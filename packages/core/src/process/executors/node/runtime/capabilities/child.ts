import { Process, ProcessEvent, ProcessState } from '../../../../base';
import { CapabilityContext, CapabilityHandler } from './types';
import { printEvalSource } from '../eval-source';
import { COMMANDS as TEXT_UTILS } from '../../../../../shell/commands/textutils';
import { COMMANDS as FILE_UTILS } from '../../../../../shell/commands/fileutils';
import { COMMANDS as ARCHIVES } from '../../../../../shell/commands/archives';
import { COMMANDS as PROC_INFO } from '../../../../../shell/commands/procinfo';
import {
    COMMANDS as UNSUPPORTED_UTILS,
    UNSUPPORTED_COMMANDS,
    curlUsageResult,
    isUnsupported,
    unsupportedResult
} from '../../../../../shell/commands/unsupported';
import {
    COMMANDS as SHELL_BUILTIN_UTILS,
    createShellState,
    evalArith,
    runScript,
    setActiveState,
    setRunner
} from '../../../../../shell/commands/builtins';
import type { ShellState, ShellVar } from '../../../../../shell/commands/builtins';
import type { IFileSystem } from '../../../../../filesystem';
import type { CommandContext, CommandResult, ShellCommand } from '../../../../../shell/commands/types';
import {
    LIFECYCLE_COMMANDS,
    NPM_VERSION,
    findPackageRoot,
    missingScriptMessage,
    parseScriptArgs,
    readManifest,
    scriptCommandLine,
    scriptEvents,
    scriptFailureMessage,
    scriptHeader,
    scriptLabel,
    scriptList,
    scriptPath
} from '../../../../../npm/scripts';
import { nodeSyncRunner, syncRunActive } from '../../pump';
import type { SyncChildResult } from '../../pump';

/*
 * Host half of child_process, worker_threads and cluster. The guest half is ../guest/modules/child.ts.
 *
 * A child is a container process started through ctx.services.startProcess and recorded under its pid.
 * Its output reaches the parent guest as 'ev' deliveries when the stdio mode is 'pipe', is forwarded
 * through the parent's ctx.output when 'inherit', and is dropped when 'ignore'.
 *
 * IPC is relayed here. A child attaches its own guest target with child.ipcAttach (the child's pid is
 * ctx.pid). Frames from the parent (child.sendToChild) are delivered to that target as 'ipc'; frames
 * from the child (child.sendToParent) come back to the parent as 'ev' with k 'ipc'. Frames sent before
 * the child attaches are queued and flushed on attach. Every delivery is a macrotask, so no guest is
 * re-entered from inside another guest's call.
 */

type StdioMode = 'pipe' | 'inherit' | 'ignore';

interface ChildRecord {
    token: string;
    kind: string;
    /** The spawning process: deliveries to its guest and inherited output go through it. */
    parent: CapabilityContext;
    /** The parent guest target that receives this child's events. */
    target: number;
    stdout: StdioMode;
    stderr: StdioMode;
    pid?: number;
    process?: Process;
    /** The child guest's IPC target, set when the child attaches. */
    ipcTarget?: number;
    connected: boolean;
    /** Frames addressed to the child that were sent before it attached. */
    queue: unknown[];
    exited: boolean;
    killSignal?: string;
}

interface Registry {
    byPid: Map<number, ChildRecord>;
    pending: Map<string, ChildRecord>;
}

const REGISTRIES = new WeakMap<object, Registry>();

/** Workers that reported an uncaught error to their parent: their own stderr copy of that error is not printed. */
const FAILED_WORKERS = new WeakSet<ChildRecord>();

/** One registry per container (keyed by its services object), so pids of different containers never collide. */
function registryFor(ctx: CapabilityContext): Registry {
    let registry = REGISTRIES.get(ctx.services);
    if (!registry) {
        registry = { byPid: new Map(), pending: new Map() };
        REGISTRIES.set(ctx.services, registry);
    }
    return registry;
}

/**
 * Schedules a delivery as a macrotask, so a guest is never re-entered from inside another guest's call. Inside a
 * synchronous run no macrotask runs before the call returns, so the action runs now: the delivery it makes is queued
 * by the receiving process and taken by that process's pump.
 */
function later(action: () => void): void {
    if (syncRunActive()) {
        action();
        return;
    }
    setTimeout(action, 0);
}

function modeOf(value: unknown): StdioMode {
    return value === 'inherit' || value === 'ignore' ? value : 'pipe';
}

/** The environment a child inherits: the caller's, without the IPC markers of this runtime. */
function childEnvOf(ctx: CapabilityContext): Record<string, string> {
    const env: Record<string, string> = { ...ctx.env() };
    delete env.OWC_IPC_KIND;
    delete env.OWC_IPC_DATA;
    return env;
}

/** Container executables are node, *.js and sh; anything else has no executor and reports ENOENT like Node. */
function spawnFailure(error: unknown, file: string, args: string[]): Error {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('No executor found')) {
        return Object.assign(new Error(`spawn ${file} ENOENT`), {
            code: 'ENOENT',
            errno: -2,
            syscall: `spawn ${file}`,
            path: file,
            spawnargs: args
        });
    }
    return Object.assign(new Error(message), {
        code: 'ERR_CHILD_PROCESS_SPAWN',
        syscall: `spawn ${file}`,
        path: file,
        spawnargs: args
    });
}

function routeOutput(record: ChildRecord, fd: 1 | 2, text: string): void {
    const mode = fd === 1 ? record.stdout : record.stderr;
    if (mode === 'pipe') {
        later(() => record.parent.deliver(record.target, 'ev', { k: 'out', fd, s: text }));
    } else if (mode === 'inherit') {
        record.parent.output(fd === 1 ? { stdout: text } : { stderr: text });
    }
}

/** A frame goes to another guest's sink: always a macrotask, even inside a synchronous run. */
function deliverFrame(ctx: CapabilityContext, pid: number, target: number, frame: unknown): void {
    setTimeout(() => ctx.services.sinkFor(pid)?.deliver(target, 'ipc', frame), 0);
}

const spawnChildAsync: CapabilityHandler = async (args, ctx) => {
    const registry = registryFor(ctx);
    const file = String(args.file);
    const argv: string[] = Array.isArray(args.args) ? args.args.map(String) : [];
    const env: Record<string, string> = args.env ? { ...args.env } : childEnvOf(ctx);
    if (args.ipc) {
        env.OWC_IPC_KIND = String(args.ipcKind);
        env.OWC_IPC_DATA = JSON.stringify({ ...args.ipcData, token: args.token });
    }
    const stdio: unknown[] = Array.isArray(args.stdio) ? args.stdio : [];
    const record: ChildRecord = {
        token: String(args.token),
        kind: String(args.kind),
        parent: ctx,
        target: Number(args.target),
        stdout: modeOf(stdio[1]),
        stderr: modeOf(stdio[2]),
        connected: Boolean(args.ipc),
        queue: [],
        exited: false
    };
    registry.pending.set(record.token, record);
    const child = await ctx.services
        .startProcess({
            parentPid: ctx.pid,
            executable: file,
            args: argv,
            cwd: typeof args.cwd === 'string' ? args.cwd : ctx.cwd(),
            env
        })
        .catch((error: unknown) => {
            registry.pending.delete(record.token);
            throw spawnFailure(error, file, argv);
        });
    record.process = child;
    record.pid = child.pid;
    registry.pending.delete(record.token);
    registry.byPid.set(child.pid, record);

    if (child.state !== ProcessState.RUNNING && child.state !== ProcessState.CREATED) {
        // The process finished inside spawn, before these listeners existed, so its EXIT was never seen.
        // Its output emitted in that window is not recoverable; the exit is reported now.
        record.exited = true;
        record.connected = false;
        registry.byPid.delete(child.pid);
        const code = child.exitCode ?? 0;
        later(() => record.parent.deliver(record.target, 'ev', { k: 'exit', code, signal: null }));
        return { pid: child.pid };
    }
    child.addEventListener(ProcessEvent.MESSAGE, (data: { stdout?: string; stderr?: string }) => {
        if (record.exited) return;
        if (data.stdout !== undefined) routeOutput(record, 1, data.stdout);
        if (data.stderr !== undefined && !FAILED_WORKERS.has(record)) routeOutput(record, 2, data.stderr);
    });
    child.addEventListener(ProcessEvent.ERROR, (data: { error: Error }) => {
        if (record.exited || !data.error) return;
        const { name, message } = data.error;
        const code = (data.error as { code?: unknown }).code;
        later(() => record.parent.deliver(record.target, 'ev', { k: 'error', e: { name, message, code } }));
    });
    child.addEventListener(ProcessEvent.EXIT, (data: { exitCode: number | null }) => {
        // terminate() and start() both emit EXIT for a killed process: the first one wins
        if (record.exited) return;
        record.exited = true;
        record.connected = false;
        registry.byPid.delete(child.pid);
        const signal = record.killSignal ?? null;
        const code = signal === null ? (data.exitCode ?? 0) : null;
        later(() => record.parent.deliver(record.target, 'ev', { k: 'exit', code, signal }));
    });
    return { pid: child.pid };
};

/** A spawn made while a synchronous run is on the stack runs to completion there; any other spawn is asynchronous. */
const spawnChild: CapabilityHandler = (args, ctx) => (syncRunActive() ? spawnChildNow(args, ctx) : spawnChildAsync(args, ctx));

const killChild: CapabilityHandler = (args, ctx) => {
    const record = registryFor(ctx).byPid.get(Number(args.pid));
    if (!record || record.exited || !record.process || record.parent.pid !== ctx.pid) return false;
    if (record.process.state !== ProcessState.RUNNING) return false;
    record.killSignal = String(args.signal ?? 'SIGTERM');
    void record.process.terminate();
    return true;
};

/** Writes to a child's stdin. Only shell processes read Process input; node children do not (documented gap). */
const stdinWrite: CapabilityHandler = (args, ctx) => {
    const record = registryFor(ctx).byPid.get(Number(args.pid));
    if (!record || record.exited || !record.process || record.parent.pid !== ctx.pid) return false;
    try {
        record.process.writeInput(String(args.data));
        return true;
    } catch {
        return false;
    }
};

/** Called by a child guest at bootstrap: records its IPC target and flushes frames queued before it attached. */
const ipcAttach: CapabilityHandler = (args, ctx) => {
    const registry = registryFor(ctx);
    const pending = typeof args.token === 'string' ? registry.pending.get(args.token) : undefined;
    const record = registry.byPid.get(ctx.pid) ?? pending;
    if (!record) return null;
    registry.byPid.set(ctx.pid, record);
    record.pid = ctx.pid;
    record.ipcTarget = Number(args.targetId);
    for (const frame of record.queue.splice(0)) {
        deliverFrame(ctx, ctx.pid, record.ipcTarget, frame);
    }
    return null;
};

/** Child to parent: called from the child's guest (ctx is the child). */
const sendToParent: CapabilityHandler = (args, ctx) => {
    const record = registryFor(ctx).byPid.get(ctx.pid);
    if (!record || !record.connected) return false;
    const frame = args.frame;
    if (frame && frame.t === 'e') FAILED_WORKERS.add(record);
    later(() => record.parent.deliver(record.target, 'ev', { k: 'ipc', f: frame }));
    return true;
};

/** Parent to child: called from the parent's guest (ctx is the parent). */
const sendToChild: CapabilityHandler = (args, ctx) => {
    const record = registryFor(ctx).byPid.get(Number(args.pid));
    if (!record || record.exited || !record.connected || record.parent.pid !== ctx.pid) return false;
    if (record.ipcTarget === undefined || record.pid === undefined) {
        record.queue.push(args.frame);
        return true;
    }
    deliverFrame(ctx, record.pid, record.ipcTarget, args.frame);
    return true;
};

/** Parent closes the channel to one child. */
const disconnectChild: CapabilityHandler = (args, ctx) => {
    const record = registryFor(ctx).byPid.get(Number(args.pid));
    if (!record || record.exited || !record.connected || record.parent.pid !== ctx.pid) return false;
    record.connected = false;
    const frame = { t: 'd' };
    if (record.ipcTarget === undefined || record.pid === undefined) {
        record.queue.push(frame);
    } else {
        deliverFrame(ctx, record.pid, record.ipcTarget, frame);
    }
    return true;
};

/** Child closes its own channel; the parent is told so its ChildProcess emits 'disconnect'. */
const disconnectSelf: CapabilityHandler = (_args, ctx) => {
    const record = registryFor(ctx).byPid.get(ctx.pid);
    if (!record || !record.connected) return false;
    record.connected = false;
    later(() => record.parent.deliver(record.target, 'ev', { k: 'ipcdown' }));
    return true;
};

/** Parent guest is exiting: worker threads are terminated, and IPC children are disconnected, as Node does. */
const parentExit: CapabilityHandler = (_args, ctx) => {
    for (const record of registryFor(ctx).byPid.values()) {
        if (record.parent.pid !== ctx.pid || record.exited || !record.process) continue;
        if (record.kind === 'worker') {
            if (record.process.state === ProcessState.RUNNING) {
                record.killSignal = 'SIGTERM';
                void record.process.terminate();
            }
        } else if (record.connected && record.ipcTarget !== undefined && record.pid !== undefined) {
            record.connected = false;
            deliverFrame(ctx, record.pid, record.ipcTarget, { t: 'd' });
        }
    }
    return null;
};

/*
 * Synchronous family (spawnSync, execSync, execFileSync). child.spawnSync runs the child to completion inside this
 * call (NodeProcess.runToCompletionSync, pump.ts). A node child is a NodeProcess. The container's shell is
 * asynchronous end to end (ShellProcess and Shell await every command), so `sh` runs through shellLine below: the
 * dispatch of ShellProcess.executeCommand and the built-ins of Shell, as synchronous code. A child that waits on
 * asynchronous host work (network, a grandchild, a promise-returning capability) cannot be stepped here: the call
 * fails with ERR_NOT_SUPPORTED and keeps the output written so far.
 */

/** process.argv[0] of every node child: `node` in a shell command and the container's node binary both resolve to it. */
const NODE_BINARY = '/usr/local/bin/node';

/** Pids of synchronous children, counted apart from the container's own process pids. */
let nextSyncPid = 61000;

interface SyncErrorInfo {
    code: string;
    message: string;
    errno?: number;
    syscall?: string;
    path?: string;
    spawnargs?: string[];
}

/** What child.spawnSync returns; the guest shapes it into the SpawnSyncReturns object Node gives. */
interface SyncOutcome {
    pid: number;
    spawned: boolean;
    status: number | null;
    signal: string | null;
    stdout: string | null;
    stderr: string | null;
    error: SyncErrorInfo | null;
}

/** One run of an executable to completion: the pid, status, signal and output the child left. */
type SyncRun = SyncChildResult & { pid: number };

interface ShellStep {
    stdout: string;
    stderr: string;
    exitCode: number;
}

/** A step that produced nothing, for the paths that run no command at all. */
const EMPTY_STEP: ShellStep = { stdout: '', stderr: '', exitCode: 0 };

interface SyncShell {
    ctx: CapabilityContext;
    cwd: string;
    env: Record<string, string>;
    input: string | null;
    /** `$0`: the name the shell was started as (`sh`, `/bin/sh`). */
    name?: string;
    /** `$?`: written by shellLine after every command, read by every expansion. */
    lastStatus: number;
    /** The state the builtins of `builtins.ts` share for this line: variables, aliases, the directory stack. */
    state?: ShellState;
    /** Set when a builtin ended the shell (`exec`, or an `exit` inside `eval`): no later command runs. */
    stopped?: boolean;
    /** The background jobs of this line: `cmd &` adds one, `jobs` lists them and `wait` runs them. */
    jobs?: ShellJob[];
}

/**
 * One command started with `&`.
 *
 * The guest runs as one synchronous call on the host, so nothing can run alongside the shell: a job
 * is *started* only in the sense that the shell no longer waits for it -- its words are kept here
 * and run either by `wait`, or when the line's own foreground commands are through. It is never
 * dropped, and it never waits on host work that cannot finish inside the call: a job that would
 * block fails with the same ERR_NOT_SUPPORTED the foreground path gives.
 */
interface ShellJob {
    /** The number `jobs` prints in `[1]`, and `%1` names. */
    id: number;
    /** The pid `&` prints and `$!` holds. */
    pid: number;
    /** The command as it was written, for `jobs`. */
    text: string;
    /** The pipeline to run, its `|` already split out. */
    stages: RawWord[][];
    /** Run to completion: `wait` no longer has anything to wait for. */
    done: boolean;
    /** The status it left, once it has run. */
    exitCode: number;
}

/** Pids of background jobs, counted apart from the container's own processes and from sync children. */
let nextBackgroundPid = 62000;

/** The jobs of this shell, made on the first one. */
function jobsOf(shell: SyncShell): ShellJob[] {
    return (shell.jobs ??= []);
}

const SHELL_BUILTINS = new Set(['echo', 'cat', 'pwd', 'ls', 'mkdir', 'rm', 'rmdir', 'touch', 'cd', 'cp', 'mv', 'true', 'false']);
const SHELL_EXTERNALS = new Set(['curl', 'unzip', 'wget', 'npm', 'npx']);

/**
 * Every command the modules under shell/commands provide, merged once at load. The order is the
 * order the modules are tried: a name the container cannot have at all is last, so the reason in
 * `UNSUPPORTED` wins over a same-named handler elsewhere (`man`, `open`, `xclip`).
 */
const SHELL_MODULE_COMMANDS: Record<string, ShellCommand> = {
    ...TEXT_UTILS,
    ...FILE_UTILS,
    ...ARCHIVES,
    ...PROC_INFO,
    ...SHELL_BUILTIN_UTILS,
    ...UNSUPPORTED_UTILS,
    ...UNSUPPORTED_COMMANDS
};

/** The names `builtins.ts` implements. Kept apart so their one state-carrying entry point is used. */
const SHELL_BUILTIN_NAMES: Set<string> = new Set(Object.keys(SHELL_BUILTIN_UTILS));

/**
 * The callback `builtins.ts` runs a command it does not implement itself through: `command X`,
 * `builtin echo`, `env FOO=1 cmd`, and every simple command of `eval`, `exec` and `source`. It is
 * this dispatcher's own `shellCommand`, so a command reached from inside a builtin behaves exactly
 * as it does typed on the line. Installed once, at load: one runtime, one dispatcher.
 */
setRunner((state, words, input) => {
    const shell = state.host as SyncShell | undefined;
    if (shell === undefined) return { stdout: '', stderr: `Command not found: ${words[0] ?? ''}`, exitCode: 127 };
    const saved = shell.input;
    shell.input = input;
    try {
        return shellCommand(shell, words);
    } finally {
        shell.input = saved;
    }
});

/**
 * The file system a module command reads and writes through.
 *
 * `atPath` in shell/commands/types.ts resolves a relative path with `fs.resolvePath(path, cwd)`, and
 * the container's own implementation answers a relative path from the file system root rather than
 * from the base it is given: `resolvePath('users.txt', '/work')` is `/users.txt`. Neither the modules
 * nor types.ts may be changed, so the dispatcher hands them a view whose `resolvePath` joins against
 * the base, as the interface describes. Every other method is the container's own untouched, no
 * argument is rewritten before the handler sees it, and the join removes nothing: a name is written
 * to the file system exactly as the handler formed it, `..` included, so a module that refuses a
 * traversal still refuses it.
 */
function fsForModules(fs: IFileSystem, cwdOf: () => string): IFileSystem {
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

/** The context a module command is called with: the shell's own directory, environment and input. */
function moduleContext(shell: SyncShell, args: string[]): CommandContext {
    return {
        args,
        cwd: shell.cwd,
        env: shell.env,
        input: shell.input,
        fs: fsForModules(shell.ctx.fileSystem, () => shell.cwd)
    };
}

/**
 * The state a line's builtins share, created on the first builtin that needs one and kept on the
 * shell for the rest of the line, so `export FOO=bar; declare -p FOO` behaves as it does in one
 * shell. `host` is the module's free slot for the host: the runner installed above reads the shell
 * back out of it.
 */
function shellStateFor(shell: SyncShell): ShellState {
    let state = shell.state;
    if (state === undefined) {
        state = createShellState(shell.env, shell.cwd, fsForModules(shell.ctx.fileSystem, () => shell.cwd));
        state.host = shell;
        // The engine (builtins.ts) cannot start a job itself without importing the capability layer, so
        // a lone `&` inside a compound command is registered through this callback. Returning null makes
        // the engine run the pipeline in the foreground rather than invent a job.
        state.startJob = (_state: ShellState, source: string) => {
            const segment = splitCommandList(source)[0];
            if (segment === undefined) return null;
            const stages = splitPipeline(segment.words);
            if (stages === null) return null;
            startBackgroundJob(shell, stages);
            const jobs = jobsOf(shell);
            return jobs.length === 0 ? null : jobs[jobs.length - 1];
        };
        if (shell.name !== undefined) state.shellName = shell.name;
        shell.state = state;
    }
    // `cd` moves the shell's directory; `pushd` moves the state's. The two are one directory.
    state.cwd = shell.cwd;
    return state;
}

/**
 * `builtins.ts` binds one state at a time for the contexts a host builds itself (`setActiveState`).
 * The previous one is restored afterwards, so a shell nested inside this one (a node child running
 * `sh` synchronously) gets its own back.
 */
let activeShellState: ShellState | null = null;

function withShellState<T>(state: ShellState, body: () => T): T {
    const saved = activeShellState;
    activeShellState = state;
    setActiveState(state);
    try {
        return body();
    } finally {
        activeShellState = saved;
        setActiveState(saved);
    }
}

/** Carries the builtins' exported variables into the environment the other commands of the line run with. */
function syncShellEnv(shell: SyncShell, state: ShellState): void {
    const exported = state.env;
    for (const name of Object.keys(shell.env)) if (!(name in exported)) delete shell.env[name];
    for (const name of Object.keys(exported)) shell.env[name] = exported[name];
}

/** `exec` and an `exit` inside `eval` leave the script engine as a thrown signal, not a result. */
function signalName(error: unknown): string {
    return (error as { constructor?: { name?: string } } | null | undefined)?.constructor?.name ?? '';
}

/**
 * One command out of `builtins.ts`. The handler is the module's own and is called with the ordinary
 * module context; three things the other modules do not need are handled here.
 *
 *  - the state: bound for the duration of the call, and written back to the shell afterwards, so
 *    the directory and the exported environment a builtin changed are what the next command sees;
 *  - the module's output sink: a builtin may write with `writeOut`/`writeErr` instead of returning
 *    (`type`, `alias`, `unalias`, `hash`, `wait`), so `state.io` is collected around the call and
 *    joined to what the handler returned;
 *  - the script engine's signals: `exec`, and an `exit` inside `eval`, end the line as they end a
 *    shell, and carry their status with them.
 */
function shellBuiltinModule(shell: SyncShell, command: string, args: string[]): ShellStep {
    // `exec 3>&1` names no command to replace the shell with. Saying it is not supported is true;
    // running it would search for a utility called `3>&1` and report a command that does exist.
    if (command === 'exec' && args.length > 0 && /^[0-9]*(>>?|<<<?|&)/.test(args[0])) {
        return { stdout: '', stderr: `exec: ${args.join(' ')}: a redirection with no command is not supported on this runtime`, exitCode: 1 };
    }
    const handler = SHELL_BUILTIN_UTILS[command];
    const state = shellStateFor(shell);
    const savedIo = state.io;
    const savedBuffer = state.inputBuffer;
    const savedCursor = state.inputCursor;
    // `read` and `mapfile` take their lines out of the state's buffer, not out of the context
    state.inputBuffer = shell.input ?? '';
    state.inputCursor = 0;
    state.io = { stdout: '', stderr: '' };
    try {
        return withShellState(state, () => {
            let step: ShellStep;
            try {
                const result = handler(moduleContext(shell, args));
                step = {
                    stdout: state.io.stdout + result.stdout,
                    stderr: state.io.stderr + result.stderr,
                    exitCode: result.exitCode
                };
            } catch (error) {
                if (isNotSupported(error)) throw error;
                const name = signalName(error);
                const code = (error as { code?: unknown } | null | undefined)?.code;
                if (name === 'ExitSignal' || name === 'ReturnSignal') {
                    shell.stopped = true;
                    step = { stdout: state.io.stdout, stderr: state.io.stderr, exitCode: typeof code === 'number' ? code : 0 };
                } else if (name === 'BreakSignal' || name === 'ContinueSignal') {
                    step = { stdout: state.io.stdout, stderr: state.io.stderr, exitCode: 0 };
                } else {
                    step = {
                        stdout: state.io.stdout,
                        stderr: state.io.stderr + (error instanceof Error ? error.message : String(error)),
                        exitCode: 1
                    };
                }
            } finally {
                if (state.execTarget !== null) shell.stopped = true;
                shell.cwd = state.cwd;
                syncShellEnv(shell, state);
            }
            return step;
        });
    } finally {
        state.io = savedIo;
        state.inputBuffer = savedBuffer;
        state.inputCursor = savedCursor;
    }
}

/**
 * One command out of a shell command module, or null when the name belongs to no module. The module
 * resolves its own paths from `cwd`, so nothing here normalises an argument: `archives.ts` refuses
 * a `..` member rather than rewriting it, and rewriting before the call would undo that.
 */
function shellModuleCommand(shell: SyncShell, command: string, args: string[]): ShellStep | null {
    // builtins.ts keeps state between commands, so it is reached through its own entry point
    if (SHELL_BUILTIN_NAMES.has(command)) return shellBuiltinModule(shell, command, args);
    const handler = SHELL_MODULE_COMMANDS[command];
    if (handler === undefined) return null;
    try {
        const result: CommandResult = handler(moduleContext(shell, args));
        return { stdout: result.stdout, stderr: diagnostic(result.stderr), exitCode: result.exitCode };
    } catch (error) {
        if (isNotSupported(error)) throw error;
        return { stdout: '', stderr: diagnostic(error instanceof Error ? error.message : String(error)), exitCode: 1 };
    }
}

function notSupportedSync(what: string): Error {
    return Object.assign(
        new Error(`child_process: ${what} cannot run inside a synchronous call on this runtime; use the asynchronous API`),
        { code: 'ERR_NOT_SUPPORTED' }
    );
}

function isNotSupported(error: unknown): boolean {
    return (error as { code?: unknown } | null | undefined)?.code === 'ERR_NOT_SUPPORTED';
}

/** The error a failed spawn reports, named the way spawnSync names it. */
function syncSpawnError(error: unknown, file: string, argv: string[]): SyncErrorInfo {
    if (isNotSupported(error)) {
        return { code: 'ERR_NOT_SUPPORTED', message: (error as Error).message };
    }
    const failure = spawnFailure(error, file, argv) as Error & { code?: string };
    if (failure.code === 'ENOENT') {
        return { code: 'ENOENT', message: `spawnSync ${file} ENOENT`, errno: -2, syscall: `spawnSync ${file}`, path: file, spawnargs: argv };
    }
    return { code: String(failure.code), message: failure.message, syscall: `spawnSync ${file}`, path: file, spawnargs: argv };
}

/** The file and arguments a node command runs, as NodeProcessExecutor reads them. */
function nodeInvocation(argv: string[]): { file: string; args: string[]; evalSource?: string } {
    if (argv.length === 0) throw new Error('No JavaScript file specified');
    if (argv[0] === '-e' || argv[0] === '--eval') {
        if (argv.length < 2) throw new Error(`${argv[0]} requires an argument`);
        return { file: '[eval]', args: argv.slice(2), evalSource: argv[1] };
    }
    if (argv[0] === '-p' || argv[0] === '--print') {
        if (argv.length < 2) throw new Error(`${argv[0]} requires an argument`);
        return { file: '[eval]', args: argv.slice(2), evalSource: printEvalSource(argv[1]) };
    }
    return { file: argv[0], args: argv.slice(1) };
}

/** One node child run to completion. The caller decides what a blocked or timed-out run means. */
function nodeRun(
    ctx: CapabilityContext,
    invocation: { file: string; args: string[]; evalSource?: string },
    env: Record<string, string>,
    cwd: string,
    timeoutMs: number,
    killSignal: string
): SyncChildResult & { pid: number } {
    const runner = nodeSyncRunner.run;
    if (runner === undefined) throw notSupportedSync('a node child');
    const pid = nextSyncPid++;
    const result = runner({
        pid,
        parentPid: ctx.pid,
        file: invocation.file,
        args: invocation.args,
        cwd,
        env,
        evalSource: invocation.evalSource,
        fileSystem: ctx.fileSystem,
        services: ctx.services,
        timeoutMs,
        killSignal
    });
    return { pid, ...result };
}

function shellPath(shell: SyncShell, path: string): string {
    const joined = path.startsWith('/') ? path : `${shell.cwd}/${path}`.replace(/\/+/g, '/');
    // `cd ./sub` leaves the shell in `/work/sub`, not in `/work/./sub`
    const parts = joined.split('/').filter((part) => part !== '' && part !== '.');
    return '/' + parts.join('/');
}

/** A node command inside the shell: its status and output become the shell command's. */
function shellNode(shell: SyncShell, invocation: { file: string; args: string[]; evalSource?: string }): ShellStep {
    const run = nodeRun(shell.ctx, invocation, shell.env, shell.cwd, 0, 'SIGTERM');
    if (run.blocked !== undefined) throw notSupportedSync(`the shell command ${invocation.file}, which waits on ${run.blocked}`);
    return { stdout: run.stdout, stderr: run.stderr, exitCode: run.status ?? 1 };
}

/** Shell's built-ins with the output and status Shell.executeBuiltin gives them. */
function shellBuiltin(shell: SyncShell, command: string, args: string[]): ShellStep {
    const fs = shell.ctx.fileSystem;
    const at = (path: string) => shellPath(shell, path);
    const ok = (stdout = ''): ShellStep => ({ stdout, stderr: '', exitCode: 0 });
    const fail = (stderr: string): ShellStep => ({ stdout: '', stderr: diagnostic(stderr), exitCode: 1 });
    try {
        switch (command) {
            case 'echo':
                return ok(args.join(' ') + '\n');
            case 'true':
                return ok();
            case 'false':
                return fail('');
            case 'cat': {
                // no argument reads the child's input (Shell says 'No file specified'; Node reads stdin)
                if (args.length === 0) return ok(shell.input ?? '');
                let joined = '';
                let missing: string | null = null;
                for (const name of args) {
                    let content: string | undefined;
                    try {
                        content = fs.readFile(at(name));
                    } catch {
                        content = undefined;
                    }
                    if (content === undefined) missing ??= name;
                    else joined += content;
                }
                // as cat has it: the files it could read are written, the status is the failure
                return missing === null ? ok(joined) : { stdout: joined, stderr: diagnostic(`File not found: ${missing}`), exitCode: 1 };
            }
            case 'pwd':
                return ok(shell.cwd + '\n');
            case 'ls': {
                // A directory operand lists the names in it; a file operand -- every name `ls *.txt`
                // expands to -- prints its own name, as it does in a shell.
                const operands = args.filter((arg) => !arg.startsWith('-'));
                const names: string[] = [];
                if (operands.length === 0) {
                    names.push(...lsNames(fs, shell.cwd));
                } else {
                    for (const operand of operands) {
                        const path = at(operand);
                        if (isDirectory(fs, path)) names.push(...lsNames(fs, path));
                        else if (fs.fileExists(path)) names.push(operand);
                        else return { stdout: '', stderr: diagnostic(`ls: ${operand}: No such file or directory`), exitCode: 2 };
                    }
                }
                return ok(names.length > 0 ? names.join('\n') + '\n' : '');
            }
            case 'mkdir':
                if (args.length === 0) return fail('No directory specified');
                fs.createDirectory(at(args[0]));
                return ok();
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
                shell.cwd = next;
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

/** Shell.execute: `>` and `>>` in a built-in's words write its output to files when it succeeds. */
function shellBuiltinWithRedirects(shell: SyncShell, command: string, args: string[]): ShellStep {
    const words: string[] = [];
    const redirects: { type: '>' | '>>'; file: string }[] = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '>' || args[i] === '>>') {
            if (i + 1 >= args.length) return { stdout: '', stderr: `Syntax error: missing file for redirection ${args[i]}`, exitCode: 2 };
            redirects.push({ type: args[i] as '>' | '>>', file: args[i + 1] });
            i++;
        } else {
            words.push(args[i]);
        }
    }
    const step = shellBuiltin(shell, command, words);
    if (step.exitCode !== 0 || redirects.length === 0) return step;
    for (const redirect of redirects) {
        try {
            const file = shellPath(shell, redirect.file);
            const fs = shell.ctx.fileSystem;
            fs.writeFile(file, redirect.type === '>>' ? (fs.readFile(file) || '') + step.stdout : step.stdout);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { stdout: '', stderr: `Failed to redirect to ${redirect.file}: ${message}`, exitCode: 1 };
        }
    }
    return { stdout: '', stderr: '', exitCode: 0 };
}

/** One command of a command line, and the operator that joins it to the command before it. */
interface ShellSegment {
    words: RawWord[];
    op: ';' | '&&' | '||' | null;
    /** Ended by a trailing `&`: started as a background job, and `$?` after it is 0 whatever it leaves. */
    background: boolean;
}

/**
 * Splits a command line on `;`, `&&`, `||` and a lone `&`. A quoted run holds an operator, so it is
 * copied whole. A trailing operator leaves a final segment with no command, which the runner skips.
 */
function splitCommandList(line: string): ShellSegment[] {
    const segments: ShellSegment[] = [];
    let text = '';
    let op: ';' | '&&' | '||' | null = null;
    const push = (background = false): void => {
        const words = tokenizeLine(text);
        if (words.length > 0) segments.push({ words, op, background });
        text = '';
    };
    let i = 0;
    while (i < line.length) {
        const ch = line[i];
        if (ch === '\\') {
            text += line.slice(i, i + 2);
            i += 2;
        } else if (ch === "'" || ch === '"') {
            // a quoted run holds an operator, so it is copied whole
            let end = i + 1;
            while (end < line.length && line[end] !== ch) {
                const span = ch === '"' ? constructSpan(line, end) : -1;
                if (span !== -1) {
                    end = span;
                    continue;
                }
                end += ch === '"' && line[end] === '\\' ? 2 : 1;
            }
            text += line.slice(i, Math.min(end + 1, line.length));
            i = end + 1;
        } else if (ch === ';' || ch === '\n') {
            // a newline separates commands as `;` does, which is what makes a comment end there
            push();
            op = ';';
            i++;
        } else if ((ch === '&' || ch === '|') && line[i + 1] === ch) {
            push();
            op = ch === '&' ? '&&' : '||';
            i += 2;
        } else if (ch === '&' && isBackgroundAmp(line, i)) {
            // a lone & ends the command before it and starts it in the background; what follows runs
            // whatever that command leaves, so it joins the next one the way `;` does
            push(true);
            op = ';';
            i++;
        } else {
            // a `$( )` or backquoted construct holds an operator too
            const span = constructSpan(line, i);
            if (span !== -1) {
                text += line.slice(i, span);
                i = span;
                continue;
            }
            // a lone & (a background job) is not split out of the text here: `2>&1` and `>&2` hold
            // one too, so it is recognised as a word after tokenizing, where the quoting is known.
            // A lone | is left in the words here and splits the command into a pipeline in
            // splitPipeline
            text += ch;
            i++;
        }
    }
    push();
    return segments;
}

/**
 * `#` starts a comment where it begins a word: everything from there to the end of the line is
 * dropped, the operators in it included, so `echo a # b; c` runs one command. Inside quotes, and
 * after a backslash, it is an ordinary character.
 */
function stripComment(line: string): string {
    let text = line;
    let atWordStart = true;
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '\\') {
            i += 2;
            atWordStart = false;
            continue;
        }
        if (ch === "'" || ch === '"') {
            const close = findQuoteClose(text, i, ch);
            const stop = close === -1 ? text.length : close + 1;
            i = stop;
            atWordStart = false;
            continue;
        }
        // a comment ends at the next newline, not at the end of the line: `a # c` + newline + `b`
        if (ch === '#' && atWordStart) {
            const nl = text.indexOf('\n', i);
            text = nl === -1 ? text.slice(0, i) : text.slice(0, i) + text.slice(nl);
            continue;
        }
        const span = constructSpan(text, i);
        if (span !== -1) {
            i = span;
            atWordStart = false;
            continue;
        }
        atWordStart = ch === ' ' || ch === '\t' || ch === '\n' || ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === ')';
        i++;
    }
    return text;
}

/** The index of the `quote` closing the one at `start`, or -1 when the line ends first. */
function findQuoteClose(text: string, start: number, quote: string): number {
    let i = start + 1;
    while (i < text.length) {
        const ch = text[i];
        if (quote === '"' && ch === '\\') {
            i += 2;
            continue;
        }
        if (ch === quote) return i;
        i++;
    }
    return -1;
}

/**
 * A line the shell cannot even parse: a quote, a `$( `, a `${ ` or a backquote that is never closed
 * anywhere on it. `tokenizeLine` would quietly close all four at the end of the line and print the
 * text; the host reports a syntax error and exits 2, which is what this returns.
 */
function syntaxErrorOf(line: string): string | null {
    let i = 0;
    while (i < line.length) {
        const ch = line[i];
        if (ch === '\\') {
            i += 2;
            continue;
        }
        if (ch === "'" || ch === '"') {
            const close = findQuoteClose(line, i, ch);
            if (close === -1) return `Syntax error: unexpected EOF while looking for matching ${ch === "'" ? "`''" : "`\"'"}`;
            i = close + 1;
            continue;
        }
        if (ch === '`') {
            const end = findBacktick(line, i + 1);
            if (end === -1) return 'Syntax error: unexpected EOF while looking for matching `` ` ``';
            i = end + 1;
            continue;
        }
        if (ch === '$' && line[i + 1] === '(') {
            const arithmetic = line[i + 2] === '(';
            const end = arithmetic ? matchArithmetic(line, i + 2) : matchParen(line, i + 1);
            if (end === -1) return 'Syntax error: unexpected EOF while looking for matching `)\'';
            i = end + 1;
            continue;
        }
        if (ch === '$' && line[i + 1] === '{') {
            const end = matchBrace(line, i + 1);
            if (end === -1) return 'Syntax error: unexpected EOF while looking for matching `}\'';
            i = end + 1;
            continue;
        }
        i++;
    }
    return null;
}

/**
 * The words a line has to be handed to the script engine of `builtins.ts` for: the reserved words
 * that open a compound command (`if`, `for`, `while`, `until`, `case`, `{ }`, `( )`) and a function
 * definition. Only the *first* word of a segment is looked at, so `echo {` and `find . -name "*.txt"`
 * keep going through this dispatcher: there, `{` is an argument and the parser would expand the glob.
 */
const COMPOUND_KEYWORDS = new Set(['if', 'for', 'while', 'until', 'case', 'select']);
/** `g()`, `f(){ ... }` and the same written with no space: a function definition. */
const FUNCTION_DEFINITION = /^[A-Za-z_][A-Za-z0-9_]*\(\)/;
const NAME_WORD = /^[A-Za-z_][A-Za-z0-9_]*$/;

function startsCompound(segment: ShellSegment): boolean {
    const words = segment.words;
    if (words.length === 0) return false;
    const first = rawText(words[0]);
    if (COMPOUND_KEYWORDS.has(first)) return true;
    // `(echo hi)` and `{ echo a; }` are written with the brace or the parenthesis against the command
    if (/^[({]/.test(first)) return true;
    if (FUNCTION_DEFINITION.test(first)) return true;
    // `g () { ... }`: the name, then the parenthesis as a word of its own (`g ()` gives `()`)
    return NAME_WORD.test(first) && words.length > 1 && /^\(/.test(rawText(words[1]));
}

/* ----------------------------------------------------------------------------------------------
 * Parameter expansion
 *
 * The words a command line is made of are kept as *parts* rather than strings, because a shell has
 * to remember which characters came from where: `$x` expands whether or not it is quoted, but only
 * an unquoted expansion is split into fields, and a single-quoted `$x` does not expand at all.
 * Tokenizing records that; expanding reads it back.
 * -------------------------------------------------------------------------------------------- */

/** One piece of a word. `expand`: `$` in this text is expanded. `split`: the result is field-split. */
interface ShellPart {
    text: string;
    expand: boolean;
    split: boolean;
}

/** A word as it was written: the pieces it is made of, in order. */
type RawWord = ShellPart[];

/** The index just past a `$( )`, `${ }` or backquoted construct starting at `i`, or -1 when it is not closed. */
function constructSpan(text: string, i: number): number {
    if (text[i] === '`') {
        const end = findBacktick(text, i + 1);
        return end === -1 ? -1 : end + 1;
    }
    if (text[i] === '$' && text[i + 1] === '(') {
        const end = matchParen(text, i + 1);
        return end === -1 ? -1 : end + 1;
    }
    if (text[i] === '$' && text[i + 1] === '{') {
        const end = matchBrace(text, i + 1);
        return end === -1 ? -1 : end + 1;
    }
    return -1;
}

/**
 * Splits a command line into words the way a POSIX shell quotes them: single quotes keep everything,
 * double quotes keep everything except \" \\ \$ \` and an escaped newline, a bare backslash escapes
 * the next character, and adjacent quoted or plain pieces make one word. No expansion is done.
 *
 * A `$( )`, `${ }` or backquoted construct is one piece whatever it holds, so the white space, the
 * operators and the escaped `$` inside it never split the word or the line.
 */
function tokenizeLine(line: string): RawWord[] {
    const words: RawWord[] = [];
    let word: RawWord = [];
    let inWord = false;
    const push = (text: string, expand: boolean, split: boolean): void => {
        if (text === '') return;
        const last = word[word.length - 1];
        if (last !== undefined && last.expand === expand && last.split === split) last.text += text;
        else word.push({ text, expand, split });
        inWord = true;
    };
    const flush = (): void => {
        if (inWord) {
            words.push(word);
            word = [];
            inWord = false;
        }
    };
    let i = 0;
    while (i < line.length) {
        const ch = line[i];
        if (ch === ' ' || ch === '\t' || ch === '\n') {
            flush();
            i++;
        } else if (ch === "'") {
            const close = line.indexOf("'", i + 1);
            const stop = close === -1 ? line.length : close;
            push(line.slice(i + 1, stop), false, false);
            i = stop + 1;
        } else if (ch === '"') {
            inWord = true;
            i++;
            while (i < line.length && line[i] !== '"') {
                const next = line[i + 1];
                const span = constructSpan(line, i);
                if (span !== -1) {
                    push(line.slice(i, span), true, false);
                    i = span;
                    continue;
                }
                if (line[i] === '\\' && next !== undefined && '"\\$`\n'.includes(next)) {
                    if (next !== '\n') push(next, false, false);
                    i += 2;
                } else {
                    push(line[i], true, false);
                    i++;
                }
            }
            i++;
        } else if (ch === '\\') {
            const next = line[i + 1];
            if (next !== undefined && next !== '\n') push(next, false, false);
            i += 2;
        } else {
            const span = constructSpan(line, i);
            if (span !== -1) {
                push(line.slice(i, span), true, true);
                i = span;
            } else {
                push(ch, true, true);
                i++;
            }
        }
    }
    flush();
    return words;
}

/** The word as it was written, before any expansion. */
function rawText(word: RawWord): string {
    return word.map((part) => part.text).join('');
}

/** True when the word is one unquoted piece of exactly `text`: an unquoted `|`, `<` or `2>&1`. */
function rawIs(word: RawWord, text: string): boolean {
    return word.length === 1 && word[0].expand && word[0].text === text;
}

/**
 * True for the `&` at `i`, which ends a command in the background. One that belongs to a redirection
 * is not one: `2>&1` and `>&2` write it next to a `>`, and `&>file` opens with it. Neither is a `&&`,
 * which the branch above has already taken. A quoted run, a `$( )`, a `${ }` and a backquoted
 * construct are copied whole before this is ever reached, so the `&` one of those holds is safe.
 */
function isBackgroundAmp(line: string, i: number): boolean {
    const before = line[i - 1];
    const after = line[i + 1];
    if (after === '>' || after === '<') return false;
    return before !== '>' && before !== '<';
}

/** What a word expands to: `text` plus `split` (field splitting applies) and, for `"$@"`, the field boundary. */
interface ExpandAtom {
    text: string;
    split: boolean;
    /** The text came out of an unquoted piece, so pathname expansion applies to it. */
    glob: boolean;
    /** The field before this one ends here. */
    before?: boolean;
    /** This field ends here, even where the next piece would otherwise join it. */
    after?: boolean;
}

/** One field of a word after expansion, and whether pathname expansion may still rewrite it. */
interface ExpandedField {
    text: string;
    glob: boolean;
}

/** Where one expansion reports an error (`${x:?}`) and the status of a command substitution. */
interface ExpandCtx {
    error: string | null;
    code: number;
    substStatus: number | null;
}

/** `IFS` is the default one; only its white space is split on. */
const IFS_SPLIT = /[ \t\n]+/;

/** A leading `NAME=` turns a word into an assignment rather than a command. */
const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/;

function positionalOf(shell: SyncShell): string[] {
    return shell.state?.positional ?? [];
}

/** `$name`: the shell's own variables first, then the environment the line started with. */
function lookupVar(shell: SyncShell, name: string): string | undefined {
    const state = shell.state;
    if (state !== undefined) {
        for (let i = state.scopes.length - 1; i >= 0; i--) {
            const found = state.scopes[i].get(name);
            if (found !== undefined) return found.value;
        }
    }
    const value = shell.env[name];
    return typeof value === 'string' ? value : undefined;
}

function isSetVar(shell: SyncShell, name: string): boolean {
    if ('?0#$!-@*'.includes(name)) return true;
    if (/^[0-9]+$/.test(name)) return Number(name) <= positionalOf(shell).length;
    return lookupVar(shell, name) !== undefined;
}

/** The value of one parameter, special names included; `$@` and `$*` are handled by parameterAtoms. */
function valueOfName(shell: SyncShell, name: string): string {
    switch (name) {
        case '?':
            return String(shell.lastStatus);
        case '0':
            return shell.name ?? shell.state?.shellName ?? 'sh';
        case '#':
            return String(positionalOf(shell).length);
        case '$':
            return '1';
        // `$!`: the pid the last `&` printed, now that this shell starts background jobs
        case '!':
            return String(shell.state?.lastBackgroundPid ?? 0);
        case '-':
            return '';
        default:
            break;
    }
    if (/^[1-9][0-9]*$/.test(name)) return positionalOf(shell)[Number(name) - 1] ?? '';
    return lookupVar(shell, name) ?? '';
}

/**
 * `$@` and `$*` are the two that are not one string. `"$@"` is one field per positional parameter,
 * and `$*` in quotes is one field with them joined; unquoted, the two behave alike and are split.
 */
function parameterAtoms(shell: SyncShell, name: string, split: boolean, out: ExpandAtom[]): void {
    const params = positionalOf(shell);
    if (!split && name === '@') {
        for (let i = 0; i < params.length; i++) {
            out.push({ text: params[i], split: false, glob: false, before: i > 0, after: i < params.length - 1 });
        }
        return;
    }
    out.push({ text: params.join(' '), split, glob: split });
}

/**
 * `NAME=value` in the shell's own variables, and in the environment where it is already exported.
 * Returns the error of assigning to a read-only variable, which ends the line as it ends a shell.
 */
function assignVar(shell: SyncShell, name: string, value: string): string | null {
    const state = shellStateFor(shell);
    let existing: ShellVar | undefined;
    for (let i = state.scopes.length - 1; i >= 0; i--) {
        const found = state.scopes[i].get(name);
        if (found !== undefined) {
            existing = found;
            break;
        }
    }
    if (existing?.readonly === true) return `${name}: readonly variable`;
    const exported = existing?.export === true || (existing === undefined && Object.prototype.hasOwnProperty.call(shell.env, name));
    state.scopes[0].set(name, exported ? { value, export: true } : { value });
    if (exported) shell.env[name] = value;
    return null;
}

/**
 * Runs a `$( )` or backquoted script in a shell of its own and strips the trailing newlines, as a
 * shell does. The jobs it starts stay pending: what a substitution captures is what its own commands
 * wrote, and a job nobody has waited for has written nothing yet -- it runs when the line that holds
 * the substitution is through, so `$(jobs)` captures the list and not the output of the jobs in it.
 */
function runSubstitution(shell: SyncShell, script: string): { text: string; status: number } {
    const child: SyncShell = {
        ctx: shell.ctx,
        cwd: shell.cwd,
        env: { ...shell.env },
        input: shell.input,
        name: shell.name,
        lastStatus: shell.lastStatus,
        // one job table: a job a substitution started is the shell's own, and `wait` can wait for it
        jobs: shell.jobs,
        state: shell.state
    };
    const step = shellLine(child, script, true);
    // `cd` inside the substitution is the substitution's own, not the shell's
    if (child.state !== undefined) child.state.cwd = shell.cwd;
    return { text: step.stdout.replace(/\n+$/, ''), status: step.exitCode };
}

/** The index of the `)` closing the `(` at `start`, or -1 when it is never closed. */
function matchParen(text: string, start: number): number {
    let depth = 0;
    let i = start;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '\\') {
            i += 2;
        } else if (ch === "'") {
            const close = text.indexOf("'", i + 1);
            i = close === -1 ? text.length : close + 1;
        } else if (ch === '"') {
            i++;
            while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
            i++;
        } else if (ch === '(') {
            depth++;
            i++;
        } else if (ch === ')') {
            depth--;
            if (depth === 0) return i;
            i++;
        } else {
            i++;
        }
    }
    return -1;
}

/** The index of the final `)` of a `$(( ))`, or -1 when the expression is not closed. */
function matchArithmetic(text: string, start: number): number {
    const close = matchParen(text, start);
    return close !== -1 && text[close + 1] === ')' ? close + 1 : -1;
}

/** The index of the `}` closing the `{` at `start`, counting nested `${`. */
function matchBrace(text: string, start: number): number {
    let depth = 0;
    let i = start;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '\\') {
            i += 2;
        } else if (ch === '{') {
            depth++;
            i++;
        } else if (ch === '}') {
            depth--;
            if (depth === 0) return i;
            i++;
        } else {
            i++;
        }
    }
    return -1;
}

/** The index of the next unescaped backtick at or after `from`, or -1. */
function findBacktick(text: string, from: number): number {
    for (let i = from; i < text.length; i++) {
        if (text[i] === '\\') {
            i++;
            continue;
        }
        if (text[i] === '`') return i;
    }
    return -1;
}

/** Inside backquotes only `$`, `` ` `` and `\` may be escaped; every other backslash stays. */
function unescapeBacktick(text: string): string {
    let out = '';
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\\' && '$`\\'.includes(text[i + 1] ?? '')) {
            out += text[i + 1];
            i++;
        } else {
            out += text[i];
        }
    }
    return out;
}

/** A glob pattern as a regular expression: `*`, `?` and `[...]`, with `*` greedy when `greedy` is set. */
function patternRegExp(pattern: string, greedy: boolean): RegExp | null {
    let source = '';
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (ch === '\\') {
            source += escapeRegExp(pattern[i + 1] ?? '\\');
            i++;
        } else if (ch === '*') {
            source += greedy ? '(.*)' : '(.*?)';
        } else if (ch === '?') {
            source += '.';
        } else if (ch === '[') {
            let end = i + 1;
            if (pattern[end] === '!' || pattern[end] === '^') end++;
            if (pattern[end] === ']') end++;
            while (end < pattern.length && pattern[end] !== ']') end += pattern[end] === '\\' ? 2 : 1;
            if (end >= pattern.length) {
                source += '\\[';
            } else {
                let body = pattern.slice(i + 1, end);
                if (body.startsWith('!')) body = '^' + body.slice(1);
                source += '[' + body + ']';
                i = end;
            }
        } else {
            source += escapeRegExp(ch);
        }
    }
    try {
        return new RegExp(source);
    } catch {
        return null;
    }
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The parameter name at the start of the inside of a `${ }`. */
function parameterName(text: string): string | null {
    if (text === '') return null;
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text);
    if (name !== null) return name[0];
    const digits = /^[0-9]+/.exec(text);
    if (digits !== null) return digits[0];
    return '@*#?$!-'.includes(text[0]) ? text[0] : null;
}

/** The whole value of one piece of a word, with no field splitting: an assignment, a pattern, a redirect's file. */
function expandText(shell: SyncShell, text: string, ctx: ExpandCtx): string {
    const atoms: ExpandAtom[] = [];
    expandInto(shell, text, false, atoms, ctx);
    return atoms.map((atom) => atom.text).join('');
}

/** Expands one piece of a word into atoms. `split` says whether the result is subject to field splitting. */
function expandInto(shell: SyncShell, text: string, split: boolean, out: ExpandAtom[], ctx: ExpandCtx): void {
    let literal = '';
    let literalGlob = false;
    const flushLiteral = (): void => {
        if (literal !== '') {
            // a glob character only counts where it was written unquoted: `\*` is an ordinary `*`
            out.push({ text: literal, split, glob: split && literalGlob });
            literal = '';
            literalGlob = false;
        }
    };
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '\\') {
            const next = text[i + 1];
            if (next !== undefined && '$`\\"'.includes(next)) {
                literal += next;
                i += 2;
                continue;
            }
            literal += ch;
            i++;
            continue;
        }
        if (ch === '`') {
            const end = findBacktick(text, i + 1);
            if (end === -1) {
                literal += ch;
                i++;
                continue;
            }
            flushLiteral();
            const run = runSubstitution(shell, unescapeBacktick(text.slice(i + 1, end)));
            ctx.substStatus = run.status;
            out.push({ text: run.text, split, glob: split });
            i = end + 1;
            continue;
        }
        if (ch !== '$') {
            if (ch === '*' || ch === '?' || ch === '[') literalGlob = true;
            literal += ch;
            i++;
            continue;
        }
        const next = text[i + 1];
        if (next === '(' && text[i + 2] === '(') {
            const end = matchArithmetic(text, i + 2);
            if (end !== -1) {
                flushLiteral();
                const value = arithmeticValue(shell, text.slice(i + 3, end - 1));
                // `1/0`: an expansion error, which ends the line as it ends a shell
                if (value.error !== null) {
                    ctx.error = value.error;
                    ctx.code = 127;
                    return;
                }
                out.push({ text: value.text, split, glob: split });
                i = end + 1;
                continue;
            }
        }
        if (next === '(') {
            const end = matchParen(text, i + 1);
            if (end !== -1) {
                flushLiteral();
                const run = runSubstitution(shell, text.slice(i + 2, end));
                ctx.substStatus = run.status;
                out.push({ text: run.text, split, glob: split });
                i = end + 1;
                continue;
            }
        }
        if (next === '{') {
            const end = matchBrace(text, i + 1);
            if (end !== -1) {
                flushLiteral();
                const from = out.length;
                paramExpansion(shell, text.slice(i + 2, end), split, out, ctx);
                if (ctx.error !== null) return;
                for (let k = from; k < out.length; k++) out[k].glob = split;
                i = end + 1;
                continue;
            }
        }
        const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i + 1));
        if (name !== null) {
            flushLiteral();
            out.push({ text: valueOfName(shell, name[0]), split, glob: split });
            i += 1 + name[0].length;
            continue;
        }
        if (next !== undefined && '0123456789#@*?$!-'.includes(next)) {
            flushLiteral();
            if (next === '@' || next === '*') parameterAtoms(shell, next, split, out);
            else out.push({ text: valueOfName(shell, next), split, glob: split });
            i += 2;
            continue;
        }
        literal += ch;
        i++;
    }
    flushLiteral();
}

/** `$(( ))`. The expression is the module's own evaluator, so the operators are the ones it already has. */
function arithmeticValue(shell: SyncShell, expression: string): { text: string; error: string | null } {
    try {
        return { text: String(evalArith(shellStateFor(shell), expression)), error: null };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { text: '', error: `${expression}: ${message}` };
    }
}

/** One `${...}`: the operators POSIX has, plus `${x/p/r}` and `${x:o:l}`. */
function paramExpansion(shell: SyncShell, body: string, split: boolean, out: ExpandAtom[], ctx: ExpandCtx): void {
    const literal = (): void => {
        out.push({ text: '${' + body + '}', split: false, glob: false });
    };
    if (body.startsWith('#') && body.length > 1) {
        const name = parameterName(body.slice(1));
        if (name === null) return literal();
        const length = name === '@' || name === '*' ? positionalOf(shell).length : valueOfName(shell, name).length;
        out.push({ text: String(length), split, glob: split });
        return;
    }
    const name = parameterName(body);
    if (name === null) return literal();
    const rest = body.slice(name.length);
    const scalar = (): string => (name === '@' || name === '*' ? positionalOf(shell).join(' ') : valueOfName(shell, name));
    const set = isSetVar(shell, name);
    const empty = !set || scalar() === '';
    const word = (text: string): string => expandText(shell, text, ctx);
    if (rest === '') {
        if (name === '@' || name === '*') parameterAtoms(shell, name, split, out);
        else out.push({ text: valueOfName(shell, name), split, glob: split });
        return;
    }
    const substring = /^:(-?\d+)(?::(-?\d+))?$/.exec(rest);
    if (substring !== null) {
        const from = Number(substring[1]);
        const value = scalar().split('');
        const start = from < 0 ? Math.max(0, value.length + from) : from;
        const count = substring[2] === undefined ? undefined : Number(substring[2]);
        out.push({ text: (count === undefined ? value.slice(start) : count < 0 ? value.slice(start, value.length + count) : value.slice(start, start + count)).join(''), split, glob: split });
        return;
    }
    if (rest.startsWith(':-')) {
        out.push({ text: empty ? word(rest.slice(2)) : scalar(), split, glob: split });
        return;
    }
    if (rest.startsWith('-') && rest[1] !== '}') {
        out.push({ text: set ? scalar() : word(rest.slice(1)), split, glob: split });
        return;
    }
    if (rest.startsWith(':=') || rest.startsWith('=')) {
        const value = rest.startsWith(':=') ? rest.slice(2) : rest.slice(1);
        if (empty) {
            const assigned = word(value);
            const refused = assignVar(shell, name, assigned);
            if (refused !== null) {
                ctx.error = refused;
                ctx.code = 127;
                return;
            }
            out.push({ text: assigned, split, glob: split });
        } else {
            out.push({ text: scalar(), split, glob: split });
        }
        return;
    }
    if (rest.startsWith(':+')) {
        out.push({ text: empty ? '' : word(rest.slice(2)), split, glob: split });
        return;
    }
    if (rest.startsWith('+')) {
        out.push({ text: set ? word(rest.slice(1)) : '', split, glob: split });
        return;
    }
    if (rest.startsWith(':?') || rest.startsWith('?')) {
        const colon = rest.startsWith(':?');
        if (colon ? empty : !set) {
            const message = word(rest.slice(colon ? 2 : 1));
            ctx.error = `${name}: ${message === '' ? 'parameter null or not set' : message}`;
            ctx.code = 127;
        } else {
            out.push({ text: scalar(), split, glob: split });
        }
        return;
    }
    /**
     * `${x#p}` and `${x%p}`. A regular expression matches leftmost-first, which is the wrong
     * direction for a shell's shortest match, so the cut points are tried in the order the operator
     * means instead of being anchored: `#` takes the shortest matching prefix (the first cut from
     * the left), `##` the longest, `%` the shortest matching suffix (the first cut from the right)
     * and `%%` the longest. `${x%.*}` on `a.b.c` is `a.b`, not `a`.
     */
    const trimmed = (operator: '#' | '%', longest: boolean, pattern: string): string => {
        const source = scalar();
        const regexp = patternRegExp(pattern, true);
        if (regexp === null) return source;
        const whole = new RegExp('^(?:' + regexp.source + ')$');
        const cuts: number[] = [];
        if (operator === '#') {
            for (let j = 0; j <= source.length; j++) cuts.push(j);
            if (longest) cuts.reverse();
            for (const j of cuts) if (whole.test(source.slice(0, j))) return source.slice(j);
            return source;
        }
        for (let k = source.length; k >= 0; k--) cuts.push(k);
        if (longest) cuts.reverse();
        for (const k of cuts) if (whole.test(source.slice(k))) return source.slice(0, k);
        return source;
    };
    if (rest.startsWith('##')) {
        out.push({ text: trimmed('#', true, word(rest.slice(2))), split, glob: split });
        return;
    }
    if (rest.startsWith('#')) {
        out.push({ text: trimmed('#', false, word(rest.slice(1))), split, glob: split });
        return;
    }
    if (rest.startsWith('%%')) {
        out.push({ text: trimmed('%', true, word(rest.slice(2))), split, glob: split });
        return;
    }
    if (rest.startsWith('%')) {
        out.push({ text: trimmed('%', false, word(rest.slice(1))), split, glob: split });
        return;
    }
    if (rest.startsWith('/')) {
        const every = rest.startsWith('//');
        let rest2 = rest.slice(every ? 2 : 1);
        let anchor = '';
        if (rest2.startsWith('#')) {
            anchor = '^';
            rest2 = rest2.slice(1);
        } else if (rest2.startsWith('%')) {
            anchor = '$';
            rest2 = rest2.slice(1);
        }
        let at = -1;
        for (let i = 0; i < rest2.length; i++) {
            if (rest2[i] === '\\') {
                i++;
                continue;
            }
            if (rest2[i] === '/') {
                at = i;
                break;
            }
        }
        const pattern = word(at === -1 ? rest2 : rest2.slice(0, at));
        const replacement = word(at === -1 ? '' : rest2.slice(at + 1));
        const regexp = patternRegExp(pattern, false);
        if (regexp === null) {
            out.push({ text: scalar(), split, glob: split });
            return;
        }
        const source = scalar();
        const flags = every ? 'g' : '';
        out.push({ text: source.replace(new RegExp(anchor + regexp.source, flags), replacement.replace(/\$/g, '$$')), split, glob: split });
        return;
    }
    literal();
}

/**
 * One word's worth of fields. Field splitting happens here and only here: a run of white space that
 * came out of an unquoted expansion ends the field, and an empty unquoted expansion leaves none.
 */
function assembleFields(atoms: ExpandAtom[]): ExpandedField[] {
    const fields: ExpandedField[] = [];
    let cur = '';
    let glob = false;
    let have = false;
    const push = (): void => {
        if (have) fields.push({ text: cur, glob });
        cur = '';
        glob = false;
        have = false;
    };
    for (const atom of atoms) {
        if (atom.before === true && have) push();
        if (atom.split) {
            const pieces = atom.text.split(IFS_SPLIT);
            for (let i = 0; i < pieces.length; i++) {
                if (i > 0) push();
                if (pieces[i] !== '') {
                    cur += pieces[i];
                    glob = glob || atom.glob;
                    have = true;
                }
            }
        } else {
            cur += atom.text;
            glob = glob || atom.glob;
            have = true;
        }
        if (atom.after === true && have) push();
    }
    push();
    return fields;
}

/* ----------------------------------------------------------------------------------------------
 * Pathname expansion
 *
 * A field that came out of an unquoted piece holding a `*`, a `?` or a `[` is a pattern: it is
 * replaced by the names it matches, and by itself when it matches none. As in a shell, `*` and `?`
 * never cross a `/`, a name beginning with `.` is matched only by a pattern that begins with `.`,
 * and a pattern ending in `/` matches directories only, with the `/` kept.
 * -------------------------------------------------------------------------------------------- */

/** The names a pattern component matches, as a regular expression; `*` and `?` never cross a `/`. */
function componentRegExp(pattern: string): RegExp | null {
    let source = '';
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (ch === '\\') {
            source += escapeRegExp(pattern[i + 1] ?? '\\');
            i++;
        } else if (ch === '*') {
            source += '[^/]*';
        } else if (ch === '?') {
            source += '[^/]';
        } else if (ch === '[') {
            let end = i + 1;
            if (pattern[end] === '!' || pattern[end] === '^') end++;
            if (pattern[end] === ']') end++;
            while (end < pattern.length && pattern[end] !== ']') end += pattern[end] === '\\' ? 2 : 1;
            if (end >= pattern.length) {
                source += '\\[';
            } else {
                let body = pattern.slice(i + 1, end);
                if (body.startsWith('!')) body = '^' + body.slice(1);
                source += '[' + body + ']';
                i = end;
            }
        } else {
            source += escapeRegExp(ch);
        }
    }
    try {
        return new RegExp('^(?:' + source + ')$');
    } catch {
        return null;
    }
}

/** The names `pattern` expands to, sorted as a shell sorts them, or null when it matches none. */
function shellGlob(shell: SyncShell, pattern: string): string[] | null {
    if (!/[*?[]/.test(pattern)) return null;
    const fs = shell.ctx.fileSystem;
    const absolute = pattern.startsWith('/');
    const trailing = pattern.endsWith('/');
    const parts = (absolute ? pattern.slice(1) : pattern).split('/');
    if (trailing) parts.pop();
    if (parts.length === 0) return null;
    let dirs: string[] = [absolute ? '/' : shell.cwd];
    let stems: string[] = [absolute ? '/' : ''];
    for (let p = 0; p < parts.length; p++) {
        const component = parts[p];
        const last = p === parts.length - 1;
        const regexp = /[*?[]/.test(component) ? componentRegExp(component) : null;
        const nextDirs: string[] = [];
        const nextStems: string[] = [];
        const found: string[] = [];
        for (let d = 0; d < dirs.length; d++) {
            let entries: string[];
            try {
                entries = fs.listDirectory(dirs[d]);
            } catch {
                continue;
            }
            // `.` and `..` are real names a pattern beginning with `.` matches, as the host has it
            const names = component.startsWith('.') ? ['.', '..', ...entries] : entries;
            for (const name of names) {
                if (name !== '.' && name !== '..' && name.startsWith('.') && !component.startsWith('.')) continue;
                const matched = regexp === null ? name === component : regexp.test(name);
                if (!matched) continue;
                const stem = stems[d] + name;
                if (!last) {
                    const child = joinPath(dirs[d], name);
                    if (isDirectory(fs, child)) {
                        nextDirs.push(child);
                        nextStems.push(stem + '/');
                    }
                    continue;
                }
                if (trailing) {
                    if (isDirectory(fs, joinPath(dirs[d], name))) found.push(stem + '/');
                } else {
                    found.push(stem);
                }
            }
        }
        if (last) return found.length === 0 ? null : found.sort();
        dirs = nextDirs;
        stems = nextStems;
        if (dirs.length === 0) return null;
    }
    return null;
}

function joinPath(dir: string, name: string): string {
    return (dir.endsWith('/') ? dir : dir + '/') + name;
}

function isDirectory(fs: IFileSystem, path: string): boolean {
    try {
        return fs.isDirectory(path);
    } catch {
        return false;
    }
}

/** The names `ls` prints for one directory: sorted, and without the dot files, as the host has it. */
function lsNames(fs: IFileSystem, dir: string): string[] {
    return fs.listDirectory(dir).filter((name) => !name.startsWith('.')).sort();
}

/**
 * The fields one simple command runs with. Leading `NAME=value` words are assignments, not a
 * command: they go into the shell's variables, and a line that is nothing but assignments has no
 * command to run. Returns null for that, and for a word list with no words at all.
 */
function expandCommandWords(shell: SyncShell, words: RawWord[], ctx: ExpandCtx): string[] | null {
    let i = 0;
    while (i < words.length && ASSIGNMENT_WORD.test(rawText(words[i]))) {
        const assignment = expandWordText(shell, words[i], ctx);
        const at = assignment.indexOf('=');
        if (at > 0) {
            const refused = assignVar(shell, assignment.slice(0, at), assignment.slice(at + 1));
            if (refused !== null) {
                ctx.error = refused;
                ctx.code = 127;
                return null;
            }
        }
        i++;
    }
    if (i === words.length) return null;
    const fields: string[] = [];
    for (let j = i; j < words.length; j++) {
        for (const field of assembleFields(expandParts(shell, words[j], ctx))) {
            // `set -f` turns pathname expansion off; otherwise no match leaves the word as written
            if (field.glob && shell.state?.options.noglob !== true) {
                fields.push(...(shellGlob(shell, field.text) ?? [field.text]));
            } else {
                fields.push(field.text);
            }
        }
    }
    return fields;
}

/** The value of a whole word with no field splitting: an assignment, a redirect's file. */
function expandWordText(shell: SyncShell, word: RawWord, ctx: ExpandCtx): string {
    return expandParts(shell, word, ctx)
        .map((atom) => atom.text)
        .join('');
}

function expandParts(shell: SyncShell, parts: ShellPart[], ctx: ExpandCtx): ExpandAtom[] {
    const atoms: ExpandAtom[] = [];
    for (const part of parts) {
        if (part.expand) expandInto(shell, part.text, part.split, atoms, ctx);
        else atoms.push({ text: part.text, split: false, glob: false });
    }
    return atoms;
}

/* ----------------------------------------------------------------------------------------------
 * Redirection
 *
 * A redirection is an operator *and* a destination, and the two are resolved left to right before
 * the command runs: `2>&1` points stderr at wherever stdout points at that moment, so `> f 2>&1`
 * sends both to `f` while `2>&1 > f` leaves stderr on the terminal. `/dev/null` is a sink, not a
 * container file, and a destination that cannot be opened fails the command with status 1 without
 * running it, while an operator with no file after it is a syntax error, status 2, as the host has
 * both.
 * -------------------------------------------------------------------------------------------- */

/** Where one descriptor of a command goes once its redirections are resolved. */
type RedirectDest = { kind: 'stdout' } | { kind: 'stderr' } | { kind: 'null' } | { kind: 'file'; file: string; append: boolean };

/** One `<`, `>`, `>>` or `N>&M` of a command, in the order it was written. */
interface RedirectSpec {
    kind: 'in' | 'out' | 'dup';
    fd: number;
    /** The descriptor a `dup` copies the destination of, at this point in the list. */
    from?: number;
    append?: boolean;
    /** The file name as it was written; expanded when the redirection is resolved. */
    file?: RawWord;
}

/** `>`, `>>`, `<`, `2>`, `2>>`, `1<` ... with the file standing as a word of its own. */
const REDIRECT_OPERATOR = /^([0-9]?)(>>?|<)$/;
/** `2>/dev/null`, `>out.txt`, `>>out.txt`, `<in.txt` ... : the file written against the operator. */
const REDIRECT_ATTACHED = /^([0-9]?)(>>?|<)(.+)$/;
/** `2>&1`, `1>&2`, `>&2` ... */
const REDIRECT_DUP = /^([0-9]?)>&([0-9])$/;

/** The text of a word that is one unquoted piece, so a bare `>` counts and a quoted one does not. */
function operatorText(word: RawWord): string | null {
    return word.length === 1 && word[0].expand ? word[0].text : null;
}

/** Removes every redirection from a command's words; `missing` names an operator with no file after it. */
function takeRedirects(words: RawWord[]): { ops: RedirectSpec[]; missing: string | null } {
    const ops: RedirectSpec[] = [];
    for (let i = 0; i < words.length; i++) {
        const text = operatorText(words[i]);
        if (text === null) continue;
        const dup = REDIRECT_DUP.exec(text);
        if (dup !== null) {
            words.splice(i, 1);
            i--;
            ops.push({ kind: 'dup', fd: dup[1] === '' ? 1 : Number(dup[1]), from: Number(dup[2]) });
            continue;
        }
        const op = REDIRECT_OPERATOR.exec(text);
        if (op !== null) {
            if (i + 1 >= words.length) return { ops, missing: text };
            const file = words[i + 1];
            words.splice(i, 2);
            i--;
            ops.push({ kind: op[2] === '<' ? 'in' : 'out', fd: fdOf(op[1], op[2]), file, append: op[2] === '>>' });
            continue;
        }
        // `2>/dev/null` and `>out.txt`: the operator and the file are one word
        const attached = REDIRECT_ATTACHED.exec(text);
        if (attached === null) continue;
        words.splice(i, 1);
        i--;
        ops.push({
            kind: attached[2] === '<' ? 'in' : 'out',
            fd: fdOf(attached[1], attached[2]),
            // a redirect's file name is expanded but neither field-split nor globbed, as a shell has it
            file: [{ text: attached[3], expand: true, split: false }],
            append: attached[2] === '>>'
        });
    }
    return { ops, missing: null };
}

/** The descriptor a redirect names: 0 for a bare `<`, 1 for a bare `>` or `>>`. */
function fdOf(digits: string, operator: string): number {
    if (digits !== '') return Number(digits);
    return operator === '<' ? 0 : 1;
}

/**
 * One command of a pipeline: its words, the `|` that bounded it already taken out. A `|` splits only
 * where it stands as a word of its own and was not quoted, so `echo "a | b"` is one command.
 */
function splitPipeline(words: RawWord[]): RawWord[][] | null {
    if (!words.some((word) => rawIs(word, '|'))) return [words];
    const stages: RawWord[][] = [[]];
    for (const word of words) {
        if (rawIs(word, '|')) stages.push([]);
        else stages[stages.length - 1].push(word);
    }
    if (stages.some((stage) => stage.length === 0)) return null;
    return stages;
}

/**
 * A diagnostic as the shell writes one: with the newline that ends it, so `2>&1` puts it on stdout
 * the way the host does. `runShell` adds the newline a command left out, and adds no second one.
 */
function diagnostic(text: string): string {
    return text === '' || text.endsWith('\n') ? text : text + '\n';
}

/** The text `< file` feeds a command; a file that is not there fails the command, as a shell's does. */
function readShellInput(shell: SyncShell, file: string): { text: string; error: string | null } {
    try {
        const text = shell.ctx.fileSystem.readFile(shellPath(shell, file));
        return text === undefined ? { text: '', error: `No such file or directory: ${file}` } : { text, error: null };
    } catch {
        // the file system's own message carries its absolute path; the shell names the file it was given
        return { text: '', error: `No such file or directory: ${file}` };
    }
}

/** What a file holds, or undefined where it is not there or cannot be read. */
function readFileOrUndefined(shell: SyncShell, file: string): string | undefined {
    try {
        return shell.ctx.fileSystem.readFile(file);
    } catch {
        return undefined;
    }
}

/** Opens the destination of a `>` or `>>` before the command runs: `>` empties it, `>>` creates it. */
function openRedirectFile(shell: SyncShell, dest: { file: string; append: boolean }): string | null {
    const fs = shell.ctx.fileSystem;
    try {
        if (!dest.append || readFileOrUndefined(shell, dest.file) === undefined) fs.writeFile(dest.file, '');
        return null;
    } catch {
        return `No such file or directory: ${dest.file}`;
    }
}

/** Sends what a command wrote to stdout and to stderr to the destinations its redirections named. */
function finishRedirects(shell: SyncShell, dest: (RedirectDest | null)[], step: ShellStep): ShellStep {
    let stdout = '';
    let stderr = '';
    const write = (d: RedirectDest & { kind: 'file' }, text: string): void => {
        if (text === '') return;
        try {
            const existing = d.append ? readFileOrUndefined(shell, d.file) ?? '' : '';
            shell.ctx.fileSystem.writeFile(d.file, existing + text);
        } catch {
            /* a destination that closed under the command's feet is left as it is */
        }
    };
    const one = dest[1];
    const two = dest[2];
    // `> f 2>&1`: one destination, so the two streams reach it in the order the command wrote them
    if (one !== null && one === two && one.kind === 'file') {
        write(one, step.stdout + step.stderr);
        return { stdout: '', stderr: '', exitCode: step.exitCode };
    }
    for (const fd of [1, 2] as const) {
        const d = dest[fd];
        const text = fd === 1 ? step.stdout : step.stderr;
        if (d === null || d.kind === 'null') continue;
        if (d.kind === 'stdout') stdout += text;
        else if (d.kind === 'stderr') stderr += text;
        else write(d, text);
    }
    return { stdout, stderr, exitCode: step.exitCode };
}

/**
 * One command of a pipeline, run with `input` as its standard input: its own `< file` wins over the
 * pipe, and its redirections apply to it alone, not to the pipeline.
 */
function shellStage(shell: SyncShell, words: RawWord[], input: string | null): ShellStep {
    const stageWords = words.slice();
    const { ops, missing } = takeRedirects(stageWords);
    if (missing !== null) return { stdout: '', stderr: diagnostic(`Syntax error: missing file for redirection ${missing}`), exitCode: 2 };
    const ctx: ExpandCtx = { error: null, code: 0, substStatus: null };
    // 0 is the command's input; 1 and 2 start as the shell's own two outputs
    const dest: (RedirectDest | null)[] = [null, { kind: 'stdout' }, { kind: 'stderr' }];
    let stageInput = input;
    for (const op of ops) {
        if (op.kind === 'dup') {
            dest[op.fd] = dest[op.from ?? 1] ?? { kind: 'null' };
            continue;
        }
        const file = expandWordText(shell, op.file as RawWord, ctx);
        if (ctx.error !== null) {
            shell.stopped = true;
            return { stdout: '', stderr: diagnostic(ctx.error), exitCode: ctx.code };
        }
        if (op.kind === 'in') {
            const read = readShellInput(shell, file);
            if (read.error !== null) return { stdout: '', stderr: diagnostic(read.error), exitCode: 1 };
            stageInput = read.text;
            continue;
        }
        dest[op.fd] = file === '/dev/null' ? { kind: 'null' } : { kind: 'file', file: shellPath(shell, file), append: op.append === true };
    }
    for (const fd of [1, 2] as const) {
        const d = dest[fd];
        if (d === null || d.kind !== 'file') continue;
        const failed = openRedirectFile(shell, d);
        // the command never runs where a destination cannot be opened, as it never does in a shell
        if (failed !== null) return { stdout: '', stderr: diagnostic(failed), exitCode: 1 };
    }
    const saved = shell.input;
    shell.input = stageInput;
    try {
        const fields = expandCommandWords(shell, stageWords, ctx);
        if (ctx.error !== null) {
            // `${x:?}` and an assignment to a read-only variable end the line, as they end a shell
            shell.stopped = true;
            return { stdout: '', stderr: diagnostic(ctx.error), exitCode: ctx.code };
        }
        // a line of assignments and nothing else has no command to run
        if (fields === null) return finishRedirects(shell, dest, { stdout: '', stderr: '', exitCode: ctx.substStatus ?? 0 });
        return finishRedirects(shell, dest, shellCommand(shell, fields));
    } finally {
        shell.input = saved;
    }
}

/**
 * A pipeline: every command reads what the command before it wrote. The status is the last
 * command's, or the first that failed under `set -o pipefail`, and every command's error output is
 * the pipeline's.
 */
function shellPipeline(shell: SyncShell, stages: RawWord[][]): ShellStep {
    let input = shell.input;
    let stderr = '';
    let step: ShellStep = { stdout: '', stderr: '', exitCode: 0 };
    let firstFailure: number | null = null;
    for (let i = 0; i < stages.length; i++) {
        step = shellStage(shell, stages[i], input);
        input = step.stdout;
        if (step.exitCode !== 0 && firstFailure === null) firstFailure = step.exitCode;
        if (i < stages.length - 1) stderr += step.stderr;
    }
    const exitCode = shell.state?.options.pipefail === true && firstFailure !== null ? firstFailure : step.exitCode;
    return { stdout: step.stdout, stderr: stderr + step.stderr, exitCode };
}

/** The command as `jobs` prints it: the words of every stage, joined as they were written. */
function jobText(stages: RawWord[][]): string {
    return stages.map((stage) => stage.map(rawText).join(' ')).join(' | ');
}

/**
 * `cmd &`: records the job and prints the line a shell prints for one, without running it. The
 * shell's own `$?` after it is 0, as it is after any command it does not wait for, and `$!` is the
 * pid it printed.
 */
function startBackgroundJob(shell: SyncShell, stages: RawWord[][]): ShellStep {
    const jobs = jobsOf(shell);
    const id = jobs.reduce((high, job) => Math.max(high, job.id), 0) + 1;
    const job: ShellJob = { id, pid: nextBackgroundPid++, text: jobText(stages), stages, done: false, exitCode: 0 };
    jobs.push(job);
    // `$!` lives in the state the builtins share, so it is the same pid `wait` and `$!` see
    shellStateFor(shell).lastBackgroundPid = job.pid;
    return { stdout: `[${id}] ${job.pid}\n`, stderr: '', exitCode: 0 };
}

/** Runs one job to completion. A job is a subshell: what it does to the directory and to `$?` stays in it. */
function runJob(shell: SyncShell, job: ShellJob): ShellStep {
    const savedCwd = shell.cwd;
    const savedStatus = shell.lastStatus;
    const savedStopped = shell.stopped;
    try {
        const step = shellPipeline(shell, job.stages);
        job.done = true;
        job.exitCode = step.exitCode;
        return step;
    } finally {
        shell.cwd = savedCwd;
        shell.lastStatus = savedStatus;
        shell.stopped = savedStopped;
        if (shell.state !== undefined) {
            shell.state.cwd = savedCwd;
            shell.state.lastStatus = savedStatus;
        }
    }
}

/**
 * Drops the jobs that have run out of the table. A shell keeps a job only while it has something to
 * say about it: once `wait` has reaped it -- or the line's own flush has run it -- `jobs` lists it no
 * more, which is why `cmd & wait; jobs` prints nothing where `cmd & jobs` prints one line.
 */
function reapJobs(shell: SyncShell): void {
    const jobs = shell.jobs;
    if (jobs === undefined) return;
    for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].done) jobs.splice(i, 1);
}

/**
 * Runs every job of the line that has not run yet, in the order it was started. This is what a
 * background job means on a host that runs one command at a time: the command is not waited for
 * where it is written, and it is run -- with its output kept -- once the line's foreground is
 * through, or the moment `wait` asks for it.
 */
function runPendingJobs(shell: SyncShell): ShellStep {
    const jobs = shell.jobs;
    if (jobs === undefined) return { stdout: '', stderr: '', exitCode: 0 };
    let stdout = '';
    let stderr = '';
    for (const job of jobs) {
        if (job.done) continue;
        const step = runJob(shell, job);
        stdout += step.stdout;
        stderr += step.stderr;
    }
    reapJobs(shell);
    return { stdout, stderr, exitCode: 0 };
}

/** The job `wait` or `jobs` names: `%2` is the second job, a bare number is a pid. */
function findJob(shell: SyncShell, name: string): ShellJob | undefined {
    const jobs = jobsOf(shell);
    if (name.startsWith('%')) {
        const spec = name.slice(1);
        const last = jobs[jobs.length - 1];
        if (spec === '+' || spec === '%' || spec === '') return last;
        if (spec === '-') return jobs[jobs.length - 2];
        return jobs.find((job) => job.id === Number(spec));
    }
    const pid = Number(name);
    return Number.isNaN(pid) ? undefined : jobs.find((job) => job.pid === pid);
}

/**
 * `wait`, the one command of the job table a builtin cannot answer. The builtins of `builtins.ts`
 * read the same table -- the state takes it out of `state.host`, which is this shell -- so their own
 * `jobs` lists these very jobs in the columns a shell prints them in, and is reached like any other
 * builtin. Running one is another matter: on a host that runs one command at a time a job runs only
 * when something asks for it, and nothing in that module can ask this dispatcher to run one.
 */
function shellWait(shell: SyncShell, args: string[]): ShellStep {
    // `wait`: no argument waits for every job, as it does in a shell, and its status is 0
    if (args.length === 0) return runPendingJobs(shell);
    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    for (const arg of args) {
        if (arg === '-n' || arg === '-f') continue;
        const job = findJob(shell, arg);
        if (job === undefined) {
            stderr += `wait: ${arg}: not a child of this shell\n`;
            exitCode = 127;
            continue;
        }
        const step = job.done ? { stdout: '', stderr: '', exitCode: job.exitCode } : runJob(shell, job);
        stdout += step.stdout;
        stderr += step.stderr;
        exitCode = step.exitCode;
    }
    // a job `wait` has reaped is a job `jobs` no longer lists, as it is in a shell
    reapJobs(shell);
    return { stdout, stderr, exitCode };
}

/**
 * A line that opens with a compound command -- `if`, `for`, `while`, `until`, `case`, a `{ }` group,
 * a `( )` subshell or a function definition -- handed to the script engine of `builtins.ts`, which
 * already parses all of them. Every simple command it meets comes back through the runner installed
 * at the top of this file, so the line keeps this dispatcher's own commands, its node execution and
 * its 127 for an unknown name, and the engine keeps `set -e` and `set -o pipefail` inside the
 * construct, which this loop cannot see.
 */
function runCompoundLine(shell: SyncShell, line: string): ShellStep {
    const state = shellStateFor(shell);
    const savedIo = state.io;
    const savedBuffer = state.inputBuffer;
    const savedCursor = state.inputCursor;
    // `read` and `mapfile` take their lines out of the state's buffer, not out of the context
    state.inputBuffer = shell.input ?? '';
    state.inputCursor = 0;
    state.io = { stdout: '', stderr: '' };
    try {
        const step = withShellState(state, () => {
            try {
                const result = runScript(state, line);
                return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
            } catch (error) {
                if (isNotSupported(error)) throw error;
                return {
                    stdout: state.io.stdout,
                    stderr: state.io.stderr + (error instanceof Error ? error.message : String(error)),
                    exitCode: 1
                };
            } finally {
                if (state.execTarget !== null) shell.stopped = true;
                shell.cwd = state.cwd;
                syncShellEnv(shell, state);
            }
        });
        // runScript has already run the EXIT trap; drop it so runExitTrap cannot run it a second time
        state.traps.delete('EXIT');
        shell.lastStatus = step.exitCode;
        state.lastStatus = step.exitCode;
        return step;
    } finally {
        state.io = savedIo;
        state.inputBuffer = savedBuffer;
        state.inputCursor = savedCursor;
    }
}

/**
 * ShellProcess.executeCommand for one command line: `;`, `&&` and `||`, with the exit status of the
 * last command that ran. `exit` stops the line, as it stops a shell -- not, however, when it is the
 * command of a background segment: there it is the subshell the job runs in that ends, as it is in
 * bash, and the line goes on. A `|` with a command missing beside it is a syntax error the whole
 * line fails on, before anything runs, as /bin/sh has it.
 *
 * `deferPendingJobs` is for a command substitution, which is a shell of its own inside this one: it
 * leaves the jobs it started for the line around it to run, so they are run after it, never in it.
 */
function shellLine(shell: SyncShell, line: string, deferPendingJobs = false): ShellStep {
    const body = stripComment(line);
    const syntax = syntaxErrorOf(body);
    if (syntax !== null) return { stdout: '', stderr: diagnostic(syntax), exitCode: 2 };
    const segments = splitCommandList(body).filter((segment) => segment.words.length > 0);
    const pipelines: (RawWord[][] | null)[] = segments.map((segment) => splitPipeline(segment.words));
    if (pipelines.some((pipeline) => pipeline === null)) {
        return { stdout: '', stderr: diagnostic('Syntax error: a command is missing beside `|`'), exitCode: 2 };
    }
    if (segments.some(startsCompound)) return runCompoundLine(shell, body);
    let exitCode = 0;
    let stdout = '';
    let stderr = '';
    for (let i = 0; i < segments.length; i++) {
        // `exec` replaced the shell, or an expansion error ended it: nothing after it runs
        if (shell.stopped) break;
        const segment = segments[i];
        if (segment.op === '&&' && exitCode !== 0) continue;
        if (segment.op === '||' && exitCode === 0) continue;
        const step =
            segment.background === true
                ? startBackgroundJob(shell, pipelines[i] as RawWord[][])
                : shellPipeline(shell, pipelines[i] as RawWord[][]);
        stdout += step.stdout;
        stderr += step.stderr;
        exitCode = step.exitCode;
        // `$?` is what the last command left, for the expansions of the next one
        shell.lastStatus = exitCode;
        if (shell.state !== undefined) shell.state.lastStatus = exitCode;
        // `exit` ends the line -- but a backgrounded one ends only the subshell of its job
        if (segment.background !== true && rawText(segment.words[0]) === 'exit') break;
        // `set -e`: a command that fails ends the line, unless it is an operand of `&&` or `||`
        const operand =
            segment.op === '&&' ||
            segment.op === '||' ||
            (i + 1 < segments.length && (segments[i + 1].op === '&&' || segments[i + 1].op === '||'));
        if (!operand && shell.state?.options.errexit === true && exitCode !== 0) break;
    }
    // a job no one waited for cannot outlive the line on a host that runs one command at a time, so
    // it runs here, after the foreground is through: started late rather than never, and never before
    const flushed = deferPendingJobs ? EMPTY_STEP : runPendingJobs(shell);
    const trapped = runExitTrap(
        shell,
        { stdout: stdout + flushed.stdout, stderr: stderr + flushed.stderr, exitCode },
        deferPendingJobs
    );
    // a job the EXIT trap itself started is run the same way
    const afterTrap = deferPendingJobs ? EMPTY_STEP : runPendingJobs(shell);
    return { stdout: trapped.stdout + afterTrap.stdout, stderr: trapped.stderr + afterTrap.stderr, exitCode: trapped.exitCode };
}

/**
 * `trap ACTION EXIT`: the action runs when the line ends, and the line's status is the status it had.
 * The trap is removed first, so its own commands cannot fire it again. No other condition ever arises
 * in this dispatcher -- there are no signals, and no `DEBUG` or `ERR` hook -- so a trap set on one of
 * those is recorded and listed by `trap -p` and never runs.
 */
function runExitTrap(shell: SyncShell, step: ShellStep, deferPendingJobs = false): ShellStep {
    const state = shell.state;
    if (state === undefined) return step;
    const trap = state.traps.get('EXIT');
    if (trap === undefined || trap.reset || trap.ignore || trap.action === '') return step;
    state.traps.delete('EXIT');
    const fired = shellLine(shell, trap.action, deferPendingJobs);
    return { stdout: step.stdout + fired.stdout, stderr: step.stderr + fired.stderr, exitCode: step.exitCode };
}

/** The version `curl --version` and `wget --version` report: the one in packages/core/package.json. */
const CONTAINER_VERSION = '0.1.0';

/**
 * `curl --version` and `wget --version`: the two words of `SHELL_EXTERNALS` that name no request,
 * so they can be answered without a network. What is printed is the container's own version of the
 * two, and it says so: a fetch here is `fetch`, not a libcurl or a GNU build, and a line that only
 * looks like the host's would be a lie. Anything else -- a URL, an option, no argument at all --
 * falls through to the honest failure it gives today.
 */
function externalVersion(command: string, args: string[]): string | null {
    if (command !== 'curl' && command !== 'wget') return null;
    if (args.length === 0 || !args.every((arg) => arg === '--version' || arg === '-V')) return null;
    if (command === 'curl') return `curl ${CONTAINER_VERSION} (OpenWebContainer)\nProtocols: http https\nFeatures: fetch\n`;
    return `Wget ${CONTAINER_VERSION} (OpenWebContainer)\n`;
}

/** The first line of `file`, or undefined when it cannot be read. */
function readFirstLine(fs: IFileSystem, file: string): string | undefined {
    try {
        return fs.readFile(file);
    } catch {
        return undefined;
    }
}

/**
 * `npm` in a synchronous call, reached from a line that names it and from `spawnSync('npm', ...)`.
 *
 * `npm run` and the lifecycle commands run the package's script here, in the shell engine already
 * on the stack, so a script of shell commands and `node` files works where the container's own npm
 * process -- which is asynchronous end to end -- cannot be stepped. A command that has to reach the
 * registry (`npm install`, `npx`) still cannot: it waits on host work this call cannot complete, and
 * says so rather than answering with a status that means nothing.
 */
function npmCommand(shell: SyncShell, args: string[]): ShellStep {
    const [sub, ...rest] = args;
    if (sub === '-v' || sub === '--version' || sub === 'version') {
        return { stdout: NPM_VERSION + '\n', stderr: '', exitCode: 0 };
    }
    const event = LIFECYCLE_COMMANDS[sub ?? ''];
    if (sub !== 'run' && sub !== 'run-script' && event === undefined) {
        throw notSupportedSync(`the shell command npm ${sub ?? ''}`.trim());
    }
    const { name, ifPresent, extra } = parseScriptArgs(rest, event);
    const packageDir = findPackageRoot(shell.ctx.fileSystem, shell.cwd) ?? shell.cwd;
    const manifest = readManifest(shell.ctx.fileSystem, packageDir);
    if (manifest === undefined) {
        return { stdout: '', stderr: diagnostic(`npm error code ENOENT\nnpm error enoent Could not read package.json in ${packageDir}`), exitCode: 1 };
    }
    const label = scriptLabel(manifest, packageDir);
    const scripts = (manifest.scripts ?? {}) as Record<string, unknown>;
    if (name === undefined) return { stdout: scriptList(label, scripts), stderr: '', exitCode: 0 };
    if (typeof scripts[name] !== 'string') {
        if (ifPresent) return EMPTY_STEP;
        return { stdout: '', stderr: diagnostic(missingScriptMessage(name)), exitCode: 1 };
    }
    const PATH = scriptPath(shell.ctx.fileSystem, packageDir, shell.env.PATH);
    let stdout = '';
    for (const step of scriptEvents(name, scripts)) {
        const command = String(scripts[step]);
        const line = scriptCommandLine(scripts, step, name, extra);
        stdout += scriptHeader(label, step, line);
        /* one shell per script, as npm has: the directory, the exported variables and `$?` of one
           script are its own, and only PATH and the npm_package_* names carry over. */
        const child: SyncShell = {
            ctx: shell.ctx,
            cwd: packageDir,
            env: {
                ...shell.env,
                PATH,
                npm_package_name: String(manifest.name ?? ''),
                npm_package_version: String(manifest.version ?? ''),
                npm_package_json: `${packageDir === '/' ? '' : packageDir}/package.json`,
                npm_lifecycle_event: step
            },
            input: shell.input,
            lastStatus: shell.lastStatus
        };
        const result = shellLine(child, line);
        stdout += result.stdout;
        if (result.exitCode !== 0) {
            return { stdout, stderr: diagnostic(result.stderr + scriptFailureMessage(label, step, command, result.exitCode)), exitCode: result.exitCode };
        }
        stdout += result.stderr;
    }
    return { stdout, stderr: '', exitCode: 0 };
}

/** ShellProcess.executeCommand for one command, in the same order of dispatch. */
function shellCommand(shell: SyncShell, words: string[]): ShellStep {
    if (words.length === 0) return { stdout: '', stderr: '', exitCode: 0 };
    const [command, ...cmdArgs] = words;
    try {
        if (command === 'exit') {
            const status = Number.parseInt(cmdArgs[0] ?? '0', 10);
            return { stdout: '', stderr: '', exitCode: Number.isNaN(status) ? 0 : status };
        }
        if (command === 'history') return { stdout: '', stderr: '', exitCode: 0 };
        // `jobs` reads the job table this dispatcher keeps for `&` -- the state the builtins share
        // takes it out of `state.host`, which is this shell -- so the builtin's own `jobs` answers it,
        // in the columns a shell prints them in
        if (command === 'jobs') return shellBuiltinModule(shell, command, cmdArgs);
        // `wait` has to run a job, and running one is something only this dispatcher can do
        if (command === 'wait') return shellWait(shell, cmdArgs);
        if (SHELL_BUILTINS.has(command)) return shellBuiltinWithRedirects(shell, command, cmdArgs);
        const version = externalVersion(command, cmdArgs);
        if (version !== null) return { stdout: version, stderr: '', exitCode: 0 };
        if (command === 'npm') return npmCommand(shell, cmdArgs);
        // `curl` that names no URL has nothing to wait for: its own usage failure, with its own
        // status 2, so a synchronous caller gets what the utility would answer rather than the
        // blanket refusal a command that needs the network gets.
        if (command === 'curl') {
            const withoutNetwork = curlUsageResult(cmdArgs);
            if (withoutNetwork !== null) {
                return { stdout: withoutNetwork.stdout, stderr: withoutNetwork.stderr, exitCode: withoutNetwork.exitCode };
            }
        }
        if (SHELL_EXTERNALS.has(command)) throw notSupportedSync(`the shell command ${command}`);
        if (command === 'node' || command === NODE_BINARY) return shellNode(shell, nodeInvocation(cmdArgs));
        // A builtin is never looked for on PATH, the way it never is in a shell: `.` is the source
        // builtin, not the current directory, and `env` is not `/usr/bin/env`.
        const PATH = SHELL_BUILTIN_NAMES.has(command) ? undefined : shell.env.PATH;
        if (PATH) {
            for (const dir of PATH.split(':')) {
                // joined against the directory: fs.resolvePath answers a relative name from the root
                const base = dir.endsWith('/') ? dir.slice(0, -1) : dir;
                const found = shell.ctx.fileSystem.normalizePath(`${base}/${command}`);
                if (!shell.ctx.fileSystem.fileExists(found)) continue;
                if (found.endsWith('.js')) return shellNode(shell, { file: found, args: cmdArgs });
                // a node_modules/.bin shim: a node script with no .js name, run through its shebang
                const content = readFirstLine(shell.ctx.fileSystem, found);
                const shebang = content === undefined ? null : /^#!(.*)/.exec(content);
                const tokens = shebang === null ? [] : shebang[1].trim().split(/\s+/);
                const interpreter = tokens[0] === '/usr/bin/env' ? tokens.slice(1).find((t) => !t.startsWith('-')) : tokens[0]?.split('/').pop();
                if (interpreter === 'node') return shellNode(shell, { file: found, args: cmdArgs });
                return { stdout: '', stderr: diagnostic(`No executor found for: ${found}`), exitCode: 1 };
            }
        }
        let content: string | undefined;
        try {
            content = shell.ctx.fileSystem.readFile(command);
        } catch {
            content = undefined;
        }
        const shebang = content ? /^#!(.*)/.exec(content) : null;
        if (shebang) {
            const tokens = shebang[1].split(' ');
            if (tokens[0] === '/usr/bin/env') {
                if (tokens.length === 1) return { stdout: '', stderr: '', exitCode: 1 };
                if (tokens[1] === 'node') return shellNode(shell, { file: command, args: cmdArgs });
                throw notSupportedSync(`the shebang interpreter ${tokens[1]}`);
            }
        }
        // A utility the container cannot have reports the reason it cannot, with status 1: never 127.
        if (isUnsupported(command)) {
            const result = unsupportedResult(command);
            return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
        }
        const moduleStep = shellModuleCommand(shell, command, cmdArgs);
        if (moduleStep !== null) return moduleStep;
        return { stdout: '', stderr: diagnostic(`Command not found: ${command}`), exitCode: 127 };
    } catch (error) {
        if (isNotSupported(error)) throw error;
        return { stdout: '', stderr: error instanceof Error ? error.message : String(error), exitCode: 1 };
    }
}

/** `sh -c <line>` (or `sh <words>`): stdout exactly as the built-ins wrote it, stderr with a newline after it, as ShellProcess prints it. */
function runShell(
    ctx: CapabilityContext,
    argv: string[],
    env: Record<string, string>,
    cwd: string,
    input: string | null,
    name: string
): { status: number; stdout: string; stderr: string } {
    if (argv.length === 0) throw notSupportedSync('an interactive sh (no command given)');
    const line = argv[0] === '-c' ? (argv[1] ?? '') : argv.join(' ');
    const step = shellLine({ ctx, cwd, env, input, name, lastStatus: 0 }, line);
    return {
        status: step.exitCode,
        stdout: step.stdout,
        // `sh` ends a diagnostic with a newline; a command that wrote its own already ends in one
        stderr: step.stderr === '' || step.stderr.endsWith('\n') ? step.stderr : step.stderr + '\n'
    };
}

/** Runs an executable to completion. A spawn that cannot start (no executor, bad invocation) throws. */
function runSyncCommand(
    ctx: CapabilityContext,
    file: string,
    argv: string[],
    env: Record<string, string>,
    cwd: string,
    timeoutMs: number,
    killSignal: string,
    input: string | null
): SyncRun {
    if (file === 'sh' || file === '/bin/sh') {
        const step = runShell(ctx, argv, env, cwd, input, file);
        return { pid: nextSyncPid++, status: step.status, signal: null, stdout: step.stdout, stderr: step.stderr, timedOut: false };
    }
    if (file === 'node' || file === NODE_BINARY) return nodeRun(ctx, nodeInvocation(argv), env, cwd, timeoutMs, killSignal);
    if (file.endsWith('.js')) return nodeRun(ctx, { file, args: argv }, env, cwd, timeoutMs, killSignal);
    if (file === 'npm' || file === 'npx') {
        const step = npmCommand({ ctx, cwd, env, input, lastStatus: 0 }, argv);
        return { pid: nextSyncPid++, status: step.exitCode, signal: null, stdout: step.stdout, stderr: step.stderr, timedOut: false };
    }
    // `spawnSync('curl', ['--version'])`, `execFileSync('ls', ['-l'])` and every other name the
    // container's own synchronous shell can run: one dispatch for all three synchronous calls, the
    // way all three look up one PATH on a host. A name the shell has no command for stays a failed
    // spawn, as it stays one on a host.
    if (SHELL_BUILTINS.has(file) || SHELL_BUILTIN_NAMES.has(file) || SHELL_EXTERNALS.has(file)
        || isUnsupported(file) || SHELL_MODULE_COMMANDS[file] !== undefined) {
        const step = shellCommand({ ctx, cwd, env, input, lastStatus: 0 }, [file, ...argv]);
        return { pid: nextSyncPid++, status: step.exitCode, signal: null, stdout: step.stdout, stderr: step.stderr, timedOut: false };
    }
    throw new Error(`No executor found for: ${file}`);
}

/** child.spawn inside a synchronous run: the child runs to completion inside this call, its output and exit are queued for the pump, and its pid is returned at once. */
function spawnChildNow(args: Record<string, any>, ctx: CapabilityContext): { pid: number } {
    if (args.ipc) throw notSupportedSync('an IPC child (fork, cluster or worker thread)');
    const file = String(args.file);
    const argv: string[] = Array.isArray(args.args) ? args.args.map(String) : [];
    const env: Record<string, string> = args.env ? { ...args.env } : childEnvOf(ctx);
    const cwd = typeof args.cwd === 'string' ? args.cwd : ctx.cwd();
    const stdio: unknown[] = Array.isArray(args.stdio) ? args.stdio : [];
    const target = Number(args.target);
    let run: SyncRun;
    try {
        run = runSyncCommand(ctx, file, argv, env, cwd, 0, 'SIGTERM', null);
    } catch (error) {
        if (isNotSupported(error)) throw error;
        throw spawnFailure(error, file, argv);
    }
    if (run.blocked !== undefined) throw notSupportedSync(`the child, which waits on ${run.blocked},`);
    const stdoutMode = modeOf(stdio[1]);
    const stderrMode = modeOf(stdio[2]);
    if (stdoutMode === 'pipe' && run.stdout) ctx.deliver(target, 'ev', { k: 'out', fd: 1, s: run.stdout });
    if (stdoutMode === 'inherit' && run.stdout) ctx.output({ stdout: run.stdout });
    if (stderrMode === 'pipe' && run.stderr) ctx.deliver(target, 'ev', { k: 'out', fd: 2, s: run.stderr });
    if (stderrMode === 'inherit' && run.stderr) ctx.output({ stderr: run.stderr });
    const signal = run.signal;
    ctx.deliver(target, 'ev', { k: 'exit', code: signal === null ? (run.status ?? 0) : null, signal });
    return { pid: run.pid };
}

/** child.spawnSync: one executable run to completion inside this call, reported the way Node's spawnSync reports it. */
const spawnSyncChild: CapabilityHandler = (args, ctx): SyncOutcome => {
    const file = String(args.file);
    const argv: string[] = Array.isArray(args.args) ? args.args.map(String) : [];
    const env: Record<string, string> = args.env ? { ...args.env } : childEnvOf(ctx);
    const cwd = typeof args.cwd === 'string' ? args.cwd : ctx.cwd();
    const timeoutMs = Number(args.timeout) > 0 ? Number(args.timeout) : 0;
    const killSignal = typeof args.killSignal === 'string' ? args.killSignal : 'SIGTERM';
    const input = typeof args.input === 'string' ? args.input : null;
    const stdio: unknown[] = Array.isArray(args.stdio) ? args.stdio : [];
    const stdoutMode = modeOf(stdio[1]);
    const stderrMode = modeOf(stdio[2]);

    let run: SyncRun;
    try {
        run = runSyncCommand(ctx, file, argv, env, cwd, timeoutMs, killSignal, input);
    } catch (error) {
        if (isNotSupported(error)) {
            return { pid: nextSyncPid++, spawned: true, status: null, signal: null, stdout: null, stderr: null, error: syncSpawnError(error, file, argv) };
        }
        return { pid: 0, spawned: false, status: null, signal: null, stdout: null, stderr: null, error: syncSpawnError(error, file, argv) };
    }

    let error: SyncErrorInfo | null = null;
    let status = run.status;
    let signal = run.signal;
    if (run.blocked !== undefined) {
        error = { code: 'ERR_NOT_SUPPORTED', message: notSupportedSync(`the child, which waits on ${run.blocked},`).message };
        status = null;
        signal = null;
    } else if (run.timedOut) {
        error = { code: 'ETIMEDOUT', message: `spawnSync ${file} ETIMEDOUT`, errno: -110, syscall: `spawnSync ${file}`, path: file, spawnargs: argv };
        status = null;
        signal = killSignal;
    }
    if (stdoutMode === 'inherit' && run.stdout) ctx.output({ stdout: run.stdout });
    if (stderrMode === 'inherit' && run.stderr) ctx.output({ stderr: run.stderr });
    return {
        pid: run.pid,
        spawned: true,
        status,
        signal,
        stdout: stdoutMode === 'pipe' ? run.stdout : null,
        stderr: stderrMode === 'pipe' ? run.stderr : null,
        error
    };
};

export const CHILD_CAPABILITIES: Record<string, CapabilityHandler> = {
    'child.spawn': spawnChild,
    'child.kill': killChild,
    'child.stdin': stdinWrite,
    'child.ipcAttach': ipcAttach,
    'child.sendToParent': sendToParent,
    'child.sendToChild': sendToChild,
    'child.disconnectChild': disconnectChild,
    'child.disconnectSelf': disconnectSelf,
    'child.parentExit': parentExit,
    'child.spawnSync': spawnSyncChild
};
