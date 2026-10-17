/*
 * The native binding of node-pty (pty.node, src/unix/pty.cc of node-pty 1.1.0) in JavaScript, in
 * the container. createAddon() returns the four exports the real add-on has: fork, open, resize
 * and process. Everything runs over the container's own child processes, which the host hands to
 * the shim as env.child (see runtime/guest/globals.ts), because the container has no terminal
 * device: no openpty, no file descriptor that is a tty, no line discipline, no window size and no
 * job control.
 *
 * What fork() starts. The container can run three kinds of executable: `sh` (a ShellProcess),
 * `node` and a `.js` file (a NodeProcess). `sh` with no arguments is the interactive shell: it
 * prints a prompt, echoes what is written to it, runs a command line on the line terminator and
 * prints the result, which is the closest thing the container has to a session on a terminal.
 * `sh` with arguments (['-c', line]) runs one command line and exits. A file that is none of
 * these three fails with ENOENT, as a file with no executor does in Node.
 *
 * What onData delivers. The child's stdout and its stderr, merged in the order they arrive, as
 * one stream, the way a pty merges them, with every newline turned into CR NL the way the line
 * discipline of a terminal turns it. The bytes are the container's own text encoded back to
 * UTF-8: the pipes here carry strings, not bytes, so a program that wrote bytes that are not
 * UTF-8 has already been decoded by the host and cannot be recovered.
 *
 * What resize() does. It records the size and nothing else: there is no TIOCSWINSZ, no SIGWINCH
 * and no program in the container that asks for the size of its terminal. cols and rows are
 * reported back, and COLUMNS and LINES are put in the child's environment at spawn, which is the
 * only place a size can reach a child here.
 *
 * What a spawned program sees. isatty is false: the guest's tty.isatty() returns false, the
 * stream node-pty reads from reports isTTY false, and the container's shell has no test for a
 * terminal. A program that changes its output for one (colour, column wrapping, an interactive
 * prompt of its own) does not do so here, because there is no terminal for it to detect.
 */

/** What the host hands the shim: the one host facility it needs. */
export interface PtyAddonEnv {
    /** child_process.spawn of the guest: starts a container child and returns its ChildProcess. */
    child?: { spawn(file: string, args: string[], options: Record<string, unknown>): any };
}

/**
 * The fd table the two halves share. This shim writes the records; the guest's tty.ReadStream and
 * fs.write, which node-pty's own JavaScript uses, read them. They are separate bundles, so the
 * table lives on globalThis under this one name.
 */
const FD_TABLE = '__owcPtyFds';

/** The size node-pty uses when it is given none (lib/terminal.js DEFAULT_COLS / DEFAULT_ROWS). */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/**
 * Signal numbers, as Linux numbers them (the guest reports linux-x64). The real add-on reports
 * the signal that ended the child as a number and 0 when the child exited, so a name the container
 * used becomes that number here; a name outside this table is passed on unchanged rather than
 * replaced with a wrong number.
 */
const SIGNAL_NUMBERS: Record<string, number> = {
    SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGBUS: 7, SIGFPE: 8,
    SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15,
    SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20
};

interface PtyRecord {
    /** The fd handed to node-pty: an index into the table, not a descriptor of the host. */
    fd: number;
    /** The file spawn() asked for, as it was given. */
    file: string;
    args: string[];
    child: any;
    /** The container's pid of the child, once the host has given it one (after spawn returns). */
    realPid?: number;
    /** One listener list: 'data' carries a Buffer for every chunk the child wrote. */
    emitter: { on(name: string, fn: (chunk: any) => void): unknown; removeListener(name: string, fn: (chunk: any) => void): unknown; emit(name: string, chunk: any): void };
    cols: number;
    rows: number;
    exited: boolean;
    paused: boolean;
    queue: any[];
    /** The tty.ReadStream node-pty built around this fd, once it has. */
    socket: any;
    write(text: string): number;
}

function table(): Record<number, PtyRecord> {
    const g = globalThis as any;
    if (!g[FD_TABLE]) g[FD_TABLE] = Object.create(null);
    return g[FD_TABLE] as Record<number, PtyRecord>;
}

function bufferOf(): any {
    return (globalThis as any).Buffer;
}

function size(value: unknown, fallback: number): number {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function signalNumber(signal: unknown): number | string {
    if (signal === undefined || signal === null || signal === '') return 0;
    if (typeof signal === 'number') return signal;
    const name = String(signal);
    return Object.prototype.hasOwnProperty.call(SIGNAL_NUMBERS, name) ? SIGNAL_NUMBERS[name] : name;
}

/** "K=V" pairs, as node-pty's Terminal._parseEnv makes them, back into an object. */
function envObject(pairs: unknown): Record<string, string> {
    const out: Record<string, string> = Object.create(null);
    if (!Array.isArray(pairs)) return out;
    for (const pair of pairs) {
        const text = String(pair);
        const at = text.indexOf('=');
        if (at <= 0) continue;
        out[text.slice(0, at)] = text.slice(at + 1);
    }
    return out;
}

/**
 * The executable the container can start for a file, or null when it can start none. Only sh,
 * node and a .js file have an executor here; anything else fails the way a file with no executor
 * fails in Node.
 */
function executableOf(file: string): string | null {
    if (file === 'sh' || file === '/bin/sh') return 'sh';
    if (file === 'node' || file === '/usr/local/bin/node') return 'node';
    if (file.endsWith('.js')) return file;
    const base = file.slice(file.lastIndexOf('/') + 1);
    if (base === 'sh') return 'sh';
    if (base === 'node') return 'node';
    return null;
}

/**
 * What a write to the pty does to a line terminator. A terminal sends CR for the Enter key and
 * the line discipline turns it into NL, which is what a program reading a line sees; the
 * container's shell takes a line on NL too, and on a lone CR, which it reads as Enter as well.
 * A CR that ends a chunk of text becomes NL; a chunk that is nothing but a CR is left alone.
 */
function toNewline(data: string): string {
    // A lone NL is the Enter key here: a length-1 write never reaches the shell's paste path,
    // which is the only place it takes a line on NL, and a lone CR is what it reads as Enter.
    if (data === '\n') return '\r';
    if (data === '\r') return data;
    return data.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * What a pty does to a newline on the way out. A program writes NL; the line discipline of the
 * terminal turns it into CR NL (ONLCR), which is what the master side and everything reading it
 * sees, so a line the container's child wrote as "a\n" arrives as "a\r\n". A CR the program wrote
 * itself is left alone, so a program that already writes CR NL comes out as CR CR NL, as it does
 * on a real terminal.
 */
function toCrlf(chunk: unknown): unknown {
  if (typeof chunk === 'string') return chunk.indexOf('\n') < 0 ? chunk : chunk.replace(/\n/g, '\r\n');
  const B = bufferOf();
  if (B && (chunk instanceof Uint8Array || (typeof B.isBuffer === 'function' && B.isBuffer(chunk)))) {
    const text = B.from(chunk).toString('utf8');
    return text.indexOf('\n') < 0 ? chunk : B.from(text.replace(/\n/g, '\r\n'), 'utf8');
  }
  return chunk;
}

/**
 * The exit code node-pty reports: a number, never null. The add-on reads waitpid and reports the
 * exit status when the child exited and 0 when a signal ended it, with the signal beside it.
 */
function exitStatusCode(code: unknown): number {
  const status = Number(code);
  return code === undefined || code === null || !Number.isFinite(status) ? 0 : status;
}

function asBuffer(chunk: unknown): any {
    const B = bufferOf();
    if (B && typeof B.isBuffer === 'function' && B.isBuffer(chunk)) return chunk;
    if (chunk instanceof Uint8Array) return B.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    return B.from(String(chunk), 'utf8');
}

/** The smallest thing the two halves need of an event emitter: one listener list for 'data'. */
function makeEmitter(): PtyRecord['emitter'] {
    const listeners: ((chunk: any) => void)[] = [];
    return {
        on(name: string, fn: (chunk: any) => void): unknown {
            if (name === 'data' && typeof fn === 'function') listeners.push(fn);
            return this;
        },
        removeListener(name: string, fn: (chunk: any) => void): unknown {
            const at = listeners.indexOf(fn);
            if (name === 'data' && at >= 0) listeners.splice(at, 1);
            return this;
        },
        emit(name: string, chunk: any): void {
            if (name !== 'data') return;
            listeners.slice().forEach((fn) => fn(chunk));
        }
    };
}

export function createAddon(env: PtyAddonEnv = {}): object {
    const spawnChild = env && env.child && typeof env.child.spawn === 'function' ? env.child.spawn : undefined;
    let nextFd = 1000;

    /**
     * pty.fork: starts the child and returns the master side. The callback is called once, with
     * the exit code (0 when a signal ended the child) and the signal, as the real add-on
     * reports them.
     */
    function fork(
        file: string,
        args: string[],
        parsedEnv: string[],
        cwd: string,
        cols: number,
        rows: number,
        _uid: number,
        _gid: number,
        _utf8: boolean,
        _helperPath: string,
        onexit: (code: number | null, signal: number | string) => void
    ): { fd: number; pid: number; pty: string } {
        if (spawnChild === undefined) {
            throw new Error('the node-pty shim needs the container child_process: the host did not pass env.child');
        }
        const name = file === undefined || file === null || file === '' ? 'sh' : String(file);
        const argv: string[] = Array.isArray(args) ? args.map((item) => String(item)) : [];
        const exe = executableOf(name);
        if (exe === null) {
            const failure: any = new Error(`spawn ${name} ENOENT`);
            failure.code = 'ENOENT';
            failure.errno = -2;
            failure.syscall = `spawn ${name}`;
            failure.path = name;
            failure.spawnargs = argv;
            throw failure;
        }
        const envObject_ = envObject(parsedEnv);
        const child = spawnChild(exe, argv, {
            cwd: typeof cwd === 'string' && cwd !== '' ? cwd : undefined,
            env: envObject_,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        const fd = nextFd++;
        const emitter = makeEmitter();
        const record: PtyRecord = {
            fd,
            file: name,
            args: argv,
            child,
            emitter,
            cols: size(cols, DEFAULT_COLS),
            rows: size(rows, DEFAULT_ROWS),
            exited: false,
            paused: false,
            queue: [],
            socket: null,
            write(text: string): number {
                if (record.exited || !child.stdin) return 0;
                const line = toNewline(text);
                child.stdin.write(line);
                return bufferOf().byteLength(line, 'utf8');
            }
        };
        table()[fd] = record;

        const deliver = (chunk: unknown): void => {
            const line = asBuffer(toCrlf(chunk));
            if (record.paused) {
                record.queue.push(line);
                return;
            }
            emitter.emit('data', line);
        };
        if (child.stdout) child.stdout.on('data', deliver);
        if (child.stderr) child.stderr.on('data', deliver);

        /** The socket is closed first, so node-pty's UnixTerminal emits 'exit' without its 200ms wait. */
        const finish = (code: number | null, signal: number | string): void => {
            if (record.exited) return;
            record.exited = true;
            if (record.socket && typeof record.socket.destroy === 'function') record.socket.destroy();
            delete table()[fd];
            if (typeof onexit === 'function') onexit(code, signal);
        };
        child.on('exit', (code: unknown, signal: unknown) => {
            finish(exitStatusCode(code), signalNumber(signal));
        });
        // A spawn the host refused never reaches 'exit': its 'close' carries the errno.
        child.on('close', (code: unknown, signal: unknown) => {
            if (record.exited) return;
            finish(exitStatusCode(code), signalNumber(signal));
        });

        // The container gives a child its pid asynchronously, after spawn has returned, so there is
        // no process id to report at construction: the pty's own id is reported instead, and
        // process.kill (runtime/guest/globals.ts) resolves that id back to the child. It is an id
        // of the pty, not a pid of a process, and it is the same number as the fd.
        if (child.on) {
            child.on('spawn', () => {
                record.realPid = child.pid;
            });
        }

        return { fd, pid: fd, pty: name };
    }

    /** pty.resize: records the size. Nothing in the container has a window to resize. */
    function resize(fd: number, cols: number, rows: number): void {
        const record = table()[Number(fd)];
        if (!record) return;
        record.cols = size(cols, record.cols);
        record.rows = size(rows, record.rows);
        if (record.socket) {
            record.socket.columns = record.cols;
            record.socket.rows = record.rows;
        }
    }

    /**
     * pty.process: the title of the process on the terminal. There is no terminal and no way to
     * read a title out of a container process, so the file that was spawned is reported, which is
     * what node-pty falls back to when the title is unavailable.
     */
    function process(fd: number): string {
        const record = table()[Number(fd)];
        return record ? record.file : '';
    }

    /** pty.open: there is no openpty here and nothing to hand back for a master or a slave. */
    function open(): never {
        const failure: any = new Error(
            'pty.open is not supported in this container: it has no pseudo-terminal device, so there is no master or slave descriptor to open'
        );
        failure.code = 'ERR_PTY_UNSUPPORTED';
        throw failure;
    }

    return { fork, open, resize, process };
}

export default createAddon;
