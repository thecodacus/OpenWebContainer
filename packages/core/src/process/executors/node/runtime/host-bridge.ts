import { QuickJSContext, QuickJSHandle } from 'quickjs-emscripten';
import { IFileSystem } from '../../../../filesystem';
import { NodeResolver, ResolveMode, dirnameOf } from './resolver';
import { base64ToBytes, bytesToBase64 } from '../../../../utils/bytes';
import { CapabilityEnvelope } from './capabilities/types';
import { installWasmBridge } from './wasm-host';

export interface HostBridgeDeps {
    fileSystem: IFileSystem;
    resolver: NodeResolver;
    pid: number;
    argv: string[];
    env: Record<string, string>;
    cwd: () => string;
    /** Changes the process's working directory; returns '' or an fs error code. */
    chdir: (path: string) => string;
    now: () => number;
    emitStdout: (text: string) => void;
    emitStderr: (text: string) => void;
    exit: (code: number) => void;
    setTimer: (id: number, ms: number) => void;
    clearTimer: (id: number) => void;
    /** Synchronous capability call; returns an envelope. */
    capability: (op: string, argsJson: string) => CapabilityEnvelope;
    /** Asynchronous capability; the guest's pending operation `opId` is settled later. */
    startOperation: (op: string, argsJson: string, opId: number) => void;
    holdRef: (delta: number) => void;
    /** Evaluates an ES module synchronously for require(); returns '' or the failure text. */
    loadEsm: (file: string, token: number) => string;
}

class FsCodeError extends Error {
    constructor(readonly code: string) {
        super(code);
    }
}

/**
 * Builds the `host` object the guest bootstrap receives. Every function returns a
 * fresh handle (quickjs-emscripten disposes returned handles) and reports fs
 * failures as an error code string, which the guest turns into a Node-style error.
 */
export function installHostBridge(context: QuickJSContext, deps: HostBridgeDeps): QuickJSHandle {
    const host = context.newObject();
    const define = (name: string, impl: (...args: QuickJSHandle[]) => QuickJSHandle) => {
        const fn = context.newFunction(name, (...args: QuickJSHandle[]) => impl(...args));
        context.setProp(host, name, fn);
        fn.dispose();
    };
    const text = (handle: QuickJSHandle) => context.getString(handle);
    const nullable = (value: string | undefined | null) => (value === undefined || value === null ? context.null : context.newString(value));
    const guardFs = (action: () => void): string => {
        try {
            action();
            return '';
        } catch (error) {
            return error instanceof FsCodeError ? error.code : 'EIO';
        }
    };
    const requireParentDirectory = (file: string) => {
        if (deps.fileSystem.statPath(dirnameOf(file))?.type !== 'dir') throw new FsCodeError('ENOENT');
    };

    define('resolve', (specifier, fromDir, mode) => {
        const found = deps.resolver.resolve(text(specifier), text(fromDir), text(mode) as ResolveMode);
        return context.newString(found ?? '');
    });
    define('isESM', (file) => (deps.resolver.isESM(text(file)) ? context.true : context.false));
    define('readText', (path) => nullable(safeRead(() => deps.fileSystem.readFile(text(path)))));
    define('readBase64', (path) => nullable(safeRead(() => {
        const bytes = deps.fileSystem.readBytes(text(path));
        return bytes ? bytesToBase64(bytes) : undefined;
    })));
    define('statJSON', (path) => nullable(safeRead(() => {
        const stat = deps.fileSystem.statPath(text(path));
        return stat ? JSON.stringify(stat) : undefined;
    })));
    define('readdirJSON', (path) => context.newString(JSON.stringify(deps.fileSystem.readdirNames(text(path)) ?? [])));
    define('writeBase64', (path, data) => context.newString(guardFs(() => {
        const file = text(path);
        requireParentDirectory(file);
        if (deps.fileSystem.statPath(file)?.type === 'dir') throw new FsCodeError('EISDIR');
        deps.fileSystem.writeBytes(file, base64ToBytes(text(data)));
    })));
    define('mkdir', (path) => context.newString(guardFs(() => {
        deps.fileSystem.createDirectory(text(path));
    })));
    define('rm', (path, recursive) => context.newString(guardFs(() => {
        const file = text(path);
        const recursiveRemoval = context.dump(recursive) === true;
        if (!recursiveRemoval && deps.fileSystem.statPath(file)?.type === 'dir' && (deps.fileSystem.readdirNames(file)?.length ?? 0) > 0) {
            throw new FsCodeError('ENOTEMPTY');
        }
        deps.fileSystem.removePath(file, recursiveRemoval);
    })));
    define('rename', (from, to) => context.newString(guardFs(() => {
        deps.fileSystem.renamePath(text(from), text(to));
    })));

    define('cwd', () => context.newString(deps.cwd()));
    /**
     * process.chdir: the working directory lives on the host, so the guest asks for the change
     * and gets back '' or the error code Node would report (ENOENT, ENOTDIR).
     */
    define('chdir', (path) => context.newString(deps.chdir(text(path))));
    define('pid', () => context.newNumber(deps.pid));
    define('argvJSON', () => context.newString(JSON.stringify(deps.argv)));
    define('envJSON', () => context.newString(JSON.stringify(deps.env)));
    define('now', () => context.newNumber(deps.now()));
    define('randomBase64', (size) => {
        const bytes = new Uint8Array(context.getNumber(size));
        crypto.getRandomValues(bytes);
        return context.newString(bytesToBase64(bytes));
    });
    define('stdout', (chunk) => {
        deps.emitStdout(text(chunk));
        return context.undefined;
    });
    define('stderr', (chunk) => {
        deps.emitStderr(text(chunk));
        return context.undefined;
    });
    define('exit', (code) => {
        deps.exit(context.getNumber(code));
        return context.undefined;
    });
    define('setTimer', (id, ms) => {
        deps.setTimer(context.getNumber(id), context.getNumber(ms));
        return context.undefined;
    });
    define('clearTimer', (id) => {
        deps.clearTimer(context.getNumber(id));
        return context.undefined;
    });
    define('cap', (op, args) => context.newString(JSON.stringify(deps.capability(text(op), text(args)))));
    define('start', (op, args, opId) => {
        deps.startOperation(text(op), text(args), context.getNumber(opId));
        return context.undefined;
    });
    /**
     * Compiles one CommonJS module body into its wrapper function. The host compiles it rather
     * than an in-guest eval so the engine records `file` as the script name: eval'd code is named
     * `<input>`, which leaves every module's stack frames without a path and breaks packages that
     * find their binary from a stack frame (`bindings`, and anything built on it). Returns the
     * wrapper, or the compile failure's message as a string when the source does not parse.
     */
    define('compileCjs', (src, file) => {
        const result = context.evalCode(
            '(function (exports, require, module, __filename, __dirname) {' + text(src) + '\n})',
            text(file),
            { type: 'global' }
        );
        if (result.error) {
            const messageHandle = context.getProp(result.error, 'message');
            const message = context.typeof(messageHandle) === 'string' ? context.getString(messageHandle) : '';
            messageHandle.dispose();
            result.error.dispose();
            return context.newString(message);
        }
        return result.value;
    });
    define('esmLoad', (file, token) => context.newString(deps.loadEsm(text(file), context.getNumber(token))));
    define('ref', (delta) => {
        deps.holdRef(context.getNumber(delta));
        return context.undefined;
    });

    // WebAssembly: the guest engine has none, so modules compile and run here.
    const wasm = installWasmBridge(context);
    context.setProp(host, 'wasm', wasm);
    wasm.dispose();

    return host;
}

function safeRead<T>(read: () => T | undefined): T | undefined {
    try {
        return read();
    } catch {
        return undefined;
    }
}

