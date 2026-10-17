import { QuickJSContext, QuickJSHandle } from 'quickjs-emscripten';

/**
 * Host side of the container's WebAssembly support.
 *
 * The guest engine has no WebAssembly: QuickJS is built without it, so `typeof WebAssembly`
 * is 'undefined' and every package that ships a .wasm binary fails at load. The worker this
 * container runs in does have it, so the guest gets a WebAssembly whose modules are compiled
 * and run here, in the host realm, while the guest keeps objects that behave like the real ones.
 *
 * The one thing that cannot be shared is memory. A guest value lives in the QuickJS heap and a
 * host ArrayBuffer lives outside it, and quickjs-emscripten copies an ArrayBuffer in both
 * directions rather than aliasing it. So a `WebAssembly.Memory` is a host memory plus a guest
 * shadow of the same size, and the two are made equal at every call boundary: whenever control
 * crosses between guest and host -- an export being called, or an import calling back into
 * guest code -- the bytes are copied across. Inside one wasm call the module sees ordinary
 * host memory and runs at full speed; the copy is O(memory size) per boundary crossing. The
 * copy is made in chunks rather than in one piece, so the peak is one memory plus a chunk and
 * not two whole memories -- a chunk is what the guest engine can allocate, a whole memory
 * twice over is not.
 *
 * Everything else follows from that. A module compiles and links here. Its exports are host
 * functions the guest reaches through `call`. Its imports are guest values: functions the host
 * calls back into (quickjs-emscripten allows a host call into the VM while the VM is calling
 * out), and memories, tables and globals that are synced like the memory above.
 *
 * Guest functions are kept alive by `retain`: a handle given to a host function dies when that
 * function returns, so it is copied into a host-owned object that outlives the call.
 */

type SyncKind = 'mem' | 'glob' | 'tab';

interface InstanceRecord {
    instance: WebAssembly.Instance;
    memories: Set<number>;
    tables: Set<number>;
    globals: Set<number>;
    pull: number;
    push: number;
}

interface GuestThrowDetail {
    name: string;
    message: string;
    code?: string;
}

class GuestThrow extends Error {
    constructor(readonly detail: GuestThrowDetail) {
        super(detail.message);
    }
}

/** Installs `host.wasm`. Returns a handle the caller owns and must dispose after setting it. */
export function installWasmBridge(context: QuickJSContext): QuickJSHandle {
    const modules = new Map<number, WebAssembly.Module>();
    const instances = new Map<number, InstanceRecord>();
    const memories = new Map<number, WebAssembly.Memory>();
    const tables = new Map<number, WebAssembly.Table>();
    const globals = new Map<number, WebAssembly.Global>();
    const hostFns = new Map<number, (...args: number[]) => unknown>();
    /** Guest values the host must keep: a handle argument dies with the call that received it. */
    const retained = context.newObject();
    let nextId = 1;
    const freshId = () => nextId++;

    const api = context.newObject();
    const define = (name: string, impl: (...args: QuickJSHandle[]) => QuickJSHandle) => {
        const fn = context.newFunction(name, (...args: QuickJSHandle[]) => impl(...args));
        context.setProp(api, name, fn);
        fn.dispose();
    };
    const number = (handle: QuickJSHandle) => context.getNumber(handle);
    const text = (handle: QuickJSHandle) => context.getString(handle);
    const json = (value: unknown) => context.newString(JSON.stringify(value));
    const ok = (value: unknown) => json({ ok: true, value: value === undefined ? null : value });
    const fail = (code: string, message: string, props?: Record<string, unknown>) =>
        json({ ok: false, code, message, props });
    const parse = (handle: QuickJSHandle): unknown => {
        try {
            return JSON.parse(text(handle));
        } catch {
            return undefined;
        }
    };

    /** Copies a guest ArrayBuffer or typed array out of the QuickJS heap. */
    const bytesOf = (handle: QuickJSHandle): Uint8Array => {
        const lifetime = context.getArrayBuffer(handle);
        const view = lifetime.value;
        const copy = new Uint8Array(view.length);
        copy.set(view);
        lifetime.dispose();
        return copy;
    };    const bufferHandle = (bytes: Uint8Array): QuickJSHandle => context.newArrayBuffer(bytes.buffer as ArrayBuffer);

    const retainedHandle = (id: number): QuickJSHandle | undefined => {
        const handle = context.getProp(retained, String(id));
        if (context.typeof(handle) !== 'function') {
            handle.dispose();
            return undefined;
        }
        return handle;
    };

    /** Reads name/message/code off a guest error so the guest can rebuild a faithful error. */
    const detailOf = (handle: QuickJSHandle): GuestThrowDetail => {
        const read = (name: string): string | undefined => {
            const prop = context.getProp(handle, name);
            const value = context.typeof(prop) === 'string' ? context.getString(prop) : undefined;
            prop.dispose();
            return value;
        };
        return { name: read('name') ?? 'Error', message: read('message') ?? 'the import threw', code: read('code') };
    };

    /** Calls a retained guest function. Throws GuestThrow when the guest itself throws. */
    const callGuest = (id: number, args: QuickJSHandle[]): unknown => {
        const target = retainedHandle(id);
        if (!target) throw new GuestThrow({ name: 'Error', message: 'the import function is gone' });
        const result = context.callFunction(target, context.undefined, ...args);
        target.dispose();
        for (const arg of args) arg.dispose();
        if (result.error) {
            const detail = detailOf(result.error);
            result.error.dispose();
            throw new GuestThrow(detail);
        }
        const handle = result.value;
        const kind = context.typeof(handle);
        let value: unknown = null;
        if (kind === 'number') value = context.getNumber(handle);
        else if (kind === 'string') value = context.getString(handle);
        else if (kind === 'boolean') value = context.dump(handle) === true;
        handle.dispose();
        return value;
    };

    const numberArgs = (args: unknown): number[] =>
        Array.isArray(args) ? args.map((value) => (typeof value === 'number' ? value : Number(value))) : [];

    // --- memory sync --------------------------------------------------------------------

    /**
     * The size of one piece of a memory sync.
     *
     * The two sides are made equal by copying the memory across, and a copy of the whole thing
     * costs a second memory's worth of bytes for the duration of the copy: with sql.js that is
     * 32-128 MB at once, which the guest engine cannot allocate. Moving the memory in pieces
     * keeps the peak at one memory plus one chunk, and the semantics are unchanged because the
     * pieces cover the memory end to end. Measured against 256 KiB and 4 MiB at 16-2048 pages,
     * 1 MiB is within noise of the faster of the two at every size while keeping the piece
     * small: 4 MiB halves the number of crossings but doubles what is live during the copy.
     */
    const SYNC_CHUNK_BYTES = 1048576;

    const ensurePages = (memory: WebAssembly.Memory, byteLength: number) => {
        const wanted = Math.ceil(byteLength / 65536);
        const current = memory.buffer.byteLength / 65536;
        if (wanted > current) memory.grow(wanted - current);
    };

    const pullFromGuest = (record: InstanceRecord, kind: SyncKind, id: number, offset: number, length: number): unknown => {
        const target = retainedHandle(record.pull);
        if (!target) return undefined;
        const kindHandle = context.newString(kind);
        const idHandle = context.newNumber(id);
        const offsetHandle = context.newNumber(offset);
        const lengthHandle = context.newNumber(length);
        const result = context.callFunction(target, context.undefined, kindHandle, idHandle, offsetHandle, lengthHandle);
        kindHandle.dispose();
        idHandle.dispose();
        offsetHandle.dispose();
        lengthHandle.dispose();
        target.dispose();
        if (result.error) {
            result.error.dispose();
            return undefined;
        }
        const handle = result.value;
        const type = context.typeof(handle);
        let value: unknown = undefined;
        if (type === 'object') value = bytesOf(handle);
        else if (type === 'number') value = context.getNumber(handle);
        else if (type === 'string') value = context.getString(handle);
        handle.dispose();
        return value;
    };

    const pushToGuest = (record: InstanceRecord, kind: SyncKind, id: number, offset: number, make: () => QuickJSHandle) => {
        const target = retainedHandle(record.push);
        if (!target) return;
        const kindHandle = context.newString(kind);
        const idHandle = context.newNumber(id);
        const offsetHandle = context.newNumber(offset);
        const payload = make();
        const result = context.callFunction(target, context.undefined, kindHandle, idHandle, offsetHandle, payload);
        kindHandle.dispose();
        idHandle.dispose();
        offsetHandle.dispose();
        payload.dispose();
        target.dispose();
        if (result.error) result.error.dispose();
        else result.value.dispose();
    };

    /** A view over the memory's bytes. newArrayBuffer copies into the guest, so no extra copy here. */
    const hostMemoryBytes = (memory: WebAssembly.Memory): Uint8Array => new Uint8Array(memory.buffer);

    /** One piece of the memory, copied out: a view would hand the guest the whole buffer. */
    const hostMemoryChunk = (memory: WebAssembly.Memory, offset: number, length: number): Uint8Array =>
        new Uint8Array(memory.buffer, offset, length).slice();

    /**
     * guest -> host, before the host runs wasm or an import. Tables and globals need no sync:
     * the guest writes them through to the host as it sets them. Memory is the one thing the
     * guest can change invisibly, by writing into its shadow.
     *
     * The shadow is read one chunk at a time and each chunk is written straight into the host
     * memory, so at most one chunk exists outside the two memories. A chunk shorter than the
     * one asked for means the shadow ended, which is also how a zero-page memory ends.
     */
    const syncIn = (record: InstanceRecord) => {
        for (const id of record.memories) {
            const memory = memories.get(id);
            if (!memory) continue;
            let offset = 0;
            while (true) {
                const bytes = pullFromGuest(record, 'mem', id, offset, SYNC_CHUNK_BYTES);
                if (!(bytes instanceof Uint8Array) || bytes.length === 0) break;
                if (offset + bytes.length > memory.buffer.byteLength) ensurePages(memory, offset + bytes.length);
                const view = new Uint8Array(memory.buffer);
                const room = Math.max(0, view.length - offset);
                if (room > 0) view.set(bytes.subarray(0, Math.min(bytes.length, room)), offset);
                offset += bytes.length;
                if (bytes.length < SYNC_CHUNK_BYTES) break;
            }
        }
    };

    /** host -> guest, after wasm has run, a chunk at a time. */
    const syncOut = (record: InstanceRecord) => {
        for (const id of record.memories) {
            const memory = memories.get(id);
            if (!memory) continue;
            const total = memory.buffer.byteLength;
            for (let offset = 0; offset < total; offset += SYNC_CHUNK_BYTES) {
                const length = Math.min(SYNC_CHUNK_BYTES, total - offset);
                pushToGuest(record, 'mem', id, offset, () => bufferHandle(hostMemoryChunk(memory, offset, length)));
            }
        }
    };

    const tableEntriesJson = (table: WebAssembly.Table): string => {
        const entries: Array<{ i: number; k: 'fn' | 'null'; id?: number }> = [];
        for (let i = 0; i < table.length; i++) {
            const entry = table.get(i);
            if (typeof entry !== 'function') {
                entries.push({ i, k: 'null' });
                continue;
            }
            const id = freshId();
            hostFns.set(id, entry as (...args: number[]) => unknown);
            entries.push({ i, k: 'fn', id });
        }
        return JSON.stringify(entries);
    };

    /**
     * A wasm import that is a function: it may be a guest function (call back into the VM, syncing
     * memory either side of the call) or a function the host took out of a table.
     */
    const resolveImportFunction = (id: number): ((...args: number[]) => unknown) => {
        const hostFn = hostFns.get(id);
        if (hostFn) return hostFn;
        return (...args: number[]) => {
            const handles = args.map((value) => context.newNumber(value));
            return callGuest(id, handles);
        };
    };

    // --- operations ----------------------------------------------------------------------

    define('validate', (bytes) => {
        try {
            const source = bytesOf(bytes);
            return WebAssembly.validate(source) ? context.true : context.false;
        } catch {
            return context.false;
        }
    });

    define('compile', (bytes) => {
        let source: Uint8Array;
        try {
            source = bytesOf(bytes);
        } catch {
            return fail('ERR_WASM_COMPILE', 'the argument is not a typed array or ArrayBuffer');
        }
        try {
            const id = freshId();
            modules.set(id, new WebAssembly.Module(source));
            return ok(id);
        } catch (error) {
            return fail('ERR_WASM_COMPILE', error instanceof Error ? error.message : String(error));
        }
    });

    const describeModule = (module: WebAssembly.Module): string => {
        const shape = (list: readonly WebAssembly.ModuleImportDescriptor[] | readonly WebAssembly.ModuleExportDescriptor[]) =>
            list.map((entry) => ({ module: (entry as WebAssembly.ModuleImportDescriptor).module, name: entry.name, kind: entry.kind }));
        return JSON.stringify({ imports: shape(WebAssembly.Module.imports(module)), exports: shape(WebAssembly.Module.exports(module)) });
    };

    define('moduleShape', (id) => {
        const module = modules.get(number(id));
        return module ? context.newString(describeModule(module)) : fail('ERR_WASM', 'no such module');
    });

    define('instantiate', (moduleId, importsJson, pull, push) => {
        const module = modules.get(number(moduleId));
        if (!module) return fail('ERR_WASM', 'no such module');
        const descriptor = parse(importsJson) as Record<string, Record<string, { k: string; id?: number; v?: number }>> | undefined;
        const record: InstanceRecord = {
            instance: undefined as unknown as WebAssembly.Instance,
            memories: new Set(),
            tables: new Set(),
            globals: new Set(),
            pull: number(pull),
            push: number(push)
        };
        const imports: Record<string, Record<string, unknown>> = {};
        for (const [namespace, entries] of Object.entries(descriptor ?? {})) {
            const built: Record<string, unknown> = {};
            for (const [name, entry] of Object.entries(entries ?? {})) {
                if (entry.k === 'mem' && entry.id !== undefined && memories.has(entry.id)) {
                    record.memories.add(entry.id);
                    built[name] = memories.get(entry.id);
                } else if (entry.k === 'tab' && entry.id !== undefined && tables.has(entry.id)) {
                    record.tables.add(entry.id);
                    built[name] = tables.get(entry.id);
                } else if (entry.k === 'glob' && entry.id !== undefined && globals.has(entry.id)) {
                    record.globals.add(entry.id);
                    built[name] = globals.get(entry.id);
                } else if (entry.k === 'num') {
                    built[name] = entry.v;
                } else if (entry.k === 'fn' && entry.id !== undefined) {
                    built[name] = wrapImport(record, entry.id);
                }
            }
            imports[namespace] = built;
        }

        let instance: WebAssembly.Instance;
        try {
            instance = new WebAssembly.Instance(module, imports as WebAssembly.Imports);
        } catch (error) {
            return fail('ERR_WASM_LINK', error instanceof Error ? error.message : String(error));
        }
        record.instance = instance;

        const exports: Array<{ name: string; kind: string; id?: number }> = [];
        for (const entry of WebAssembly.Module.exports(module)) {
            const value = (instance.exports as Record<string, unknown>)[entry.name];
            if (value instanceof WebAssembly.Memory) {
                const id = freshId();
                memories.set(id, value);
                record.memories.add(id);
                exports.push({ name: entry.name, kind: 'memory', id });
            } else if (value instanceof WebAssembly.Table) {
                const id = freshId();
                tables.set(id, value);
                record.tables.add(id);
                exports.push({ name: entry.name, kind: 'table', id });
            } else if (value instanceof WebAssembly.Global) {
                const id = freshId();
                globals.set(id, value);
                record.globals.add(id);
                exports.push({ name: entry.name, kind: 'global', id });
            } else {
                exports.push({ name: entry.name, kind: 'function' });
            }
        }

        const id = freshId();
        instances.set(id, record);
        // The guest's shadow memories start equal to the module's, so nothing is stale at first call.
        syncOut(record);
        return ok({ id, exports });
    });

    /**
     * An import function: the module is calling out, so the memory goes the other way round
     * from an export -- the guest is shown what the module has written before the callback
     * runs, and what the guest writes comes back into the module before the module resumes.
     * A function taken out of a table runs here, on the host memory, so only the way back
     * needs a sync.
     */
    const wrapImport = (record: InstanceRecord, id: number) => {
        const hostFn = hostFns.get(id);
        if (hostFn) {
            return (...args: number[]) => {
                const value = hostFn(...args);
                syncOut(record);
                return value;
            };
        }
        return (...args: number[]) => {
            syncOut(record);
            let value: unknown;
            try {
                value = callGuest(id, args.map((arg) => context.newNumber(arg)));
            } catch (error) {
                syncIn(record);
                throw error;
            }
            syncIn(record);
            return typeof value === 'number' ? value : 0;
        };
    };

    define('call', (instanceId, name, argsJson) => {
        const record = instances.get(number(instanceId));
        if (!record) return fail('ERR_WASM', 'no such instance');
        const target = (record.instance.exports as Record<string, unknown>)[text(name)];
        if (typeof target !== 'function') return fail('ERR_WASM', 'no such export: ' + text(name));
        try {
            syncIn(record);
            const value = (target as (...args: number[]) => unknown)(...numberArgs(parse(argsJson)));
            syncOut(record);
            return ok(typeof value === 'bigint' ? Number(value) : (value ?? null));
        } catch (error) {
            if (error instanceof GuestThrow) {
                return fail('ERR_WASM_GUEST', error.detail.message, { name: error.detail.name, code: error.detail.code });
            }
            return fail('ERR_WASM_TRAP', error instanceof Error ? error.message : String(error));
        }
    });

    define('memoryNew', (initial, maximum) => {
        const pages = Math.max(0, Math.floor(number(initial)));
        const limit = Math.floor(number(maximum));
        try {
            const descriptor: WebAssembly.MemoryDescriptor = { initial: pages };
            if (limit >= 0) descriptor.maximum = limit;
            const id = freshId();
            memories.set(id, new WebAssembly.Memory(descriptor));
            return ok(id);
        } catch (error) {
            return fail('ERR_WASM', error instanceof Error ? error.message : String(error));
        }
    });
    define('memoryPages', (id) => {
        const memory = memories.get(number(id));
        return memory ? ok(memory.buffer.byteLength / 65536) : fail('ERR_WASM', 'no such memory');
    });
    define('memoryGrow', (id, delta) => {
        const memory = memories.get(number(id));
        if (!memory) return fail('ERR_WASM', 'no such memory');
        try {
            const before = memory.buffer.byteLength / 65536;
            memory.grow(Math.max(0, Math.floor(number(delta))));
            return ok(before);
        } catch (error) {
            return fail('ERR_WASM', error instanceof Error ? error.message : String(error));
        }
    });
    /**
     * Returns the host memory's bytes as an ArrayBuffer, or undefined for an unknown id. With an
     * offset and a length it returns just that piece: the guest seeds a shadow for a memory the
     * module created from these, and seeding a large one in one piece costs a second memory.
     */
    define('memoryRead', (id, offset, length) => {
        const memory = memories.get(number(id));
        if (!memory) return context.undefined;
        if (context.typeof(offset) !== 'number') return bufferHandle(hostMemoryBytes(memory));
        const total = memory.buffer.byteLength;
        const start = Math.max(0, Math.min(total, Math.floor(number(offset))));
        const size = Math.max(0, Math.min(total - start, Math.floor(number(length))));
        return bufferHandle(hostMemoryChunk(memory, start, size));
    });
    define('memoryWrite', (id, bytes) => {
        const memory = memories.get(number(id));
        if (!memory) return fail('ERR_WASM', 'no such memory');
        const source = bytesOf(bytes);
        ensurePages(memory, source.length);
        const view = new Uint8Array(memory.buffer);
        view.set(source.subarray(0, Math.min(source.length, view.length)));
        return ok(null);
    });

    define('tableNew', (element, initial, maximum) => {
        const limit = Math.floor(number(maximum));
        try {
            const descriptor: WebAssembly.TableDescriptor = { element: text(element) as 'anyfunc', initial: Math.max(0, Math.floor(number(initial))) };
            if (limit >= 0) descriptor.maximum = limit;
            const id = freshId();
            tables.set(id, new WebAssembly.Table(descriptor));
            return ok(id);
        } catch (error) {
            return fail('ERR_WASM', error instanceof Error ? error.message : String(error));
        }
    });
    define('tableLength', (id) => {
        const table = tables.get(number(id));
        return table ? ok(table.length) : fail('ERR_WASM', 'no such table');
    });
    define('tableGrow', (id, delta) => {
        const table = tables.get(number(id));
        if (!table) return fail('ERR_WASM', 'no such table');
        try {
            return ok(table.grow(Math.max(0, Math.floor(number(delta)))));
        } catch (error) {
            return fail('ERR_WASM', error instanceof Error ? error.message : String(error));
        }
    });
    define('tableGet', (id, index) => {
        const table = tables.get(number(id));
        if (!table) return fail('ERR_WASM', 'no such table');
        const entry = table.get(Math.floor(number(index)));
        if (typeof entry !== 'function') return ok({ k: 'null' });
        const fnId = freshId();
        hostFns.set(fnId, entry as (...args: number[]) => unknown);
        return ok({ k: 'fn', id: fnId });
    });
    define('tableSet', (id, index, value) => {
        const table = tables.get(number(id));
        if (!table) return fail('ERR_WASM', 'no such table');
        const entry = parse(value) as { k: string; id?: number } | undefined;
        const wanted = entry?.k === 'fn' && entry.id !== undefined ? resolveImportFunction(entry.id) : null;
        try {
            table.set(Math.floor(number(index)), wanted);
            return ok(null);
        } catch (error) {
            /*
             * A table of function type takes WebAssembly function objects only: this engine
             * refuses an ordinary JavaScript function, the way it refuses one from any host.
             * The guest keeps its function -- its own `get` still returns it, and the module
             * sees an empty slot -- so report the refusal instead of failing the set.
             */
            if (typeof wanted === 'function' && !hostFns.has(entry!.id!)) {
                return fail('ERR_WASM_TABLE_JSFN', error instanceof Error ? error.message : String(error));
            }
            return fail('ERR_WASM', error instanceof Error ? error.message : String(error));
        }
    });
    define('tableDump', (id) => {
        const table = tables.get(number(id));
        return table ? context.newString(tableEntriesJson(table)) : fail('ERR_WASM', 'no such table');
    });

    define('globalNew', (type, mutable, value) => {
        try {
            const descriptor: WebAssembly.GlobalDescriptor = { value: text(type) as 'i32', mutable: context.dump(mutable) === true };
            const id = freshId();
            const global = new WebAssembly.Global(descriptor, descriptor.value === 'i64' ? BigInt(Math.trunc(number(value))) : number(value));
            globals.set(id, global);
            return ok(id);
        } catch (error) {
            return fail('ERR_WASM', error instanceof Error ? error.message : String(error));
        }
    });
    define('globalGet', (id) => {
        const global = globals.get(number(id));
        if (!global) return fail('ERR_WASM', 'no such global');
        return ok(typeof global.value === 'bigint' ? Number(global.value) : Number(global.value));
    });
    define('globalSet', (id, value) => {
        const global = globals.get(number(id));
        if (!global) return fail('ERR_WASM', 'no such global');
        try {
            global.value = typeof global.value === 'bigint' ? BigInt(Math.trunc(number(value))) : number(value);
            return ok(null);
        } catch (error) {
            return fail('ERR_WASM', error instanceof Error ? error.message : String(error));
        }
    });

    /** Calls a function the host holds: one taken from a table, or a retained guest function. */
    define('fnCall', (id, argsJson, instanceId) => {
        const fnId = number(id);
        const hostFn = hostFns.get(fnId);
        const record = instanceId ? instances.get(number(instanceId)) : undefined;
        if (!hostFn) {
            try {
                return ok(callGuest(fnId, numberArgs(parse(argsJson)).map((value) => context.newNumber(value))));
            } catch (error) {
                if (error instanceof GuestThrow) {
                    return fail('ERR_WASM_GUEST', error.detail.message, { name: error.detail.name, code: error.detail.code });
                }
                return fail('ERR_WASM', error instanceof Error ? error.message : String(error));
            }
        }
        try {
            if (record) syncIn(record);
            const value = hostFn(...numberArgs(parse(argsJson)));
            if (record) syncOut(record);
            return ok(typeof value === 'bigint' ? Number(value) : (value ?? null));
        } catch (error) {
            if (error instanceof GuestThrow) {
                return fail('ERR_WASM_GUEST', error.detail.message, { name: error.detail.name, code: error.detail.code });
            }
            return fail('ERR_WASM_TRAP', error instanceof Error ? error.message : String(error));
        }
    });

    define('retain', (value) => {
        const id = freshId();
        context.setProp(retained, String(id), value);
        return context.newNumber(id);
    });
    define('drop', (id) => {
        context.setProp(retained, String(number(id)), context.undefined);
        hostFns.delete(number(id));
        return context.undefined;
    });
    define('dispose', (id) => {
        const key = number(id);
        modules.delete(key);
        instances.delete(key);
        memories.delete(key);
        tables.delete(key);
        globals.delete(key);
        hostFns.delete(key);
        return context.undefined;
    });

    return api;
}
