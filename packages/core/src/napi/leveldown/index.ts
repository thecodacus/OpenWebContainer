/**
 * The native binding of leveldown 6.1.1 (leveldown.node, binding.cc) and of rocksdb 5.2.1, which is a
 * rebrand of the same add-on, in JavaScript. createAddon(options) returns the 23 exports NAPI_INIT()
 * registers, with the argument, callback and error conventions of the C++ measured on Node 24.15.
 *
 * The add-on is a leveldb::DB. The shim is a sorted map over byte strings in memory (store.ts) with a
 * write-ahead log in the virtual filesystem (log.ts), compacted on open. Keys and values cross the
 * boundary as strings (UTF-8) or as any ArrayBufferView (its bytes), like ToSlice()/Entry::Convert();
 * anything else becomes the empty slice, as it does in C++.
 *
 * Async work runs on a later macrotask and calls back (undefined, ...) or (error), as
 * Napi::AsyncWorker does -- except iterator_next and iterator_seek on an ended iterator, which the
 * add-on completes in the calling tick, and db_get_property, which is synchronous.
 *
 * Divergences from the add-on, all deliberate and recorded in MANIFEST.md:
 *  - The add-on dereferences a NULL db_ after close (measured: put, get, del and batch take the
 *    process down with SIGSEGV). The shim instead calls back with Error('Database is not open').
 *  - approximateSize has no sstable/memtable split to report; it sums the entries of the range that a
 *    compaction has written, which is 0 for data still living only in the log -- as the add-on
 *    measures 0 before compactRange.
 *  - getProperty returns '' for every property but leveldb.num-files-at-level<N>, which is '0'; the
 *    add-on's multi-line leveldb.stats and leveldb.sstables tables are not reproduced.
 *  - The add-on's leveldb directory layout (CURRENT, MANIFEST, LOCK, .log, .ldb) is replaced by the
 *    single LOG file of log.ts; destroy_db therefore removes LOG, LOG.tmp and any file with a
 *    leveldb-shaped name, and leaves everything else, as leveldb::DestroyDB does.
 */
import type { ByteString } from './bytes';
import { convert, toBytes } from './bytes';
import type { BufferConstructorLike, NapiAddonOptions, NapiFileSystem } from './fs';
import { Cursor, SortedStore, forEachEntry } from './store';
import type { Snapshot } from './store';
import { MAGIC, MAGIC_LENGTH, RECORD_DEL, RECORD_PUT, RECORD_MULTI, encodeRecord, parseLog } from './log';

const NOT_FOUND = 'NotFound: ';
const NOT_OPEN = 'Database is not open';
const ITERATOR_ENDED = 'iterator has ended';
const EXTERNAL_DB = 'napi_get_value_external(env, argv[0], (void**)&database) failed!';
const EXTERNAL_ITERATOR = 'napi_get_value_external(env, argv[0], (void**)&iterator) failed!';
const EXTERNAL_BATCH = 'napi_get_value_external(env, argv[0], (void**)&batch) failed!';
const LOCATION_STRING = 'napi_get_value_string_utf8(env, argv[1], NULL, 0, &location_size) failed!';

/** The log file inside a database directory. */
const LOG_NAME = 'LOG';
const TEMP_NAME = 'LOG.tmp';

/** A busy location: leveldb holds <location>/LOCK, so a second open reports an IO error. */
const locks = new Set<string>();

interface Operation {
    type: number;
    key: ByteString;
    value: ByteString;
}

/** One MULTI record's payload: [kind, klen, vlen, key, value] per operation. */
function encodeOperations(ops: readonly Operation[]): Uint8Array {
    let size = 0;
    for (const op of ops) size += 9 + op.key.length + (op.type === RECORD_DEL ? 0 : op.value.length);
    const out = new Uint8Array(size);
    let at = 0;
    for (const op of ops) {
        const vlen = op.type === RECORD_DEL ? 0 : op.value.length;
        out[at] = op.type;
        out[at + 1] = (op.key.length >>> 24) & 0xff;
        out[at + 2] = (op.key.length >>> 16) & 0xff;
        out[at + 3] = (op.key.length >>> 8) & 0xff;
        out[at + 4] = op.key.length & 0xff;
        out[at + 5] = (vlen >>> 24) & 0xff;
        out[at + 6] = (vlen >>> 16) & 0xff;
        out[at + 7] = (vlen >>> 8) & 0xff;
        out[at + 8] = vlen & 0xff;
        at += 9;
        for (let i = 0; i < op.key.length; i++) out[at++] = op.key.charCodeAt(i);
        if (op.type !== RECORD_DEL) for (let i = 0; i < op.value.length; i++) out[at++] = op.value.charCodeAt(i);
    }
    return out;
}

function decodeOperations(payload: ByteString): Operation[] {
    const ops: Operation[] = [];
    let at = 0;
    while (at + 9 <= payload.length) {
        const type = payload.charCodeAt(at);
        const klen = ((payload.charCodeAt(at + 1) << 24) | (payload.charCodeAt(at + 2) << 16) | (payload.charCodeAt(at + 3) << 8) | payload.charCodeAt(at + 4)) >>> 0;
        const vlen = ((payload.charCodeAt(at + 5) << 24) | (payload.charCodeAt(at + 6) << 16) | (payload.charCodeAt(at + 7) << 8) | payload.charCodeAt(at + 8)) >>> 0;
        at += 9;
        if (at + klen + vlen > payload.length) break;
        const key = payload.slice(at, at + klen);
        at += klen;
        const value = payload.slice(at, at + vlen);
        at += vlen;
        ops.push({ type, key, value });
    }
    return ops;
}

/** BooleanProperty(env, options, name, default). */
function booleanOption(options: unknown, name: string, fallback: boolean): boolean {
    if (typeof options !== 'object' || options === null) return fallback;
    const value = (options as Record<string, unknown>)[name];
    return typeof value === 'boolean' ? value : fallback;
}

/** Int32Property: ToInt32, so Infinity and NaN are 0 and a fraction is truncated. */
function int32Option(options: unknown, name: string, fallback: number): number {
    if (typeof options !== 'object' || options === null) return fallback;
    const value = (options as Record<string, unknown>)[name];
    if (typeof value !== 'number') return fallback;
    if (!isFinite(value)) return 0;
    return value | 0;
}

function uint32Option(options: unknown, name: string, fallback: number): number {
    if (typeof options !== 'object' || options === null) return fallback;
    const value = (options as Record<string, unknown>)[name];
    if (typeof value !== 'number') return fallback;
    if (!isFinite(value)) return 0;
    return value >>> 0;
}

/** RangeOption: a bound is absent when the property is missing or the value has no bytes. */
function rangeOption(options: unknown, name: string): ByteString | undefined {
    if (typeof options !== 'object' || options === null) return undefined;
    if (!Object.prototype.hasOwnProperty.call(options, name)) return undefined;
    const bytes = toBytes((options as Record<string, unknown>)[name]);
    return bytes.length === 0 ? undefined : bytes;
}

/** Whether the filesystem is present; a shim loaded without one cannot touch a location. */
function fsOf(options: NapiAddonOptions | undefined): NapiFileSystem {
    const fs = options && options.fs;
    if (!fs || typeof fs.read !== 'function') throw new Error('createAddon() requires a filesystem');
    return fs;
}

class Database {
    store = new SortedStore();
    status: 'new' | 'open' | 'closed' = 'new';
    location = '';
    /** Log length in bytes, including the magic. */
    logLength = MAGIC_LENGTH;
    /** Records since the last compaction; the trigger for compacting on open. */
    records = 0;
    /** Keys written since the last compaction: what approximateSize leaves out. */
    unflushed = new Set<ByteString>();
    iterators = new Set<Iterator>();
    private readonly fs: NapiFileSystem;

    constructor(fs: NapiFileSystem) {
        this.fs = fs;
    }

    logPath(): string {
        return this.location + '/' + LOG_NAME;
    }

    /** Reads the log, replays it and, when it has grown past its contents, rewrites it. */
    load(): void {
        const bytes = this.fs.read(this.logPath());
        if (bytes === undefined) {
            this.fs.write(this.logPath(), asciiBytes(MAGIC));
            this.logLength = MAGIC_LENGTH;
            this.records = 0;
            return;
        }
        const parsed = parseLog(bytes);
        this.apply(parsed.entries);
        if (parsed.torn || parsed.badMagic) {
            // Drop the torn tail: the bytes after the last record whose CRC verifies.
            if (parsed.badMagic) {
                this.store = new SortedStore();
                this.unflushed.clear();
                this.fs.write(this.logPath(), asciiBytes(MAGIC));
                this.logLength = MAGIC_LENGTH;
            } else {
                this.fs.write(this.logPath(), bytes.subarray(0, parsed.length));
                this.logLength = parsed.length;
            }
        } else {
            this.logLength = bytes.length;
        }
        this.records = parsed.entries.length;
        this.maybeCompact();
    }

    private apply(entries: { type: number; key: ByteString; value: ByteString }[]): void {
        for (const entry of entries) {
            if (entry.type === RECORD_MULTI) {
                for (const op of decodeOperations(entry.value)) this.write(op);
            } else {
                this.write(entry);
            }
        }
    }

    private write(op: Operation): void {
        if (op.type === RECORD_DEL) {
            this.store.del(op.key);
            this.unflushed.delete(op.key);
        } else {
            this.store.put(op.key, op.value);
            this.unflushed.add(op.key);
        }
    }

    /** True when the log holds more than twice the data it describes. */
    private shouldCompact(): boolean {
        return this.logLength > 2 * this.store.bytes + 4096;
    }

    private maybeCompact(): void {
        if (this.shouldCompact()) this.compact();
    }

    /** Rewrites the log as one put record per live entry, through a temporary file and a rename. */
    compact(): void {
        const parts: Uint8Array[] = [asciiBytes(MAGIC)];
        let count = 0;
        forEachEntry(this.store.snapshot(), (key, value) => {
            parts.push(encodeRecord(RECORD_PUT, key, value));
            count++;
        });
        let size = 0;
        for (const part of parts) size += part.length;
        const file = new Uint8Array(size);
        let at = 0;
        for (const part of parts) {
            file.set(part, at);
            at += part.length;
        }
        const temp = this.location + '/' + TEMP_NAME;
        this.fs.write(temp, file);
        this.fs.rename(temp, this.logPath());
        this.logLength = size;
        this.records = count;
        this.unflushed.clear();
    }

    /** Appends records and then applies them; the store only moves once the log has them. */
    commit(ops: readonly Operation[]): void {
        if (ops.length === 0) return;
        const record = ops.length === 1 && ops[0].type !== RECORD_MULTI
            ? encodeRecord(ops[0].type, ops[0].key, ops[0].value)
            : encodeRecord(RECORD_MULTI, '', bytesToStringLatin1(encodeOperations(ops)));
        this.fs.append(this.logPath(), record);
        this.logLength += record.length;
        this.records += ops.length;
        for (const op of ops) this.write(op);
        this.maybeCompact();
    }
}

function asciiBytes(text: string): Uint8Array {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
    return out;
}

/** The bytes of a Uint8Array as a byte string; the MULTI payload is bytes, not text. */
function bytesToStringLatin1(bytes: Uint8Array): ByteString {
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
}

class Iterator {
    readonly view: Snapshot;
    readonly cursor: Cursor;
    readonly reverse: boolean;
    readonly keys: boolean;
    readonly values: boolean;
    readonly keyAsBuffer: boolean;
    readonly valueAsBuffer: boolean;
    readonly highWaterMark: number;
    readonly limit: number;
    readonly lt: ByteString | undefined;
    readonly lte: ByteString | undefined;
    readonly gt: ByteString | undefined;
    readonly gte: ByteString | undefined;
    landed = false;
    didSeek = false;
    isEnding = false;
    hasEnded = false;
    count = 0;
    /** The entries the last ReadMany produced, as [key, value, key, value, ...]. */
    cache: ByteString[] = [];

    constructor(database: Database, options: unknown) {
        this.view = database.store.snapshot();
        this.cursor = new Cursor(this.view);
        this.reverse = booleanOption(options, 'reverse', false);
        this.keys = booleanOption(options, 'keys', true);
        this.values = booleanOption(options, 'values', true);
        this.keyAsBuffer = booleanOption(options, 'keyAsBuffer', true);
        this.valueAsBuffer = booleanOption(options, 'valueAsBuffer', true);
        this.limit = int32Option(options, 'limit', -1);
        this.highWaterMark = uint32Option(options, 'highWaterMark', 16 * 1024);
        this.lt = rangeOption(options, 'lt');
        this.lte = rangeOption(options, 'lte');
        this.gt = rangeOption(options, 'gt');
        this.gte = rangeOption(options, 'gte');
    }

    /** BaseIterator::OutOfRange: lt is exclusive, lte inclusive, gt exclusive, gte inclusive. */
    outOfRange(target: ByteString): boolean {
        return (
            (this.lt !== undefined && target >= this.lt) ||
            (this.lte !== undefined && target > this.lte) ||
            (this.gt !== undefined && target <= this.gt) ||
            (this.gte !== undefined && target < this.gte)
        );
    }

    valid(): boolean {
        return this.cursor.valid() && !this.outOfRange(this.cursor.key());
    }

    /** One step in iteration order: BaseIterator::Next. */
    advance(): void {
        if (this.reverse) this.cursor.prev();
        else this.cursor.next();
    }

    /** The first entry in iteration order. */
    startOfOrder(): void {
        if (this.reverse) this.cursor.seekToLast();
        else this.cursor.seekToFirst();
    }

    /** The last entry in iteration order: BaseIterator::SeekToLast. */
    endOfOrder(): void {
        if (this.reverse) this.cursor.seekToFirst();
        else this.cursor.seekToLast();
    }

    /** One past the last entry in iteration order: BaseIterator::SeekToEnd. */
    end(): void {
        this.endOfOrder();
        this.advance();
    }

    /** BaseIterator::Increment: limit_ < 0 is unlimited; 0 yields nothing. */
    increment(): boolean {
        return this.limit < 0 || ++this.count <= this.limit;
    }

    /**
     * BaseIterator::SeekToRange. gte beats gt, lte beats lt. The bound branches move the raw cursor --
     * Seek to the first key >= the bound, Prev when that overshoots -- and only the two unbounded
     * branches and the two fallbacks use the iteration-order helpers above.
     */
    seekToRange(): void {
        this.didSeek = true;
        if (!this.reverse && this.gte !== undefined) {
            this.cursor.seek(this.gte);
        } else if (!this.reverse && this.gt !== undefined) {
            this.cursor.seek(this.gt);
            if (this.cursor.valid() && this.cursor.key() === this.gt) this.cursor.next();
        } else if (this.reverse && this.lte !== undefined) {
            this.cursor.seek(this.lte);
            if (!this.cursor.valid()) this.cursor.seekToLast();
            else if (this.cursor.key() > this.lte) this.cursor.prev();
        } else if (this.reverse && this.lt !== undefined) {
            this.cursor.seek(this.lt);
            if (!this.cursor.valid()) this.cursor.seekToLast();
            else if (this.cursor.key() >= this.lt) this.cursor.prev();
        } else if (this.reverse) {
            this.cursor.seekToLast();
        } else {
            this.cursor.seekToFirst();
        }
    }

    /** BaseIterator::Seek: a raw seek, then one step when the landing key is the wrong side. */
    seek(target: ByteString): void {
        this.didSeek = true;
        if (this.outOfRange(target)) return this.end();
        this.cursor.seek(target);
        if (this.cursor.valid()) {
            const key = this.cursor.key();
            if (this.reverse ? key > target : key < target) this.advance();
        } else {
            this.startOfOrder();
            if (this.cursor.valid()) {
                const key = this.cursor.key();
                if (this.reverse ? key > target : key < target) this.end();
            }
        }
    }
}

class Batch {
    ops: Operation[] = [];
    constructor(readonly database: Database) {}
}

/** Napi::AsyncWorker: run on a later macrotask, then call back (undefined, ...) or (error). */
function queueWork(callback: unknown, execute: () => unknown): void {
    setImmediate(() => {
        let result: unknown;
        try {
            result = execute();
        } catch (error) {
            (callback as (err: unknown) => void)(error);
            return;
        }
        (callback as (err: null, ...rest: unknown[]) => void)(null, ...(result as unknown[]));
    });
}

/** A binding function as Napi::Function::New makes it: no name, any arguments. */
function napiFunction(impl: (args: IArguments) => unknown): Function {
    const fn = function () {
        return impl(arguments as unknown as IArguments);
    };
    Object.defineProperty(fn, 'name', { value: '' });
    return fn;
}

function databaseOf(value: unknown): Database {
    if (!(value instanceof Database)) throw new Error(EXTERNAL_DB);
    return value;
}

function iteratorOf(value: unknown): Iterator {
    if (!(value instanceof Iterator)) throw new Error(EXTERNAL_ITERATOR);
    return value;
}

function batchOf(value: unknown): Batch {
    if (!(value instanceof Batch)) throw new Error(EXTERNAL_BATCH);
    return value;
}

export function createAddon(options?: NapiAddonOptions): object {
    const fs = fsOf(options);
    const B = (options && options.Buffer) || (globalThis as { Buffer?: BufferConstructorLike }).Buffer;
    if (!B || typeof B.from !== 'function') throw new Error('createAddon() requires a Buffer constructor');

    const convertOut = (s: ByteString, asBuffer: boolean): Uint8Array | string => convert(B, s, asBuffer);

    /** Iterator::ReadMany(size = 1000). Returns whether there is more to read. */
    function readMany(iterator: Iterator): boolean {
        const cache: ByteString[] = [];
        let bytesRead = 0;
        while (true) {
            if (iterator.landed) iterator.advance();
            if (!iterator.valid() || !iterator.increment()) break;
            if (iterator.keys) {
                cache.push(iterator.cursor.key());
                bytesRead += iterator.cursor.key().length;
            } else {
                cache.push('');
            }
            if (iterator.values) {
                cache.push(iterator.cursor.value());
                bytesRead += iterator.cursor.value().length;
            } else {
                cache.push('');
            }
            iterator.cache = cache;
            if (!iterator.landed) {
                iterator.landed = true;
                return true;
            }
            if (bytesRead > iterator.highWaterMark || cache.length >= 2000) return true;
        }
        iterator.cache = cache;
        return false;
    }

    function dbInit(): Database {
        return new Database(fs);
    }

    function dbOpen(args: IArguments): undefined {
        const database = databaseOf(args[0]);
        if (typeof args[1] !== 'string') throw new Error(LOCATION_STRING);
        const location = args[1];
        const options = args[2];
        const callback = args[3];
        queueWork(callback, () => {
            const createIfMissing = booleanOption(options, 'createIfMissing', true);
            const errorIfExists = booleanOption(options, 'errorIfExists', false);
            if (locks.has(location)) throw new Error(`IO error: lock ${location}/LOCK: already held by process`);
            const kind = fs.stat(location);
            if (kind === undefined) {
                if (!createIfMissing) throw new Error(`Invalid argument: ${location}: does not exist (create_if_missing is false)`);
                try {
                    fs.mkdir(location);
                } catch (error) {
                    throw new Error(`IO error: ${location}/LOCK: No such file or directory`);
                }
            } else if (kind !== 'dir') {
                throw new Error(`IO error: ${location}/LOCK: Not a directory`);
            }
            const exists = fs.stat(location + '/' + LOG_NAME) !== undefined;
            if (exists && errorIfExists) throw new Error(`Invalid argument: ${location}: exists (error_if_exists is true)`);
            database.location = location;
            database.load();
            database.status = 'open';
            locks.add(location);
            return [];
        });
        return undefined;
    }

    function dbClose(args: IArguments): undefined {
        const database = databaseOf(args[0]);
        const callback = args[1];
        queueWork(callback, () => {
            for (const iterator of database.iterators) {
                iterator.isEnding = true;
                iterator.hasEnded = true;
            }
            database.iterators.clear();
            database.status = 'closed';
            locks.delete(database.location);
            return [];
        });
        return undefined;
    }

    /** Everything but open, close and get_property needs an open database. */
    function openDatabase(database: Database): void {
        if (database.status !== 'open') throw new Error(NOT_OPEN);
    }

    function dbPut(args: IArguments): undefined {
        const database = databaseOf(args[0]);
        const callback = args[4];
        const key = toBytes(args[1]);
        const value = toBytes(args[2]);
        queueWork(callback, () => {
            openDatabase(database);
            database.commit([{ type: RECORD_PUT, key, value }]);
            return [];
        });
        return undefined;
    }

    function dbGet(args: IArguments): undefined {
        const database = databaseOf(args[0]);
        const callback = args[3];
        const key = toBytes(args[1]);
        const asBuffer = booleanOption(args[2], 'asBuffer', true);
        queueWork(callback, () => {
            openDatabase(database);
            const value = database.store.get(key);
            if (value === undefined) throw new Error(NOT_FOUND);
            return [convertOut(value, asBuffer)];
        });
        return undefined;
    }

    function dbGetMany(args: IArguments): undefined {
        const database = databaseOf(args[0]);
        const callback = args[3];
        const keys = Array.isArray(args[1]) ? args[1].map(toBytes) : [];
        const asBuffer = booleanOption(args[2], 'asBuffer', true);
        queueWork(callback, () => {
            openDatabase(database);
            const values = keys.map((key) => {
                const value = database.store.get(key);
                return value === undefined ? undefined : convertOut(value, asBuffer);
            });
            return [values];
        });
        return undefined;
    }

    function dbDel(args: IArguments): undefined {
        const database = databaseOf(args[0]);
        const callback = args[3];
        const key = toBytes(args[1]);
        queueWork(callback, () => {
            openDatabase(database);
            database.commit([{ type: RECORD_DEL, key, value: '' }]);
            return [];
        });
        return undefined;
    }

    /** leveldb's clear is an iterator scan with chunked deletes; ours is one atomic batch. */
    function dbClear(args: IArguments): undefined {
        const database = databaseOf(args[0]);
        const options = args[1];
        const callback = args[2];
        queueWork(callback, () => {
            openDatabase(database);
            const iterator = new Iterator(database, options);
            iterator.seekToRange();
            const ops: Operation[] = [];
            while (iterator.valid() && iterator.increment()) {
                ops.push({ type: RECORD_DEL, key: iterator.cursor.key(), value: '' });
                iterator.advance();
            }
            database.commit(ops);
            return [];
        });
        return undefined;
    }

    function dbApproximateSize(args: IArguments): undefined {
        const database = databaseOf(args[0]);
        const callback = args[3];
        const start = toBytes(args[1]);
        const end = toBytes(args[2]);
        queueWork(callback, () => {
            openDatabase(database);
            let size = 0;
            forEachEntry(database.store.snapshot(), (key, value) => {
                if (key < start || key >= end) return;
                if (database.unflushed.has(key)) return;
                size += key.length + value.length;
            });
            return [size];
        });
        return undefined;
    }

    function dbCompactRange(args: IArguments): undefined {
        const database = databaseOf(args[0]);
        const callback = args[3];
        queueWork(callback, () => {
            openDatabase(database);
            database.compact();
            return [];
        });
        return undefined;
    }

    /** Synchronous, as in C++: the only export with no worker. */
    function dbGetProperty(args: IArguments): string {
        const database = databaseOf(args[0]);
        openDatabase(database);
        const property = typeof args[1] === 'string' ? args[1] : '';
        const match = /^leveldb\.num-files-at-level(\d+)$/.exec(property);
        return match === null ? '' : '0';
    }

    /** leveldb::DestroyDB: leveldb-shaped files go, everything else stays. */
    function destroyDb(args: IArguments): undefined {
        const callback = args[1];
        const location = typeof args[0] === 'string' ? args[0] : '';
        queueWork(callback, () => {
            if (locks.has(location)) throw new Error(`IO error: lock ${location}/LOCK: already held by process`);
            const names = fs.readdir(location);
            if (names === undefined) return [];
            for (const name of names) {
                if (isDatabaseFile(name)) fs.unlink(location + '/' + name);
            }
            if ((fs.readdir(location) || []).length === 0) fs.rmdir(location);
            return [];
        });
        return undefined;
    }

    /** leveldb::RepairDB: replay what is recoverable and rewrite; a torn tail is dropped. */
    function repairDb(args: IArguments): undefined {
        const callback = args[1];
        const location = typeof args[0] === 'string' ? args[0] : '';
        queueWork(callback, () => {
            const database = new Database(fs);
            const kind = fs.stat(location);
            if (kind === undefined) return [];
            if (kind !== 'dir') throw new Error(`IO error: ${location}/LOCK: Not a directory`);
            database.location = location;
            database.load();
            database.compact();
            return [];
        });
        return undefined;
    }

    function iteratorInit(args: IArguments): Iterator {
        const database = databaseOf(args[0]);
        openDatabase(database);
        const iterator = new Iterator(database, args[1]);
        database.iterators.add(iterator);
        return iterator;
    }

    function iteratorSeek(args: IArguments): undefined {
        const iterator = iteratorOf(args[0]);
        if (iterator.isEnding || iterator.hasEnded) throw new Error(ITERATOR_ENDED);
        iterator.landed = false;
        iterator.seek(toBytes(args[1]));
        return undefined;
    }

    function iteratorNext(args: IArguments): undefined {
        const iterator = iteratorOf(args[0]);
        const callback = args[1];
        if (iterator.isEnding || iterator.hasEnded) {
            (callback as (err: Error) => void)(new Error(ITERATOR_ENDED));
            return undefined;
        }
        queueWork(callback, () => {
            if (!iterator.didSeek) iterator.seekToRange();
            const ok = readMany(iterator);
            const cache = iterator.cache;
            const size = cache.length;
            const array = new Array(size);
            for (let idx = 0; idx < size; idx += 2) {
                array[size - idx - 1] = convertOut(cache[idx], iterator.keyAsBuffer);
                array[size - idx - 2] = convertOut(cache[idx + 1], iterator.valueAsBuffer);
            }
            return [array, !ok];
        });
        return undefined;
    }

    function iteratorEnd(args: IArguments): undefined {
        const iterator = iteratorOf(args[0]);
        const callback = args[1];
        if (!iterator.isEnding && !iterator.hasEnded) {
            iterator.isEnding = true;
            queueWork(callback, () => {
                iterator.hasEnded = true;
                return [];
            });
        }
        // A second end() never calls back, as the add-on queues no second worker.
        return undefined;
    }

    function batchInit(args: IArguments): Batch {
        const database = databaseOf(args[0]);
        return new Batch(database);
    }

    function batchPut(args: IArguments): undefined {
        const batch = batchOf(args[0]);
        batch.ops.push({ type: RECORD_PUT, key: toBytes(args[1]), value: toBytes(args[2]) });
        return undefined;
    }

    function batchDel(args: IArguments): undefined {
        const batch = batchOf(args[0]);
        batch.ops.push({ type: RECORD_DEL, key: toBytes(args[1]), value: '' });
        return undefined;
    }

    function batchClear(args: IArguments): undefined {
        const batch = batchOf(args[0]);
        batch.ops.length = 0;
        return undefined;
    }

    function batchWrite(args: IArguments): undefined {
        const batch = batchOf(args[0]);
        const callback = args[2];
        const ops = batch.ops.slice();
        queueWork(callback, () => {
            openDatabase(batch.database);
            batch.database.commit(ops);
            return [];
        });
        return undefined;
    }

    /**
     * batch_do reads only type, key and value off each element and silently skips anything else, so an
     * unrecognised type, a missing key or a non-object element writes nothing at all.
     */
    function batchDo(args: IArguments): undefined {
        const database = databaseOf(args[0]);
        const callback = args[3];
        const array = args[1];
        const ops: Operation[] = [];
        if (Array.isArray(array)) {
            for (const element of array) {
                if (typeof element !== 'object' || element === null) continue;
                const record = element as Record<string, unknown>;
                if (record.type === 'del') {
                    if (!Object.prototype.hasOwnProperty.call(record, 'key')) continue;
                    ops.push({ type: RECORD_DEL, key: toBytes(record.key), value: '' });
                } else if (record.type === 'put') {
                    if (!Object.prototype.hasOwnProperty.call(record, 'key')) continue;
                    if (!Object.prototype.hasOwnProperty.call(record, 'value')) continue;
                    ops.push({ type: RECORD_PUT, key: toBytes(record.key), value: toBytes(record.value) });
                }
            }
        }
        queueWork(callback, () => {
            openDatabase(database);
            database.commit(ops);
            return [];
        });
        return undefined;
    }

    return {
        db_init: napiFunction(dbInit),
        db_open: napiFunction(dbOpen),
        db_close: napiFunction(dbClose),
        db_put: napiFunction(dbPut),
        db_get: napiFunction(dbGet),
        db_get_many: napiFunction(dbGetMany),
        db_del: napiFunction(dbDel),
        db_clear: napiFunction(dbClear),
        db_approximate_size: napiFunction(dbApproximateSize),
        db_compact_range: napiFunction(dbCompactRange),
        db_get_property: napiFunction(dbGetProperty),
        destroy_db: napiFunction(destroyDb),
        repair_db: napiFunction(repairDb),
        iterator_init: napiFunction(iteratorInit),
        iterator_seek: napiFunction(iteratorSeek),
        iterator_end: napiFunction(iteratorEnd),
        iterator_next: napiFunction(iteratorNext),
        batch_do: napiFunction(batchDo),
        batch_init: napiFunction(batchInit),
        batch_put: napiFunction(batchPut),
        batch_del: napiFunction(batchDel),
        batch_clear: napiFunction(batchClear),
        batch_write: napiFunction(batchWrite)
    };
}

/** The file names leveldb::DestroyDB recognises, plus this shim's own log. */
function isDatabaseFile(name: string): boolean {
    return (
        name === LOG_NAME ||
        name === TEMP_NAME ||
        name === 'LOCK' ||
        name === 'CURRENT' ||
        name === 'LOG.old' ||
        /^MANIFEST-\d+$/.test(name) ||
        /^\d+\.(log|ldb|sst|dbtmp)$/.test(name)
    );
}
