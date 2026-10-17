/*
 * better-sqlite3@11.5.0 native add-on (better_sqlite3.node) reimplemented in plain JavaScript.
 *
 * createAddon() returns the object the add-on's JavaScript wrapper (lib/database.js) expects from
 * require('bindings')('better_sqlite3.node'): { Database, Statement, StatementIterator, Backup,
 * setErrorConstructor }. The SQL engine is SQLite 3.47.0 -- the exact amalgamation better-sqlite3
 * 11.5.0 bundles, compiled with its compile-time options -- transpiled to plain JavaScript by
 * Emscripten wasm2js (./sqlite3-engine.cjs, built by engine/build-engine.mjs). No WebAssembly,
 * no native code, no Node-only module is used at run time.
 *
 * Every method below is a port of the corresponding C++ function in better-sqlite3 11.5.0
 * src/better_sqlite3.cpp (lzz sources src/objects/*.lzz, src/util/*.lzz): argument checks, error
 * messages, return shapes, the statement/iterator busy-lock lifecycle and the binder are kept
 * literally. Where the C++ relies on V8 pending exceptions (was_js_error), the shim stores the
 * JavaScript error and rethrows it after SQLite has unwound.
 *
 * Files: database files are read and written as whole files. The host hands createAddon() the narrow
 * NAPI_HOST.fs surface (read/write/append/rename/unlink/mkdir/rmdir/readdir/stat -- the same one
 * src/napi/leveldown/fs.ts documents); a node:fs-like object is accepted as well, so the shim also
 * runs under Node unchanged. Either is adapted to one whole-file API below: readFileSync,
 * writeFileSync, existsSync, statSync, unlinkSync, and no realpathSync, which the host surface has
 * no equivalent of. Open files are held in memory, shared by every connection of this add-on
 * instance, and written back on xSync, on unlock below RESERVED and on the last close.
 */
// The engine is a generated CommonJS module (module.exports = createSqliteEngine).
import createSqliteEngine from './sqlite3-engine.cjs';

/* ------------------------------------------------------------------ environment */

export interface AddonFs {
  readFileSync(path: string): Uint8Array;
  writeFileSync(path: string, data: Uint8Array): void;
  existsSync(path: string): boolean;
  statSync(path: string): { size: number; isFile(): boolean; isDirectory(): boolean };
  unlinkSync(path: string): void;
  realpathSync?(path: string): string;
}

/**
 * What the container actually provides (NAPI_HOST.fs in runtime/guest/globals.ts): byte-level
 * operations over the virtual filesystem, resolved against the guest's cwd, with no encodings,
 * streams or descriptors. See src/napi/leveldown/fs.ts for the contract each one keeps:
 * read() returns undefined for a missing file, stat() returns 'file'/'dir'/undefined, write()
 * replaces the whole file and fails when a parent directory is missing, unlink() of a missing file
 * is not an error. There is no size and no realpath.
 */
export interface NapiHostFs {
  read(path: string): Uint8Array | undefined;
  write(path: string, bytes: Uint8Array): void;
  append(path: string, bytes: Uint8Array): void;
  rename(from: string, to: string): void;
  unlink(path: string): void;
  mkdir(path: string): void;
  rmdir(path: string): void;
  readdir(path: string): string[] | undefined;
  stat(path: string): string | undefined;
}

export interface AddonEnv {
  fs?: AddonFs | NapiHostFs;
  cwd?: () => string;
}

/* The host surface is not node:fs, and node:fs is not the host surface; tell the two apart by the
 * one operation only node:fs spells this way. */
function isNodeFsLike(fs: any): boolean {
  return typeof fs.readFileSync === 'function' && typeof fs.writeFileSync === 'function';
}

function enoent(path: string): Error {
  const e: any = new Error("ENOENT: no such file or directory, open '" + path + "'");
  e.code = 'ENOENT';
  e.errno = -2;
  e.syscall = 'open';
  e.path = path;
  return e;
}

/** Adapts either filesystem to the whole-file API the VFS below is written against. */
function asAddonFs(fs: any): AddonFs {
  if (isNodeFsLike(fs)) return fs as AddonFs;
  const h = fs as NapiHostFs;
  return {
    readFileSync(path: string): Uint8Array {
      const bytes = h.read(path);
      if (bytes === undefined || bytes === null) throw enoent(path);
      return bytes;
    },
    writeFileSync(path: string, data: Uint8Array): void {
      h.write(path, data instanceof Uint8Array ? data : new Uint8Array(data));
    },
    existsSync(path: string): boolean {
      return h.stat(path) !== undefined;
    },
    statSync(path: string): { size: number; isFile(): boolean; isDirectory(): boolean } {
      const kind = h.stat(path);
      if (kind === undefined) throw enoent(path);
      const isDirectory = kind === 'dir';
      const st: { size: number; isFile(): boolean; isDirectory(): boolean } = {
        size: 0, isFile: () => !isDirectory, isDirectory: () => isDirectory,
      };
      // The host surface has no size. SQLite only asks for it to tell an empty database from a
      // missing one, so read it on demand rather than on every stat of a large file.
      Object.defineProperty(st, 'size', {
        get: () => { const bytes = h.read(path); return bytes === undefined || bytes === null ? 0 : bytes.length; },
        enumerable: true, configurable: true,
      });
      return st;
    },
    unlinkSync(path: string): void { h.unlink(path); },
    // No realpathSync: the host resolves a path the way fullPathname() already does, lexically
    // against the guest's cwd, so the lexical absolute path is its realpath here.
  };
}

declare const requireBuiltin: ((name: string) => unknown) | undefined;
declare const require: ((name: string) => unknown) | undefined;

function resolveBuiltin(name: string): any {
  // OWC guest bundles receive requireBuiltin from the bootstrap scope; Node 22.3+ has
  // process.getBuiltinModule; plain CommonJS has require.
  if (typeof requireBuiltin === 'function') return requireBuiltin(name);
  const proc: any = (globalThis as any).process;
  if (proc && typeof proc.getBuiltinModule === 'function') return proc.getBuiltinModule(name);
  if (typeof require === 'function') return require(name);
  throw new Error('better-sqlite3 shim: no module loader available for "' + name + '"');
}

/* -------------------------------------------------------------------- constants */

const SQLITE_OK = 0;
const SQLITE_ERROR = 1;
const SQLITE_BUSY = 5;
const SQLITE_NOMEM = 7;
const SQLITE_CANTOPEN = 14;
const SQLITE_CONSTRAINT = 19;
const SQLITE_TOOBIG = 18;
const SQLITE_RANGE = 25;
const SQLITE_ROW = 100;
const SQLITE_DONE = 101;
const SQLITE_IOERR_SHORT_READ = 522;
const SQLITE_IOERR_WRITE = 778;
const SQLITE_IOERR_FSYNC = 1034;
const SQLITE_IOERR_DELETE = 2570;
const SQLITE_IOERR_DELETE_NOENT = 5898;
const SQLITE_IOERR_ACCESS = 3338;

const SQLITE_INTEGER = 1;
const SQLITE_FLOAT = 2;
const SQLITE_TEXT = 3;
const SQLITE_BLOB = 4;

const SQLITE_OPEN_READONLY = 0x1;
const SQLITE_OPEN_READWRITE = 0x2;
const SQLITE_OPEN_CREATE = 0x4;
const SQLITE_OPEN_DELETEONCLOSE = 0x8;
const SQLITE_OPEN_EXCLUSIVE = 0x10;

const SQLITE_UTF8 = 1;
const SQLITE_DETERMINISTIC = 0x800;
const SQLITE_DIRECTONLY = 0x80000;
const SQLITE_LIMIT_LENGTH = 0;
const SQLITE_LIMIT_SQL_LENGTH = 1;
const SQLITE_DBCONFIG_ENABLE_LOAD_EXTENSION = 1005;
const SQLITE_DBCONFIG_DEFENSIVE = 1010;
const SQLITE_PREPARE_PERSISTENT = 0x01;
const SQLITE_DESERIALIZE_FREEONCLOSE = 1;
const SQLITE_DESERIALIZE_RESIZEABLE = 2;
const SQLITE_DESERIALIZE_READONLY = 4;
const SQLITE_TRANSIENT = -1;

const SQLITE_LOCK_NONE = 0;
const SQLITE_LOCK_SHARED = 1;
const SQLITE_LOCK_RESERVED = 2;
const SQLITE_LOCK_PENDING = 3;
const SQLITE_LOCK_EXCLUSIVE = 4;
const SQLITE_SHM_UNLOCK = 1;
const SQLITE_SHM_LOCK = 2;
const SQLITE_SHM_SHARED = 4;
const SQLITE_SHM_EXCLUSIVE = 8;
const SQLITE_SHM_NLOCK = 8;
const SQLITE_ACCESS_EXISTS = 0;

// Database::MAX_BUFFER_SIZE / MAX_STRING_SIZE on Node 24.15 (64-bit): node::Buffer::kMaxLength is
// 2^53-1 (> INT_MAX, so INT_MAX), v8::String::kMaxLength is 2^29-24. Measured, see the record.
const INT_MAX = 2147483647;
const MAX_BUFFER_SIZE = INT_MAX;
const MAX_STRING_SIZE = 536870888;
const USHRT_MAX = 65535;

// CS::CS (src/util/constants.lzz): the code -> name table, verbatim and in the same order.
const CODE_NAMES: Map<number, string> = new Map([
  [0, 'SQLITE_OK'], [1, 'SQLITE_ERROR'], [2, 'SQLITE_INTERNAL'], [3, 'SQLITE_PERM'], [4, 'SQLITE_ABORT'],
  [5, 'SQLITE_BUSY'], [6, 'SQLITE_LOCKED'], [7, 'SQLITE_NOMEM'], [8, 'SQLITE_READONLY'],
  [9, 'SQLITE_INTERRUPT'], [10, 'SQLITE_IOERR'], [11, 'SQLITE_CORRUPT'], [12, 'SQLITE_NOTFOUND'],
  [13, 'SQLITE_FULL'], [14, 'SQLITE_CANTOPEN'], [15, 'SQLITE_PROTOCOL'], [16, 'SQLITE_EMPTY'],
  [17, 'SQLITE_SCHEMA'], [18, 'SQLITE_TOOBIG'], [19, 'SQLITE_CONSTRAINT'], [20, 'SQLITE_MISMATCH'],
  [21, 'SQLITE_MISUSE'], [22, 'SQLITE_NOLFS'], [23, 'SQLITE_AUTH'], [24, 'SQLITE_FORMAT'],
  [25, 'SQLITE_RANGE'], [26, 'SQLITE_NOTADB'], [27, 'SQLITE_NOTICE'], [28, 'SQLITE_WARNING'],
  [100, 'SQLITE_ROW'], [101, 'SQLITE_DONE'], [266, 'SQLITE_IOERR_READ'], [522, 'SQLITE_IOERR_SHORT_READ'],
  [778, 'SQLITE_IOERR_WRITE'], [1034, 'SQLITE_IOERR_FSYNC'], [1290, 'SQLITE_IOERR_DIR_FSYNC'],
  [1546, 'SQLITE_IOERR_TRUNCATE'], [1802, 'SQLITE_IOERR_FSTAT'], [2058, 'SQLITE_IOERR_UNLOCK'],
  [2314, 'SQLITE_IOERR_RDLOCK'], [2570, 'SQLITE_IOERR_DELETE'], [2826, 'SQLITE_IOERR_BLOCKED'],
  [3082, 'SQLITE_IOERR_NOMEM'], [3338, 'SQLITE_IOERR_ACCESS'], [3594, 'SQLITE_IOERR_CHECKRESERVEDLOCK'],
  [3850, 'SQLITE_IOERR_LOCK'], [4106, 'SQLITE_IOERR_CLOSE'], [4362, 'SQLITE_IOERR_DIR_CLOSE'],
  [4618, 'SQLITE_IOERR_SHMOPEN'], [4874, 'SQLITE_IOERR_SHMSIZE'], [5130, 'SQLITE_IOERR_SHMLOCK'],
  [5386, 'SQLITE_IOERR_SHMMAP'], [5642, 'SQLITE_IOERR_SEEK'], [5898, 'SQLITE_IOERR_DELETE_NOENT'],
  [6154, 'SQLITE_IOERR_MMAP'], [6410, 'SQLITE_IOERR_GETTEMPPATH'], [6666, 'SQLITE_IOERR_CONVPATH'],
  [6922, 'SQLITE_IOERR_VNODE'], [7178, 'SQLITE_IOERR_AUTH'], [262, 'SQLITE_LOCKED_SHAREDCACHE'],
  [261, 'SQLITE_BUSY_RECOVERY'], [517, 'SQLITE_BUSY_SNAPSHOT'], [270, 'SQLITE_CANTOPEN_NOTEMPDIR'],
  [526, 'SQLITE_CANTOPEN_ISDIR'], [782, 'SQLITE_CANTOPEN_FULLPATH'], [1038, 'SQLITE_CANTOPEN_CONVPATH'],
  [267, 'SQLITE_CORRUPT_VTAB'], [264, 'SQLITE_READONLY_RECOVERY'], [520, 'SQLITE_READONLY_CANTLOCK'],
  [776, 'SQLITE_READONLY_ROLLBACK'], [1032, 'SQLITE_READONLY_DBMOVED'], [516, 'SQLITE_ABORT_ROLLBACK'],
  [275, 'SQLITE_CONSTRAINT_CHECK'], [531, 'SQLITE_CONSTRAINT_COMMITHOOK'],
  [787, 'SQLITE_CONSTRAINT_FOREIGNKEY'], [1043, 'SQLITE_CONSTRAINT_FUNCTION'],
  [1299, 'SQLITE_CONSTRAINT_NOTNULL'], [1555, 'SQLITE_CONSTRAINT_PRIMARYKEY'],
  [1811, 'SQLITE_CONSTRAINT_TRIGGER'], [2067, 'SQLITE_CONSTRAINT_UNIQUE'], [2323, 'SQLITE_CONSTRAINT_VTAB'],
  [2579, 'SQLITE_CONSTRAINT_ROWID'], [283, 'SQLITE_NOTICE_RECOVER_WAL'],
  [539, 'SQLITE_NOTICE_RECOVER_ROLLBACK'], [284, 'SQLITE_WARNING_AUTOINDEX'], [279, 'SQLITE_AUTH_USER'],
  [256, 'SQLITE_OK_LOAD_PERMANENTLY'],
]);

function codeName(code: number): string {
  const name = CODE_NAMES.get(code);
  return name !== undefined ? name : 'UNKNOWN_SQLITE_ERROR_' + code;
}

/* ------------------------------------------------------------------- utilities */

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth'];

function isInt32(v: unknown): v is number {
  return typeof v === 'number' && (v | 0) === v && !Object.is(v, -0);
}
function isObjectLike(v: unknown): boolean {
  return (typeof v === 'object' && v !== null) || typeof v === 'function';
}
function isBufferLike(v: unknown): v is ArrayBufferView {
  // node::Buffer::HasInstance() is IsArrayBufferView(): any typed array or DataView.
  return ArrayBuffer.isView(v);
}
function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
function expectArg(args: IArguments | unknown[], i: number, check: (v: unknown) => boolean, what: string): void {
  if (args.length <= i || !check(args[i])) {
    throw new TypeError('Expected ' + ORDINALS[i] + ' argument to be ' + what);
  }
}
function expectPresent(args: IArguments | unknown[], i: number): void {
  if (args.length <= i) throw new TypeError('Expected a ' + ORDINALS[i] + ' argument');
}
const isString = (v: unknown) => typeof v === 'string';
const isBoolean = (v: unknown) => typeof v === 'boolean';
const isFunction = (v: unknown) => typeof v === 'function';
const isObject = (v: unknown) => isObjectLike(v);

function setFrozen(obj: object, key: string, value: unknown): void {
  // SetFrozen(): DefineOwnProperty with DontDelete | ReadOnly (enumerable).
  Object.defineProperty(obj, key, { value, writable: false, enumerable: true, configurable: false });
}
function makePrototypeEnumerable(cls: Function, names: string[]): void {
  // FunctionTemplate PrototypeTemplate()->Set(name, fn) installs enumerable methods.
  for (const name of names) {
    const desc = Object.getOwnPropertyDescriptor(cls.prototype, name)!;
    desc.enumerable = true;
    Object.defineProperty(cls.prototype, name, desc);
  }
}

/* UTF-8 with V8 semantics: String::Utf8Value replaces lone surrogates with U+FFFD; NewFromUtf8
 * decodes with WHATWG replacement of maximal subparts. */
function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { n += 4; i++; } else n += 3;
    } else n += 3;
  }
  return n;
}
function utf8Write(s: string, heap: Uint8Array, p: number): number {
  const start = p;
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) { heap[p++] = c; continue; }
    if (c < 0x800) { heap[p++] = 0xc0 | (c >> 6); heap[p++] = 0x80 | (c & 63); continue; }
    if (c >= 0xd800 && c <= 0xdfff) {
      if (c <= 0xdbff && i + 1 < s.length) {
        const d = s.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) {
          const cp = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
          i++;
          heap[p++] = 0xf0 | (cp >> 18); heap[p++] = 0x80 | ((cp >> 12) & 63);
          heap[p++] = 0x80 | ((cp >> 6) & 63); heap[p++] = 0x80 | (cp & 63);
          continue;
        }
      }
      c = 0xfffd;
    }
    heap[p++] = 0xe0 | (c >> 12); heap[p++] = 0x80 | ((c >> 6) & 63); heap[p++] = 0x80 | (c & 63);
  }
  return p - start;
}
function utf8Decode(h: Uint8Array, p: number, end: number): string {
  let out = '';
  let units: number[] = [];
  while (p < end) {
    const b = h[p];
    if (b < 0x80) { units.push(b); p++; }
    else {
      let need = 0, cp = 0, lower = 0x80, upper = 0xbf;
      if (b >= 0xc2 && b <= 0xdf) { need = 1; cp = b & 0x1f; }
      else if (b >= 0xe0 && b <= 0xef) { need = 2; cp = b & 0xf; if (b === 0xe0) lower = 0xa0; if (b === 0xed) upper = 0x9f; }
      else if (b >= 0xf0 && b <= 0xf4) { need = 3; cp = b & 0x7; if (b === 0xf0) lower = 0x90; if (b === 0xf4) upper = 0x8f; }
      else { units.push(0xfffd); p++; need = -1; }
      if (need > 0) {
        let q = p + 1, ok = true;
        for (let k = 0; k < need; k++, q++) {
          const c = q < end ? h[q] : -1;
          if (c < lower || c > upper) { ok = false; break; }
          lower = 0x80; upper = 0xbf;
          cp = (cp << 6) | (c & 0x3f);
        }
        if (!ok) { units.push(0xfffd); p = q; }
        else {
          p = q;
          if (cp >= 0x10000) { cp -= 0x10000; units.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff)); }
          else units.push(cp);
        }
      }
    }
    if (units.length >= 8192) { out += String.fromCharCode.apply(null, units); units = []; }
  }
  if (units.length) out += String.fromCharCode.apply(null, units);
  return out;
}

/* ------------------------------------------------------------------- the addon */

export function createAddon(env: AddonEnv = {}): object {
  const M: any = {};
  // wasm2js + WASM_ASYNC_COMPILATION=0: the module object is complete when the call returns; the
  // returned promise only matters on failure, which the check below reports synchronously.
  const ready: any = (createSqliteEngine as any)(M);
  if (ready && typeof ready.catch === 'function') ready.catch(() => undefined);
  if (typeof M._sqlite3_open_v2 !== 'function' || !M.calledRun) {
    throw new Error('better-sqlite3 shim: SQL engine did not initialize synchronously');
  }

  const BufferCtor: any = (globalThis as any).Buffer;
  let fsImpl: AddonFs | null = env.fs ? asAddonFs(env.fs) : null;
  const getFs = (): AddonFs => fsImpl || (fsImpl = resolveBuiltin('fs') as AddonFs);
  const getCwd = env.cwd || (() => (globalThis as any).process.cwd());

  /* heap views (replaced when the heap grows) */
  let U8: Uint8Array = M.HEAPU8;
  let I32 = new Int32Array(U8.buffer);
  let U32 = new Uint32Array(U8.buffer);
  function u8(): Uint8Array {
    if (M.HEAPU8 !== U8) { U8 = M.HEAPU8; I32 = new Int32Array(U8.buffer); U32 = new Uint32Array(U8.buffer); }
    return U8;
  }
  function i32(): Int32Array { u8(); return I32; }
  function u32(): Uint32Array { u8(); return U32; }

  /* scratch stack for out-parameters (re-entrant: callbacks may nest) */
  const SCRATCH_SIZE = 64 * 1024;
  const scratchBase: number = M._malloc(SCRATCH_SIZE);
  let scratchTop = scratchBase;
  function tmp(n: number): number {
    const p = scratchTop;
    scratchTop += (n + 7) & ~7;
    if (scratchTop > scratchBase + SCRATCH_SIZE) throw new Error('better-sqlite3 shim: scratch overflow');
    return p;
  }
  const emptyBlob: number = M._malloc(8); // non-NULL pointer for zero-length blobs ("" in the C++)

  function cstr(p: number): string {
    if (!p) return '';
    const h = u8();
    let e = p;
    while (h[e]) e++;
    return utf8Decode(h, p, e);
  }
  function cstrOrNull(p: number): string | null {
    return p ? cstr(p) : null;
  }
  // Allocates a NUL-terminated UTF-8 copy with malloc; returns [ptr, byteLength].
  function allocUtf8(s: string): [number, number] {
    const n = utf8Length(s);
    const p: number = M._malloc(n + 1);
    const h = u8();
    utf8Write(s, h, p);
    h[p + n] = 0;
    return [p, n];
  }
  function readI64Number(p: number): number {
    return i32()[(p + 4) >> 2] * 4294967296 + u32()[p >> 2];
  }
  function readI64BigInt(p: number): bigint {
    return (BigInt(i32()[(p + 4) >> 2]) << 32n) | BigInt(u32()[p >> 2]);
  }
  const I64_MIN = -(2n ** 63n);
  const I64_MAX = 2n ** 63n - 1n;
  function bigintParts(v: bigint): [number, number] | null {
    if (v < I64_MIN || v > I64_MAX) return null;
    const u = BigInt.asUintN(64, v);
    return [Number(u & 0xffffffffn) | 0, Number(u >> 32n) | 0];
  }

  let SqliteErrorCtor: any = null;
  function makeSqliteError(message: string, code: number): Error {
    const name = codeName(code);
    if (SqliteErrorCtor) return new SqliteErrorCtor(message, name);
    const e: any = new Error(message);
    e.code = name;
    return e;
  }

  let nextId = 0; // Addon::NextId()

  /* ------------------------------------------------------------ data conversion */

  function bufferFromHeap(p: number, n: number): any {
    if (n <= 0 || !p) return BufferCtor.alloc(0);
    return BufferCtor.from(u8().subarray(p, p + n));
  }

  function columnValue(h: number, i: number, safeInts: boolean): unknown {
    switch (M._sqlite3_column_type(h, i)) {
      case SQLITE_INTEGER:
        if (safeInts) {
          const p = tmp(8);
          try { M._owc_column_int64(h, i, p); return readI64BigInt(p); } finally { scratchTop = p; }
        }
        // without safe integers an INTEGER is delivered as a double, as SQLITE_FLOAT is
        return M._sqlite3_column_double(h, i);
      case SQLITE_FLOAT:
        return M._sqlite3_column_double(h, i);
      case SQLITE_TEXT: {
        const p = M._sqlite3_column_text(h, i);
        const n = M._sqlite3_column_bytes(h, i);
        return utf8Decode(u8(), p, p + n);
      }
      case SQLITE_BLOB: {
        const p = M._sqlite3_column_blob(h, i);
        const n = M._sqlite3_column_bytes(h, i);
        return bufferFromHeap(p, n);
      }
      default:
        return null;
    }
  }
  function valueValue(v: number, safeInts: boolean): unknown {
    switch (M._sqlite3_value_type(v)) {
      case SQLITE_INTEGER:
        if (safeInts) {
          const p = tmp(8);
          try { M._owc_value_int64(v, p); return readI64BigInt(p); } finally { scratchTop = p; }
        }
        // without safe integers an INTEGER is delivered as a double, as SQLITE_FLOAT is
        return M._sqlite3_value_double(v);
      case SQLITE_FLOAT:
        return M._sqlite3_value_double(v);
      case SQLITE_TEXT: {
        const p = M._sqlite3_value_text(v);
        const n = M._sqlite3_value_bytes(v);
        return utf8Decode(u8(), p, p + n);
      }
      case SQLITE_BLOB: {
        const p = M._sqlite3_value_blob(v);
        const n = M._sqlite3_value_bytes(v);
        return bufferFromHeap(p, n);
      }
      default:
        return null;
    }
  }
  function argumentValues(argv: number, argc: number, safeInts: boolean): unknown[] {
    const out = new Array(argc);
    for (let i = 0; i < argc; i++) out[i] = valueValue(i32()[(argv >> 2) + i], safeInts);
    return out;
  }

  const MODE_FLAT = 0, MODE_PLUCK = 1, MODE_EXPAND = 2, MODE_RAW = 3;

  function getRow(h: number, safeInts: boolean, mode: number): unknown {
    if (mode === MODE_PLUCK) return columnValue(h, 0, safeInts);
    const count = M._sqlite3_column_count(h);
    if (mode === MODE_RAW) {
      const row = new Array(count);
      for (let i = 0; i < count; i++) row[i] = columnValue(h, i, safeInts);
      return row;
    }
    const row: any = {};
    if (mode === MODE_EXPAND) {
      for (let i = 0; i < count; i++) {
        const tp = M._sqlite3_column_table_name(h, i);
        const table = tp ? cstr(tp) : '$';
        const column = cstr(M._sqlite3_column_name(h, i));
        const value = columnValue(h, i, safeInts);
        if (Object.prototype.hasOwnProperty.call(row, table)) row[table][column] = value;
        else { const nested: any = {}; row[table] = nested; nested[column] = value; }
      }
      return row;
    }
    for (let i = 0; i < count; i++) row[cstr(M._sqlite3_column_name(h, i))] = columnValue(h, i, safeInts);
    return row;
  }

  /* Data::BindValueFromJS: returns an SQLite status, or -1 for an unbindable value. */
  function bindValueFromJS(h: number, index: number, value: unknown): number {
    if (typeof value === 'number') return M._sqlite3_bind_double(h, index, value);
    if (typeof value === 'bigint') {
      const parts = bigintParts(value);
      if (parts) return M._owc_bind_int64(h, index, parts[0], parts[1]);
      return SQLITE_TOOBIG;
    }
    if (typeof value === 'string') {
      const [p, n] = allocUtf8(value);
      try { return M._sqlite3_bind_text(h, index, p, n, SQLITE_TRANSIENT); } finally { M._free(p); }
    }
    if (isBufferLike(value)) {
      const n = value.byteLength;
      if (n === 0) return M._sqlite3_bind_blob(h, index, emptyBlob, 0, SQLITE_TRANSIENT);
      const p: number = M._malloc(n);
      try {
        u8().set(new Uint8Array(value.buffer, value.byteOffset, n), p);
        return M._sqlite3_bind_blob(h, index, p, n, SQLITE_TRANSIENT);
      } finally { M._free(p); }
    }
    if (value === null || value === undefined) return M._sqlite3_bind_null(h, index);
    return -1;
  }

  interface Converter { prefix(): string; propagate(ctx: number): void; }

  /* Data::ResultValueFromJS + DataConverter::ThrowDataConversionError. A conversion error is
   * reported to the converter (which records it as the pending JavaScript error). */
  function resultValueFromJS(ctx: number, value: unknown, conv: Converter): void {
    if (typeof value === 'number') { M._sqlite3_result_double(ctx, value); return; }
    let isBigInt = false;
    if (typeof value === 'bigint') {
      const parts = bigintParts(value);
      if (parts) { M._owc_result_int64(ctx, parts[0], parts[1]); return; }
      isBigInt = true;
    } else if (typeof value === 'string') {
      const [p, n] = allocUtf8(value);
      try { M._sqlite3_result_text(ctx, p, n, SQLITE_TRANSIENT); } finally { M._free(p); }
      return;
    } else if (isBufferLike(value)) {
      const n = value.byteLength;
      if (n === 0) { M._sqlite3_result_blob(ctx, emptyBlob, 0, SQLITE_TRANSIENT); return; }
      const p: number = M._malloc(n);
      try {
        u8().set(new Uint8Array(value.buffer, value.byteOffset, n), p);
        M._sqlite3_result_blob(ctx, p, n, SQLITE_TRANSIENT);
      } finally { M._free(p); }
      return;
    } else if (value === null || value === undefined) {
      M._sqlite3_result_null(ctx);
      return;
    }
    const err = isBigInt
      ? new RangeError(conv.prefix() + ' a bigint that was too big')
      : new TypeError(conv.prefix() + ' an invalid value');
    pendingConversionError = err;
    conv.propagate(ctx);
  }
  let pendingConversionError: unknown = null;

  /* ------------------------------------------------------------------- state */

  interface DbState {
    handle: number;
    open: boolean;
    busy: boolean;
    safeInts: boolean;
    unsafeMode: boolean;
    jsError: { error: unknown } | null; // was_js_error, carrying the error to rethrow
    hasLogger: boolean;
    logger: Function | null;
    iterators: number;
    stmts: Set<StmtState>;
    backups: Set<BackupState>;
  }
  interface StmtState {
    db: DbState;
    handle: number;
    id: number;
    alive: boolean;
    locked: boolean;
    bound: boolean;
    bindMap: Array<[string, number]> | null;
    safeInts: boolean;
    mode: number;
    returnsData: boolean;
  }
  interface IterState {
    stmt: StmtState;
    handle: number;
    db: DbState;
    bound: boolean;
    safeInts: boolean;
    mode: number;
    alive: boolean;
    logged: boolean;
  }
  interface BackupState {
    db: DbState;
    dest: number;
    backup: number;
    id: number;
    alive: boolean;
    unlink: boolean;
  }

  const DBS: WeakMap<object, DbState> = new WeakMap();
  const STMTS: WeakMap<object, StmtState> = new WeakMap();
  const ITERS: WeakMap<object, IterState> = new WeakMap();
  const BACKUPS: WeakMap<object, BackupState> = new WeakMap();

  function unwrap<T>(map: WeakMap<object, T>, self: unknown): T {
    const s = isObjectLike(self) ? map.get(self as object) : undefined;
    if (s === undefined) throw new TypeError('Illegal invocation');
    return s;
  }

  // ObjectWrap destructors: a collected Statement is finalized (Statement::~Statement) and a
  // collected Database is closed (Database::~Database), when the runtime has FinalizationRegistry.
  const FR: any = (globalThis as any).FinalizationRegistry;
  const stmtRegistry: any = typeof FR === 'function'
    ? new FR((st: StmtState) => {
        if (st.alive && !st.locked) {
          st.db.stmts.delete(st);
          st.alive = false;
          M._sqlite3_finalize(st.handle);
        }
      })
    : null;
  const dbRegistry: any = typeof FR === 'function'
    ? new FR((db: DbState) => { if (!db.busy && !db.iterators) closeDbHandles(db); })
    : null;

  function sqliteErrorFromHandle(handle: number): Error {
    return makeSqliteError(cstr(M._sqlite3_errmsg(handle)), M._sqlite3_extended_errcode(handle));
  }
  /* Database::ThrowDatabaseError(): a pending JavaScript error wins over the SQLite error. */
  function databaseError(db: DbState): unknown {
    if (db.jsError) {
      const e = db.jsError.error;
      db.jsError = null;
      return e;
    }
    return sqliteErrorFromHandle(db.handle);
  }
  /* Database::Log(): returns true when the logger threw (error kept in db.jsError). */
  function log(db: DbState, h: number): boolean {
    if (!db.hasLogger) return false;
    const expanded = M._sqlite3_expanded_sql(h);
    const text = expanded ? cstr(expanded) : cstr(M._sqlite3_sql(h));
    if (expanded) M._sqlite3_free(expanded);
    try {
      (db.logger as Function).call(undefined, text);
      return false;
    } catch (e) {
      db.jsError = { error: e };
      return true;
    }
  }

  function closeStatement(st: StmtState): void {
    if (st.alive) { st.alive = false; M._sqlite3_finalize(st.handle); }
  }
  function closeBackupHandles(b: BackupState): void {
    // Backup::CloseHandles()
    if (!b.alive) return;
    b.alive = false;
    const filename = cstr(M._sqlite3_db_filename(b.dest, mainName));
    M._sqlite3_backup_finish(b.backup);
    M._sqlite3_close(b.dest);
    if (b.unlink) removeFile(filename);
  }
  function closeDbHandles(db: DbState): void {
    // Database::CloseHandles()
    if (!db.open) return;
    db.open = false;
    for (const st of db.stmts) closeStatement(st);
    for (const b of db.backups) closeBackupHandles(b);
    db.stmts.clear();
    db.backups.clear();
    M._sqlite3_close(db.handle);
  }

  const mainName: number = allocUtf8('main')[0];

  /* -------------------------------------------------------------------- binder */

  function getBindMap(st: StmtState): Array<[string, number]> {
    if (st.bindMap) return st.bindMap;
    const map: Array<[string, number]> = [];
    const count = M._sqlite3_bind_parameter_count(st.handle);
    for (let i = 1; i <= count; i++) {
      const p = M._sqlite3_bind_parameter_name(st.handle, i);
      if (p) map.push([cstr(p + 1), i]);
    }
    st.bindMap = map;
    return map;
  }

  /* Binder::Bind(): throws (after clearing the bindings) on failure. */
  function bindParameters(st: StmtState, args: ArrayLike<unknown>, argc: number): void {
    const h = st.handle;
    const paramCount = M._sqlite3_bind_parameter_count(h);
    let anonIndex = 0;
    const nextAnonIndex = (): number => {
      while (M._sqlite3_bind_parameter_name(h, ++anonIndex) !== 0) { /* skip named */ }
      return anonIndex;
    };
    const bindValue = (value: unknown, index: number): void => {
      const status = bindValueFromJS(h, index, value);
      if (status !== SQLITE_OK) {
        switch (status) {
          case -1: throw new TypeError('SQLite3 can only bind numbers, strings, bigints, buffers, and null');
          case SQLITE_TOOBIG: throw new RangeError('The bound string, buffer, or bigint is too big');
          case SQLITE_RANGE: throw new RangeError('Too many parameter values were provided');
          case SQLITE_NOMEM: throw new Error('Out of memory');
          default: throw new Error('An unexpected error occured while trying to bind parameters');
        }
      }
    };
    try {
      let count = 0;
      let boundObject = false;
      for (let i = 0; i < argc; i++) {
        const arg = args[i];
        if (Array.isArray(arg)) {
          const len = arg.length;
          if (len > INT_MAX) throw new RangeError('Too many parameter values were provided');
          for (let j = 0; j < len; j++) bindValue(arg[j], nextAnonIndex());
          count += len;
          continue;
        }
        if (isObjectLike(arg) && !isBufferLike(arg)) {
          if (isPlainObject(arg as object)) {
            if (boundObject) throw new TypeError('You cannot specify named parameters in two different objects');
            boundObject = true;
            const map = getBindMap(st);
            for (let j = 0; j < map.length; j++) {
              const key = map[j][0];
              if (!Object.prototype.hasOwnProperty.call(arg, key)) {
                throw new RangeError('Missing named parameter "' + key + '"');
              }
              bindValue((arg as any)[key], map[j][1]);
            }
            count += map.length;
            continue;
          } else if (getBindMap(st).length) {
            throw new TypeError('Named parameters can only be passed within plain objects');
          }
        }
        bindValue(arg, nextAnonIndex());
        count += 1;
      }
      if (count !== paramCount) {
        if (count < paramCount) {
          if (!boundObject && getBindMap(st).length) throw new TypeError('Missing named parameters');
          throw new RangeError('Too few parameter values were provided');
        }
        throw new RangeError('Too many parameter values were provided');
      }
    } catch (e) {
      M._sqlite3_clear_bindings(h);
      throw e;
    }
  }

  /* --------------------------------------------------------------- privileged */

  let privileged: { self: any; args: IArguments | unknown[] } | null = null;
  function construct<T>(Ctor: new () => T, self: any, args: IArguments | unknown[]): T {
    privileged = { self, args };
    try { return new Ctor(); } finally { privileged = null; }
  }

  const BUSY_MSG = 'This database connection is busy executing a query';
  const CLOSED_MSG = 'The database connection is not open';

  /* ------------------------------------------------------------------ Database */

  class Database {
    constructor(filename: string, filenameGiven: string, inMemory: boolean, readonly: boolean,
                mustExist: boolean, timeout: number, logger: unknown, buffer: unknown) {
      const args = arguments;
      expectArg(args, 0, isString, 'a string');
      expectArg(args, 1, isString, 'a string');
      expectArg(args, 2, isBoolean, 'a boolean');
      expectArg(args, 3, isBoolean, 'a boolean');
      expectArg(args, 4, isBoolean, 'a boolean');
      expectArg(args, 5, isInt32, 'a 32-bit signed integer');
      expectPresent(args, 6);
      expectPresent(args, 7);

      const mask = readonly ? SQLITE_OPEN_READONLY
        : mustExist ? SQLITE_OPEN_READWRITE
        : (SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE);
      const pp = tmp(4);
      const [fp] = allocUtf8(filename);
      let handle = 0;
      try {
        const rc = M._sqlite3_open_v2(fp, pp, mask, 0);
        handle = i32()[pp >> 2];
        if (rc !== SQLITE_OK) {
          const err = sqliteErrorFromHandle(handle);
          M._sqlite3_close(handle);
          throw err;
        }
      } finally {
        M._free(fp);
        scratchTop = pp;
      }
      M._sqlite3_extended_result_codes(handle, 1);
      M._sqlite3_busy_timeout(handle, timeout);
      M._sqlite3_limit(handle, SQLITE_LIMIT_LENGTH, MAX_BUFFER_SIZE < MAX_STRING_SIZE ? MAX_BUFFER_SIZE : MAX_STRING_SIZE);
      M._sqlite3_limit(handle, SQLITE_LIMIT_SQL_LENGTH, MAX_STRING_SIZE);
      M._owc_db_config_int(handle, SQLITE_DBCONFIG_ENABLE_LOAD_EXTENSION, 1);
      M._owc_db_config_int(handle, SQLITE_DBCONFIG_DEFENSIVE, 1);

      if (isBufferLike(buffer)) deserialize(buffer, handle, readonly);

      const db: DbState = {
        handle, open: true, busy: false, safeInts: false, unsafeMode: false, jsError: null,
        hasLogger: typeof logger === 'function', logger: typeof logger === 'function' ? logger : null,
        iterators: 0, stmts: new Set(), backups: new Set(),
      };
      DBS.set(this, db);
      if (dbRegistry) dbRegistry.register(this, db, db);
      // SetPrototypeGetter(): own enumerable properties installed before the frozen ones.
      Object.defineProperty(this, 'open', { get: () => db.open, enumerable: true, configurable: false });
      Object.defineProperty(this, 'inTransaction', {
        get: () => db.open && !M._sqlite3_get_autocommit(db.handle), enumerable: true, configurable: false,
      });
      setFrozen(this, 'memory', inMemory);
      setFrozen(this, 'readonly', readonly);
      setFrozen(this, 'name', filenameGiven);
    }

    prepare(source: string, database: object, pragmaMode: boolean): any {
      const args = arguments;
      expectArg(args, 0, isString, 'a string');
      expectArg(args, 1, isObject, 'an object');
      expectArg(args, 2, isBoolean, 'a boolean');
      return construct(Statement, this, args);
    }

    exec(source: string): void {
      const db = unwrap(DBS, this);
      expectArg(arguments, 0, isString, 'a string');
      if (!db.open) throw new TypeError(CLOSED_MSG);
      if (db.busy) throw new TypeError(BUSY_MSG);
      if (!db.unsafeMode && db.iterators) throw new TypeError(BUSY_MSG);
      db.busy = true;
      const [base, n] = allocUtf8(source);
      const ppStmt = tmp(4);
      const pzTail = tmp(4);
      let status = SQLITE_OK;
      try {
        let sql = base;
        const end = base + n;
        for (;;) {
          const h8 = u8();
          while (sql < end && isSkipped(h8[sql])) ++sql;
          status = M._sqlite3_prepare_v2(db.handle, sql, -1, ppStmt, pzTail);
          sql = i32()[pzTail >> 2];
          const handle = i32()[ppStmt >> 2];
          if (!handle) break;
          if (db.hasLogger && log(db, handle)) {
            M._sqlite3_finalize(handle);
            status = -1;
            break;
          }
          do status = M._sqlite3_step(handle);
          while (status === SQLITE_ROW);
          status = M._sqlite3_finalize(handle);
          if (status !== SQLITE_OK) break;
        }
      } finally {
        M._free(base);
        scratchTop = ppStmt;
        db.busy = false;
      }
      if (status !== SQLITE_OK) throw databaseError(db);
    }

    backup(database: object, attachedName: string, destFile: string, unlink: boolean): any {
      const args = arguments;
      expectArg(args, 0, isObject, 'an object');
      expectArg(args, 1, isString, 'a string');
      expectArg(args, 2, isString, 'a string');
      expectArg(args, 3, isBoolean, 'a boolean');
      return construct(Backup, this, args);
    }

    serialize(attachedName: string): any {
      const db = unwrap(DBS, this);
      expectArg(arguments, 0, isString, 'a string');
      if (!db.open) throw new TypeError(CLOSED_MSG);
      if (db.busy) throw new TypeError(BUSY_MSG);
      if (db.iterators) throw new TypeError(BUSY_MSG);
      const [np] = allocUtf8(attachedName);
      const pSize = tmp(8);
      try {
        i32()[pSize >> 2] = -1; i32()[(pSize + 4) >> 2] = -1; // sqlite3_int64 length = -1
        const data = M._owc_serialize(db.handle, np, pSize);
        const length = readI64Number(pSize);
        if (!data && length) throw new Error('Out of memory');
        const buf = bufferFromHeap(data, length);
        if (data) M._sqlite3_free(data);
        return buf;
      } finally {
        M._free(np);
        scratchTop = pSize;
      }
    }

    function(fn: Function, name: string, argc: number, safeInts: number, deterministic: boolean, directOnly: boolean): void {
      const db = unwrap(DBS, this);
      const args = arguments;
      expectArg(args, 0, isFunction, 'a function');
      expectArg(args, 1, isString, 'a string');
      expectArg(args, 2, isInt32, 'a 32-bit signed integer');
      expectArg(args, 3, isInt32, 'a 32-bit signed integer');
      expectArg(args, 4, isBoolean, 'a boolean');
      expectArg(args, 5, isBoolean, 'a boolean');
      if (!db.open) throw new TypeError(CLOSED_MSG);
      if (db.busy) throw new TypeError(BUSY_MSG);
      if (db.iterators) throw new TypeError(BUSY_MSG);
      let mask = SQLITE_UTF8;
      if (deterministic) mask |= SQLITE_DETERMINISTIC;
      if (directOnly) mask |= SQLITE_DIRECTONLY;
      const safe = safeInts < 2 ? safeInts !== 0 : db.safeInts;
      const id = registerFunction({ kind: 'function', db, name, fn, safeInts: safe });
      const [np] = allocUtf8(name);
      let rc: number;
      try { rc = M._owc_create_function(db.handle, np, argc, mask, id); } finally { M._free(np); }
      if (rc !== SQLITE_OK) throw databaseError(db);
    }

    aggregate(start: unknown, step: Function, inverse: unknown, result: unknown, name: string, argc: number,
              safeInts: number, deterministic: boolean, directOnly: boolean): void {
      const db = unwrap(DBS, this);
      const args = arguments;
      expectPresent(args, 0);
      expectArg(args, 1, isFunction, 'a function');
      expectPresent(args, 2);
      expectPresent(args, 3);
      expectArg(args, 4, isString, 'a string');
      expectArg(args, 5, isInt32, 'a 32-bit signed integer');
      expectArg(args, 6, isInt32, 'a 32-bit signed integer');
      expectArg(args, 7, isBoolean, 'a boolean');
      expectArg(args, 8, isBoolean, 'a boolean');
      if (!db.open) throw new TypeError(CLOSED_MSG);
      if (db.busy) throw new TypeError(BUSY_MSG);
      if (db.iterators) throw new TypeError(BUSY_MSG);
      const isWindow = typeof inverse === 'function';
      let mask = SQLITE_UTF8;
      if (deterministic) mask |= SQLITE_DETERMINISTIC;
      if (directOnly) mask |= SQLITE_DIRECTONLY;
      const safe = safeInts < 2 ? safeInts !== 0 : db.safeInts;
      const id = registerFunction({
        kind: 'aggregate', db, name, fn: step, safeInts: safe,
        start, invokeStart: typeof start === 'function',
        inverse: isWindow ? inverse as Function : null,
        result: typeof result === 'function' ? result as Function : null,
      });
      const [np] = allocUtf8(name);
      let rc: number;
      try { rc = M._owc_create_aggregate(db.handle, np, argc, mask, id, isWindow ? 1 : 0); } finally { M._free(np); }
      if (rc !== SQLITE_OK) throw databaseError(db);
    }

    table(factory: Function, name: string, eponymous: boolean): void {
      const db = unwrap(DBS, this);
      const args = arguments;
      expectArg(args, 0, isFunction, 'a function');
      expectArg(args, 1, isString, 'a string');
      expectArg(args, 2, isBoolean, 'a boolean');
      if (!db.open) throw new TypeError(CLOSED_MSG);
      if (db.busy) throw new TypeError(BUSY_MSG);
      if (db.iterators) throw new TypeError(BUSY_MSG);
      const moduleId = ++nextModuleId;
      modules.set(moduleId, { db, name, factory });
      const [np] = allocUtf8(name);
      db.busy = true;
      let rc: number;
      try { rc = M._owc_create_module(db.handle, np, eponymous ? 1 : 0, moduleId); } finally { M._free(np); db.busy = false; }
      if (rc !== SQLITE_OK) throw databaseError(db);
    }

    loadExtension(filename: string, entryPoint?: string): void {
      const db = unwrap(DBS, this);
      const args = arguments;
      expectArg(args, 0, isString, 'a string');
      if (args.length > 1) expectArg(args, 1, isString, 'a string');
      if (!db.open) throw new TypeError(CLOSED_MSG);
      if (db.busy) throw new TypeError(BUSY_MSG);
      if (db.iterators) throw new TypeError(BUSY_MSG);
      const [fp] = allocUtf8(filename);
      const ep = args.length > 1 ? allocUtf8(entryPoint as string)[0] : 0;
      const pErr = tmp(4);
      try {
        i32()[pErr >> 2] = 0;
        const status = M._sqlite3_load_extension(db.handle, fp, ep, pErr);
        const errPtr = i32()[pErr >> 2];
        const message = cstr(errPtr);
        M._sqlite3_free(errPtr);
        if (status !== SQLITE_OK) throw makeSqliteError(message, status);
      } finally {
        M._free(fp);
        if (ep) M._free(ep);
        scratchTop = pErr;
      }
    }

    close(): void {
      const db = unwrap(DBS, this);
      if (db.open) {
        if (db.busy) throw new TypeError(BUSY_MSG);
        if (db.iterators) throw new TypeError(BUSY_MSG);
        if (dbRegistry) dbRegistry.unregister(db);
        closeDbHandles(db);
      }
    }

    defaultSafeIntegers(toggle?: boolean): void {
      const db = unwrap(DBS, this);
      if (arguments.length === 0) db.safeInts = true;
      else { expectArg(arguments, 0, isBoolean, 'a boolean'); db.safeInts = toggle as boolean; }
    }

    unsafeMode(toggle?: boolean): void {
      const db = unwrap(DBS, this);
      if (arguments.length === 0) db.unsafeMode = true;
      else { expectArg(arguments, 0, isBoolean, 'a boolean'); db.unsafeMode = toggle as boolean; }
      M._owc_db_config_int(db.handle, SQLITE_DBCONFIG_DEFENSIVE, db.unsafeMode ? 0 : 1);
    }
  }
  makePrototypeEnumerable(Database, ['prepare', 'exec', 'backup', 'serialize', 'function', 'aggregate',
    'table', 'loadExtension', 'close', 'defaultSafeIntegers', 'unsafeMode']);

  function isSkipped(c: number): boolean {
    // IS_SKIPPED(): ' ', ';', or '\t'..'\r'
    return c === 32 || c === 59 || (c >= 9 && c <= 13);
  }

  /* Database::Deserialize() */
  function deserialize(buffer: ArrayBufferView, handle: number, readonly: boolean): void {
    const length = buffer.byteLength;
    const data: number = M._owc_malloc64(length);
    let flags = SQLITE_DESERIALIZE_FREEONCLOSE | SQLITE_DESERIALIZE_RESIZEABLE;
    if (readonly) flags |= SQLITE_DESERIALIZE_READONLY;
    if (length) {
      if (!data) { M._sqlite3_close(handle); throw new Error('Out of memory'); }
      u8().set(new Uint8Array(buffer.buffer, buffer.byteOffset, length), data);
    }
    const status = M._owc_deserialize(handle, mainName, data, length, flags);
    if (status !== SQLITE_OK) {
      const message = status === SQLITE_ERROR ? 'unable to deserialize database' : cstr(M._sqlite3_errstr(status));
      M._sqlite3_close(handle);
      throw makeSqliteError(message, status);
    }
  }

  /* ----------------------------------------------------------------- Statement */

  // STATEMENT_START(): shared preamble of run/get/all. Returns the bound flag.
  function statementStart(self: unknown, args: IArguments, requireData: boolean, mutates: boolean): StmtState {
    const st = unwrap(STMTS, self);
    if (requireData && !st.returnsData) throw new TypeError('This statement does not return data. Use run() instead');
    const db = st.db;
    if (!db.open) throw new TypeError(CLOSED_MSG);
    if (db.busy) throw new TypeError(BUSY_MSG);
    if (st.locked) throw new TypeError('This statement is busy executing a query');
    if (mutates && !db.unsafeMode && db.iterators) throw new TypeError(BUSY_MSG);
    if (!st.bound) bindParameters(st, args, args.length);
    else if (args.length > 0) throw new TypeError('This statement already has bound parameters');
    db.busy = true;
    if (log(db, st.handle)) {
      db.busy = false;
      const err = databaseError(db);
      if (!st.bound) M._sqlite3_clear_bindings(st.handle);
      throw err;
    }
    return st;
  }
  function statementFail(st: StmtState): never {
    st.db.busy = false;
    const err = databaseError(st.db);
    if (!st.bound) M._sqlite3_clear_bindings(st.handle);
    throw err;
  }
  function statementReturn<T>(st: StmtState, value: T): T {
    st.db.busy = false;
    if (!st.bound) M._sqlite3_clear_bindings(st.handle);
    return value;
  }

  class Statement {
    constructor() {
      if (!privileged) throw new TypeError('Statements can only be constructed by the db.prepare() method');
      const dbObj = privileged.self;
      const db = unwrap(DBS, dbObj);
      if (!db.open) throw new TypeError(CLOSED_MSG);
      if (db.busy) throw new TypeError(BUSY_MSG);
      const source = privileged.args[0] as string;
      const database = privileged.args[1] as object;
      const pragmaMode = privileged.args[2] as boolean;
      let flags = SQLITE_PREPARE_PERSISTENT;
      if (pragmaMode) {
        if (!db.unsafeMode && db.iterators) throw new TypeError(BUSY_MSG);
        flags = 0;
      }
      const [sp, n] = allocUtf8(source);
      const ppStmt = tmp(4);
      const pzTail = tmp(4);
      let handle = 0;
      try {
        if (M._sqlite3_prepare_v3(db.handle, sp, n + 1, flags, ppStmt, pzTail) !== SQLITE_OK) {
          throw databaseError(db);
        }
        handle = i32()[ppStmt >> 2];
        if (handle === 0) throw new RangeError('The supplied SQL string contains no statements');
        let tail = i32()[pzTail >> 2];
        const h8 = u8();
        for (let c; (c = h8[tail]); ) {
          if (isSkipped(c)) { ++tail; continue; }
          if (c === 47 && h8[tail + 1] === 42) { // "/*"
            tail += 2;
            for (let d; (d = h8[tail]); ++tail) {
              if (d === 42 && h8[tail + 1] === 47) { tail += 2; break; }
            }
          } else if (c === 45 && h8[tail + 1] === 45) { // "--"
            tail += 2;
            for (let d; (d = h8[tail]); ++tail) {
              if (d === 10) { ++tail; break; }
            }
          } else {
            M._sqlite3_finalize(handle);
            throw new RangeError('The supplied SQL string contains more than one statement');
          }
        }
      } finally {
        M._free(sp);
        scratchTop = ppStmt;
      }
      const returnsData = M._sqlite3_column_count(handle) >= 1 || pragmaMode;
      const st: StmtState = {
        db, handle, id: nextId++, alive: true, locked: false, bound: false, bindMap: null,
        safeInts: db.safeInts, mode: MODE_FLAT, returnsData,
      };
      db.stmts.add(st);
      STMTS.set(this, st);
      if (stmtRegistry) stmtRegistry.register(this, st);
      Object.defineProperty(this, 'busy', { get: () => st.alive && st.locked, enumerable: true, configurable: false });
      setFrozen(this, 'reader', returnsData);
      setFrozen(this, 'readonly', M._sqlite3_stmt_readonly(handle) !== 0);
      setFrozen(this, 'source', source);
      setFrozen(this, 'database', database);
    }

    run(): any {
      const st = statementStart(this, arguments, false, true);
      const db = st.db;
      const totalChangesBefore = M._sqlite3_total_changes(db.handle);
      M._sqlite3_step(st.handle);
      if (M._sqlite3_reset(st.handle) === SQLITE_OK) {
        const changes = M._sqlite3_total_changes(db.handle) === totalChangesBefore ? 0 : M._sqlite3_changes(db.handle);
        const p = tmp(8);
        let lastInsertRowid: number | bigint;
        try {
          M._owc_last_insert_rowid(db.handle, p);
          lastInsertRowid = st.safeInts ? readI64BigInt(p) : readI64Number(p);
        } finally { scratchTop = p; }
        const result: any = {};
        result.changes = changes;
        result.lastInsertRowid = lastInsertRowid;
        return statementReturn(st, result);
      }
      return statementFail(st);
    }

    get(): any {
      const st = statementStart(this, arguments, true, false);
      const status = M._sqlite3_step(st.handle);
      if (status === SQLITE_ROW) {
        let row: unknown;
        try { row = getRow(st.handle, st.safeInts, st.mode); } catch (e) { M._sqlite3_reset(st.handle); st.db.busy = false; if (!st.bound) M._sqlite3_clear_bindings(st.handle); throw e; }
        M._sqlite3_reset(st.handle);
        return statementReturn(st, row);
      } else if (status === SQLITE_DONE) {
        M._sqlite3_reset(st.handle);
        return statementReturn(st, undefined);
      }
      M._sqlite3_reset(st.handle);
      return statementFail(st);
    }

    all(): any {
      const st = statementStart(this, arguments, true, false);
      const result: unknown[] = [];
      const safeInts = st.safeInts;
      const mode = st.mode;
      try {
        while (M._sqlite3_step(st.handle) === SQLITE_ROW) result.push(getRow(st.handle, safeInts, mode));
      } catch (e) {
        M._sqlite3_reset(st.handle);
        st.db.busy = false;
        if (!st.bound) M._sqlite3_clear_bindings(st.handle);
        throw e;
      }
      if (M._sqlite3_reset(st.handle) === SQLITE_OK) return statementReturn(st, result);
      return statementFail(st);
    }

    iterate(): any {
      return construct(StatementIterator, this, arguments);
    }

    bind(): any {
      const st = unwrap(STMTS, this);
      if (st.bound) throw new TypeError('The bind() method can only be invoked once per statement object');
      if (!st.db.open) throw new TypeError(CLOSED_MSG);
      if (st.db.busy) throw new TypeError(BUSY_MSG);
      if (st.locked) throw new TypeError('This statement is busy executing a query');
      bindParameters(st, arguments, arguments.length);
      st.bound = true;
      return this;
    }

    pluck(toggle?: boolean): any { return setMode(this, arguments, 'pluck', MODE_PLUCK); }
    expand(toggle?: boolean): any { return setMode(this, arguments, 'expand', MODE_EXPAND); }
    raw(toggle?: boolean): any { return setMode(this, arguments, 'raw', MODE_RAW); }

    safeIntegers(toggle?: boolean): any {
      const st = unwrap(STMTS, this);
      if (st.db.busy) throw new TypeError(BUSY_MSG);
      if (st.locked) throw new TypeError('This statement is busy executing a query');
      if (arguments.length === 0) st.safeInts = true;
      else { expectArg(arguments, 0, isBoolean, 'a boolean'); st.safeInts = toggle as boolean; }
      return this;
    }

    columns(): any {
      const st = unwrap(STMTS, this);
      if (!st.returnsData) throw new TypeError('The columns() method is only for statements that return data');
      if (!st.db.open) throw new TypeError(CLOSED_MSG);
      if (st.db.busy) throw new TypeError(BUSY_MSG);
      const h = st.handle;
      const count = M._sqlite3_column_count(h);
      const columns: unknown[] = [];
      for (let i = 0; i < count; i++) {
        const column: any = {};
        column.name = cstrOrNull(M._sqlite3_column_name(h, i));
        column.column = cstrOrNull(M._sqlite3_column_origin_name(h, i));
        column.table = cstrOrNull(M._sqlite3_column_table_name(h, i));
        column.database = cstrOrNull(M._sqlite3_column_database_name(h, i));
        column.type = cstrOrNull(M._sqlite3_column_decltype(h, i));
        columns.push(column);
      }
      return columns;
    }
  }
  makePrototypeEnumerable(Statement, ['run', 'get', 'all', 'iterate', 'bind', 'pluck', 'expand', 'raw',
    'safeIntegers', 'columns']);

  function setMode(self: unknown, args: IArguments, name: string, mode: number): unknown {
    const st = unwrap(STMTS, self);
    if (!st.returnsData) throw new TypeError('The ' + name + '() method is only for statements that return data');
    if (st.db.busy) throw new TypeError(BUSY_MSG);
    if (st.locked) throw new TypeError('This statement is busy executing a query');
    let use = true;
    if (args.length !== 0) { expectArg(args, 0, isBoolean, 'a boolean'); use = args[0] as boolean; }
    st.mode = use ? mode : st.mode === mode ? MODE_FLAT : st.mode;
    return self;
  }

  /* --------------------------------------------------------- StatementIterator */

  function doneRecord(): any {
    const r: any = {};
    r.value = undefined;
    r.done = true;
    return r;
  }
  function iterCleanup(it: IterState): void {
    it.alive = false;
    it.stmt.locked = false;
    it.db.iterators -= 1;
    M._sqlite3_reset(it.handle);
  }
  function iterReturn(it: IterState): any {
    iterCleanup(it);
    if (!it.bound) M._sqlite3_clear_bindings(it.handle);
    return doneRecord();
  }
  function iterThrow(it: IterState): never {
    iterCleanup(it);
    const err = databaseError(it.stmt.db);
    if (!it.bound) M._sqlite3_clear_bindings(it.handle);
    throw err;
  }

  class StatementIterator {
    constructor() {
      if (!privileged) throw new TypeError('Disabled constructor');
      const stmtObj = privileged.self;
      const args = privileged.args;
      const st = unwrap(STMTS, stmtObj);
      if (!st.returnsData) throw new TypeError('This statement does not return data. Use run() instead');
      const db = st.db;
      if (!db.open) throw new TypeError(CLOSED_MSG);
      if (db.busy) throw new TypeError(BUSY_MSG);
      if (st.locked) throw new TypeError('This statement is busy executing a query');
      if (db.iterators === USHRT_MAX) throw new RangeError('Too many active database iterators');
      const bound = st.bound;
      if (!bound) bindParameters(st, args, args.length);
      else if (args.length > 0) throw new TypeError('This statement already has bound parameters');
      const it: IterState = {
        stmt: st, handle: st.handle, db, bound, safeInts: st.safeInts, mode: st.mode, alive: true,
        logged: !db.hasLogger,
      };
      st.locked = true;
      db.iterators += 1;
      ITERS.set(this, it);
      setFrozen(this, 'statement', stmtObj);
    }

    next(): any {
      const it = unwrap(ITERS, this);
      if (it.db.busy) throw new TypeError(BUSY_MSG);
      if (!it.alive) return doneRecord();
      it.db.busy = true;
      if (!it.logged) {
        it.logged = true;
        if (log(it.stmt.db, it.handle)) {
          it.db.busy = false;
          iterThrow(it);
        }
      }
      const status = M._sqlite3_step(it.handle);
      it.db.busy = false;
      if (status === SQLITE_ROW) {
        const r: any = {};
        r.value = getRow(it.handle, it.safeInts, it.mode);
        r.done = false;
        return r;
      }
      if (status === SQLITE_DONE) return iterReturn(it);
      return iterThrow(it);
    }

    return(): any {
      const it = unwrap(ITERS, this);
      if (it.db.busy) throw new TypeError(BUSY_MSG);
      if (it.alive) return iterReturn(it);
      return doneRecord();
    }

    [Symbol.iterator](): any {
      return this;
    }
  }
  makePrototypeEnumerable(StatementIterator, ['next', 'return']);
  {
    const desc = Object.getOwnPropertyDescriptor(StatementIterator.prototype, Symbol.iterator)!;
    desc.enumerable = true;
    Object.defineProperty(StatementIterator.prototype, Symbol.iterator, desc);
  }

  /* -------------------------------------------------------------------- Backup */

  class Backup {
    constructor() {
      if (!privileged) throw new TypeError('Disabled constructor');
      const db = unwrap(DBS, privileged.self);
      if (!db.open) throw new TypeError(CLOSED_MSG);
      if (db.busy) throw new TypeError(BUSY_MSG);
      const database = privileged.args[0] as object;
      const attachedName = privileged.args[1] as string;
      const destFile = privileged.args[2] as string;
      const unlink = privileged.args[3] as boolean;
      const pp = tmp(4);
      const [dp] = allocUtf8(destFile);
      const [ap] = allocUtf8(attachedName);
      let dest = 0;
      let backup = 0;
      try {
        const rc = M._sqlite3_open_v2(dp, pp, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, 0);
        dest = i32()[pp >> 2];
        if (rc !== SQLITE_OK) {
          const err = sqliteErrorFromHandle(dest);
          M._sqlite3_close(dest);
          throw err;
        }
        M._sqlite3_extended_result_codes(dest, 1);
        M._sqlite3_limit(dest, SQLITE_LIMIT_LENGTH, INT_MAX);
        backup = M._sqlite3_backup_init(dest, mainName, db.handle, ap);
        if (backup === 0) {
          const err = sqliteErrorFromHandle(dest);
          M._sqlite3_close(dest);
          throw err;
        }
      } finally {
        M._free(dp);
        M._free(ap);
        scratchTop = pp;
      }
      const b: BackupState = { db, dest, backup, id: nextId++, alive: true, unlink };
      db.backups.add(b);
      BACKUPS.set(this, b);
      setFrozen(this, 'database', database);
    }

    transfer(pages: number): any {
      const b = unwrap(BACKUPS, this);
      expectArg(arguments, 0, isInt32, 'a 32-bit signed integer');
      if (!b.db.open) throw new TypeError(CLOSED_MSG);
      const status = M._sqlite3_backup_step(b.backup, pages) & 0xff;
      if (status === SQLITE_OK || status === SQLITE_DONE || status === SQLITE_BUSY) {
        const result: any = {};
        result.totalPages = M._sqlite3_backup_pagecount(b.backup);
        result.remainingPages = M._sqlite3_backup_remaining(b.backup);
        if (status === SQLITE_DONE) b.unlink = false;
        return result;
      }
      throw makeSqliteError(cstr(M._sqlite3_errstr(status)), status);
    }

    close(): any {
      const b = unwrap(BACKUPS, this);
      if (b.alive) b.db.backups.delete(b);
      closeBackupHandles(b);
      return this;
    }
  }
  makePrototypeEnumerable(Backup, ['transfer', 'close']);

  function setErrorConstructor(ctor: Function): void {
    expectArg(arguments, 0, isFunction, 'a function');
    SqliteErrorCtor = ctor;
  }

  /* ------------------------------------------- user functions and aggregates */

  interface FnRecord {
    kind: 'function' | 'aggregate';
    db: DbState;
    name: string;
    fn: Function;
    safeInts: boolean;
    start?: unknown;
    invokeStart?: boolean;
    inverse?: Function | null;
    result?: Function | null;
  }
  interface Accumulator { initialized: boolean; empty: boolean; value: unknown; isWindow: boolean; }

  const functions: Map<number, FnRecord> = new Map();
  let nextFunctionId = 0;
  const accumulators: Map<number, Accumulator> = new Map();
  let nextAccumulatorId = 0;

  function registerFunction(rec: FnRecord): number {
    const id = ++nextFunctionId;
    functions.set(id, rec);
    return id;
  }

  // CustomFunction::PropagateJSError()
  function propagateFunctionError(rec: FnRecord, ctx: number, error: unknown): void {
    rec.db.jsError = { error };
    M._sqlite3_result_error(ctx, emptyBlob, 0);
  }
  function functionConverter(rec: FnRecord, onError: (ctx: number) => void): Converter {
    return {
      prefix: () => 'User-defined function ' + rec.name + '() returned',
      propagate: (ctx: number) => onError(ctx),
    };
  }

  // Accumulator lookup keyed by an id stored in the (zero-initialized) aggregate context.
  function accumulatorFor(ctx: number): Accumulator {
    const p: number = M._sqlite3_aggregate_context(ctx, 8);
    const h = i32();
    let id = h[p >> 2];
    if (id === 0) {
      id = ++nextAccumulatorId;
      h[p >> 2] = id;
      accumulators.set(id, { initialized: false, empty: true, value: undefined, isWindow: false });
    }
    return accumulators.get(id)!;
  }
  function releaseAccumulator(ctx: number): void {
    const p: number = M._sqlite3_aggregate_context(ctx, 0);
    if (p) { const id = i32()[p >> 2]; if (id) accumulators.delete(id); }
  }
  // CustomAggregate::DestroyAccumulator()
  function destroyAccumulator(acc: Accumulator): void {
    acc.empty = true;
    acc.value = undefined;
  }
  // CustomAggregate::PropagateJSError(): DestroyAccumulator + CustomFunction::PropagateJSError
  function propagateAggregateError(rec: FnRecord, acc: Accumulator, ctx: number, error: unknown): void {
    destroyAccumulator(acc);
    propagateFunctionError(rec, ctx, error);
  }
  // CustomAggregate::GetAccumulator()
  function getAccumulator(rec: FnRecord, ctx: number): Accumulator {
    const acc = accumulatorFor(ctx);
    if (!acc.initialized) {
      acc.initialized = true;
      if (rec.invokeStart) {
        try {
          acc.value = (rec.start as Function).call(undefined);
          acc.empty = false;
        } catch (e) {
          propagateAggregateError(rec, acc, ctx, e);
        }
      } else {
        acc.value = rec.start;
        acc.empty = false;
      }
    }
    return acc;
  }
  function xStepBase(id: number, ctx: number, argc: number, argv: number, inverse: boolean): void {
    const rec = functions.get(id)!;
    const acc = getAccumulator(rec, ctx);
    if (acc.empty) return;
    try {
      const args = new Array(argc + 1);
      args[0] = acc.value;
      for (let i = 0; i < argc; i++) args[i + 1] = valueValue(i32()[(argv >> 2) + i], rec.safeInts);
      const ret = (inverse ? rec.inverse! : rec.fn).apply(undefined, args);
      if (ret !== undefined) acc.value = ret;
    } catch (e) {
      propagateAggregateError(rec, acc, ctx, e);
    }
  }
  function xValueBase(id: number, ctx: number, isFinal: boolean): void {
    const rec = functions.get(id)!;
    const acc = getAccumulator(rec, ctx);
    try {
      if (acc.empty) return;
      if (!isFinal) acc.isWindow = true;
      else if (acc.isWindow) { destroyAccumulator(acc); return; }
      let result = acc.value;
      if (rec.result) {
        try {
          result = rec.result.call(undefined, result);
        } catch (e) {
          propagateAggregateError(rec, acc, ctx, e);
          return;
        }
      }
      pendingConversionError = null;
      resultValueFromJS(ctx, result, {
        prefix: () => 'User-defined function ' + rec.name + '() returned',
        propagate: (c: number) => propagateAggregateError(rec, acc, c, pendingConversionError),
      });
      if (isFinal) destroyAccumulator(acc);
    } finally {
      if (isFinal) releaseAccumulator(ctx);
    }
  }

  /* ------------------------------------------------------------ virtual tables */

  interface ModuleRec { db: DbState; name: string; factory: Function; }
  interface VtabRec { module: ModuleRec; generator: Function; parameterNames: string[]; safeInts: boolean; }
  interface CursorRec { vtab: VtabRec; iterator: any; next: Function | null; row: any; done: boolean; rowid: number; }
  const modules: Map<number, ModuleRec> = new Map();
  let nextModuleId = 0;
  const vtabs: Map<number, VtabRec> = new Map();
  let nextVtabId = 0;
  const cursors: Map<number, CursorRec> = new Map();
  let nextCursorId = 0;

  // CustomTable::PropagateJSError(): only flags the database; the caller returns SQLITE_ERROR.
  function propagateTableError(db: DbState, error: unknown): void {
    db.jsError = { error };
  }

  /* ------------------------------------------------------------------- the VFS */

  interface VFile {
    path: string | null;
    data: Uint8Array;
    size: number;
    dirty: boolean;
    refs: number;
    deleted: boolean;
    lockShared: number;
    lockReserved: number;
    lockPending: number;
    lockExclusive: number;
    shm: ShmState | null;
  }
  interface VHandle { id: number; file: VFile; level: number; deleteOnClose: boolean; shmMapped: boolean; shmShared: number; shmExcl: number; }
  interface ShmState { regions: number[]; refs: number; shared: number[]; exclusive: number[]; }

  const files: Map<string, VFile> = new Map();
  const handles: Map<number, VHandle> = new Map();
  let nextHandleId = 0;

  function newFile(path: string | null, data: Uint8Array): VFile {
    return {
      path, data, size: data.length, dirty: false, refs: 0, deleted: false,
      lockShared: 0, lockReserved: 0, lockPending: 0, lockExclusive: 0, shm: null,
    };
  }
  function flush(file: VFile): number {
    if (!file.dirty || file.path === null || file.deleted) return SQLITE_OK;
    try {
      getFs().writeFileSync(file.path, file.data.subarray(0, file.size));
      file.dirty = false;
      return SQLITE_OK;
    } catch (e) {
      return SQLITE_IOERR_WRITE;
    }
  }
  function ensureCapacity(file: VFile, n: number): void {
    if (n <= file.data.length) return;
    let cap = file.data.length || 4096;
    while (cap < n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(file.data.subarray(0, file.size));
    file.data = next;
  }
  function parentDir(p: string): string {
    const i = p.lastIndexOf('/');
    return i <= 0 ? '/' : p.slice(0, i);
  }
  function normalizePath(p: string): string {
    const out: string[] = [];
    for (const part of p.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') out.pop();
      else out.push(part);
    }
    return '/' + out.join('/');
  }
  function fullPathname(name: string): string {
    let p = name.charAt(0) === '/' ? normalizePath(name) : normalizePath(getCwd() + '/' + name);
    // unixFullPathname() resolves symbolic links; resolve the directory part when the fs can.
    const fsx = getFs();
    if (typeof fsx.realpathSync === 'function') {
      const dir = parentDir(p);
      try {
        const real = fsx.realpathSync(dir);
        p = (real === '/' ? '' : real) + '/' + p.slice(dir === '/' ? 1 : dir.length + 1);
      } catch (e) { /* directory missing: keep the lexical path */ }
    }
    return p;
  }
  function removeFile(path: string): void {
    const f = files.get(path);
    if (f) { f.deleted = true; files.delete(path); }
    try { const fsx = getFs(); if (fsx.existsSync(path)) fsx.unlinkSync(path); } catch (e) { /* remove() ignores errors */ }
  }
  function handleOf(id: number): VHandle {
    const h = handles.get(id);
    if (!h) throw new Error('better-sqlite3 shim: unknown VFS handle ' + id);
    return h;
  }

  const vfs = {
    vfs_open(zName: number, flags: number, pOutFlags: number): number {
      const name = zName ? cstr(zName) : null;
      let file: VFile;
      if (name === null) {
        file = newFile(null, new Uint8Array(0));
      } else {
        const existing = files.get(name);
        if (existing && !existing.deleted) {
          if ((flags & SQLITE_OPEN_EXCLUSIVE) && (flags & SQLITE_OPEN_CREATE)) return -SQLITE_CANTOPEN;
          file = existing;
        } else {
          const fsx = getFs();
          let exists = false;
          try {
            if (fsx.existsSync(name)) {
              if (fsx.statSync(name).isDirectory()) return -SQLITE_CANTOPEN;
              exists = true;
            }
          } catch (e) { return -SQLITE_CANTOPEN; }
          if (exists) {
            if ((flags & SQLITE_OPEN_EXCLUSIVE) && (flags & SQLITE_OPEN_CREATE)) return -SQLITE_CANTOPEN;
            let bytes: Uint8Array;
            try { bytes = fsx.readFileSync(name); } catch (e) { return -SQLITE_CANTOPEN; }
            file = newFile(name, new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
          } else {
            if (!(flags & SQLITE_OPEN_CREATE)) return -SQLITE_CANTOPEN;
            try { fsx.writeFileSync(name, new Uint8Array(0)); } catch (e) { return -SQLITE_CANTOPEN; }
            file = newFile(name, new Uint8Array(0));
          }
          files.set(name, file);
        }
      }
      file.refs++;
      const id = ++nextHandleId;
      handles.set(id, {
        id, file, level: SQLITE_LOCK_NONE, deleteOnClose: name === null || !!(flags & SQLITE_OPEN_DELETEONCLOSE),
        shmMapped: false, shmShared: 0, shmExcl: 0,
      });
      if (pOutFlags) i32()[pOutFlags >> 2] = flags;
      return id;
    },
    vfs_close(id: number): number {
      const h = handleOf(id);
      vfs.vfs_unlock(id, SQLITE_LOCK_NONE);
      handles.delete(id);
      const f = h.file;
      f.refs--;
      let rc = SQLITE_OK;
      if (h.deleteOnClose) {
        if (f.path !== null) removeFile(f.path);
      } else if (f.refs === 0) {
        rc = flush(f);
        if (f.path !== null && files.get(f.path) === f) files.delete(f.path);
      }
      return rc;
    },
    vfs_read(id: number, buf: number, amt: number, offset: number): number {
      const f = handleOf(id).file;
      const h8 = u8();
      const avail = Math.max(0, Math.min(amt, f.size - offset));
      if (avail > 0) h8.set(f.data.subarray(offset, offset + avail), buf);
      if (avail < amt) {
        h8.fill(0, buf + avail, buf + amt);
        return SQLITE_IOERR_SHORT_READ;
      }
      return SQLITE_OK;
    },
    vfs_write(id: number, buf: number, amt: number, offset: number): number {
      const f = handleOf(id).file;
      const end = offset + amt;
      ensureCapacity(f, end);
      if (offset > f.size) f.data.fill(0, f.size, offset);
      f.data.set(u8().subarray(buf, buf + amt), offset);
      if (end > f.size) f.size = end;
      f.dirty = true;
      return SQLITE_OK;
    },
    vfs_truncate(id: number, size: number): number {
      const f = handleOf(id).file;
      if (size > f.size) { ensureCapacity(f, size); f.data.fill(0, f.size, size); }
      f.size = size;
      f.dirty = true;
      return SQLITE_OK;
    },
    vfs_sync(id: number, flags: number): number {
      const rc = flush(handleOf(id).file);
      return rc === SQLITE_OK ? SQLITE_OK : SQLITE_IOERR_FSYNC;
    },
    vfs_filesize(id: number): number {
      return handleOf(id).file.size;
    },
    vfs_lock(id: number, level: number): number {
      const h = handleOf(id);
      const f = h.file;
      if (h.level >= level) return SQLITE_OK;
      if (level === SQLITE_LOCK_SHARED) {
        if (f.lockPending || f.lockExclusive) return SQLITE_BUSY;
        f.lockShared++;
        h.level = SQLITE_LOCK_SHARED;
        return SQLITE_OK;
      }
      if (level === SQLITE_LOCK_RESERVED) {
        if (f.lockReserved || f.lockPending || f.lockExclusive) return SQLITE_BUSY;
        f.lockReserved = id;
        h.level = SQLITE_LOCK_RESERVED;
        return SQLITE_OK;
      }
      // EXCLUSIVE (through PENDING)
      if (h.level < SQLITE_LOCK_PENDING) {
        if ((f.lockPending && f.lockPending !== id) || (f.lockReserved && f.lockReserved !== id)) return SQLITE_BUSY;
        f.lockPending = id;
        h.level = SQLITE_LOCK_PENDING;
      }
      if (f.lockShared > 1) return SQLITE_BUSY;
      f.lockExclusive = id;
      h.level = SQLITE_LOCK_EXCLUSIVE;
      return SQLITE_OK;
    },
    vfs_unlock(id: number, level: number): number {
      const h = handleOf(id);
      const f = h.file;
      if (h.level <= level) return SQLITE_OK;
      if (f.lockExclusive === id) f.lockExclusive = 0;
      if (f.lockPending === id) f.lockPending = 0;
      if (f.lockReserved === id) f.lockReserved = 0;
      if (level === SQLITE_LOCK_NONE && h.level >= SQLITE_LOCK_SHARED) f.lockShared--;
      h.level = level;
      // Below RESERVED the write transaction is over: publish the file image.
      if (level < SQLITE_LOCK_RESERVED && f.dirty) {
        const rc = flush(f);
        if (rc !== SQLITE_OK) return rc;
      }
      return SQLITE_OK;
    },
    vfs_check_reserved(id: number): number {
      const f = handleOf(id).file;
      return (f.lockReserved || f.lockPending || f.lockExclusive) ? 1 : 0;
    },
    vfs_shm_map(id: number, region: number, size: number, extend: number, pp: number): number {
      const h = handleOf(id);
      const f = h.file;
      if (!f.shm) f.shm = { regions: [], refs: 0, shared: new Array(SQLITE_SHM_NLOCK).fill(0), exclusive: new Array(SQLITE_SHM_NLOCK).fill(0) };
      if (!h.shmMapped) { h.shmMapped = true; f.shm.refs++; }
      let p = f.shm.regions[region] || 0;
      if (!p && extend) {
        for (let r = 0; r <= region; r++) {
          if (!f.shm.regions[r]) {
            const q: number = M._malloc(size);
            if (!q) return SQLITE_NOMEM;
            u8().fill(0, q, q + size);
            f.shm.regions[r] = q;
          }
        }
        p = f.shm.regions[region];
      }
      i32()[pp >> 2] = p;
      return SQLITE_OK;
    },
    vfs_shm_lock(id: number, offset: number, n: number, flags: number): number {
      const h = handleOf(id);
      const shm = h.file.shm!;
      const mask = ((1 << (offset + n)) - 1) & ~((1 << offset) - 1);
      if (flags & SQLITE_SHM_UNLOCK) {
        for (let i = offset; i < offset + n; i++) {
          const bit = 1 << i;
          if (h.shmShared & bit) shm.shared[i]--;
          if (h.shmExcl & bit) shm.exclusive[i] = 0;
        }
        h.shmShared &= ~mask;
        h.shmExcl &= ~mask;
        return SQLITE_OK;
      }
      if (flags & SQLITE_SHM_SHARED) {
        for (let i = offset; i < offset + n; i++) {
          if (shm.exclusive[i] && shm.exclusive[i] !== id) return SQLITE_BUSY;
        }
        for (let i = offset; i < offset + n; i++) {
          if (!(h.shmShared & (1 << i))) shm.shared[i]++;
        }
        h.shmShared |= mask;
        return SQLITE_OK;
      }
      // EXCLUSIVE
      for (let i = offset; i < offset + n; i++) {
        if (shm.exclusive[i] && shm.exclusive[i] !== id) return SQLITE_BUSY;
        const mine = (h.shmShared & (1 << i)) ? 1 : 0;
        if (shm.shared[i] - mine > 0) return SQLITE_BUSY;
      }
      for (let i = offset; i < offset + n; i++) shm.exclusive[i] = id;
      h.shmExcl |= mask;
      return SQLITE_OK;
    },
    vfs_shm_unmap(id: number, deleteFlag: number): number {
      const h = handleOf(id);
      const f = h.file;
      const shm = f.shm;
      if (!shm || !h.shmMapped) return SQLITE_OK;
      vfs.vfs_shm_lock(id, 0, SQLITE_SHM_NLOCK, SQLITE_SHM_UNLOCK | SQLITE_SHM_SHARED);
      h.shmMapped = false;
      shm.refs--;
      if (shm.refs === 0) {
        for (const p of shm.regions) if (p) M._free(p);
        f.shm = null;
      }
      return SQLITE_OK;
    },
    vfs_delete(zName: number, syncDir: number): number {
      const name = cstr(zName);
      const f = files.get(name);
      let found = false;
      if (f) { f.deleted = true; files.delete(name); found = true; }
      try {
        const fsx = getFs();
        if (fsx.existsSync(name)) { fsx.unlinkSync(name); found = true; }
      } catch (e) {
        return SQLITE_IOERR_DELETE;
      }
      return found ? SQLITE_OK : SQLITE_IOERR_DELETE_NOENT;
    },
    vfs_access(zName: number, flags: number): number {
      const name = cstr(zName);
      const f = files.get(name);
      if (f && !f.deleted) return flags === SQLITE_ACCESS_EXISTS ? (f.size > 0 ? 1 : 0) : 1;
      try {
        const fsx = getFs();
        if (!fsx.existsSync(name)) return 0;
        if (flags !== SQLITE_ACCESS_EXISTS) return 1;
        const st = fsx.statSync(name);
        return (!st.isFile() || st.size > 0) ? 1 : 0;
      } catch (e) {
        return -SQLITE_IOERR_ACCESS;
      }
    },
    vfs_fullpathname(zName: number, nOut: number, zOut: number): number {
      const full = fullPathname(cstr(zName));
      const n = utf8Length(full);
      if (n + 1 > nOut) return SQLITE_CANTOPEN | (3 << 8); // SQLITE_CANTOPEN_FULLPATH
      const h8 = u8();
      utf8Write(full, h8, zOut);
      h8[zOut + n] = 0;
      return SQLITE_OK;
    },
    vfs_randomness(nByte: number, zOut: number): number {
      const bytes = new Uint8Array(nByte);
      const c: any = (globalThis as any).crypto;
      if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
      else for (let i = 0; i < nByte; i++) bytes[i] = Math.floor(Math.random() * 256);
      u8().set(bytes, zOut);
      return nByte;
    },
    vfs_now_ms(): number {
      return Date.now();
    },
    vfs_sleep(us: number): void {
      const end = Date.now() + us / 1000;
      while (Date.now() < end) { /* busy wait: the guest has no blocking sleep */ }
    },

    /* scalar functions: CustomFunction::xFunc */
    xfunc(id: number, ctx: number, argc: number, argv: number): void {
      const rec = functions.get(id)!;
      let ret: unknown;
      try {
        const args = argc !== 0 ? argumentValues(argv, argc, rec.safeInts) : [];
        ret = rec.fn.apply(undefined, args);
      } catch (e) {
        propagateFunctionError(rec, ctx, e);
        return;
      }
      pendingConversionError = null;
      resultValueFromJS(ctx, ret, functionConverter(rec, (c) => propagateFunctionError(rec, c, pendingConversionError)));
    },
    xstep(id: number, ctx: number, argc: number, argv: number): void { xStepBase(id, ctx, argc, argv, false); },
    xinverse(id: number, ctx: number, argc: number, argv: number): void { xStepBase(id, ctx, argc, argv, true); },
    xvalue(id: number, ctx: number): void { xValueBase(id, ctx, false); },
    xfinal(id: number, ctx: number): void { xValueBase(id, ctx, true); },
    xdestroy(id: number): void { functions.delete(id); },

    /* virtual tables: CustomTable::* */
    vtab_connect(moduleId: number, dbHandle: number, argc: number, argv: number, pzErr: number, pVtabId: number, pParamCount: number): number {
      const mod = modules.get(moduleId)!;
      const strArgs: string[] = [];
      for (let i = 0; i < argc; i++) strArgs.push(cstr(i32()[(argv >> 2) + i]));
      let ret: any;
      try {
        ret = mod.factory.apply(undefined, strArgs);
      } catch (e) {
        propagateTableError(mod.db, e);
        return SQLITE_ERROR;
      }
      const sql = ret[0] as string;
      const generator = ret[1] as Function;
      const parameterNames = (ret[2] as unknown[]).map(String);
      let safeInts = ret[3] as number;
      const directOnly = ret[4] as boolean;
      const safe = safeInts < 2 ? safeInts !== 0 : mod.db.safeInts;
      const [sp] = allocUtf8(sql);
      let rc: number;
      try { rc = M._sqlite3_declare_vtab(dbHandle, sp); } finally { M._free(sp); }
      if (rc !== SQLITE_OK) {
        const [ap] = allocUtf8('failed to declare virtual table "%s"');
        i32()[pzErr >> 2] = M._owc_mprintf_s(ap, i32()[(argv >> 2) + 2]);
        M._free(ap);
        return SQLITE_ERROR;
      }
      if (directOnly && M._owc_vtab_config_directonly(dbHandle) !== SQLITE_OK) {
        const [ap] = allocUtf8('failed to configure virtual table "%s"');
        i32()[pzErr >> 2] = M._owc_mprintf_s(ap, i32()[(argv >> 2) + 2]);
        M._free(ap);
        return SQLITE_ERROR;
      }
      const vtabId = ++nextVtabId;
      vtabs.set(vtabId, { module: mod, generator, parameterNames, safeInts: safe });
      i32()[pVtabId >> 2] = vtabId;
      i32()[pParamCount >> 2] = parameterNames.length;
      return SQLITE_OK;
    },
    vtab_param_name(vtabId: number, column: number, zOut: number, nOut: number): void {
      const v = vtabs.get(vtabId)!;
      const name = v.parameterNames[column] || '';
      const [p, n] = allocUtf8(name);
      const m = Math.min(n, nOut - 1);
      const h8 = u8();
      h8.copyWithin(zOut, p, p + m);
      h8[zOut + m] = 0;
      M._free(p);
    },
    vtab_disconnect(vtabId: number): void { vtabs.delete(vtabId); },
    vtab_open(vtabId: number): number {
      const id = ++nextCursorId;
      cursors.set(id, { vtab: vtabs.get(vtabId)!, iterator: null, next: null, row: null, done: false, rowid: 0 });
      return id;
    },
    vtab_close(cursorId: number): void { cursors.delete(cursorId); },
    vtab_filter(cursorId: number, idxNum: number, argc: number, argv: number): number {
      const cur = cursors.get(cursorId)!;
      const vtab = cur.vtab;
      const db = vtab.module.db;
      const parameterCount = vtab.parameterNames.length;
      const args = new Array(parameterCount);
      let argn = 0;
      for (let i = 0; i < parameterCount; i++) {
        if (idxNum & (1 << i)) {
          args[i] = valueValue(i32()[(argv >> 2) + argn++], vtab.safeInts);
          if (args[i] === null) { cur.done = true; return SQLITE_OK; }
        } else {
          args[i] = undefined;
        }
      }
      let iterator: any;
      try {
        iterator = vtab.generator.apply(undefined, args);
        cur.next = iterator.next;
      } catch (e) {
        propagateTableError(db, e);
        return SQLITE_ERROR;
      }
      cur.iterator = iterator;
      cur.rowid = 0;
      return vfs.vtab_next(cursorId);
    },
    vtab_next(cursorId: number): number {
      const cur = cursors.get(cursorId)!;
      let record: any;
      try {
        record = (cur.next as Function).call(cur.iterator);
      } catch (e) {
        propagateTableError(cur.vtab.module.db, e);
        return SQLITE_ERROR;
      }
      const done = !!record.done;
      if (!done) cur.row = record.value;
      cur.done = done;
      cur.rowid += 1;
      return SQLITE_OK;
    },
    vtab_eof(cursorId: number): number { return cursors.get(cursorId)!.done ? 1 : 0; },
    vtab_column(cursorId: number, ctx: number, column: number): number {
      const cur = cursors.get(cursorId)!;
      const mod = cur.vtab.module;
      let status = SQLITE_OK;
      let value: unknown;
      try {
        value = cur.row[column];
      } catch (e) {
        propagateTableError(mod.db, e);
        return SQLITE_ERROR;
      }
      pendingConversionError = null;
      resultValueFromJS(ctx, value, {
        prefix: () => 'Virtual table module "' + mod.name + '" yielded',
        propagate: () => { status = SQLITE_ERROR; propagateTableError(mod.db, pendingConversionError); },
      });
      return status;
    },
    vtab_rowid(cursorId: number): number { return cursors.get(cursorId)!.rowid; },
    module_destroy(moduleId: number): void { modules.delete(moduleId); },
  };
  M.owc = vfs;

  const addon: any = {};
  addon.Database = Database;
  addon.Statement = Statement;
  addon.StatementIterator = StatementIterator;
  addon.Backup = Backup;
  addon.setErrorConstructor = setErrorConstructor;
  return addon;
}

export default createAddon;
