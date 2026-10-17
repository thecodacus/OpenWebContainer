/**
 * Guest source for the pure-b family: vm, domain, inspector (and inspector/promises)
 * and repl. Plain JavaScript inside a String.raw snippet; everything lives in one IIFE
 * that only registers BF factories, so no globals are introduced.
 *
 * vm model: a context is a sandbox object. Code runs through a `with` scope backed by
 * a Proxy: names the sandbox owns resolve there, ES builtins fall through to the host
 * realm, and every other free name reads and writes the sandbox, so undeclared
 * assignments and top-level var declarations land on the sandbox. Top-level function
 * declarations are copied onto the sandbox after each run. This is not a separate
 * realm: prototypes, builtins and instanceof are shared with the host.
 */
export const SRC = String.raw`
(function () {
  var ES_NAMES = Object.create(null);
  var ES_LIST = ['AggregateError', 'Array', 'ArrayBuffer', 'Atomics', 'BigInt', 'BigInt64Array',
    'BigUint64Array', 'Boolean', 'DataView', 'Date', 'Error', 'EvalError', 'FinalizationRegistry',
    'Float32Array', 'Float64Array', 'Function', 'Infinity', 'Int8Array', 'Int16Array', 'Int32Array',
    'Intl', 'JSON', 'Map', 'Math', 'NaN', 'Number', 'Object', 'Promise', 'Proxy', 'RangeError',
    'ReferenceError', 'Reflect', 'RegExp', 'Set', 'SharedArrayBuffer', 'String', 'Symbol',
    'SyntaxError', 'TypeError', 'Uint8Array', 'Uint8ClampedArray', 'Uint16Array', 'Uint32Array',
    'URIError', 'WeakMap', 'WeakRef', 'WeakSet', 'decodeURI', 'decodeURIComponent', 'encodeURI',
    'encodeURIComponent', 'escape', 'eval', 'isFinite', 'isNaN', 'parseFloat', 'parseInt',
    'undefined', 'unescape'];
  for (var esi = 0; esi < ES_LIST.length; esi++) ES_NAMES[ES_LIST[esi]] = true;

  var vmRecords = new WeakMap();
  var REGEX_AFTER_WORD = { 'return': true, 'typeof': true, 'instanceof': true, 'in': true, 'of': true,
    'new': true, 'delete': true, 'void': true, 'throw': true, 'case': true, 'do': true, 'else': true,
    'yield': true, 'await': true };

  function isObjectLike(v) {
    return v !== null && (typeof v === 'object' || typeof v === 'function');
  }

  function nodeError(Ctor, code, message) {
    var err = new Ctor(message);
    err.code = code;
    return err;
  }

  function describeReceived(value) {
    if (value === null) return 'Received null';
    if (value === undefined) return 'Received undefined';
    var t = typeof value;
    if (t === 'function') return 'Received function ' + (value.name || '(anonymous)');
    if (t === 'object') {
      var proto = Object.getPrototypeOf(value);
      var ctor = proto ? proto.constructor : undefined;
      if (ctor && ctor.name) return 'Received an instance of ' + ctor.name;
      return 'Received ' + inspectValue(value);
    }
    return 'Received type ' + t + ' (' + inspectValue(value) + ')';
  }

  function argError(name, expected, value) {
    return nodeError(TypeError, 'ERR_INVALID_ARG_TYPE',
      'The "' + name + '" argument must be ' + expected + '. ' + describeReceived(value));
  }

  // ---- lexing (only enough JavaScript to find top-level structure) ----

  function isIdStartCode(c) {
    return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || c > 127;
  }

  function isIdPartCode(c) {
    return isIdStartCode(c) || (c >= 48 && c <= 57);
  }

  function regexAllowedAfter(last) {
    if (last === null) return true;
    if (last.t === 'id') return REGEX_AFTER_WORD[last.v] === true;
    if (last.t === 'punct') return last.v !== ')' && last.v !== ']';
    return false;
  }

  function skipQuoted(src, i, q) {
    var n = src.length;
    i++;
    while (i < n) {
      var c = src.charAt(i);
      if (c === '\\') { i += 2; continue; }
      i++;
      if (c === q || c === '\n') return i;
    }
    return n;
  }

  function skipTemplate(src, i) {
    var n = src.length;
    while (i < n) {
      var c = src.charAt(i);
      if (c === '\\') { i += 2; continue; }
      if (c === '\x60') return i + 1;
      if (c === '$' && src.charAt(i + 1) === '{') {
        i = skipTemplateExpr(src, i + 2);
        if (i < 0) return -1;
        continue;
      }
      i++;
    }
    return -1;
  }

  function skipTemplateExpr(src, i) {
    var n = src.length;
    var d = 1;
    while (i < n) {
      var c = src.charAt(i);
      if (c === '"' || c === "'") { i = skipQuoted(src, i, c); continue; }
      if (c === '\x60') {
        i = skipTemplate(src, i + 1);
        if (i < 0) return -1;
        continue;
      }
      if (c === '{') d++;
      else if (c === '}') {
        d--;
        if (d === 0) return i + 1;
      }
      i++;
    }
    return -1;
  }

  function vmLex(src) {
    var toks = [];
    var n = src.length;
    var i = 0;
    var depth = 0;
    var unterminated = false;
    var last = null;
    while (i < n) {
      var code = src.charCodeAt(i);
      if (code <= 32) { i++; continue; }
      var ch = src.charAt(i);
      if (ch === '/' && src.charAt(i + 1) === '/') {
        var nl = src.indexOf('\n', i);
        i = nl < 0 ? n : nl + 1;
        continue;
      }
      if (ch === '/' && src.charAt(i + 1) === '*') {
        var endc = src.indexOf('*/', i + 2);
        if (endc < 0) { unterminated = true; i = n; } else { i = endc + 2; }
        continue;
      }
      var start = i;
      var tok;
      if (ch === '"' || ch === "'") {
        i = skipQuoted(src, i, ch);
        tok = { t: 'str', v: '' };
      } else if (ch === '\x60') {
        var after = skipTemplate(src, i + 1);
        if (after < 0) { unterminated = true; after = n; }
        i = after;
        tok = { t: 'tpl', v: '' };
      } else if (ch === '/' && regexAllowedAfter(last)) {
        i++;
        var inClass = false;
        while (i < n) {
          var rc = src.charAt(i);
          if (rc === '\\') { i += 2; continue; }
          if (rc === '\n') break;
          i++;
          if (rc === '[') inClass = true;
          else if (rc === ']') inClass = false;
          else if (rc === '/' && !inClass) break;
        }
        while (i < n && isIdPartCode(src.charCodeAt(i))) i++;
        tok = { t: 're', v: '' };
      } else if (isIdStartCode(code)) {
        i++;
        while (i < n && isIdPartCode(src.charCodeAt(i))) i++;
        tok = { t: 'id', v: src.slice(start, i) };
      } else if (code >= 48 && code <= 57) {
        i++;
        while (i < n && (isIdPartCode(src.charCodeAt(i)) || src.charAt(i) === '.')) i++;
        tok = { t: 'num', v: '' };
      } else {
        i++;
        tok = { t: 'punct', v: ch };
      }
      tok.pos = start;
      tok.end = i;
      if (tok.t === 'punct' && ch === '}') depth--;
      tok.depth = depth;
      if (tok.t === 'punct' && ch === '{') depth++;
      toks.push(tok);
      last = tok;
    }
    return { toks: toks, unterminated: unterminated };
  }

  // Names declared by top-level function declarations (depth 0, not property accesses).
  function topLevelFunctionNames(src) {
    var toks = vmLex(src).toks;
    var names = [];
    for (var k = 0; k < toks.length; k++) {
      var t = toks[k];
      if (t.t !== 'id' || t.v !== 'function' || t.depth !== 0) continue;
      var prev = toks[k - 1];
      if (prev && prev.t === 'punct' && prev.v === '.') continue;
      var nx = toks[k + 1];
      if (nx && nx.t === 'punct' && nx.v === '*') nx = toks[k + 2];
      if (nx && nx.t === 'id' && names.indexOf(nx.v) < 0) names.push(nx.v);
    }
    return names;
  }

  // REPL only: top-level let/const become var so bindings persist across lines.
  function rewriteTopLexical(src) {
    var toks = vmLex(src).toks;
    var out = '';
    var cursor = 0;
    for (var k = 0; k < toks.length; k++) {
      var t = toks[k];
      if (t.t !== 'id' || t.depth !== 0 || (t.v !== 'let' && t.v !== 'const')) continue;
      var prev = toks[k - 1];
      if (prev && !(prev.t === 'punct' && (prev.v === ';' || prev.v === '}'))) continue;
      out += src.slice(cursor, t.pos) + 'var';
      cursor = t.end;
    }
    return out + src.slice(cursor);
  }

  // Names introduced by var anywhere in the code. Reads of these resolve to undefined
  // instead of ReferenceError; nested-function vars over-approximate harmlessly.
  function declaredNames(src) {
    var toks = vmLex(src).toks;
    var names = Object.create(null);
    var inDecl = false;
    for (var k = 0; k < toks.length; k++) {
      var t = toks[k];
      var prev = toks[k - 1];
      if (t.t === 'id' && t.v === 'var') { inDecl = true; continue; }
      if (t.t === 'punct' && t.v === ';') { inDecl = false; continue; }
      if (inDecl && t.t === 'id' && prev &&
          ((prev.t === 'id' && prev.v === 'var') || (prev.t === 'punct' && prev.v === ','))) {
        names[t.v] = true;
      }
    }
    return names;
  }

  // typeof of a bare identifier must not throw for an undeclared name; rewrite it so the
  // ReferenceError from the with-scope is caught and yields 'undefined' as in Node.
  var TYPEOF_SKIP = { 'this': true, 'function': true, 'class': true, 'new': true, 'typeof': true,
    'void': true, 'delete': true, 'null': true, 'true': true, 'false': true, 'super': true,
    'import': true, 'yield': true, 'await': true };

  function rewriteTypeof(src) {
    var toks = vmLex(src).toks;
    var out = '';
    var cursor = 0;
    for (var k = 0; k + 1 < toks.length; k++) {
      var t = toks[k];
      if (t.t !== 'id' || t.v !== 'typeof') continue;
      var nx = toks[k + 1];
      if (nx.t !== 'id' || TYPEOF_SKIP[nx.v] === true) continue;
      var after = toks[k + 2];
      if (after && after.t === 'punct' && (after.v === '.' || after.v === '[' || after.v === '(')) continue;
      out += src.slice(cursor, t.pos) + '(function () { try { return typeof ' + nx.v +
        '; } catch (__owcVmE) { if (__owcVmE instanceof ReferenceError) return "undefined"; throw __owcVmE; } })()';
      cursor = nx.end;
      k++;
    }
    return out + src.slice(cursor);
  }

  function compiles(code) {
    try {
      new Function(code);
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---- contexts ----

  function silentConsole() {
    var names = ['assert', 'clear', 'count', 'countReset', 'debug', 'dir', 'dirxml', 'error', 'group',
      'groupCollapsed', 'groupEnd', 'info', 'log', 'profile', 'profileEnd', 'table', 'time', 'timeEnd',
      'timeLog', 'timeStamp', 'trace', 'warn'];
    var c = {};
    for (var i = 0; i < names.length; i++) c[names[i]] = function () { return undefined; };
    return c;
  }

  function fallbackGet(rec, key) {
    if (key === 'globalThis') return rec.G;
    if (key === 'console') return rec.console;
    if (ES_NAMES[key] === true) return globalThis[key];
    return undefined;
  }

  function makeRecord(sb) {
    var rec = { sb: sb, console: silentConsole(), G: null };
    rec.G = new Proxy(sb, {
      get: function (target, key) {
        if (typeof key !== 'string' || (key in target)) return target[key];
        return fallbackGet(rec, key);
      },
      has: function (target, key) {
        if (typeof key !== 'string') return key in target;
        return (key in target) || key === 'globalThis' || key === 'console' || ES_NAMES[key] === true;
      }
    });
    return rec;
  }

  function withHandler(rec, fnSet, decl) {
    return {
      has: function (target, key) {
        if (typeof key !== 'string') return false;
        if (key.indexOf('__owcVm') === 0) return false;
        return fnSet[key] !== true;
      },
      get: function (target, key) {
        if (typeof key !== 'string') return target[key];
        if (key in target) return target[key];
        if (decl[key] === true) return undefined;
        if (key === 'globalThis' || key === 'console' || ES_NAMES[key] === true) return fallbackGet(rec, key);
        throw new ReferenceError(key + ' is not defined');
      },
      set: function (target, key, value) {
        target[key] = value;
        return true;
      }
    };
  }

  // Runs with this = the global view. Free identifiers inside the eval resolve through
  // the with-proxy; internal __owcVm names and top-level function names stay local.
  function runWrapped(__owcVmWith, __owcVmCode, __owcVmFns, __owcVmSb) {
    var __owcVmOut;
    try {
      with (__owcVmWith) {
        __owcVmOut = eval(__owcVmCode);
      }
    } finally {
      for (var __owcVmI = 0; __owcVmI < __owcVmFns.length; __owcVmI++) {
        try {
          __owcVmSb[__owcVmFns[__owcVmI]] = eval(__owcVmFns[__owcVmI]);
        } catch (__owcVmErr) {
          // not a binding of this script; drop the placeholder created before the run
          if (__owcVmSb[__owcVmFns[__owcVmI]] === undefined) delete __owcVmSb[__owcVmFns[__owcVmI]];
        }
      }
    }
    return __owcVmOut;
  }

  function runInRecord(rec, code) {
    var fns = topLevelFunctionNames(code);
    var fnSet = Object.create(null);
    for (var i = 0; i < fns.length; i++) {
      fnSet[fns[i]] = true;
      if (!(fns[i] in rec.sb)) rec.sb[fns[i]] = undefined;
    }
    var decl = declaredNames(code);
    var scope = new Proxy(rec.sb, withHandler(rec, fnSet, decl));
    return runWrapped.call(rec.G, scope, rewriteTypeof(code), fns, rec.sb);
  }

  function createContextObject(obj) {
    if (obj === undefined) obj = {};
    if (!isObjectLike(obj)) throw argError('object', 'of type object', obj);
    if (!vmRecords.has(obj)) vmRecords.set(obj, makeRecord(obj));
    return obj;
  }

  function recordOf(obj) {
    var rec = isObjectLike(obj) ? vmRecords.get(obj) : undefined;
    if (rec === undefined) throw argError('contextifiedObject', 'an vm.Context', obj);
    return rec;
  }

  // ---- REPL helpers ----

  function replIncomplete(src) {
    var lx = vmLex(src);
    if (lx.unterminated) return true;
    var depth = 0;
    for (var i = 0; i < lx.toks.length; i++) {
      var t = lx.toks[i];
      if (t.t !== 'punct') continue;
      if (t.v === '(' || t.v === '[' || t.v === '{') depth++;
      else if (t.v === ')' || t.v === ']' || t.v === '}') depth--;
    }
    return depth > 0;
  }

  function replErrorHeader(err) {
    if (isObjectLike(err) && typeof err.name === 'string') {
      return String(err.name) + (err.message ? ': ' + err.message : '');
    }
    return inspectValue(err);
  }

  function replWriter(value) {
    return inspectValue(value);
  }

  // ---- vm ----

  BF['vm'] = function () {
    function Script(code, options) {
      if (!(this instanceof Script)) return new Script(code, options);
      if (typeof code !== 'string') throw argError('code', 'of type string', code);
      new Function(code);
      Object.defineProperty(this, '_owcCode', { value: code });
    }
    // A timeout option hands the evaluation to the host as a thunk (vm.run), which arms the deadline
    // around the call. QuickJS raises the interruption as an uncatchable error, so the host catches
    // it at the call boundary and reports it as a value; the timeout error is thrown here.
    function vmTimeoutOf(options) {
      if (options === null || typeof options !== 'object') return undefined;
      var timeout = options.timeout;
      if (timeout === undefined) return undefined;
      if (typeof timeout !== 'number') {
        throw nodeError(TypeError, 'ERR_INVALID_ARG_TYPE',
          'The "options.timeout" property must be of type number. ' + describeReceived(timeout));
      }
      if (!(timeout >= 1 && timeout <= 4294967295) || Math.floor(timeout) !== timeout) {
        throw nodeError(RangeError, 'ERR_OUT_OF_RANGE',
          'The value of "options.timeout" is out of range. It must be >= 1 && <= 4294967295. Received ' + String(timeout));
      }
      return timeout;
    }

    function vmGuarded(options, run) {
      var timeout = vmTimeoutOf(options);
      if (timeout === undefined) return run();
      var slot = null;
      api.vmThunk = function () {
        try { slot = { ok: true, value: run() }; } catch (err) { slot = { ok: false, error: err }; }
      };
      var outcome;
      try {
        outcome = callCap('vm.run', { timeout: timeout });
      } finally {
        api.vmThunk = undefined;
      }
      if (outcome.unbound) return run();
      if (outcome.interrupted) {
        throw nodeError(Error, 'ERR_SCRIPT_EXECUTION_TIMEOUT', 'Script execution timed out after ' + timeout + 'ms');
      }
      if (outcome.error !== undefined) throw new Error(outcome.error);
      if (slot.ok) return slot.value;
      throw slot.error;
    }

    Script.prototype.runInThisContext = function (options) {
      var code = this._owcCode;
      return vmGuarded(options, function () { return (0, eval)(code); });
    };
    Script.prototype.runInContext = function (contextifiedObject, options) {
      var rec = recordOf(contextifiedObject);
      var code = this._owcCode;
      return vmGuarded(options, function () { return runInRecord(rec, code); });
    };
    Script.prototype.runInNewContext = function (contextObject, options) {
      var rec = recordOf(createContextObject(contextObject));
      var code = this._owcCode;
      return vmGuarded(options, function () { return runInRecord(rec, code); });
    };
    Script.prototype.createCachedData = function () {
      return typeof Buffer !== 'undefined' ? Buffer.alloc(0) : new Uint8Array(0);
    };

    function compileFunction(code, params, options) {
      if (typeof code !== 'string') throw argError('code', 'of type string', code);
      var list = [];
      if (params !== undefined) {
        if (!Array.isArray(params)) throw argError('params', 'an instance of Array', params);
        for (var i = 0; i < params.length; i++) list.push(String(params[i]));
      }
      if (options && options.parsingContext !== undefined) {
        return runInRecord(recordOf(options.parsingContext),
          '(function (' + list.join(', ') + ') {\n' + code + '\n})');
      }
      return Function.apply(null, list.concat([code]));
    }

    return {
      Script: Script,
      createScript: function (code) { return new Script(code); },
      createContext: createContextObject,
      isContext: function (obj) {
        if (!isObjectLike(obj)) throw argError('object', 'of type object', obj);
        return vmRecords.has(obj);
      },
      runInThisContext: function (code, options) { return new Script(code).runInThisContext(options); },
      runInContext: function (code, contextifiedObject, options) {
        return new Script(code).runInContext(contextifiedObject, options);
      },
      runInNewContext: function (code, sandbox, options) {
        return new Script(code).runInNewContext(sandbox, options);
      },
      compileFunction: compileFunction,
      constants: {
        USE_MAIN_CONTEXT_DEFAULT_LOADER: Symbol('vm_dynamic_import_main_context_default'),
        DONT_CONTEXTIFY: Symbol('vm_context_no_contextify')
      }
    };
  };

  // ---- domain ----

  BF['domain'] = function () {
    var EventEmitter = requireBuiltin('events');
    var stack = [];
    var exp = { active: null };

    function setActive(d) {
      exp.active = d;
      if (typeof process === 'object' && process !== null) process.domain = d;
    }

    function Domain() {
      EventEmitter.call(this);
      this.members = [];
    }
    Domain.prototype = Object.create(EventEmitter.prototype);
    Object.defineProperty(Domain.prototype, 'constructor', { value: Domain, writable: true, configurable: true });

    Domain.prototype.enter = function () {
      stack.push(this);
      setActive(this);
    };

    Domain.prototype.exit = function () {
      var index = stack.lastIndexOf(this);
      if (index === -1) return;
      stack.splice(index);
      setActive(stack.length === 0 ? undefined : stack[stack.length - 1]);
    };

    // Synchronous throws are emitted as 'error' when the domain has listeners, else rethrown.
    function invokeInDomain(self, fn, thisArg, args) {
      self.enter();
      var ret;
      try {
        ret = fn.apply(thisArg, args);
      } catch (err) {
        self.exit();
        if (self.listenerCount('error') > 0) {
          if (isObjectLike(err)) {
            Object.defineProperty(err, 'domain', { value: self, writable: true, configurable: true });
            err.domainThrown = true;
          }
          self.emit('error', err);
          return undefined;
        }
        throw err;
      }
      self.exit();
      return ret;
    }

    Domain.prototype.run = function (fn) {
      return invokeInDomain(this, fn, this, Array.prototype.slice.call(arguments, 1));
    };

    Domain.prototype.bind = function (cb) {
      var self = this;
      function runBound() {
        return invokeInDomain(self, cb, this, Array.prototype.slice.call(arguments));
      }
      Object.defineProperty(runBound, 'domain', { value: this, writable: true, configurable: true });
      return runBound;
    };

    Domain.prototype.intercept = function (cb) {
      var self = this;
      function runIntercepted() {
        var args = Array.prototype.slice.call(arguments);
        if (args[0] && args[0] instanceof Error) {
          var er = args[0];
          er.domainBound = cb;
          er.domainThrown = false;
          Object.defineProperty(er, 'domain', { value: self, writable: true, configurable: true });
          self.emit('error', er);
          return undefined;
        }
        return invokeInDomain(self, cb, this, args.slice(1));
      }
      return runIntercepted;
    };

    Domain.prototype.add = function (ee) {
      if (ee.domain === this) return;
      if (ee.domain) ee.domain.remove(ee);
      if (this.domain && ee instanceof Domain) {
        for (var d = this.domain; d; d = d.domain) {
          if (ee === d) return;
        }
      }
      Object.defineProperty(ee, 'domain', { value: this, writable: true, configurable: true, enumerable: false });
      this.members.push(ee);
    };

    Domain.prototype.remove = function (ee) {
      ee.domain = null;
      var index = this.members.indexOf(ee);
      if (index !== -1) this.members.splice(index, 1);
    };

    Domain.prototype.dispose = function () {};

    // Emitters bound with add() route unhandled 'error' events to their domain.
    var eeEmit = EventEmitter.prototype.emit;
    EventEmitter.prototype.emit = function emit() {
      var args = Array.prototype.slice.call(arguments);
      var dom = this.domain;
      var type = args[0];
      if (type !== 'error' || this === process || !(dom instanceof Domain) || this.listenerCount('error') > 0) {
        return eeEmit.apply(this, args);
      }
      var er = args.length > 1 && args[1] ? args[1] : new Error('Unhandled error.');
      if (isObjectLike(er)) {
        er.domainEmitter = this;
        Object.defineProperty(er, 'domain', { value: dom, writable: true, configurable: true });
        er.domainThrown = false;
      }
      dom.emit('error', er);
      return true;
    };

    exp.Domain = Domain;
    exp.create = function createDomain() { return new Domain(); };
    exp.createDomain = exp.create;
    return exp;
  };

  // ---- inspector ----

  BF['inspector'] = function () {
    var EventEmitter = requireBuiltin('events');
    var exp = {};

    function Session() {
      EventEmitter.call(this);
      Object.defineProperty(this, '_owcConnected', { value: false, writable: true });
    }
    Session.prototype = Object.create(EventEmitter.prototype);
    Object.defineProperty(Session.prototype, 'constructor', { value: Session, writable: true, configurable: true });

    Session.prototype.connect = function () {
      if (this._owcConnected) {
        throw nodeError(Error, 'ERR_INSPECTOR_ALREADY_CONNECTED', 'The inspector session is already connected');
      }
      this._owcConnected = true;
    };

    Session.prototype.connectToMainThread = function () {
      throw nodeError(Error, 'ERR_INSPECTOR_NOT_WORKER', 'Current thread is not a worker');
    };

    Session.prototype.disconnect = function () {
      this._owcConnected = false;
    };

    Session.prototype.post = function (method, params, callback) {
      if (typeof method !== 'string') throw argError('method', 'of type string', method);
      if (typeof params === 'function') {
        callback = params;
        params = undefined;
      }
      if (!this._owcConnected) throw nodeError(Error, 'ERR_INSPECTOR_NOT_CONNECTED', 'Session is not connected');
      if (typeof callback === 'function') {
        callback(nodeError(Error, 'ERR_INSPECTOR_NOT_AVAILABLE',
          'Inspector protocol is not available in this runtime'));
      }
    };

    exp.Session = Session;
    exp.open = function () {};
    exp.close = function () {};
    exp.wait = function () {};
    exp.url = function () { return undefined; };
    exp.waitForDebugger = function () {
      throw nodeError(Error, 'ERR_INSPECTOR_NOT_ACTIVE', 'Inspector is not active');
    };
    exp.console = globalThis.console;
    return exp;
  };

  BF['inspector/promises'] = function () {
    var base = requireBuiltin('inspector');

    function PromiseSession() {
      base.Session.call(this);
    }
    PromiseSession.prototype = Object.create(base.Session.prototype);
    Object.defineProperty(PromiseSession.prototype, 'constructor', {
      value: PromiseSession, writable: true, configurable: true
    });
    PromiseSession.prototype.post = function (method, params) {
      var self = this;
      return new Promise(function (resolve, reject) {
        base.Session.prototype.post.call(self, method, params, function (err, result) {
          if (err) reject(err);
          else resolve(result);
        });
      });
    };

    return {
      Session: PromiseSession,
      open: base.open,
      close: base.close,
      url: base.url,
      waitForDebugger: base.waitForDebugger,
      console: base.console
    };
  };

  // ---- repl ----

  /*
   * "node" with no file: a REPL on this process's own stdin and stdout, in a context of its own.
   * stdin is opened rather than ended, so what the terminal sends reaches it; closing the REPL --
   * the .exit keyword, or the end of the input -- ends the process, as it does in Node.
   */
  api.startRepl = function () {
    var proc = globalThis.process;
    var server = requireBuiltin('repl').start({
      input: api.openStdin(),
      output: proc.stdout,
      prompt: '> ',
      terminal: true
    });
    server.on('exit', function () { host.exit(0); });
    return true;
  };

  BF['repl'] = function () {
    var EventEmitter = requireBuiltin('events');
    var vm = requireBuiltin('vm');
    var exp = {};

    function replConsole(repl) {
      var c = {};
      var logLike = ['log', 'info', 'debug', 'error', 'warn', 'trace'];
      for (var i = 0; i < logLike.length; i++) {
        c[logLike[i]] = function () { repl._writeOut(formatLogArgs(arguments) + '\n'); };
      }
      var noops = ['clear', 'count', 'countReset', 'dirxml', 'group', 'groupCollapsed', 'groupEnd', 'profile',
        'profileEnd', 'time', 'timeEnd', 'timeLog', 'timeStamp'];
      for (var j = 0; j < noops.length; j++) c[noops[j]] = function () { return undefined; };
      c.dir = function (value) { repl._writeOut(inspectValue(value) + '\n'); };
      c.assert = function (ok) {
        if (ok) return;
        var rest = Array.prototype.slice.call(arguments, 1);
        repl._writeOut('Assertion failed' + (rest.length ? ': ' + formatLogArgs(rest) : '') + '\n');
      };
      return c;
    }

    function defineBuiltinGetters(sb) {
      var names = Object.keys(BF);
      for (var i = 0; i < names.length; i++) {
        (function (name) {
          if (name.indexOf('/') >= 0 || name === 'console' || ES_NAMES[name] === true) return;
          Object.defineProperty(sb, name, {
            configurable: true,
            enumerable: false,
            get: function () { return requireBuiltin(name); },
            set: function (v) {
              Object.defineProperty(this, name, { value: v, writable: true, enumerable: true, configurable: true });
            }
          });
        })(names[i]);
      }

      /*
       * The rest of the runtime's globals: a fresh context has only its own intrinsics, so a REPL
       * started in one answers typeof WebAssembly as 'undefined' while Node's answers 'object'.
       * Each name the guest actually has is proxied, and assigning to one makes it an ordinary
       * property of the session, as in Node.
       */
      var REPL_GLOBALS = ['WebAssembly', 'Buffer', 'fetch', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'AbortController', 'AbortSignal', 'Event', 'EventTarget', 'CustomEvent', 'MessageChannel', 'MessagePort', 'MessageEvent', 'Blob', 'File', 'DOMException', 'structuredClone', 'performance', 'process', 'globalThis', 'global', 'atob', 'btoa', 'require'];
      for (var g = 0; g < REPL_GLOBALS.length; g++) {
        (function (name) {
          if (name in sb || !(name in globalThis)) return;
          Object.defineProperty(sb, name, {
            configurable: true,
            enumerable: false,
            get: function () { return globalThis[name]; },
            set: function (v) {
              Object.defineProperty(this, name, { value: v, writable: true, enumerable: true, configurable: true });
            }
          });
        })(REPL_GLOBALS[g]);
      }

      /* Node's REPL can require: it resolves against the working directory, as a file there would. */
      if (!('require' in sb)) {
        try {
          var moduleBuiltin = requireBuiltin('module');
          var cwd = globalThis.process && typeof globalThis.process.cwd === 'function' ? globalThis.process.cwd() : '/';
          if (moduleBuiltin && typeof moduleBuiltin.createRequire === 'function') {
            Object.defineProperty(sb, 'require', {
              configurable: true,
              enumerable: false,
              writable: true,
              value: moduleBuiltin.createRequire(cwd + '/.repl.js')
            });
          }
        } catch (requireError) { /* no require in this session; the rest of the context still works */ }
      }
    }

    function helpText(commands) {
      var names = Object.keys(commands).sort();
      var width = 0;
      for (var i = 0; i < names.length; i++) width = Math.max(width, names[i].length + 1);
      var lines = [];
      for (var j = 0; j < names.length; j++) {
        lines.push(('.' + names[j]).padEnd(width + 3) + commands[names[j]].help);
      }
      return lines.join('\n') + '\n\nPress Ctrl+C to abort current expression, Ctrl+D to exit the REPL\n';
    }

    function installBuiltinCommands(repl) {
      repl.commands['break'] = {
        help: 'Sometimes you get stuck, this gets you out',
        action: function () { this._buffer = ''; this.displayPrompt(); }
      };
      repl.commands['clear'] = {
        help: 'Break, and also clear the local context',
        action: function () {
          this._buffer = '';
          if (!this.useGlobal) {
            this._writeOut('Clearing context...\n');
            this._resetContext();
          }
          this.displayPrompt();
        }
      };
      repl.commands['exit'] = { help: 'Exit the REPL', action: function () { this.close(); } };
      repl.commands['help'] = {
        help: 'Print this help message',
        action: function () { this._writeOut(helpText(this.commands)); this.displayPrompt(); }
      };
      repl.commands['load'] = {
        help: 'Load JS from a file into the REPL session',
        action: function () { this.displayPrompt(); }
      };
      repl.commands['save'] = {
        help: 'Save all evaluated commands in this REPL session to a file',
        action: function () { this.displayPrompt(); }
      };
    }

    function REPLServer(options) {
      EventEmitter.call(this);
      if (typeof options === 'string') options = { prompt: options };
      options = options || {};
      var proc = typeof process === 'object' && process !== null ? process : undefined;
      this.input = options.input || (proc ? proc.stdin : undefined) || new EventEmitter();
      this.output = options.output || (proc ? proc.stdout : undefined) || { write: function () { return true; } };
      this.terminal = options.terminal === true;
      this.useGlobal = options.useGlobal === true;
      this.ignoreUndefined = options.ignoreUndefined === true;
      this.writer = typeof options.writer === 'function' ? options.writer : replWriter;
      this.commands = Object.create(null);
      this.line = '';
      this._prompt = options.prompt !== undefined ? String(options.prompt) : '> ';
      this._buffer = '';
      this._closed = false;
      this._detach = null;
      this._rl = null;
      this.context = undefined;
      installBuiltinCommands(this);
      this._resetContext();
      this._attachInput();
      this.displayPrompt();
    }
    REPLServer.prototype = Object.create(EventEmitter.prototype);
    Object.defineProperty(REPLServer.prototype, 'constructor', {
      value: REPLServer, writable: true, configurable: true
    });

    REPLServer.prototype._writeOut = function (text) {
      this.output.write(text);
    };

    REPLServer.prototype._resetContext = function () {
      if (this.useGlobal) {
        this.context = globalThis;
        return;
      }
      var sb = vm.createContext({});
      recordOf(sb).console = replConsole(this);
      defineBuiltinGetters(sb);
      this.context = sb;
    };

    REPLServer.prototype.getPrompt = function () {
      return this._prompt;
    };

    REPLServer.prototype.setPrompt = function (prompt) {
      this._prompt = String(prompt);
    };

    REPLServer.prototype.displayPrompt = function () {
      this._writeOut(this._buffer !== '' ? '| ' : this._prompt);
    };

    REPLServer.prototype.prompt = function () {
      this.displayPrompt();
    };

    REPLServer.prototype.defineCommand = function (keyword, cmd) {
      var name = String(keyword).replace(/^\./, '');
      var spec = typeof cmd === 'function' ? { action: cmd } : (cmd || {});
      this.commands[name] = {
        help: spec.help !== undefined ? String(spec.help) : '',
        action: typeof spec.action === 'function' ? spec.action.bind(this) : function () {}
      };
    };

    // Explicit close() defers the teardown to the next tick, as Node's REPL does.
    REPLServer.prototype.close = function () {
      if (this._closeScheduled || this._closed) return;
      this._closeScheduled = true;
      var repl = this;
      Promise.resolve().then(function () { repl._finishClose(); });
    };

    REPLServer.prototype._finishClose = function () {
      if (this._closed) return;
      this._closed = true;
      if (this._detach) this._detach();
      if (this._rl) this._rl.close();
      this.emit('close');
      this.emit('exit');
    };

    REPLServer.prototype._run = function (src) {
      var code = src;
      if (/^\s*\{/.test(src) && compiles('(' + src + '\n)')) code = '(' + src + '\n)';
      code = rewriteTopLexical(code);
      if (this.useGlobal) return (0, eval)(code);
      return vm.runInContext(code, this.context);
    };

    REPLServer.prototype._evaluate = function (src) {
      var result;
      try {
        result = this._run(src);
      } catch (err) {
        this._writeOut('Uncaught ' + replErrorHeader(err) + '\n');
        return;
      }
      this.context._ = result;
      if (result === undefined && this.ignoreUndefined) return;
      this._writeOut(String(this.writer(result)) + '\n');
    };

    REPLServer.prototype._onLine = function (line) {
      if (this._closed) return;
      this.line = '';
      var trimmed = line.replace(/^\s+/, '');
      if (this._buffer === '' && /^\.[A-Za-z_]/.test(trimmed)) {
        var m = /^\.(\S+)\s*([\s\S]*)$/.exec(trimmed);
        var name = m[1];
        var args = m[2].replace(/\s+$/, '');
        if (Object.prototype.hasOwnProperty.call(this.commands, name)) {
          this.commands[name].action.call(this, args);
        } else {
          this._writeOut('Invalid REPL keyword\n');
          this.displayPrompt();
        }
        return;
      }
      this._buffer = this._buffer === '' ? line : this._buffer + '\n' + line;
      if (replIncomplete(this._buffer)) {
        this.displayPrompt();
        return;
      }
      var src = this._buffer;
      this._buffer = '';
      if (src.replace(/\s+/g, '') !== '') this._evaluate(src);
      this.displayPrompt();
    };

    REPLServer.prototype._attachInput = function () {
      var repl = this;
      var input = this.input;
      if (!input || typeof input.on !== 'function') return;
      /* A terminal writes back what is typed, and nothing else does it for a REPL whose stdin is
         one: without this the characters a user types never appear. A newline comes back as the
         pair a terminal sends, so the cursor reaches the start of the next line. */
      if (this.terminal) {
        var echo = function (chunk) {
          if (repl._closed) return;
          repl._writeOut(String(chunk).replace(/\r\n?|\n/g, '\r\n'));
        };
        input.on('data', echo);
        this._detach = function () {
          if (typeof input.removeListener === 'function') input.removeListener('data', echo);
        };
      }
      var readline = requireBuiltin('readline');
      if (readline && typeof readline.createInterface === 'function') {
        var rl = readline.createInterface(input, undefined, undefined, false);
        rl.on('line', function (line) { repl._onLine(line); });
        rl.on('close', function () { repl._finishClose(); });
        this._rl = rl;
        return;
      }
      var detach = this._detach;
      var pending = '';
      var onData = function (chunk) {
        if (repl._closed) return;
        pending += typeof chunk === 'string' ? chunk : String(chunk);
        var idx = pending.indexOf('\n');
        while (idx >= 0) {
          var line = pending.slice(0, idx);
          pending = pending.slice(idx + 1);
          if (line.charAt(line.length - 1) === '\r') line = line.slice(0, -1);
          repl._onLine(line);
          if (repl._closed) return;
          idx = pending.indexOf('\n');
        }
      };
      var onEnd = function () {
        if (repl._closed) return;
        if (pending.length > 0) {
          var rest = pending;
          pending = '';
          repl._onLine(rest);
        }
        repl._finishClose();
      };
      input.on('data', onData);
      input.on('end', onEnd);
      this._detach = function () {
        if (detach !== null) detach();
        if (typeof input.removeListener === 'function') {
          input.removeListener('data', onData);
          input.removeListener('end', onEnd);
        }
      };
      if (typeof input.resume === 'function') input.resume();
    };

    function Recoverable(err) {
      this.err = err;
    }
    Recoverable.prototype = Object.create(SyntaxError.prototype);

    exp.start = function (options) { return new REPLServer(options); };
    exp.REPLServer = REPLServer;
    exp.REPL_MODE_SLOPPY = Symbol('repl-sloppy');
    exp.REPL_MODE_STRICT = Symbol('repl-strict');
    exp.writer = replWriter;
    exp.Recoverable = Recoverable;
    return exp;
  };

})();
`;
