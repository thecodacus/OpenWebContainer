/**
 * Guest-side WebAssembly: the `WebAssembly` global, built on the host bridge in
 * runtime/wasm-host.ts.
 *
 * Modules are compiled and run in the host realm, because the guest engine has no
 * WebAssembly at all. Everything here behaves like the real thing except memory: a
 * `WebAssembly.Memory` keeps a guest shadow of the bytes, and the host copies the shadow
 * across the boundary whenever an export is called or an import calls back into guest
 * code. So guest writes to `memory.buffer` are visible to the module from the next call
 * on, and the module's writes are visible to the guest as soon as a call returns -- but
 * not in between, since there is one copy per call, not per byte. The copy is made in
 * chunks, so a large heap never exists twice at once; that changes nothing about when a
 * write becomes visible, only how much is live during the copy.
 *
 * Plain JavaScript inside a String.raw snippet, evaluated by the bootstrap with `host`
 * in scope.
 */
export const WASM_SRC = String.raw`
(function () {
  if (!host.wasm) return;
  var W = host.wasm;

  class CompileError extends Error { constructor (m) { super(m); this.name = 'CompileError'; } }
  class LinkError extends Error { constructor (m) { super(m); this.name = 'LinkError'; } }
  class RuntimeError extends Error { constructor (m) { super(m); this.name = 'RuntimeError'; } }

  var NAMED = { Error: Error, TypeError: TypeError, RangeError: RangeError, ReferenceError: ReferenceError, SyntaxError: SyntaxError };

  function parse (text) {
    var value = JSON.parse(text);
    if (value && value.ok === false) throw buildError(value);
    return value;
  }
  /** A host envelope: on failure it carries the code, the message and the guest error's name. */
  function unwrap (text) {
    var value = JSON.parse(text);
    if (value && value.ok === false) throw buildError(value);
    return value.value;
  }
  function buildError (envelope) {
    var props = envelope.props || {};
    var message = envelope.message || 'WebAssembly failed';
    var error;
    if (envelope.code === 'ERR_WASM_COMPILE') error = new CompileError(message);
    else if (envelope.code === 'ERR_WASM_LINK') error = new LinkError(message);
    else if (envelope.code === 'ERR_WASM_TRAP') error = new RuntimeError(message);
    else if (envelope.code === 'ERR_WASM_GUEST') {
      var Ctor = NAMED[props.name] || Error;
      error = new Ctor(message);
      if (props.name && !NAMED[props.name]) error.name = props.name;
      if (props.code) error.code = props.code;
      return error;
    } else error = new Error(message);
    error.code = envelope.code;
    return error;
  }

  function toArrayBuffer (value) {
    if (value instanceof ArrayBuffer) return value;
    if (ArrayBuffer.isView(value)) {
      var copy = new Uint8Array(value.byteLength);
      copy.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      return copy.buffer;
    }
    throw new TypeError('WebAssembly: the argument must be a BufferSource');
  }

  /*
   * One piece of a memory copy. The host asks for pieces of this size when it syncs, and the
   * guest asks for the same when it seeds a shadow: a piece is small enough to allocate next
   * to a memory already this big, a whole memory is not.
   */
  var CHUNK = 1048576;

  /*
   * A wasm export takes numbers, and the JS API coerces anything else: ToNumber, then NaN
   * becomes 0. Doing it here rather than shipping the arguments across as JSON keeps the
   * heap out of it -- emscripten hands its Module object to a queued callback, and that
   * object carries a typed array view over every byte of a memory this size.
   */
  function wasmArgs (args) {
    var out = [];
    for (var i = 0; i < args.length; i++) {
      var value = Number(args[i]);
      out.push(value === value ? value : 0);
    }
    return JSON.stringify(out);
  }

  /* Live objects by host id, so the host's sync callbacks can find them. */
  var MEM = Object.create(null);
  var TAB = Object.create(null);
  var GLOB = Object.create(null);

  /* The guest side of a host memory: buffer is the shadow the guest code sees. */
  class Memory {
    constructor (descriptor) {
      var d = descriptor || {};
      var initial = Math.max(0, Math.floor(d.initial || 0));
      var maximum = d.maximum === undefined ? -1 : Math.floor(d.maximum);
      if (d.shared) throw new Error('WebAssembly.Memory: shared memory is not supported in the container');
      this.__id = unwrap(W.memoryNew(initial, maximum));
      this.__buffer = new ArrayBuffer(initial * 65536);
      MEM[this.__id] = this;
    }
    get buffer () { return this.__buffer; }
    grow (delta) {
      delta = Math.floor(delta);
      var before = unwrap(W.memoryGrow(this.__id, delta));
      this.__resize(unwrap(W.memoryPages(this.__id)) * 65536);
      return before;
    }
    __resize (bytes) {
      if (bytes === this.__buffer.byteLength) return;
      var next = new ArrayBuffer(bytes);
      var view = new Uint8Array(next);
      var old = new Uint8Array(this.__buffer);
      view.set(old.subarray(0, Math.min(old.length, view.length)));
      this.__buffer = next;
    }
  }

  /** A memory the module created: same as a guest Memory, seeded with the module's bytes. */
  function bindMemory (id) {
    var memory = Object.create(Memory.prototype);
    memory.__id = id;
    var size = unwrap(W.memoryPages(id)) * 65536;
    memory.__buffer = new ArrayBuffer(size);
    for (var off = 0; off < size; off += CHUNK) {
      var part = W.memoryRead(id, off, Math.min(CHUNK, size - off));
      if (!part || part.byteLength === 0) break;
      new Uint8Array(memory.__buffer, off, part.byteLength).set(new Uint8Array(part));
    }
    MEM[id] = memory;
    return memory;
  }

  class Table {
    constructor (descriptor) {
      var d = descriptor || {};
      this.__element = d.element || 'anyfunc';
      var maximum = d.maximum === undefined ? -1 : Math.floor(d.maximum);
      this.__id = unwrap(W.tableNew(this.__element, Math.max(0, Math.floor(d.initial || 0)), maximum));
      this.__entries = new Array(unwrap(W.tableLength(this.__id)));
      this.__ids = new Array(this.__entries.length);
      TAB[this.__id] = this;
    }
    get length () { return unwrap(W.tableLength(this.__id)); }
    get (index) {
      var entry = this.__entries[index];
      if (entry === undefined) {
        var info = unwrap(W.tableGet(this.__id, index));
        entry = info && info.k === 'fn' ? hostFunction(this.__id, info.id) : null;
        this.__entries[index] = entry;
      }
      return entry;
    }
    set (index, value) {
      if (value !== null && typeof value !== 'function') throw new TypeError('WebAssembly.Table.set: expected a function or null');
      var previous = this.__ids[index];
      if (previous !== undefined) W.drop(previous);
      var id = value === null ? 0 : W.retain(value);
      var reply = JSON.parse(W.tableSet(this.__id, index, JSON.stringify(value === null ? { k: 'null' } : { k: 'fn', id: id })));
      /* A function-typed table takes WebAssembly functions only, so the guest keeps its own. */
      if (reply && reply.ok === false && reply.code !== 'ERR_WASM_TABLE_JSFN') throw buildError(reply);
      this.__ids[index] = value === null ? undefined : id;
      this.__entries[index] = value;
    }
    grow (delta) {
      var before = unwrap(W.tableGrow(this.__id, Math.floor(delta)));
      this.__entries.length = unwrap(W.tableLength(this.__id));
      return before;
    }
    __host (json) {
      var entries = JSON.parse(json);
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        if (entry.k === 'fn') this.__entries[entry.i] = hostFunction(this.__id, entry.id);
        else if (this.__entries[entry.i] === undefined) this.__entries[entry.i] = null;
      }
      this.__entries.length = unwrap(W.tableLength(this.__id));
    }
  }

  function bindTable (id) {
    var table = Object.create(Table.prototype);
    table.__element = 'anyfunc';
    table.__id = id;
    table.__entries = new Array(unwrap(W.tableLength(id)));
    table.__ids = new Array(table.__entries.length);
    TAB[id] = table;
    table.__host(W.tableDump(id));
    return table;
  }

  /** A wasm function the host holds: calling it goes through the host, with memory synced. */
  function hostFunction (instanceId, fnId) {
    var call = function () {
      return unwrap(W.fnCall(fnId, wasmArgs(arguments), instanceId));
    };
    Object.defineProperty(call, 'name', { value: 'wasm-function', configurable: true });
    return call;
  }

  class Global {
    constructor (descriptor, value) {
      var d = descriptor || {};
      this.__id = unwrap(W.globalNew(d.value || 'i32', !!d.mutable, value === undefined ? 0 : Number(value)));
      GLOB[this.__id] = this;
    }
    get value () { return unwrap(W.globalGet(this.__id)); }
    set value (next) { unwrap(W.globalSet(this.__id, Number(next))); }
  }

  function bindGlobal (id) {
    var global = Object.create(Global.prototype);
    global.__id = id;
    GLOB[id] = global;
    return global;
  }

  /*
   * The host's two sync callbacks. Only memory needs them: a table or global the guest
   * writes goes straight through to the host, while a write into the memory shadow is
   * invisible until it is copied.
   *
   * A memory is copied a chunk at a time, so a large heap is never live twice: onPull
   * answers with the bytes at (offset, length) and onPush writes the bytes it is handed
   * back at offset, growing the shadow when a chunk runs past its end. The chunk is a
   * fresh ArrayBuffer each time -- the host copies it out of this heap anyway.
   */
  var PULL = 0;
  var PUSH = 0;
  function onPull (kind, id, offset, length) {
    if (kind !== 'mem') return undefined;
    var memory = MEM[id];
    if (!memory) return undefined;
    var size = memory.__buffer.byteLength;
    var start = typeof offset === 'number' && offset > 0 ? Math.min(offset, size) : 0;
    var end = typeof length === 'number' && length > 0 ? Math.min(size, start + length) : size;
    var out = new Uint8Array(Math.max(0, end - start));
    if (out.length > 0) out.set(new Uint8Array(memory.__buffer, start, out.length));
    return out.buffer;
  }
  function onPush (kind, id, offset, payload) {
    if (kind !== 'mem') return undefined;
    var memory = MEM[id];
    if (!memory || !payload) return undefined;
    var start = typeof offset === 'number' && offset > 0 ? offset : 0;
    if (start + payload.byteLength > memory.__buffer.byteLength) memory.__resize(start + payload.byteLength);
    if (payload.byteLength > 0) new Uint8Array(memory.__buffer, start, payload.byteLength).set(new Uint8Array(payload));
    return undefined;
  }
  function syncIds () {
    if (!PULL) {
      PULL = W.retain(onPull);
      PUSH = W.retain(onPush);
    }
    return [PULL, PUSH];
  }

  function shapeOf (module) {
    var text = W.moduleShape(module.__id);
    var value = JSON.parse(text);
    if (value && value.ok === false) throw buildError(value);
    return value;
  }

  class Module {
    constructor (bytes) {
      this.__id = unwrap(W.compile(toArrayBuffer(bytes)));
    }
    static imports (module) {
      var shape = shapeOf(module);
      return shape.imports.map(function (entry) { return { module: entry.module, name: entry.name, kind: entry.kind }; });
    }
    static exports (module) {
      var shape = shapeOf(module);
      return shape.exports.map(function (entry) { return { name: entry.name, kind: entry.kind }; });
    }
    static customSections () { return []; }
  }

  function describeImports (imports) {
    var out = {};
    if (!imports) return out;
    var namespaces = Object.keys(imports);
    for (var i = 0; i < namespaces.length; i++) {
      var entries = imports[namespaces[i]] || {};
      var built = {};
      var names = Object.keys(entries);
      for (var j = 0; j < names.length; j++) {
        var value = entries[names[j]];
        if (value instanceof Memory) built[names[j]] = { k: 'mem', id: value.__id };
        else if (value instanceof Table) built[names[j]] = { k: 'tab', id: value.__id };
        else if (value instanceof Global) built[names[j]] = { k: 'glob', id: value.__id };
        else if (typeof value === 'function') built[names[j]] = { k: 'fn', id: W.retain(value) };
        else if (typeof value === 'number') built[names[j]] = { k: 'num', v: value };
        else if (value === undefined || value === null) continue;
        else throw new TypeError('WebAssembly: ' + namespaces[i] + '.' + names[j] + ' is not a supported import');
      }
      out[namespaces[i]] = built;
    }
    return out;
  }

  function wrapExport (instanceId, entry) {
    if (entry.kind === 'function') {
      var fn = function () {
        return unwrap(W.call(instanceId, entry.name, wasmArgs(arguments)));
      };
      Object.defineProperty(fn, 'name', { value: entry.name, configurable: true });
      return fn;
    }
    if (entry.kind === 'memory') return bindMemory(entry.id);
    if (entry.kind === 'table') return bindTable(entry.id);
    if (entry.kind === 'global') return bindGlobal(entry.id);
    return undefined;
  }

  class Instance {
    constructor (module, imports) {
      if (!(module instanceof Module)) throw new TypeError('WebAssembly.Instance: expected a Module');
      var ids = syncIds();
      var info = unwrap(W.instantiate(module.__id, JSON.stringify(describeImports(imports)), ids[0], ids[1]));
      this.__id = info.id;
      this.__module = module;
      this.exports = Object.create(null);
      for (var i = 0; i < info.exports.length; i++) {
        var entry = info.exports[i];
        this.exports[entry.name] = wrapExport(this.__id, entry);
      }
    }
  }

  function validate (bytes) {
    try {
      return W.validate(toArrayBuffer(bytes)) === true;
    } catch (error) {
      return false;
    }
  }
  function compile (bytes) {
    return Promise.resolve(new Module(bytes));
  }
  /*
   * Two shapes, as in the JS API: given bytes this resolves to { module, instance }, and given a
   * Module it resolves to the Instance itself. hash-wasm and most emscripten output take the
   * second form and read result.exports straight off what they awaited.
   */
  function instantiate (source, imports) {
    try {
      if (source instanceof Module) return Promise.resolve(new Instance(source, imports));
      var module = new Module(source);
      return Promise.resolve({ module: module, instance: new Instance(module, imports) });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  Object.defineProperty(globalThis, 'WebAssembly', {
    value: {
      compile: compile,
      instantiate: instantiate,
      validate: validate,
      Module: Module,
      Instance: Instance,
      Memory: Memory,
      Table: Table,
      Global: Global,
      CompileError: CompileError,
      LinkError: LinkError,
      RuntimeError: RuntimeError
    },
    writable: true,
    configurable: true,
    enumerable: false
  });
})();
`;
