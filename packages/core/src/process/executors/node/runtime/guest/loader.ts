import { REGEX_COMPAT_SRC } from './regex-compat';
/**
 * Guest-side module system: builtin registry, CommonJS loader with node_modules
 * resolution delegated to the host, timers driven by host callbacks, and the
 * API object the host calls into. Plain JavaScript, no template interpolation.
 */
export const LOADER_SRC = REGEX_COMPAT_SRC + String.raw`
var BF = Object.create(null);
var BC = Object.create(null);
var MODULE_CACHE = Object.create(null);
var EXIT_SIGNAL = { __owcExit: true };
var mainModule = undefined;
var timers = Object.create(null);
var nextTimerId = 1;
var startedAt = host.now();

function stripNodePrefix(name) {
  return name.indexOf('node:') === 0 ? name.slice(5) : name;
}

function isBuiltinName(name) {
  return Object.prototype.hasOwnProperty.call(BF, stripNodePrefix(name));
}

function requireBuiltin(name) {
  var key = stripNodePrefix(name);
  if (Object.prototype.hasOwnProperty.call(BC, key)) return BC[key];
  var factory = BF[key];
  if (!factory) return undefined;
  var exported = factory();
  BC[key] = exported;
  return exported;
}

function dirnameOf(p) {
  var i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

function moduleNotFound(id) {
  var err = new Error("Cannot find module '" + id + "'");
  err.code = 'MODULE_NOT_FOUND';
  return err;
}

function readSource(filename) {
  var src = host.readText(filename);
  if (src === null) throw moduleNotFound(filename);
  return src;
}

function stripHashbang(src) {
  return src.charAt(0) === '#' && src.charAt(1) === '!' ? '//' + src.slice(2) : src;
}

function Module(filename, parent) {
  this.id = filename;
  this.filename = filename;
  this.path = dirnameOf(filename);
  this.exports = {};
  this.parent = parent;
  this.loaded = false;
  this.children = [];
  this.paths = [];
}

/* require.extensions (Module._extensions): .node files load through it, by process.dlopen; .js and .json files load in loadCJS */
var EXTENSIONS = {
  '.js': function (module, filename) {
    var wrapper = compileCjsWrapper(stripHashbang(readSource(filename)), filename);
    wrapper.call(module.exports, module.exports, makeRequire(module), module, filename, dirnameOf(filename));
  },
  '.json': function (module, filename) {
    module.exports = JSON.parse(readSource(filename));
  },
  '.node': function (module, filename) {
    return process.dlopen(module, filename);
  }
};

function makeRequire(mod) {
  var req = function require(id) {
    return requireFrom(mod, id);
  };
  req.resolve = function resolve(id) {
    if (isBuiltinName(id)) return stripNodePrefix(id);
    var found = host.resolve(String(id), mod.path, 'require');
    if (!found) throw moduleNotFound(id);
    return found;
  };
  req.cache = MODULE_CACHE;
  req.main = mainModule;
  req.extensions = EXTENSIONS;
  return req;
}

function requireFrom(parent, id) {
  if (typeof id !== 'string') {
    throw new TypeError('The "id" argument must be of type string. Received ' + typeof id);
  }
  if (isBuiltinName(id)) {
    // DEP0040 is a warning for user code: node does not print it when a package in node_modules requires punycode
    if (!(parent && parent.filename && parent.filename.indexOf('/node_modules/') >= 0)) return requireBuiltin(id);
    globalThis.__owcDependencyRequire = true;
    try {
      return requireBuiltin(id);
    } finally {
      globalThis.__owcDependencyRequire = false;
    }
  }
  var base = parent && parent.path ? parent.path : host.cwd();
  var filename = host.resolve(id, base, 'require');
  if (!filename) throw moduleNotFound(id);
  return loadCJS(filename, parent, false).exports;
}

/* The host compiles the wrapper, not an in-guest eval: the engine names eval'd code <input>, so
   every CommonJS module would share one nameless script and its stack frames would carry no path.
   Packages that locate their binary from a stack frame (bindings, and anything built on it) read
   CallSite.getFileName() and fail on that. A failed compile comes back as the message string. */
function compileCjs(src, filename) {
  var compiled = host.compileCjs(src, filename);
  if (typeof compiled === 'string') throw new SyntaxError(compiled);
  return compiled;
}

function compileCjsWrapper(src, filename) {
  try {
    return compileCjs(src, filename);
  } catch (err) {
    var fixed = null;
    if (err instanceof SyntaxError) {
      try { fixed = rxRewrite(src); } catch (rewriteErr) { fixed = null; }
    }
    if (fixed === null) throw err;
    try { return compileCjs(fixed, filename); } catch (retryErr) { throw err; }
  }
}

function loadCJS(filename, parent, isMain) {
  var cached = MODULE_CACHE[filename];
  if (cached) return cached;
  var mod = new Module(filename, parent);
  if (isMain) mainModule = mod;
  MODULE_CACHE[filename] = mod;
  try {
    if (filename.slice(-5) === '.json') {
      mod.exports = JSON.parse(readSource(filename));
    } else if (filename.slice(-5) === '.node') {
      EXTENSIONS['.node'](mod, filename);
    } else {
      if (filename.slice(-4) === '.mjs' || host.isESM(filename)) {
        return loadEsmFromRequire(filename, mod);
      }
      var src = stripHashbang(readSource(filename));
      var wrapper = compileCjsWrapper(src, filename);
      wrapper.call(mod.exports, mod.exports, makeRequire(mod), mod, filename, mod.path);
    }
    mod.loaded = true;
  } catch (err) {
    delete MODULE_CACHE[filename];
    throw err;
  }
  if (parent && parent.children) parent.children.push(mod);
  return mod;
}

var nextEsmToken = 1;

function loadEsmFromRequire(filename, mod) {
  var token = nextEsmToken++;
  var failure = host.esmLoad(filename, token);
  if (failure) {
    var loadErr = new Error(failure);
    loadErr.code = 'ERR_REQUIRE_ESM';
    throw loadErr;
  }
  var registry = globalThis.__owc_esm_registry || {};
  var namespace = registry[token];
  delete registry[token];
  if (namespace === undefined) {
    var asyncErr = new Error('require() cannot be used on an ESM graph with top-level await. Use import() instead.');
    asyncErr.code = 'ERR_REQUIRE_ASYNC_MODULE';
    throw asyncErr;
  }
  mod.exports = namespace;
  mod.loaded = true;
  return mod;
}

function scheduleTimer(fn, ms, args, repeat) {
  if (typeof fn !== 'function') {
    throw new TypeError('The "callback" argument must be of type function. Received ' + typeof fn);
  }
  var delay = Number(ms);
  if (!(delay >= 1)) delay = 1;
  var id = nextTimerId++;
  timers[id] = { fn: fn, args: args, repeat: repeat, delay: delay, refed: true, ctx: captureAsyncContext() };
  host.ref(1);
  host.setTimer(id, delay);
  return makeTimeout(id);
}

function makeTimeout(id) {
  var handle = {
    _owcTimerId: id,
    ref: function () { setTimerRef(id, true); return this; },
    unref: function () { setTimerRef(id, false); return this; },
    hasRef: function () { return !!(timers[id] && timers[id].refed); },
    refresh: function () { return this; }
  };
  handle[Symbol.toPrimitive] = function () { return id; };
  return handle;
}

function setTimerRef(id, on) {
  var t = timers[id];
  if (!t || t.refed === on) return;
  t.refed = on;
  host.ref(on ? 1 : -1);
}

function timerIdOf(t) {
  if (typeof t === 'number') return t;
  if (t && typeof t === 'object' && t._owcTimerId !== undefined) return t._owcTimerId;
  return undefined;
}

function clearTimer(t) {
  var id = timerIdOf(t);
  if (id === undefined || !timers[id]) return;
  if (timers[id].refed) host.ref(-1);
  delete timers[id];
  host.clearTimer(id);
}

function fireTimer(id) {
  var t = timers[id];
  if (!t) return;
  if (t.repeat) {
    host.setTimer(id, t.delay);
  } else {
    delete timers[id];
    if (t.refed) host.ref(-1);
  }
  runInAsyncContext(t.ctx, function () {
    t.fn.apply(undefined, t.args);
  });
}

/* a callback scheduled while a domain is active runs bound to it, so its errors reach the domain's 'error' listeners */
function bindToActiveDomain(fn) {
  var proc = globalThis.process;
  var dom = proc && proc.domain;
  return dom && typeof dom.bind === 'function' && typeof fn === 'function' ? dom.bind(fn) : fn;
}

function setTimeoutImpl(fn, ms) {
  return scheduleTimer(bindToActiveDomain(fn), ms, Array.prototype.slice.call(arguments, 2), false);
}

function setIntervalImpl(fn, ms) {
  return scheduleTimer(bindToActiveDomain(fn), ms, Array.prototype.slice.call(arguments, 2), true);
}

function setImmediateImpl(fn) {
  return scheduleTimer(bindToActiveDomain(fn), 0, Array.prototype.slice.call(arguments, 1), false);
}

/* process.nextTick queue: drained by the host before each promise job, as Node does */
var TICK_QUEUE = [];
var PENDING_UNCAUGHT = null;

/* async-local context: the async_hooks module installs capture() and run(token, fn) when it loads */
var ASYNC_CONTEXT = { capture: null, run: null };

function captureAsyncContext() {
  return ASYNC_CONTEXT.capture ? ASYNC_CONTEXT.capture() : null;
}

function runInAsyncContext(token, fn) {
  if (token === null || token === undefined || !ASYNC_CONTEXT.run) return fn();
  return ASYNC_CONTEXT.run(token, fn);
}

function enqueueTick(fn, args) {
  TICK_QUEUE.push({ fn: fn, args: args, ctx: captureAsyncContext() });
}

/* an exception that escapes a callback with no caller to receive it ends the process (first one wins) */
function reportUncaught(err) {
  if (PENDING_UNCAUGHT === null) PENDING_UNCAUGHT = { error: err };
}

function drainTicks() {
  while (TICK_QUEUE.length > 0) {
    var job = TICK_QUEUE.shift();
    try {
      runInAsyncContext(job.ctx, function () {
        job.fn.apply(undefined, job.args);
      });
    } catch (err) {
      reportUncaught(err);
    }
  }
}

function queueMicrotaskImpl(fn) {
  if (typeof fn !== 'function') throw new TypeError('The "callback" argument must be of type function');
  fn = bindToActiveDomain(fn);
  var ctx = captureAsyncContext();
  Promise.resolve().then(function () {
    try {
      runInAsyncContext(ctx, function () {
        fn();
      });
    } catch (err) {
      reportUncaught(err);
    }
  });
}

function createRequireFor(filename) {
  var path = filename.indexOf('file://') === 0 ? decodeURIComponent(filename.slice(7)) : filename;
  return makeRequire(new Module(path, null));
}

/* import.meta and import attributes: the host rewrites ES module sources to call these two */
var IMPORT_META = Object.create(null);
var ATTRIBUTE_MISSING = '\u0001owc-attr-missing';

function fileUrlOf(p) {
  return 'file://' + encodeURI(p).replace(/\?/g, '%3F').replace(/#/g, '%23');
}

function importMetaOf(filename, isMain) {
  var cached = IMPORT_META[filename];
  if (cached) return cached;
  var meta = Object.create(null);
  meta.url = fileUrlOf(filename);
  meta.dirname = dirnameOf(filename);
  meta.filename = filename;
  meta.main = !!isMain;
  meta.resolve = function resolve(specifier) {
    var spec = String(specifier);
    if (isBuiltinName(spec)) return 'node:' + stripNodePrefix(spec);
    var found = host.resolve(spec, dirnameOf(filename), 'import');
    if (!found) {
      var err = new Error("Cannot find module '" + spec + "' imported from " + filename);
      err.code = 'ERR_MODULE_NOT_FOUND';
      throw err;
    }
    return fileUrlOf(found);
  };
  IMPORT_META[filename] = meta;
  return meta;
}

function importUrlOf(spec, filename) {
  var base = dirnameOf(typeof filename === 'string' && filename !== '' ? filename : host.cwd() + '/x');
  var found = host.resolve(String(spec), base, 'import');
  return found ? fileUrlOf(found) : undefined;
}

/* The module name of a module whose evaluation throws a recorded error: the host builds the module
   from it, so an import Node rejects throws the error Node throws, code included. */
function errorModuleOf(info) {
  return 'owc-error:' + encodeURIComponent(JSON.stringify(info));
}

/* Import attributes on a dynamic import, the way Node reads them: an attribute that is not "type",
   or a type the loader does not support, is ERR_IMPORT_ATTRIBUTE_UNSUPPORTED; "type": "json" on a
   module that is not JSON is ERR_IMPORT_ATTRIBUTE_TYPE_INCOMPATIBLE; a .json module imported
   without "type": "json" is ERR_IMPORT_ATTRIBUTE_MISSING. A specifier that resolves to nothing is
   left alone, so it fails as a missing module, as it does in Node. */
function importArgOf(spec, options, filename) {
  var s = String(spec);
  var attrs = options && typeof options === 'object' && options.with && typeof options.with === 'object' ? options.with : null;
  var isJson = s.slice(-5) === '.json';
  var url = importUrlOf(s, filename);
  if (attrs !== null && url !== undefined) {
    var keys = Object.keys(attrs);
    var failure = null;
    var typeJson = false;
    for (var k = 0; k < keys.length && failure === null; k++) {
      var value = attrs[keys[k]];
      if (keys[k] !== 'type') {
        failure = { code: 'ERR_IMPORT_ATTRIBUTE_UNSUPPORTED', ctor: 'TypeError', message: 'Import attribute ' + JSON.stringify(keys[k]) + ' with value ' + JSON.stringify(String(value)) + ' is not supported in ' + url };
      } else if (value !== 'json') {
        failure = { code: 'ERR_IMPORT_ATTRIBUTE_UNSUPPORTED', ctor: 'TypeError', message: 'Import attribute "type" with value ' + JSON.stringify(String(value)) + ' is not supported in ' + url };
      } else {
        typeJson = true;
      }
    }
    if (failure === null && typeJson && !isJson) {
      failure = { code: 'ERR_IMPORT_ATTRIBUTE_TYPE_INCOMPATIBLE', ctor: 'TypeError', message: 'Module ' + JSON.stringify(url) + ' is not of type "json"' };
    }
    if (failure !== null) return errorModuleOf(failure);
  }
  if (isJson && !(attrs !== null && attrs.type === 'json')) return s + ATTRIBUTE_MISSING;
  return s;
}

/* The engine rebuilds a module loader error as a plain Error and drops everything else that was on
   it, so the host publishes the code of the failure it raised and this wrapper sets it back on the
   rejection: a module that resolves to no file carries ERR_MODULE_NOT_FOUND, and a specifier no
   loader can read carries ERR_UNSUPPORTED_ESM_URL_SCHEME. */
function importWrap(promise) {
  return promise.then(null, function (err) {
    var code = globalThis.__owc_import_failure;
    globalThis.__owc_import_failure = undefined;
    if (typeof code === 'string' && err !== null && typeof err === 'object' && err.code === undefined) {
      try { err.code = code; } catch (e) { /* a frozen error keeps the message it already has */ }
    }
    throw err;
  });
}

Object.defineProperty(globalThis, '__owc_importMeta', { value: importMetaOf, writable: true, configurable: true });
Object.defineProperty(globalThis, '__owc_importArg', { value: importArgOf, writable: true, configurable: true });
Object.defineProperty(globalThis, '__owc_importWrap', { value: importWrap, writable: true, configurable: true });

var api = {
  drainTicks: function () {
    drainTicks();
    return api.takeUncaught();
  },
  takeUncaught: function () {
    if (PENDING_UNCAUGHT === null) return null;
    var pending = PENDING_UNCAUGHT;
    PENDING_UNCAUGHT = null;
    return api.formatUncaught(pending.error);
  },
  runMain: function (filename) {
    loadCJS(filename, null, true);
  },
  fire: fireTimer,
  clearAll: function () {
    timers = Object.create(null);
  },
  keysOf: function (id, builtin) {
    var exported = builtin ? requireBuiltin(id) : loadCJS(id, null, false).exports;
    return JSON.stringify(Object.keys(exported === undefined || exported === null ? {} : exported));
  },
  exportsOf: function (id, builtin) {
    return builtin ? requireBuiltin(id) : loadCJS(id, null, false).exports;
  },
  /* the host compiles ES modules itself, so it asks for the compatibility rewrite here; the source comes back unchanged when nothing applies */
  compatRewrite: function (source) {
    var fixed = null;
    try { fixed = rxRewrite(source); } catch (rewriteErr) { fixed = null; }
    return fixed === null ? source : fixed;
  },
  builtinNames: function () {
    return JSON.stringify(Object.keys(BF));
  },
  runEval: function (source) {
    var filename = host.cwd() + '/[eval]';
    var mod = new Module(filename, null);
    mainModule = mod;
    var wrapper = compileCjs(source, filename);
    wrapper.call(mod.exports, mod.exports, makeRequire(mod), mod, filename, mod.path);
  },
  uptimeMs: function () {
    return host.now() - startedAt;
  }
};
`;
