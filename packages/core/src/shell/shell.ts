import { IFileSystem } from '../filesystem';
import JSZip from 'jszip';
import { IShell, ShellCommandResult, CommandParsedResult } from './types';
import { CommandRegistry } from './commands/registry';
import { CurlCommand } from './commands/curl';
import { UnzipCommand } from './commands/unzip';
import { WgetCommand } from './commands/wget';
import { Process } from '../process';
import { COMMANDS as TEXT_UTILS } from './commands/textutils';
import { COMMANDS as FILE_UTILS } from './commands/fileutils';
import { COMMANDS as ARCHIVES } from './commands/archives';
import { COMMANDS as PROC_INFO } from './commands/procinfo';
import {
    COMMANDS as UNSUPPORTED_UTILS,
    UNSUPPORTED_COMMANDS,
    isUnsupported,
    unsupportedResult
} from './commands/unsupported';
import {
    COMMANDS as SHELL_BUILTIN_UTILS,
    createShellState,
    getRunner,
    runScript,
    setRunner
} from './commands/builtins';
import type { ShellState } from './commands/builtins';
import type { CommandContext, CommandResult, ShellCommand } from './commands/types';
import type { NetworkHandle } from './commands/types';

interface ShellOptions {
    oscMode?: boolean;
    process: Process;
    env?: Map<string, string>;
    /** The directory the shell starts in: the cwd of the process it runs in. */
    cwd?: string;
    /** A read of the container's virtual network, for the commands that list what it holds. */
    network?: NetworkHandle;
}

/**
 * Every command the modules under shell/commands provide, merged once at load. The order is the
 * order the modules are tried, the same order the other half of the container builds its own table
 * in: a name the container cannot have at all is last, so the reason in `UNSUPPORTED` wins.
 */
const MODULE_COMMANDS: Record<string, ShellCommand> = {
    ...TEXT_UTILS,
    ...FILE_UTILS,
    ...ARCHIVES,
    ...PROC_INFO,
    ...SHELL_BUILTIN_UTILS,
    ...UNSUPPORTED_UTILS,
    ...UNSUPPORTED_COMMANDS
};

/** The names builtins.ts implements, so their one state-carrying entry point is used. */
const BUILTIN_NAMES: Set<string> = new Set(Object.keys(SHELL_BUILTIN_UTILS));

/**
 * The commands this shell implements itself, as the container's other shell does: they carry no
 * state of their own and are the only ones `cd` can move the directory of.
 */
const SHELL_BUILTINS = new Set([
    'echo', 'cat', 'pwd', 'ls', 'mkdir', 'rm', 'rmdir', 'touch', 'cd', 'cp', 'mv', 'true', 'false'
]);

/** Commands this shell can only reach by spawning a child, so a script engine cannot run them. */
const SPAWNED_COMMANDS = new Set(['node', 'npm', 'npx']);

/** Quotes one word so the shell engine reads it back as exactly that word. */
function quoteWord(word: string): string {
    return `'${word.split("'").join(`'\\''`)}'`;
}

/** True when a character outside any quoting makes the line more than one simple command. */
function isCompoundLine(line: string): boolean {
    let quote: string | null = null;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quote !== null) {
            if (ch === '\\' && quote === '"') i++;
            else if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === '\\') { i++; continue; }
        if ('|&;<>'.includes(ch)) return true;
        if (ch === '`') return true;
        if (ch === '$' && line[i + 1] === '(') return true;
    }
    return false;
}

export class Shell implements IShell {
    private fileSystem: IFileSystem;
    private currentDirectory: string;
    private env: Map<string, string>;
    private commandHistory: string[] = [];
    private historyIndex: number = -1;
    private oscMode: boolean = false;
    private buildInCommands: Map<string, (args: string[]) => Promise<ShellCommandResult>> = new Map();
    private commandRegistry: CommandRegistry;
    private process: Process;

    /**
     * The state the script engine keeps between lines: variables, functions, aliases, the directory
     * stack and the working directory. One state for the life of the shell, so a line a caller feeds
     * it sees what the line before it left, exactly as /bin/sh does.
     */
    private shellState: ShellState;
    /** The file system the module commands read and write through. */
    private moduleFs: IFileSystem;
    /** A read of the container's virtual network, handed to every command that asks for one. */
    private network: NetworkHandle | undefined;
    /** What `history` prints; the shell process owns the list and installs this. */
    private historySink: (() => ShellCommandResult) | undefined;
    /** Set by `exit`: no later command of the line runs, and the shell process stops. */
    stopped: boolean = false;
    /** The status `exit` left, for the commands of the line after it. */
    stoppedCode: number = 0;
    /** `$?` of the last line, as the expansions of the next one see it. */
    lastStatus: number = 0;

    constructor(fileSystem: IFileSystem, options: ShellOptions) {
        this.fileSystem = fileSystem;
        this.currentDirectory = options.cwd || '/';
        this.env = options.env || new Map([
            ['PATH', '/bin:/usr/bin'],
            ['HOME', '/home'],
            ['PWD', this.currentDirectory],
        ]);
        this.process = options.process;
        this.oscMode = options.oscMode || false;
        this.network = options.network;
        this.commandRegistry = new CommandRegistry();
        this.moduleFs = this.fsForModules();
        this.shellState = createShellState(Object.fromEntries(this.env), this.currentDirectory, this.moduleFs);
        this.shellState.shellName = 'sh';
        this.shellState.host = this;
        this.registerAllBuiltInCommands()
        this.registerAllExternalCommands();
    }
    private registerBuiltInCommand(name: string, command: (args: string[]) => Promise<ShellCommandResult>) {
        this.buildInCommands.set(name, command);
    }
    private registerExternalCommand(name: string, commandClass: any) {
        this.commandRegistry.register(name, commandClass);
    }
    private registerAllBuiltInCommands() {
        this.registerBuiltInCommand('cd', this.cd.bind(this));
        this.registerBuiltInCommand('ls', this.ls.bind(this));
        this.registerBuiltInCommand('pwd', this.pwd.bind(this));
        this.registerBuiltInCommand('cat', this.cat.bind(this));
        this.registerBuiltInCommand('echo', this.echo.bind(this));
        this.registerBuiltInCommand('mkdir', this.mkdir.bind(this));
        this.registerBuiltInCommand('rm', this.rm.bind(this));
        this.registerBuiltInCommand('rmdir', this.rmdir.bind(this));
        this.registerBuiltInCommand('touch', this.touch.bind(this));
    }
    private registerAllExternalCommands() {
        this.registerExternalCommand('curl', CurlCommand);
        this.registerExternalCommand('unzip', UnzipCommand);
        this.registerExternalCommand('wget', WgetCommand);
    }

    /**
     * The file system a module command reads and writes through.
     *
     * The container's own `resolvePath` answers a relative path from the file system root rather than
     * from the base it is given, so the view handed to the modules joins against the shell's
     * directory, as `CommandContext` describes. Every other method is the container's own untouched.
     */
    private fsForModules(): IFileSystem {
        const fs = this.fileSystem;
        const cwdOf = (): string => this.shellState.cwd;
        return new Proxy(fs, {
            get(target, prop) {
                if (prop === 'resolvePath') {
                    return (path: string, basePath?: string): string => {
                        if (path.startsWith('/')) return fs.normalizePath(path);
                        const base = basePath ?? cwdOf();
                        const root = base === '' ? '/' : fs.normalizePath(base);
                        return (root.endsWith('/') ? root : root + '/') + path;
                    };
                }
                const value = Reflect.get(target, prop, target);
                return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
            }
        });
    }

    /** The context a module command is called with: the shell's directory, environment and input. */
    private moduleContext(args: string[], input: string | null): CommandContext {
        return {
            args,
            cwd: this.shellState.cwd,
            env: this.shellState.env,
            input,
            fs: this.moduleFs,
            network: this.network
        };
    }

    /** A path argument against the shell's directory: absolute paths stay, relative ones join. */
    private at(path: string): string {
        if (path.startsWith('/')) return path;
        return `${this.shellState.cwd}/${path}`.replace(/\/+/g, '/');
    }

    /** Installs what `history` prints. The shell process owns the list and keeps it between lines. */
    setHistorySink(sink: () => ShellCommandResult): void {
        this.historySink = sink;
    }

    private formatOscOutput(type: string, content: string): string {
        if (!this.oscMode) return content;

        switch (type) {
            case 'file':
                return `\x1b[34m${content}\x1b[0m`;
            case 'directory':
                return `\x1b[1;34m${content}/\x1b[0m`;
            case 'executable':
                return `\x1b[32m${content}*\x1b[0m`;
            case 'error':
                return `\x1b[31m${content}\x1b[0m`;
            case 'success':
                return `\x1b[32m${content}\x1b[0m`;
            case 'info':
                return `\x1b[90m${content}\x1b[0m`;
            case 'warning':
                return `\x1b[33m${content}\x1b[0m`;
            case 'path':
                return `\x1b[36m${content}\x1b[0m`;
            case 'command':
                return `\x1b[1;35m${content}\x1b[0m`;
            default:
                return content;
        }
    }

    private getFileType(path: string): string {
        try {
            if (this.fileSystem.isDirectory(path)) {
                return 'directory';
            }
            if (path.endsWith('.js')) {
                return 'executable';
            }
            return 'file';
        } catch {
            return 'file';
        }
    }

    private success(stdout: string = '', type: string = 'success'): ShellCommandResult {
        return {
            stdout: this.oscMode ? this.formatOscOutput(type, stdout) : stdout,
            stderr: '',
            exitCode: 0
        };
    }

    private failure(stderr: string): ShellCommandResult {
        return {
            stdout: '',
            stderr: this.oscMode ? this.formatOscOutput('error', stderr) : stderr,
            exitCode: 1
        };
    }

    private formatCommandOutput(command: string, output: string): string {
        if (!this.oscMode) return output;

        // Format specific command outputs
        switch (command) {
            case 'ls':
                return output.split('\n').map(entry => {
                    if (!entry.trim()) return entry;
                    const type = this.getFileType(this.resolvePath(entry));
                    return this.formatOscOutput(type, entry);
                }).join('\n');

            case 'pwd':
                return this.formatOscOutput('path', output);

            case 'echo':
                return this.formatOscOutput('info', output);

            case 'cat':
                // Attempt to detect and color code content
                if (output.startsWith('{') || output.startsWith('[')) {
                    try {
                        JSON.parse(output);
                        return this.formatOscOutput('info', output);
                    } catch { }
                }
                return output;

            case 'mkdir':
            case 'touch':
            case 'rm':
            case 'rmdir':
            case 'cp':
            case 'mv':
                return this.formatOscOutput('success', output);

            default:
                return output;
        }
    }

    // Add these new methods for history management
    getNextCommand(): string {
        if (this.historyIndex < this.commandHistory.length - 1) {
            this.historyIndex++;
            return this.commandHistory[this.historyIndex];
        }
        this.historyIndex = this.commandHistory.length;
        return '';
    }

    getPreviousCommand(): string {
        if (this.historyIndex > 0) {
            this.historyIndex--;
            return this.commandHistory[this.historyIndex];
        } else if (this.historyIndex === 0) {
            return this.commandHistory[0];
        }
        return '';
    }

    getCurrentHistoryIndex(): number {
        return this.historyIndex;
    }

    getHistoryLength(): number {
        return this.commandHistory.length;
    }
    getWorkingDirectory(): string {
        return this.shellState.cwd;
    }

    setWorkingDirectory(path: string): void {
        const resolvedPath = this.at(path);
        if (!this.fileSystem.isDirectory(resolvedPath)) {
            throw new Error(`Directory not found: ${path}`);
        }
        this.currentDirectory = resolvedPath;
        this.shellState.cwd = resolvedPath;
        this.env.set('PWD', resolvedPath);
        this.shellState.scopes[0].set('PWD', { value: resolvedPath, export: true });
    }
    hasCommand(command: string): boolean {
        return SHELL_BUILTINS.has(command)
            || BUILTIN_NAMES.has(command)
            || MODULE_COMMANDS[command] !== undefined
            || this.commandRegistry.has(command);
    }

    /** True when the command is one this shell can only reach by spawning a child. */
    isSpawnedCommand(command: string): boolean {
        return SPAWNED_COMMANDS.has(command);
    }

    /** True when the command is one of the external commands registered in the registry. */
    hasExternalCommand(command: string): boolean {
        return this.commandRegistry.has(command);
    }

    /** True when a line is more than one simple command: the script engine runs those. */
    isCompound(line: string): boolean {
        return isCompoundLine(line);
    }

    /**
     * Runs one of the external commands of the registry (`curl`, `unzip`, `wget`). They are
     * asynchronous, so a caller that meets one on its own line runs it through here.
     */
    async executeExternal(command: string, args: string[]): Promise<ShellCommandResult> {
        const commandClass = this.commandRegistry.get(command)!;
        const commandObject = new commandClass({
            cwd: this.getWorkingDirectory(),
            fileSystem: this.fileSystem,
            env: this.env,
            process: this.process
        });
        return await commandObject.execute(args);
    }

    private resolvePath(path: string): string {
        return this.at(path);
    }

    private parseCommand(args: string[]): CommandParsedResult {
        const result: CommandParsedResult = {
            command: '',
            args: [],
            redirects: []
        };

        let i = 0;
        while (i < args.length) {
            const arg = args[i];

            if (arg === '>' || arg === '>>') {
                if (i + 1 >= args.length) {
                    throw new Error(`Syntax error: missing file for redirection ${arg}`);
                }
                result.redirects.push({
                    type: arg as ('>' | '>>'),
                    file: args[i + 1]
                });
                i += 2;
            } else {
                if (!result.command) {
                    result.command = arg;
                } else {
                    result.args.push(arg);
                }
                i++;
            }
        }

        return result;
    }

    private handleRedirection(output: string, redirects: CommandParsedResult['redirects']): void {
        for (const redirect of redirects) {
            const filePath = this.resolvePath(redirect.file);

            try {
                if (redirect.type === '>>') {
                    // Append to file
                    const existingContent = this.fileSystem.readFile(filePath) || '';
                    this.fileSystem.writeFile(filePath, existingContent + output);
                } else {
                    // Overwrite file
                    this.fileSystem.writeFile(filePath, output);
                }
            } catch (error: any) {
                throw new Error(`Failed to redirect to ${redirect.file}: ${error.message}`);
            }
        }
    }

    /**
     * One line, run by the same script engine the container's other shell uses: operators, pipes,
     * redirections, expansions, quoting, the utilities and the built-ins. The state the engine keeps
     * is this shell's own, so variables, functions, aliases and the working directory survive the
     * line and are what the next line sees.
     */
    executeLine(line: string): ShellCommandResult {
        const state = this.shellState;
        const previous = getRunner();
        setRunner(this.runSimpleCommand);
        try {
            const run = runScript(state, line);
            this.lastStatus = run.exitCode;
            this.syncFromState();
            let result: ShellCommandResult = { stdout: run.stdout, stderr: run.stderr, exitCode: run.exitCode };
            if (this.oscMode) {
                if (result.stdout) result.stdout = this.formatCommandOutput(this.headOf(line), result.stdout);
                if (result.stderr) result.stderr = this.formatOscOutput('error', result.stderr);
            }
            return result;
        } finally {
            setRunner(previous);
        }
    }

    /** The first word of a line, for the one OSC decoration that is chosen by command name. */
    private headOf(line: string): string {
        const match = /^\s*([^\s|&;<>$`'"]+)/.exec(line);
        return match === null ? '' : match[1];
    }

    /** Carries what the engine changed -- the directory and the exported variables -- back to the process. */
    private syncFromState(): void {
        this.currentDirectory = this.shellState.cwd;
        const exported = this.shellState.env;
        for (const name of [...this.env.keys()]) if (!(name in exported)) this.env.delete(name);
        for (const name of Object.keys(exported)) this.env.set(name, exported[name]);
    }

    /**
     * One command the script engine does not implement itself. The dispatch is the container's other
     * shell's, in the same order: this shell's own built-ins, then a command only a child can run,
     * then a name found on PATH or behind a shebang, then a utility the container cannot have, then
     * a utility a module provides, and `Command not found` with 127 last.
     */
    private readonly runSimpleCommand = (state: ShellState, words: string[], input: string | null): CommandResult => {
        const command = words[0] ?? '';
        const args = words.slice(1);

        // `exit` ended the line: nothing after it runs, whatever operator joins it
        if (this.stopped) return { stdout: '', stderr: '', exitCode: this.stoppedCode };
        if (command === '') return { stdout: '', stderr: '', exitCode: 0 };

        if (command === 'exit') {
            const status = Number.parseInt(args[0] ?? '0', 10);
            this.stopped = true;
            this.stoppedCode = Number.isNaN(status) ? 0 : status;
            return { stdout: '', stderr: '', exitCode: this.stoppedCode };
        }
        if (command === 'history') {
            return this.historySink === undefined ? { stdout: '', stderr: '', exitCode: 0 } : this.historySink();
        }

        if (SHELL_BUILTINS.has(command)) return this.runShellBuiltin(command, args, input);

        // A name only a child can run: the shell process reaches it on a line of its own, where the
        // caller can await it. Inside a pipeline or a compound command there is no way to wait, and
        // saying so is better than a status with nothing beside it.
        if (SPAWNED_COMMANDS.has(command)) {
            return this.cannotRun(command, 'it can only be run on a line of its own, where the shell can wait for it');
        }
        if (this.commandRegistry.has(command)) {
            return this.cannotRun(command, 'it needs the network, so the shell can only run it on a line of its own');
        }

        const found = this.lookupOnPath(state, command);
        if (found !== undefined) {
            return this.cannotRun(command, `it is the file ${found}, which only a child can run`);
        }
        if (this.hasShebang(command)) {
            return this.cannotRun(command, `it is a script, which only a child can run`);
        }

        // A utility the container cannot have reports the reason it cannot, with status 1: never 127.
        if (isUnsupported(command)) return unsupportedResult(command);

        const handler = MODULE_COMMANDS[command];
        if (handler !== undefined) {
            try {
                return handler(this.moduleContext(args, input));
            } catch (error: any) {
                return { stdout: '', stderr: error instanceof Error ? error.message : String(error), exitCode: 1 };
            }
        }

        return { stdout: '', stderr: `Command not found: ${command}`, exitCode: 127 };
    };

    /** The status and message of a command this shell cannot run inside the script engine. */
    private cannotRun(command: string, reason: string): CommandResult {
        return { stdout: '', stderr: `${command}: cannot run here: ${reason}`, exitCode: 127 };
    }

    /** The file PATH names for `command`, as the container's other shell looks it up. */
    private lookupOnPath(state: ShellState, command: string): string | undefined {
        const PATH = BUILTIN_NAMES.has(command) ? undefined : this.shellState.env.PATH;
        if (!PATH) return undefined;
        for (const dir of PATH.split(':')) {
            /* the name is joined against the directory: fs.resolvePath answers a relative name from
               the file system root, never from the base it is given */
            const base = dir.endsWith('/') ? dir.slice(0, -1) : dir;
            const found = this.fileSystem.normalizePath(`${base}/${command}`);
            if (this.fileSystem.fileExists(found)) return found;
        }
        return undefined;
    }

    /** True when `command` names a file that starts with a shebang. */
    private hasShebang(command: string): boolean {
        let content: string | undefined;
        try {
            content = this.fileSystem.readFile(this.at(command));
        } catch {
            content = undefined;
        }
        return content !== undefined && /^#!/.test(content);
    }

    /**
     * This shell's own built-ins, with the output and status the container's other shell gives them.
     * `cd` moves the engine's directory, so the next command of the line -- and the next line the
     * caller feeds -- runs there.
     */
    private runShellBuiltin(command: string, args: string[], input: string | null): CommandResult {
        const fs = this.fileSystem;
        const at = (path: string): string => this.at(path);
        const ok = (stdout = ''): CommandResult => ({ stdout, stderr: '', exitCode: 0 });
        const fail = (stderr: string): CommandResult => ({ stdout: '', stderr, exitCode: 1 });
        try {
            switch (command) {
                case 'echo':
                    return ok(args.join(' ') + '\n');
                case 'true':
                    return ok();
                case 'false':
                    return fail('');
                case 'cat': {
                    // no argument reads the standard input, as it does in a shell
                    if (args.length === 0) return ok(input ?? '');
                    let joined = '';
                    for (const name of args) {
                        const content = fs.readFile(at(name));
                        if (content === undefined) return fail(`File not found: ${name}`);
                        joined += content;
                    }
                    return ok(joined);
                }
                case 'pwd':
                    return ok(this.shellState.cwd + '\n');
                case 'ls': {
                    // A directory operand lists the names in it; a file operand -- every name a glob
                    // such as `ls *.txt` expands to -- prints its own name, as it does in a shell.
                    const operands = args.filter((arg) => !arg.startsWith('-'));
                    const names: string[] = [];
                    if (operands.length === 0) {
                        names.push(...this.lsNames(at(this.shellState.cwd)));
                    } else {
                        for (const operand of operands) {
                            const path = at(operand);
                            if (this.isDirectorySafe(path)) names.push(...this.lsNames(path));
                            else if (this.fileExistsSafe(path)) names.push(operand);
                            else return fail(`ls: ${operand}: No such file or directory`);
                        }
                    }
                    return ok(names.length > 0 ? names.join('\n') + '\n' : '');
                }
                case 'mkdir': {
                    if (args.length === 0) return fail('No directory specified');
                    const recursive = args.includes('-p');
                    const paths = args.filter((arg) => !arg.startsWith('-'));
                    if (paths.length === 0) return fail('No directory specified');
                    if (recursive) {
                        for (const path of paths) this.createDirectoryTree(at(path));
                    } else {
                        for (const path of paths) fs.createDirectory(at(path));
                    }
                    return ok();
                }
                case 'rm': {
                    if (args.length === 0) return fail('No file specified');
                    const recursive = args.includes('-r') || args.includes('-rf');
                    for (const file of args.filter((arg) => !arg.startsWith('-'))) {
                        fs.deleteFile(at(file), recursive);
                    }
                    return ok();
                }
                case 'rmdir':
                    if (args.length === 0) return fail('No directory specified');
                    fs.deleteDirectory(at(args[0]));
                    return ok();
                case 'touch':
                    if (args.length === 0) return fail('No file specified');
                    fs.writeFile(at(args[0]), '');
                    return ok();
                case 'cd': {
                    const target = args[0] || '/';
                    const next = at(target);
                    if (!fs.isDirectory(next)) return fail(`Directory not found: ${target}`);
                    this.shellState.cwd = next;
                    this.currentDirectory = next;
                    this.env.set('PWD', next);
                    this.shellState.scopes[0].set('PWD', { value: next, export: true });
                    return ok();
                }
                case 'cp':
                case 'mv': {
                    if (args.length < 2) return fail('Source and destination required');
                    const [src, dest] = args;
                    const content = fs.readFile(at(src));
                    if (content === undefined) return fail(`Source file not found: ${src}`);
                    fs.writeFile(at(dest), content);
                    if (command === 'mv') fs.deleteFile(at(src));
                    return ok();
                }
                default:
                    return fail(`Command not found: ${command}`);
            }
        } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
        }
    }

    /** The names `ls` prints for one directory: sorted, and without the dot files, as a shell has it. */
    private lsNames(path: string): string[] {
        return this.fileSystem.listDirectory(path).filter((name) => !name.startsWith('.')).sort();
    }

    /** `mkdir -p`: the directory and every directory above it. */
    private createDirectoryTree(path: string): void {
        const parts = path.split('/').filter((part) => part !== '');
        let current = '';
        for (const part of parts) {
            current += '/' + part;
            if (this.isDirectorySafe(current)) continue;
            this.fileSystem.createDirectory(current);
        }
    }

    /** `isDirectory` as a question: a path that is not there is not a directory. */
    private isDirectorySafe(path: string): boolean {
        try {
            return this.fileSystem.isDirectory(path);
        } catch {
            return false;
        }
    }

    /** `fileExists` as a question: a path `ls` cannot stat is not there. */
    private fileExistsSafe(path: string): boolean {
        try {
            return this.fileSystem.fileExists(path);
        } catch {
            return false;
        }
    }

    // Modified execute method to include history
    async execute(command: string, args: string[]): Promise<ShellCommandResult> {
        try {
            if (!command) {
                return this.success();
            }
            this.commandHistory.push(command);

            // Parse command and redirections
            const parsedCommand = this.parseCommand([command, ...args]);

            // Execute the actual command
            const result = await this.executeCommand(
                parsedCommand.command,
                parsedCommand.args
            );


            // Handle redirections
            if (result.exitCode === 0 && parsedCommand.redirects.length > 0) {
                try {
                    this.handleRedirection(result.stdout, parsedCommand.redirects);
                    result.stdout = '';
                } catch (error: any) {
                    let ret = {
                        stdout: '',
                        stderr: error.message,
                        exitCode: 1
                    };
                    if (this.oscMode && ret.stderr) {
                        ret.stderr = this.formatOscOutput('error', ret.stderr);
                    }
                    return ret;
                }
            }

            // Format output
            if (result.exitCode === 0 && result.stdout) {
                result.stdout = this.formatCommandOutput(command, result.stdout);
            }
            if (this.oscMode && result.stderr) {
                result.stderr = this.formatOscOutput('error', result.stderr);
            }

            return result;
        } catch (error: any) {
            return this.failure(error.message);
        }
    }

    private async executeCommand(command: string, args: string[]): Promise<ShellCommandResult> {
        // check if the command is a built-in command this shell implements itself
        if (SHELL_BUILTINS.has(command)) {
            return this.runShellBuiltin(command, args, null);
        }
        if (BUILTIN_NAMES.has(command) || MODULE_COMMANDS[command] !== undefined) {
            return this.executeLine([command, ...args].map(quoteWord).join(' '));
        }
        if (this.commandRegistry.has(command)) {
            return await this.executeExternal(command, args);
        }
        // check if the command is in env PATH
        let PATH = this.env.get('PATH');
        if (PATH) {
            const paths = PATH.split(':');
            for (const path of paths) {
                const executablePath = this.fileSystem.resolvePath(command, path);
                if (this.fileSystem.fileExists(executablePath)) {
                    return { stdout: '', stderr: `No executor found for: ${executablePath}`, exitCode: 1 };
                }
            }
        }
        // check for shebang
        let content: string | undefined;
        try {
            content = this.fileSystem.readFile(this.at(command));
        } catch {
            content = undefined;
        }
        const shebang = content ? /^#!(.*)/.exec(content) : null;
        if (shebang) {
            const tokens = shebang[1].split(' ');
            if (tokens[0] === '/usr/bin/env') {
                if (tokens.length === 1) return { stdout: '', stderr: '', exitCode: 1 };
                return { stdout: '', stderr: `No executor found for: ${tokens[1]}`, exitCode: 1 };
            }
        }

        // Handle built-in commands as before
        return { stdout: '', stderr: `Command not found: ${command}`, exitCode: 127 };
    }

    private async ls(args: string[]): Promise<ShellCommandResult> {
        try {
            const path = args[0] || this.currentDirectory;
            const resolvedPath = this.resolvePath(path);
            const entries = this.fileSystem.listDirectory(resolvedPath);

            return this.success(entries.join('\n'));
        } catch (error: any) {
            return this.failure(error.message);
        }
    }

    private async cat(args: string[]): Promise<ShellCommandResult> {
        if (args.length === 0) {
            return this.failure('No file specified');
        }
        try {
            const content = this.fileSystem.readFile(this.resolvePath(args[0]));
            if (content === undefined) {
                return this.failure(`File not found: ${args[0]}`);
            }
            return this.success(content);
        } catch (error: any) {
            return this.failure(error.message);
        }
    }

    private async mkdir(args: string[]): Promise<ShellCommandResult> {
        if (args.length === 0) {
            return this.failure('No directory specified');
        }
        try {
            this.fileSystem.createDirectory(this.resolvePath(args[0]));
            return this.success();
        } catch (error: any) {
            return this.failure(error.message);
        }
    }

    private async rm(args: string[]): Promise<ShellCommandResult> {
        if (args.length === 0) {
            return this.failure('No file specified');
        }
        try {
            const recursive = args.includes('-r') || args.includes('-rf');
            const files = args.filter(arg => !arg.startsWith('-'));

            for (const file of files) {
                this.fileSystem.deleteFile(this.resolvePath(file), recursive);
            }
            return this.success();
        } catch (error: any) {
            return this.failure(error.message);
        }
    }

    private async rmdir(args: string[]): Promise<ShellCommandResult> {
        if (args.length === 0) {
            return this.failure('No directory specified');
        }
        try {
            this.fileSystem.deleteDirectory(this.resolvePath(args[0]));
            return this.success();
        } catch (error: any) {
            return this.failure(error.message);
        }
    }

    private async touch(args: string[]): Promise<ShellCommandResult> {
        if (args.length === 0) {
            return this.failure('No file specified');
        }
        try {
            this.fileSystem.writeFile(this.resolvePath(args[0]), '');
            return this.success();
        } catch (error: any) {
            return this.failure(error.message);
        }
    }

    private async pwd(): Promise<ShellCommandResult> {
        return this.success(this.currentDirectory);
    }

    private async cd(args: string[]): Promise<ShellCommandResult> {
        try {
            const path = args[0] || '/';
            const newPath = this.resolvePath(path);
            if (!this.fileSystem.isDirectory(newPath)) {
                return this.failure(`Directory not found: ${path}`);
            }
            this.currentDirectory = newPath;
            this.env.set('PWD', newPath);
            return this.success();
        } catch (error: any) {
            return this.failure(error.message);
        }
    }

    private async echo(args: string[]): Promise<ShellCommandResult> {
        return this.success(args.join(' ') + '\n');
    }

    private async cp(args: string[]): Promise<ShellCommandResult> {
        if (args.length < 2) {
            return this.failure('Source and destination required');
        }
        try {
            const [src, dest] = args;
            const content = this.fileSystem.readFile(this.resolvePath(src));
            if (content === undefined) {
                return this.failure(`Source file not found: ${src}`);
            }
            this.fileSystem.writeFile(this.resolvePath(dest), content);
            return this.success();
        } catch (error: any) {
            return this.failure(error.message);
        }
    }

    private async mv(args: string[]): Promise<ShellCommandResult> {
        if (args.length < 2) {
            return this.failure('Source and destination required');
        }
        try {
            const [src, dest] = args;
            const content = this.fileSystem.readFile(this.resolvePath(src));
            if (content === undefined) {
                return this.failure(`Source file not found: ${src}`);
            }
            this.fileSystem.writeFile(this.resolvePath(dest), content);
            this.fileSystem.deleteFile(this.resolvePath(src));
            return this.success();
        } catch (error: any) {
            return this.failure(error.message);
        }
    }
}
