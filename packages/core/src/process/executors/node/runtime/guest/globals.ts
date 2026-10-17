/**
 * Guest-side globals: the `process` object (an EventEmitter), the console, the
 * standard globals (Buffer, timers, URL, TextEncoder, atob/btoa, performance,
 * crypto) and the finalize hooks the host calls at exit. Plain JavaScript inside a
 * String.raw snippet.
 */
export const GLOBALS_SRC = String.raw`
var EventEmitterCls = requireBuiltin('events');
var procEnv = JSON.parse(host.envJSON());
var proc = Object.create(EventEmitterCls.prototype);
EventEmitterCls.call(proc);
proc.title = 'node';
proc.version = 'v24.15.0';
proc.versions = { node: '24.15.0', v8: '13.6.233.10-node.24', owc: '0.1.0', napi: '10' };
proc.arch = 'x64';
proc.platform = 'linux';
proc.release = { name: 'node' };
Object.defineProperty(proc, Symbol.toStringTag, { value: 'process', configurable: true });
proc.features = {};
/* Only the internal 'constants' binding is provided: packages such as tmp read it at load time. Other names fail as they do in node. */
proc.binding = function binding(name) {
  if (name === 'constants') {
    return {
      os: requireBuiltin('os').constants,
      fs: requireBuiltin('fs').constants,
      crypto: {},
      zlib: requireBuiltin('zlib').constants || {},
      trace: {}
    };
  }
  throw new Error('No such module: ' + name);
};
/*
 * Node-API add-ons. Native code cannot load here: an add-on file whose basename (NAPI_BINARIES) or owning
 * package (NAPI_PACKAGES) a guest/modules/napi-<shim>.ts module registered gets the exports of that
 * JavaScript shim, owc:internal/napi/<shim>. Any other file fails as glibc's dlopen fails on it.
 */
var NAPI_BINARIES = Object.create(null);
var NAPI_PACKAGES = Object.create(null);
/*
 * What a Node-API shim gets when the host builds it. A shim that only computes needs none of this;
 * one that persists, like leveldown, gets fs: byte-level operations over the virtual filesystem,
 * resolved against the guest's cwd, with no encodings, streams or descriptors. See
 * src/napi/leveldown/fs.ts for the contract each one keeps. Buffer is a getter because the standard
 * globals are still being defined while this runs.
 */
var NAPI_HOST = (function () {
  var path_ = requireBuiltin('path');
  function rp (p) {
    return path_.resolve(p);
  }
  function bytes (b) {
    return Buffer.from(b.buffer, b.byteOffset, b.length);
  }
  return {
    fs: {
      read: function (p) {
        try {
          return new Uint8Array(requireBuiltin('fs').readFileSync(rp(p)));
        } catch (readError) {
          return undefined;
        }
      },
      write: function (p, b) {
        requireBuiltin('fs').writeFileSync(rp(p), bytes(b));
      },
      append: function (p, b) {
        requireBuiltin('fs').appendFileSync(rp(p), bytes(b));
      },
      rename: function (from, to) {
        requireBuiltin('fs').renameSync(rp(from), rp(to));
      },
      unlink: function (p) {
        try {
          requireBuiltin('fs').unlinkSync(rp(p));
        } catch (unlinkError) {}
      },
      mkdir: function (p) {
        var fsm = requireBuiltin('fs');
        var at = '';
        // create each level in turn, so a missing parent is not an error
        for (var i = 0; i < rp(p).split('/').length; i++) {
          var part = rp(p).split('/')[i];
          if (part === '') continue;
          at = at + '/' + part;
          try {
            fsm.mkdirSync(at);
          } catch (mkdirError) {}
        }
      },
      rmdir: function (p) {
        try {
          requireBuiltin('fs').rmdirSync(rp(p));
        } catch (rmdirError) {}
      },
      readdir: function (p) {
        try {
          return requireBuiltin('fs').readdirSync(rp(p));
        } catch (readdirError) {
          return undefined;
        }
      },
      stat: function (p) {
        try {
          return requireBuiltin('fs').statSync(rp(p)).isDirectory() ? 'dir' : 'file';
        } catch (statError) {
          return undefined;
        }
      }
    },
    /*
     * The container's own child processes, for the node-pty shim: it starts a shell (an interactive
     * ShellProcess when it is given no arguments) or a node child and reads its output and exit,
     * which is the closest thing the container has to a session on a terminal. Only spawn is
     * exposed, and the module is looked up when it is called, so a process that never loads the
     * add-on never loads child_process.
     */
    child: {
      spawn: function (file, args, options) {
        return requireBuiltin('child_process').spawn(file, args, options);
      }
    }
  };
})();
Object.defineProperty(NAPI_HOST, 'Buffer', { get: function () { return Buffer; }, configurable: true });
function dlopenError(message) {
  var err = new Error(message);
  err.code = 'ERR_DLOPEN_FAILED';
  return err;
}
function napiShimOf(file) {
  var base = file.slice(file.lastIndexOf('/') + 1);
  if (Object.prototype.hasOwnProperty.call(NAPI_BINARIES, base)) return NAPI_BINARIES[base];
  var at = file.lastIndexOf('/node_modules/');
  if (at < 0) return undefined;
  var parts = file.slice(at + 14).split('/');
  var pkg = parts[0].charAt(0) === '@' ? parts[0] + '/' + parts[1] : parts[0];
  return Object.prototype.hasOwnProperty.call(NAPI_PACKAGES, pkg) ? NAPI_PACKAGES[pkg] : undefined;
}
function loadNapiAddon(name) {
  // a name without a slash is searched for in the library path, never the working directory
  var file = name.charAt(0) === '/' ? name : name.indexOf('/') >= 0 ? requireBuiltin('path').resolve(name) : '';
  var raw = file ? host.statJSON(file) : null;
  if (raw === null) throw dlopenError(name + ': cannot open shared object file: No such file or directory');
  var st = JSON.parse(raw);
  if (st.type === 'dir') throw dlopenError(name + ': cannot read file data: Is a directory');
  var shim = napiShimOf(file);
  if (shim !== undefined) return requireBuiltin('owc:internal/napi/' + shim).createAddon(NAPI_HOST);
  if (st.size < 64) throw dlopenError(name + ': file too short');
  var head = decodeBase64(host.readBase64(file));
  if (head[0] !== 0x7f || head[1] !== 0x45 || head[2] !== 0x4c || head[3] !== 0x46) throw dlopenError(name + ': invalid ELF header');
  throw dlopenError("Module did not self-register: '" + name + "'.");
}
proc.dlopen = function dlopen(module, filename, flags) {
  if (arguments.length < 2) {
    var missing = new TypeError('process.dlopen needs at least 2 arguments');
    missing.code = 'ERR_MISSING_ARGS';
    throw missing;
  }
  if (arguments.length > 2) {
    try {
      flags | 0;
    } catch (flagError) {
      var badFlags = new TypeError('flag argument must be an integer.');
      badFlags.code = 'ERR_INVALID_ARG_TYPE';
      throw badFlags;
    }
  }
  if (module === undefined || module === null || module.exports === undefined || module.exports === null) {
    throw new TypeError('Cannot convert undefined or null to object');
  }
  module.exports = loadNapiAddon(typeof filename === 'symbol' ? '' : String(filename));
};
proc.config = {};
proc.pid = host.pid();
proc.ppid = 0;
proc.argv = JSON.parse(host.argvJSON());
proc.execPath = '/usr/local/bin/node';
proc.execArgv = [];
proc.env = procEnv;
proc.exitCode = undefined;
proc.cwd = function () {
  return host.cwd();
};
  /*
   * process.chdir moves the process's working directory, as it does in Node: the host owns it, so
   * a relative path is resolved against the current one, and what comes back is '' or the error
   * code Node would report. Everything that resolves a relative path afterwards -- require, fs, a
   * spawned child -- reads the new directory.
   */
  proc.chdir = function (dir) {
    if (typeof dir !== 'string') {
      var bad = new TypeError('The "directory" argument must be of type string. Received ' + (dir === null ? 'null' : typeof dir));
      bad.code = 'ERR_INVALID_ARG_TYPE';
      throw bad;
    }
    var failure = host.chdir(dir);
    if (failure === '') return undefined;
    var error = new Error(failure + ': ' + (failure === 'ENOTDIR' ? 'not a directory' : 'no such file or directory') + ', chdir \'' + dir + '\'');
    error.code = failure;
    error.errno = failure === 'ENOTDIR' ? -20 : -2;
    error.syscall = 'chdir';
    error.path = dir;
    throw error;
  };
proc.exit = function (code) {
  var fallback = typeof proc.exitCode === 'number' ? proc.exitCode : 0;
  var finalCode = code === undefined ? fallback : Number(code);
  proc.exitCode = finalCode;
  try {
    api.emitExit(finalCode);
  } catch (listenerError) {
    host.stderr(formatErrorStack(listenerError instanceof Error ? listenerError : new Error(String(listenerError))) + '\n');
  }
  host.exit(finalCode);
  throw EXIT_SIGNAL;
};
proc.nextTick = function (fn) {
  if (typeof fn !== 'function') throw new TypeError('The "callback" argument must be of type function');
  enqueueTick(bindToActiveDomain(fn), Array.prototype.slice.call(arguments, 1));
};
proc.hrtime = function (previous) {
  var nowNs = Math.round((host.now() - startedAt) * 1e6);
  var sec = Math.floor(nowNs / 1e9);
  var nano = nowNs % 1e9;
  if (previous) {
    var ds = sec - previous[0];
    var dn = nano - previous[1];
    if (dn < 0) {
      ds -= 1;
      dn += 1e9;
    }
    return [ds, dn];
  }
  return [sec, nano];
};
proc.hrtime.bigint = function () {
  return BigInt(Math.round((host.now() - startedAt) * 1e6));
};
proc.uptime = function () {
  return (host.now() - startedAt) / 1000;
};
proc.memoryUsage = function () {
  return { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };
};
proc.cpuUsage = function () {
  return { user: 0, system: 0 };
};
/*
 * Signals a child of this process, as Node does with the pids it knows. The container has no
 * signals across processes: every name that ends a process ends it the same way (terminate), and
 * the name is only reported back as the signal the child died of. A pid that is not a child of
 * this process is not signalled, and false comes back rather than an error, because a container
 * process cannot see processes that are not its own children.
 */
proc.kill = function (pid, signal) {
  var name = signal === undefined || signal === null || signal === 0 || signal === '0' ? 'SIGTERM' : String(signal);
  var num = Number(pid);
  var table = globalThis.__owcPtyFds;
  var record = table ? table[num] : undefined;
  // An id of a pty stands for the child behind it: the container gives a child its pid after
  // spawn has returned, so a pty has no process id to report when it is built.
  if (record && record.child && record.child.pid !== undefined) {
    return callCap('child.kill', { pid: Number(record.child.pid), signal: name }) === true;
  }
  return callCap('child.kill', { pid: num, signal: name }) === true;
};
proc.umask = function () {
  return 18;
};
proc.emitWarning = function (warning) {
  host.stderr('(node) Warning: ' + (warning && warning.message ? warning.message : String(warning)) + '\n');
};
function makeStdioStream(writeText) {
  var stream = Object.create(EventEmitterCls.prototype);
  EventEmitterCls.call(stream);
  stream.isTTY = false;
  stream.columns = 80;
  stream.write = function (chunk, encoding, callback) {
    writeText(typeof chunk === 'string' ? chunk : String(chunk));
    var done = typeof encoding === 'function' ? encoding : callback;
    if (typeof done === 'function') queueMicrotask(function () { done(); });
    return true;
  };
  stream.end = function (chunk) {
    if (chunk !== undefined && typeof chunk !== 'function') stream.write(chunk);
    return stream;
  };
  stream.cork = function () {};
  stream.uncork = function () {};
  stream.setEncoding = function () { return stream; };
  return stream;
}
proc.stdout = makeStdioStream(function (text) {
  host.stdout(text);
});
proc.stderr = makeStdioStream(function (text) {
  host.stderr(text);
});
/* stdin has no input source unless the host feeds one. It is a stream that ends at once, so a
   reader sees end of input -- except in a REPL, where the host keeps it open and pushes into it
   what the terminal sends, and closes it when the terminal is done. */
var stdinStream = null;
var stdinOpen = false;
function stdinOf() {
  if (stdinStream === null) {
    var Readable = requireBuiltin('stream').Readable;
    stdinStream = new Readable({ read: function () {} });
    stdinStream.isTTY = false;
    // text in, text out: a pushed chunk reaches a reader as the string it was written as
    stdinStream.setEncoding('utf8');
    if (!stdinOpen) stdinStream.push(null);
  }
  return stdinStream;
}
Object.defineProperty(proc, 'stdin', {
  configurable: true,
  get: function () {
    var input = stdinOf();
    Object.defineProperty(proc, 'stdin', { value: input, configurable: true, writable: true });
    return input;
  }
});
/* Keeps stdin open for a REPL: nothing has read it yet, so it can still be fed. */
api.openStdin = function () {
  stdinOpen = true;
  return stdinOf();
};
/* One chunk of terminal input, pushed into the stream a REPL reads. */
api.pushStdin = function (text) {
  if (!stdinOpen) return false;
  stdinOf().push(typeof text === 'string' ? text : String(text));
  return true;
};
/* End of terminal input: Ctrl-D, or a terminal that closed. The reader sees end of file. */
api.endStdin = function () {
  if (!stdinOpen) return false;
  stdinOpen = false;
  stdinOf().push(null);
  return true;
};
globalThis.process = proc;
BF.process = function () {
  return proc;
};
BF.console = function () {
  return consoleObj;
};

/* V8 stack trace API: CallSite-like objects built from the engine's stack text, handed to Error.prepareStackTrace */
function makeCallSite(text) {
  var parsed = /^\s*at (.*?) \((.*)\)\s*$/.exec(text);
  var fnName = parsed ? parsed[1] : null;
  var location = parsed ? parsed[2] : text.replace(/^\s*at\s+/, '');
  var where = /^(.*?):(\d+)(?::(\d+))?$/.exec(location);
  var fileName = where ? where[1] : location;
  var lineNumber = where ? parseInt(where[2], 10) : null;
  var columnNumber = where && where[3] ? parseInt(where[3], 10) : null;
  var anonymous = fnName === null || fnName === '<anonymous>';
  return {
    getThis: function () { return undefined; },
    getTypeName: function () { return null; },
    getFunction: function () { return undefined; },
    getFunctionName: function () { return anonymous ? null : fnName; },
    getMethodName: function () { return null; },
    getFileName: function () { return fileName === '<input>' ? undefined : fileName; },
    getLineNumber: function () { return lineNumber; },
    getColumnNumber: function () { return columnNumber; },
    getEvalOrigin: function () { return undefined; },
    getScriptNameOrSourceURL: function () { return fileName === '<input>' ? undefined : fileName; },
    isToplevel: function () { return anonymous; },
    isEval: function () { return false; },
    isNative: function () { return location === 'native'; },
    isConstructor: function () { return false; },
    isAsync: function () { return false; },
    isPromiseAll: function () { return false; },
    getPromiseIndex: function () { return null; },
    toString: function () { return text.replace(/^\s*at\s+/, ''); }
  };
}

if (!Error.captureStackTrace) {
  Error.captureStackTrace = function (target) {
    if (!target || typeof target !== 'object') return;
    var frames = String(new Error('').stack || '').split('\n').slice(1);
    if (typeof Error.prepareStackTrace === 'function') {
      target.stack = Error.prepareStackTrace(target, frames.map(makeCallSite));
      return;
    }
    var header = String(target.name || 'Error') + (target.message ? ': ' + target.message : '');
    target.stack = frames.length ? header + '\n' + frames.join('\n') : header;
  };
}
if (Error.stackTraceLimit === undefined) Error.stackTraceLimit = 10;

var groupIndent = '';
var counters = Object.create(null);
var timeLabels = Object.create(null);

function writeConsole(text, toStderr) {
  var lines = groupIndent ? text.split('\n').map(function (l) { return groupIndent + l; }).join('\n') : text;
  if (toStderr) host.stderr(lines + '\n');
  else host.stdout(lines + '\n');
}

var consoleObj = {
  log: function () { writeConsole(formatLogArgs(arguments), false); },
  info: function () { writeConsole(formatLogArgs(arguments), false); },
  debug: function () { writeConsole(formatLogArgs(arguments), false); },
  warn: function () { writeConsole(formatLogArgs(arguments), true); },
  error: function () { writeConsole(formatLogArgs(arguments), true); },
  trace: function () {
    var message = formatLogArgs(arguments);
    writeConsole('Trace' + (message ? ': ' + message : ''), true);
  },
  dir: function (value, opts) { writeConsole(inspectValue(value, opts), false); },
  table: function (value) { writeConsole(inspectValue(value), false); },
  assert: function (condition) {
    if (condition) return;
    var rest = Array.prototype.slice.call(arguments, 1);
    writeConsole('Assertion failed' + (rest.length ? ': ' + formatLogArgs(rest) : ''), true);
  },
  count: function (label) {
    var name = label === undefined ? 'default' : String(label);
    counters[name] = (counters[name] || 0) + 1;
    writeConsole(name + ': ' + counters[name], false);
  },
  countReset: function (label) {
    delete counters[label === undefined ? 'default' : String(label)];
  },
  time: function (label) {
    timeLabels[label === undefined ? 'default' : String(label)] = host.now();
  },
  timeLog: function (label) {
    var name = label === undefined ? 'default' : String(label);
    if (timeLabels[name] === undefined) return;
    writeConsole(name + ': ' + (host.now() - timeLabels[name]).toFixed(3) + 'ms', false);
  },
  timeEnd: function (label) {
    var name = label === undefined ? 'default' : String(label);
    if (timeLabels[name] === undefined) return;
    writeConsole(name + ': ' + (host.now() - timeLabels[name]).toFixed(3) + 'ms', false);
    delete timeLabels[name];
  },
  group: function () {
    if (arguments.length) writeConsole(formatLogArgs(arguments), false);
    groupIndent += '  ';
  },
  groupEnd: function () {
    groupIndent = groupIndent.slice(2);
  }
};
consoleObj.groupCollapsed = consoleObj.group;
globalThis.console = consoleObj;

var nodeUrl = requireBuiltin('url');
var nodeUtil = requireBuiltin('util');
var nodeBuffer = requireBuiltin('buffer');
var nodeCrypto = requireBuiltin('crypto');
globalThis.global = globalThis;
globalThis.Buffer = nodeBuffer.Buffer;
/* Node's Buffer[Symbol.species] is its pooled view class (FastBuffer). ws reads it at load and calls new on it in its frame parser; the engine build leaves it undefined, so it is supplied here with the same shape: a Uint8Array view whose prototype is Buffer.prototype. */
(function () {
  function FastBuffer(bufferOrLength, byteOffset, length) {
    return Reflect.construct(Uint8Array, arguments, Buffer);
  }
  Object.defineProperty(Buffer, Symbol.species, { get: function () { return FastBuffer; }, configurable: true });
})();
globalThis.setTimeout = setTimeoutImpl;
globalThis.clearTimeout = clearTimer;
globalThis.setInterval = setIntervalImpl;
globalThis.clearInterval = clearTimer;
globalThis.setImmediate = setImmediateImpl;
globalThis.clearImmediate = clearTimer;
globalThis.queueMicrotask = queueMicrotaskImpl;
globalThis.TextEncoder = nodeUtil.TextEncoder;
globalThis.TextDecoder = nodeUtil.TextDecoder;
globalThis.Blob = requireBuiltin('buffer').Blob;
globalThis.File = (function () {
  class File extends globalThis.Blob {
    constructor(bits, name, options) {
      super(bits, options);
      if (arguments.length < 2) throw new TypeError('The "fileName" argument must be specified');
      this.name = String(name);
      this.lastModified = options && options.lastModified !== undefined ? Number(options.lastModified) : Date.now();
    }
  }
  Object.defineProperty(File.prototype, Symbol.toStringTag, { value: 'File', configurable: true });
  return File;
})();
globalThis.URL = nodeUrl.URL;
globalThis.URLSearchParams = nodeUrl.URLSearchParams;
globalThis.atob = function (input) {
  return decodeBytes(decodeBase64(String(input)), 'latin1');
};
globalThis.btoa = function (input) {
  return encodeBase64(encodeString(String(input), 'latin1'));
};
globalThis.performance = {
  timeOrigin: Date.now() - (host.now() - startedAt),
  now: function () { return host.now() - startedAt; }
};
globalThis.structuredClone = function (value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
};
globalThis.crypto = nodeCrypto.webcrypto;
globalThis.fetch = function () {
  return Promise.reject(new TypeError('fetch is not supported by this runtime'));
};
(function () {
  var STATE = new WeakMap();
  var CONTROLLER_SIGNAL = new WeakMap();
  function AbortSignal() {
    throw new TypeError('Illegal constructor');
  }
  Object.defineProperty(AbortSignal.prototype, 'aborted', {
    get: function () { return STATE.get(this).aborted; },
    configurable: true
  });
  Object.defineProperty(AbortSignal.prototype, 'reason', {
    get: function () { return STATE.get(this).reason; },
    configurable: true
  });
  Object.defineProperty(AbortSignal.prototype, Symbol.toStringTag, { value: 'AbortSignal', configurable: true });
  AbortSignal.prototype.addEventListener = function addEventListener(type, fn) {
    if (type === 'abort') STATE.get(this).listeners.push(fn);
  };
  AbortSignal.prototype.removeEventListener = function removeEventListener(type, fn) {
    var st = STATE.get(this);
    st.listeners = st.listeners.filter(function (l) { return l !== fn; });
  };
  AbortSignal.prototype.throwIfAborted = function throwIfAborted() {
    var st = STATE.get(this);
    if (st.aborted) throw st.reason;
  };
  function createSignal() {
    var signal = Object.create(AbortSignal.prototype);
    STATE.set(signal, { aborted: false, reason: undefined, listeners: [] });
    return signal;
  }
  function abortSignal(signal, reason) {
    var st = STATE.get(signal);
    if (st.aborted) return;
    st.aborted = true;
    if (reason === undefined) {
      // Node's default reason: a DOMException AbortError, code 20 (ABORT_ERR)
      reason = new DOMException('This operation was aborted', 'AbortError');
    }
    st.reason = reason;
    var listeners = st.listeners;
    st.listeners = [];
    listeners.forEach(function (fn) { fn({ type: 'abort' }); });
  }
  AbortSignal.abort = function abort(reason) {
    var signal = createSignal();
    abortSignal(signal, reason);
    return signal;
  };
  AbortSignal.timeout = function timeout(ms) {
    var signal = createSignal();
    setTimeout(function () {
      var reason = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      abortSignal(signal, reason);
    }, ms);
    return signal;
  };
  AbortSignal.any = function any(signals) {
    var signal = createSignal();
    Array.prototype.forEach.call(signals, function (source) {
      source.addEventListener('abort', function () { abortSignal(signal, source.reason); });
    });
    return signal;
  };
  function AbortController() {
    CONTROLLER_SIGNAL.set(this, createSignal());
  }
  Object.defineProperty(AbortController.prototype, 'signal', {
    get: function () { return CONTROLLER_SIGNAL.get(this); },
    configurable: true
  });
  AbortController.prototype.abort = function abort(reason) {
    abortSignal(CONTROLLER_SIGNAL.get(this), reason);
  };
  globalThis.AbortSignal = AbortSignal;
  globalThis.AbortController = AbortController;
})();

/* Legacy RegExp statics: RegExp.$1-$9, input, lastMatch, lastParen, leftContext, rightContext. V8 keeps them from the last successful exec or test, and showdown reads RegExp.$1 right after RegExp.prototype.test. The engine build has none, so exec and test record the match here. */
(function () {
  var nativeExec = RegExp.prototype.exec;
  var last = null;
  function group(index) {
    if (last === null) return '';
    var value = last[index];
    return value === undefined ? '' : value;
  }
  function subject() {
    return last === null ? '' : last.input;
  }
  function before() {
    return last === null ? '' : last.input.slice(0, last.index);
  }
  function after() {
    return last === null ? '' : last.input.slice(last.index + last[0].length);
  }
  function lastGroup() {
    return last === null || last.length < 2 ? '' : group(last.length - 1);
  }
  function define(name, read) {
    Object.defineProperty(RegExp, name, { get: read, set: function () {}, enumerable: false, configurable: true });
  }
  RegExp.prototype.exec = function exec(string) {
    var match = nativeExec.call(this, string);
    if (match !== null) last = match;
    return match;
  };
  RegExp.prototype.test = function test(string) {
    return this.exec(string) !== null;
  };
  for (var n = 1; n <= 9; n++) {
    (function (index) {
      define('$' + index, function () { return group(index); });
    })(n);
  }
  define('input', subject);
  define('$_', subject);
  define('lastMatch', function () { return group(0); });
  define('$&', function () { return group(0); });
  define('lastParen', lastGroup);
  define('$+', lastGroup);
  define('leftContext', before);
  define('$' + String.fromCharCode(96), before);
  define('rightContext', after);
  define("$'", after);
})();

api.finalExitCode = function () {
  var code = proc.exitCode;
  return typeof code === 'number' ? code : 0;
};
var exitEmitted = false;
api.emitExit = function (code) {
  if (exitEmitted) return;
  exitEmitted = true;
  proc.emit('exit', code);
};
api.formatUncaught = function (err) {
  if (err instanceof Error) return formatErrorStack(err);
  return inspectValue(err);
};
api.isExitSignal = function (value) {
  return value === EXIT_SIGNAL;
};
api.setArgv = function (argv) {
  proc.argv = argv;
};
`;
