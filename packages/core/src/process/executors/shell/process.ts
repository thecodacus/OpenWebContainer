import { Process } from '../../base/process';
import { Shell } from '../../../shell';
import { ProcessEvent, ProcessState, ProcessType } from '../../base';
import { IFileSystem } from '../../../filesystem';
import type { NetworkHandle } from '../../../shell/commands/types';
import { ShellCommandResult } from '../../../shell';

interface CommandHistoryEntry {
    command: string;
    timestamp: Date;
}

/**
 * Splits a command line into words the way a POSIX shell quotes them: single quotes keep everything,
 * double quotes keep everything except \" \\ \$ \` and an escaped newline, a bare backslash escapes the
 * next character, and adjacent quoted or plain pieces make one word. No expansion is done.
 */
export function splitCommandLine(line: string): string[] {
    const words: string[] = [];
    let word = '';
    let inWord = false;
    let i = 0;
    while (i < line.length) {
        const ch = line[i];
        if (ch === ' ' || ch === '\t' || ch === '\n') {
            if (inWord) {
                words.push(word);
                word = '';
                inWord = false;
            }
            i++;
        } else if (ch === "'") {
            const close = line.indexOf("'", i + 1);
            const stop = close === -1 ? line.length : close;
            word += line.slice(i + 1, stop);
            inWord = true;
            i = stop + 1;
        } else if (ch === '"') {
            inWord = true;
            i++;
            while (i < line.length && line[i] !== '"') {
                const next = line[i + 1];
                if (line[i] === '\\' && next !== undefined && '"\\$`\n'.includes(next)) {
                    if (next !== '\n') word += next;
                    i += 2;
                } else {
                    word += line[i];
                    i++;
                }
            }
            i++;
        } else if (ch === '\\') {
            const next = line[i + 1];
            if (next !== undefined && next !== '\n') word += next;
            inWord = true;
            i += 2;
        } else {
            word += ch;
            inWord = true;
            i++;
        }
    }
    if (inWord) words.push(word);
    return words;
}

/**
 * The file PATH names for `command`: the directory and the name joined, not `fs.resolvePath`, which
 * answers a relative name from the file system root and never from the base it is given.
 */
function joinOnPath(fileSystem: IFileSystem, dir: string, command: string): string {
    const base = dir.endsWith('/') ? dir.slice(0, -1) : dir;
    return fileSystem.normalizePath(`${base}/${command}`);
}

/**
 * The interpreter the shebang of `file` names -- `node` for `#!/usr/bin/env node` -- or undefined
 * when the file has no shebang, so the caller can run the file itself.
 */
function shebangInterpreter(fileSystem: IFileSystem, file: string): string | undefined {
    let content: string | undefined;
    try {
        content = fileSystem.readFile(file);
    } catch {
        return undefined;
    }
    const match = content === undefined ? null : /^#!(.*)/.exec(content);
    if (match === null) return undefined;
    const tokens = match[1].trim().split(/\s+/).filter(token => token !== '');
    const first = tokens[0];
    if (first === undefined) return undefined;
    if (first.endsWith('/env') || first === 'env') {
        return tokens.slice(1).find(token => !token.startsWith('-'));
    }
    return first.split('/').pop();
}

export class ShellProcess extends Process {
    private shell: Shell;
    private prompt: string;
    private currentLine: string = '';
    private running: boolean = true;
    private filteredArgs: string[];
    private commandHistory: CommandHistoryEntry[] = [];
    private historyIndex: number = -1;
    /**
     * The line being typed, kept the first time Up moves off it, so Down can hand it back. Null
     * while the cursor sits on the current line: Down is then a no-op, never a request to replace
     * what is being typed with an empty line.
     */
    private draftLine: string | null = null;

    // Add readline state
    private cursorPosition: number = 0;
    private lineBuffer: string[] = [];

    private fileSystem: IFileSystem;

    constructor(
        pid: number,
        executablePath: string,
        args: string[],
        fileSystem: IFileSystem,
        parentPid?: number,
        cwd?: string,
        env?: Map<string, string>,
        /** A read of the container's virtual network, passed on to the shell for its commands. */
        network?: NetworkHandle
    ) {
        super(pid, ProcessType.SHELL, executablePath, args, parentPid,cwd,env);
        this.fileSystem = fileSystem;
        const oscMode = args.includes('--osc');
        this.filteredArgs = args.filter(arg => arg !== '--osc');

        this.shell = new Shell(fileSystem, { oscMode, process: this,env: this.env, cwd: this.cwd, network });
        this.shell.setHistorySink(() => ({
            stdout: this.commandHistory
                .map((entry, index) => `${index + 1}: [${entry.timestamp.toISOString()}] ${entry.command}`)
                .join('\n'),
            stderr: '',
            exitCode: 0
        }));
        this.prompt = oscMode ? '\x1b[1;32m$\x1b[0m ' : '$ ';
    }

    protected async execute(): Promise<void> {
        try {
            // Handle initial command if provided in args
            if (this.filteredArgs.length > 0) {
                const commandLine = this.filteredArgs[0] === '-c'
                    ? (this.filteredArgs[1] ?? '')
                    : this.filteredArgs.join(' ');
                const result = await this.executeCommand(commandLine);
                if (result.stdout) {
                    this.emitOutput(result.stdout.endsWith('\n') ? result.stdout : result.stdout + '\n');
                }
                if (result.stderr) {
                    // the newline stdout gets only when it has none: a command's own diagnostics end
                    // in one already, and a second turned every error line into a blank line after it
                    this.emitError(result.stderr.endsWith('\n') ? result.stderr : result.stderr + '\n');
                }
                this._exitCode = result.exitCode;
                return;
            }

            // Initial prompt
            this.emitOutput(this.prompt);

            // Interactive shell loop
            while (this.running && this.state === ProcessState.RUNNING) {
                const input = await this.readInput();
                await this.handleInput(input);
            }
        } catch (error: any) {
            this.emitError(`Shell error: ${error.message}\n`);
            throw error;
        }
    }

    protected async onTerminate(): Promise<void> {
        this.running = false;
        this.emitOutput('\nShell terminated.\n');
    }

    private async handleInput(input: string): Promise<void> {

        // Detect paste by checking if input is multiple characters 
        // and doesn't start with an escape sequence
        if (input.length > 1 && !input.startsWith('\x1b')) {
            await this.handlePaste(input);
            return;
        }

        switch (input) {
            case '\r': // Enter
                await this.handleEnterKey();
                break;

            case '\x7F': // Backspace
            case '\b':
                this.handleBackspace();
                break;

            case '\x1b[A': // Up arrow
                this.handleUpArrow();
                break;

            case '\x1b[B': // Down arrow
                this.handleDownArrow();
                break;

            case '\x1b[C': // Right arrow
                this.handleRightArrow();
                break;

            case '\x1b[D': // Left arrow
                this.handleLeftArrow();
                break;

            case '\x03': // Ctrl+C
                this.handleCtrlC();
                break;

            case '\x04': // Ctrl+D
                this.handleCtrlD();
                break;

            default:
                if (input.length === 1 && input >= ' ') {
                    this.handleCharacterInput(input);
                }
                break;
        }
    }
    private async handlePaste(pastedText: string): Promise<void> {
        // Split the pasted text by lines
        const lines = pastedText.split(/\r?\n/);

        // Handle first line - insert at cursor position
        const firstLine = lines[0];
        const before = this.currentLine.slice(0, this.cursorPosition);
        const after = this.currentLine.slice(this.cursorPosition);

        this.currentLine = before + firstLine + after;
        this.cursorPosition += firstLine.length;

        // Update display for first line
        this.emitOutput(firstLine);
        if (after) {
            // Redraw rest of the line
            this.emitOutput(after);
            // Move cursor back to position
            this.emitOutput(`\x1b[${after.length}D`);
        }

        // If there are multiple lines, handle them one by one
        if (lines.length > 1) {
            for (let i = 1; i < lines.length; i++) {
                // Execute current line
                await this.handleEnterKey();

                // Handle next line
                const line = lines[i];
                if (line.length > 0) {
                    this.currentLine = line;
                    this.cursorPosition = line.length;
                    this.emitOutput(line);
                }
            }
        }
    }
    private async handleEnterKey(): Promise<void> {
        this.emitOutput('\n');

        const commandLine = this.currentLine.trim();
        if (commandLine) {
            // Add to history
            this.commandHistory.push({
                command: commandLine,
                timestamp: new Date()
            });
            this.historyIndex = this.commandHistory.length;

            // Execute command
            const result = await this.executeCommand(commandLine);

            // Handle output
            if (result.stdout) {
                this.emitOutput(result.stdout);
                if (!result.stdout.endsWith('\n')) {
                    this.emitOutput('\n');
                }
            }
            if (result.stderr) {
                this.emitError(result.stderr);
                if (!result.stderr.endsWith('\n')) {
                    this.emitOutput('\n');
                }
            }
        }

        // Reset current line and show new prompt
        this.currentLine = '';
        this.cursorPosition = 0;
        this.draftLine = null;
        this.emitOutput(this.prompt);
    }

    private handleBackspace(): void {
        if (this.cursorPosition > 0) {
            const before = this.currentLine.slice(0, this.cursorPosition - 1);
            const after = this.currentLine.slice(this.cursorPosition);
            this.currentLine = before + after;
            this.cursorPosition--;

            // Update display
            this.emitOutput('\b \b'); // Move back, clear character, move back
            if (after) {
                // Redraw rest of the line
                this.emitOutput(after + '\x1b[K'); // Clear to end of line
                // Move cursor back to position
                this.emitOutput(`\x1b[${after.length}D`);
            }
        }
    }

    private handleUpArrow(): void {
        if (this.historyIndex > 0) {
            if (this.draftLine === null && this.historyIndex >= this.commandHistory.length) {
                this.draftLine = this.currentLine;
            }
            this.historyIndex--;
            this.updateInputLine(this.commandHistory[this.historyIndex].command);
        }
    }

    private handleDownArrow(): void {
        /* Down only means something once Up has moved the cursor off the line being typed. Before
           that it is a no-op, the way it is in /bin/sh: it never replaces a line the user is still
           typing -- quoting and all -- with an empty one. */
        if (this.draftLine === null) return;
        if (this.historyIndex < this.commandHistory.length - 1) {
            this.historyIndex++;
            this.updateInputLine(this.commandHistory[this.historyIndex].command);
            return;
        }
        this.historyIndex = this.commandHistory.length;
        this.updateInputLine(this.draftLine);
        this.draftLine = null;
    }

    private handleLeftArrow(): void {
        if (this.cursorPosition > 0) {
            this.cursorPosition--;
            this.emitOutput('\x1b[D');
        }
    }

    private handleRightArrow(): void {
        if (this.cursorPosition < this.currentLine.length) {
            this.cursorPosition++;
            this.emitOutput('\x1b[C');
        }
    }

    private handleCtrlC(): void {
        this.currentLine = '';
        this.cursorPosition = 0;
        this.draftLine = null;
        this.emitOutput('^C\n' + this.prompt);
    }

    private handleCtrlD(): void {
        if (this.currentLine.length === 0) {
            this.emitOutput('exit\n');
            this.running = false;
            this._exitCode = 0;
        }
    }

    private handleCharacterInput(char: string): void {
        // Insert character at cursor position
        const before = this.currentLine.slice(0, this.cursorPosition);
        const after = this.currentLine.slice(this.cursorPosition);
        this.currentLine = before + char + after;
        this.cursorPosition++;
        this.draftLine = null;

        // Update display
        this.emitOutput(char);
        if (after) {
            // Redraw rest of the line
            this.emitOutput(after);
            // Move cursor back to position
            this.emitOutput(`\x1b[${after.length}D`);
        }
    }

    private updateInputLine(newLine: string): void {
        // Clear current line
        this.emitOutput('\r\x1b[K');
        // Write prompt and new line
        this.emitOutput(this.prompt + newLine);
        this.currentLine = newLine;
        this.cursorPosition = newLine.length;
    }

    /**
     * One line, run by the same script engine the container's other shell runs `sh -c <line>` with.
     *
     * The engine is synchronous, so a command that only a child process can run -- `node`, `npm`,
     * `npx`, a file found on PATH, a script behind a shebang, and the network commands of the
     * registry -- is spawned on a line of its own, where the shell can wait for it, before the line
     * reaches the engine. Everything else -- the operators, pipes, redirections and expansions, and
     * every built-in and utility -- is the engine's, and is what the other path runs.
     */
    private async executeCommand(commandLine: string): Promise<ShellCommandResult> {
        const processedArgs = splitCommandLine(commandLine);

        if (processedArgs.length === 0) {
            return { stdout: '', stderr: '', exitCode: 0 };
        }

        const [command, ...cmdArgs] = processedArgs;

        if (!this.shell.isCompound(commandLine)) {
            const spawned = await this.spawnOneCommand(command, cmdArgs);
            if (spawned !== undefined) {
                this.rememberStopped(spawned.exitCode);
                return spawned;
            }
        }

        const result = this.shell.executeLine(commandLine);
        if (this.shell.stopped) {
            this.running = false;
            this._exitCode = result.exitCode;
        }
        return result;
    }

    /** `exit` on a line of its own: the status it gave is the shell's. */
    private rememberStopped(_exitCode: number): void {
        if (!this.shell.stopped) return;
        this.running = false;
        this._exitCode = this.shell.stoppedCode;
    }

    /**
     * Runs a command that only a child process can run, or returns undefined when the command is not
     * one of those and the line belongs to the script engine.
     */
    private async spawnOneCommand(command: string, cmdArgs: string[]): Promise<ShellCommandResult | undefined> {
        try {
            if (this.shell.isSpawnedCommand(command)) {
                return await this.spawnChild(
                    command,
                    cmdArgs,
                    Object.fromEntries(this.env),
                    this.shell.getWorkingDirectory()
                );
            }
            if (this.shell.hasExternalCommand(command)) {
                return await this.shell.executeExternal(command, cmdArgs);
            }
            // A built-in or a utility is never looked for on PATH, the way it never is in a shell
            if (this.shell.hasCommand(command)) return undefined;
            // check if the command is in env PATH
            let PATH = this.env.get('PATH');
            if (PATH) {
                for (const path of PATH.split(':')) {
                    const executablePath = joinOnPath(this.fileSystem, path, command);
                    if (!this.fileSystem.fileExists(executablePath)) continue;
                    /* A file on PATH is run the way the kernel runs it: through the interpreter its
                       shebang names. A node_modules/.bin shim is one -- a `node` script with no
                       executor of its own -- so a script that calls an installed bin by name works. */
                    const interpreter = shebangInterpreter(this.fileSystem, executablePath);
                    const spawnArgs = interpreter === undefined ? cmdArgs : [executablePath, ...cmdArgs];
                    return await this.spawnChild(
                        interpreter ?? executablePath,
                        spawnArgs,
                        Object.fromEntries(this.env),
                        this.shell.getWorkingDirectory()
                    );
                }
            }
            // check for shebang: a name that is not a file to read is not one, and says so by throwing
            let content: string | undefined;
            try {
                content = this.fileSystem.readFile(command);
            } catch {
                content = undefined;
            }
            if (content) {
                const shebang = content.match(/^#!(.*)/);
                if (shebang) {
                    const interpreterName = shebang[1];
                    let name = interpreterName.split(" ")[0]
                    if (name == '/usr/bin/env') {
                        let tokens = interpreterName.split(" ")
                        if (tokens.length == 1)
                            throw "executor not specified"
                        let newCommand = tokens[1]
                        return await this.spawnChild(newCommand, [command, ...cmdArgs]);
                    }
                }
            }
            return undefined;
        } catch (error: any) {
            return {
                stdout: '',
                stderr: error.message,
                exitCode: 1
            };
        }
    }
}
