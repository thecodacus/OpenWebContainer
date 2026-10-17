/**
 * Guest source for the child family: child_process, worker_threads and cluster. Host half:
 * ../../capabilities/child.ts.
 *
 * Mechanism. Each child is a container process. Its stdout and stderr reach the parent as events
 * (stdio 'pipe'), are forwarded through the parent's output (stdio 'inherit', the default for fork,
 * worker_threads and cluster workers), or are dropped ('ignore'). The parent holds a ref from spawn
 * until the child exits, so the parent waits for its children as Node does.
 *
 * IPC (fork, cluster workers, worker_threads). A child boots with OWC_IPC_KIND (fork | cluster | worker)
 * and OWC_IPC_DATA (JSON with the spawn token, threadId, workerData or cluster id) in its environment.
 * The bootstrap hook at the end of this source reads them, deletes them from process.env, attaches an IPC
 * target with the child.ipcAttach capability, and installs process.send / process.connected /
 * process.disconnect (fork, cluster) or parentPort (worker). Messages cross as tagged JSON: undefined,
 * bigint, NaN and Infinity, Date, Map, Set and typed arrays keep their type; functions and symbols throw
 * DataCloneError. A forked child or cluster worker holds a ref while it has 'message' or 'disconnect'
 * listeners, as Node's refCounted channel does. An uncaught error in a worker thread is sent to the parent
 * as an 'error' event before the thread exits with code 1.
 *
 * Synchronous family. spawnSync, execSync and execFileSync run the child to completion inside one capability
 * call (child.spawnSync): the host steps the child's jobs, timers and synchronous host calls until it exits. A
 * child that waits on asynchronous host work (network, a grandchild, a promise-returning capability) cannot be
 * stepped there, so the call reports ERR_NOT_SUPPORTED with the output written so far.
 *
 * Known gaps. Only node, *.js and sh executables start through the container; other commands run through exec
 * or through spawn with shell: true. Writes to a node child's stdin are accepted but never read, because
 * Process.writeInput feeds only shell processes, and a synchronous node child is given no input. There is no
 * SCM_RIGHTS handle passing, no cluster networking (servers are not shared between workers), and
 * BroadcastChannel is in-process only.
 */
export const SRC = String.raw`
var cpState = {
  kind: null,
  data: {},
  connected: false,
  held: false,
  port: null,
  target: 0,
  exitHooked: false,
  threadCount: 0,
  tokenCount: 0,
  channels: [],
  portClass: null,
  childClass: null
};

var cpSignalNames = { 1: 'SIGHUP', 2: 'SIGINT', 9: 'SIGKILL', 15: 'SIGTERM' };

function cpEE() {
  return requireBuiltin('events');
}

function cpError(message, code) {
  var err = new Error(message);
  if (code) err.code = code;
  return err;
}

function cpErrorJson(err) {
  var isObject = err !== null && typeof err === 'object';
  return {
    name: isObject && err.name ? String(err.name) : 'Error',
    message: isObject && err.message !== undefined ? String(err.message) : String(err),
    code: isObject && err.code !== undefined ? String(err.code) : undefined,
    stack: isObject && err.stack ? String(err.stack) : undefined
  };
}

function cpErrorFrom(json) {
  var err = new Error(json.message);
  if (json.name) err.name = json.name;
  if (json.code) err.code = json.code;
  if (json.stack) err.stack = json.stack;
  return err;
}

function cpEncode(value) {
  if (value === undefined) return { $t: 'u' };
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    return value === value && value !== Infinity && value !== -Infinity ? value : { $t: 'x', v: String(value) };
  }
  if (typeof value === 'bigint') return { $t: 'n', v: value.toString() };
  if (typeof value === 'function' || typeof value === 'symbol') {
    var cloneError = cpError(String(value) + ' could not be cloned.', 'ERR_DATA_CLONE');
    cloneError.name = 'DataCloneError';
    throw cloneError;
  }
  if (value instanceof Date) return { $t: 'd', v: value.getTime() };
  if (value instanceof Map) {
    var entries = [];
    value.forEach(function (item, key) {
      entries.push([cpEncode(key), cpEncode(item)]);
    });
    return { $t: 'M', v: entries };
  }
  if (value instanceof Set) {
    var members = [];
    value.forEach(function (item) {
      members.push(cpEncode(item));
    });
    return { $t: 'S', v: members };
  }
  if (ArrayBuffer.isView(value)) {
    var isBuffer = Buffer.isBuffer(value);
    return {
      $t: 'B',
      c: isBuffer ? 'Buffer' : 'Uint8Array',
      v: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64')
    };
  }
  if (value instanceof ArrayBuffer) return { $t: 'AB', v: Buffer.from(value).toString('base64') };
  if (Array.isArray(value)) {
    return value.map(function (item) {
      return cpEncode(item);
    });
  }
  var out = {};
  var keys = Object.keys(value);
  var tagged = false;
  for (var i = 0; i < keys.length; i++) {
    if (keys[i] === '$t') tagged = true;
    out[keys[i]] = cpEncode(value[keys[i]]);
  }
  return tagged ? { $t: 'o', v: out } : out;
}

function cpDecode(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map(function (item) {
      return cpDecode(item);
    });
  }
  if (Object.prototype.hasOwnProperty.call(value, '$t')) {
    switch (value.$t) {
      case 'u': return undefined;
      case 'x': return Number(value.v);
      case 'n': return BigInt(value.v);
      case 'd': return new Date(value.v);
      case 'M':
        return new Map(value.v.map(function (pair) {
          return [cpDecode(pair[0]), cpDecode(pair[1])];
        }));
      case 'S':
        return new Set(value.v.map(function (item) {
          return cpDecode(item);
        }));
      case 'B': {
        var raw = Buffer.from(value.v, 'base64');
        if (value.c === 'Buffer') return raw;
        var bytes = new Uint8Array(raw.length);
        bytes.set(raw);
        return bytes;
      }
      case 'AB': {
        var decoded = Buffer.from(value.v, 'base64');
        var buffer = new ArrayBuffer(decoded.length);
        new Uint8Array(buffer).set(decoded);
        return buffer;
      }
      case 'o': {
        var inner = {};
        var innerKeys = Object.keys(value.v);
        for (var j = 0; j < innerKeys.length; j++) {
          inner[innerKeys[j]] = cpDecode(value.v[innerKeys[j]]);
        }
        return inner;
      }
      default: break;
    }
  }
  var plain = {};
  var plainKeys = Object.keys(value);
  for (var k = 0; k < plainKeys.length; k++) {
    plain[plainKeys[k]] = cpDecode(value[plainKeys[k]]);
  }
  return plain;
}

/* MessagePort: messages are delivered asynchronously (setImmediate), and a port with 'message' listeners
   holds a ref until it is closed or unref'd, as Node does. A port with a _remote sender sends over IPC. */
function cpPortClass() {
  if (cpState.portClass) return cpState.portClass;
  var EE = cpEE();
  function MessagePort() {
    EE.call(this);
    this._q = [];
    this._started = false;
    this._closed = false;
    this._peer = null;
    this._remote = null;
    this._refed = true;
    this._held = false;
    this._scheduled = false;
    var self = this;
    this.on('newListener', function (ev) {
      if (ev !== 'message') return;
      self._started = true;
      self._sync(true);
      self._schedule();
    });
    this.on('removeListener', function (ev) {
      if (ev === 'message') self._sync(false);
    });
  }
  MessagePort.prototype = Object.create(EE.prototype);
  MessagePort.prototype.constructor = MessagePort;
  MessagePort.prototype._sync = function (adding) {
    var live = !this._closed && this._started && this._refed;
    var want = live && (adding === true || this.listenerCount('message') > 0);
    if (want !== this._held) {
      this._held = want;
      holdRef(want ? 1 : -1);
    }
  };
  MessagePort.prototype._enqueue = function (value) {
    if (this._closed) return;
    this._q.push(value);
    this._schedule();
  };
  MessagePort.prototype._schedule = function () {
    if (this._scheduled || !this._started || this._closed || this._q.length === 0) return;
    this._scheduled = true;
    var self = this;
    setImmediate(function () {
      self._scheduled = false;
      while (self._started && !self._closed && self._q.length > 0) {
        self.emit('message', self._q.shift());
      }
    });
  };
  MessagePort.prototype.postMessage = function (value) {
    if (this._closed) return;
    var encoded = cpEncode(value);
    if (this._remote) {
      this._remote(encoded);
      return;
    }
    var peer = this._peer;
    if (peer && !peer._closed) peer._enqueue(cpDecode(encoded));
  };
  MessagePort.prototype.start = function () {
    if (this._closed) return;
    this._started = true;
    this._sync(false);
    this._schedule();
  };
  MessagePort.prototype.close = function () {
    if (this._closed) return;
    this._closed = true;
    this._q = [];
    this._sync(false);
    var self = this;
    var peer = this._peer;
    setImmediate(function () {
      self.emit('close');
      if (peer && !peer._closed) peer.close();
    });
  };
  MessagePort.prototype.ref = function () {
    this._refed = true;
    this._sync(false);
    return this;
  };
  MessagePort.prototype.unref = function () {
    this._refed = false;
    this._sync(false);
    return this;
  };
  MessagePort.prototype.hasRef = function () {
    return this._held;
  };
  cpState.portClass = MessagePort;
  return MessagePort;
}

function cpMakeChannel() {
  var Port = cpPortClass();
  var a = new Port();
  var b = new Port();
  a._peer = b;
  b._peer = a;
  return { port1: a, port2: b };
}

function cpBroadcastClass() {
  var Port = cpPortClass();
  function BroadcastChannel(name) {
    Port.call(this);
    this.name = String(name);
    cpState.channels.push(this);
  }
  BroadcastChannel.prototype = Object.create(Port.prototype);
  BroadcastChannel.prototype.constructor = BroadcastChannel;
  BroadcastChannel.prototype.postMessage = function (value) {
    if (this._closed) return;
    var encoded = cpEncode(value);
    var self = this;
    cpState.channels.forEach(function (other) {
      if (other !== self && other.name === self.name && !other._closed) {
        other._enqueue(cpDecode(encoded));
      }
    });
  };
  BroadcastChannel.prototype.close = function () {
    var index = cpState.channels.indexOf(this);
    if (index >= 0) cpState.channels.splice(index, 1);
    Port.prototype.close.call(this);
  };
  return BroadcastChannel;
}

function cpMode(value) {
  if (value === 'inherit' || value === 'ignore' || value === 'pipe') return value;
  if (value === 0 || value === 1 || value === 2 || (value !== null && typeof value === 'object')) return 'inherit';
  return 'pipe';
}

function cpStdio(stdio) {
  var list = typeof stdio === 'string' ? [stdio, stdio, stdio] : (Array.isArray(stdio) ? stdio : []);
  var ipc = false;
  for (var i = 0; i < list.length; i++) {
    if (list[i] === 'ipc') ipc = true;
  }
  return { modes: [cpMode(list[0]), cpMode(list[1]), cpMode(list[2])], ipc: ipc };
}

function cpEnvObject(env) {
  var out = {};
  Object.keys(env).forEach(function (key) {
    if (env[key] !== undefined) out[key] = String(env[key]);
  });
  return out;
}

function cpCallbackFrom(args) {
  for (var i = args.length - 1; i >= 0; i--) {
    if (typeof args[i] === 'function') return args[i];
  }
  return null;
}

/* exec-style argument parsing: (args?, options?, callback?) after the file or command */
function cpParseCall(rest) {
  var list = Array.prototype.slice.call(rest);
  var callback = null;
  if (list.length > 0 && typeof list[list.length - 1] === 'function') callback = list.pop();
  var args = [];
  var opts = {};
  if (list.length > 0 && Array.isArray(list[0])) {
    args = list[0];
    if (list[1] && typeof list[1] === 'object') opts = list[1];
  } else if (list.length > 0 && list[0] && typeof list[0] === 'object') {
    opts = list[0];
  }
  return { args: args, opts: opts, cb: callback };
}

/* the guest's own IPC ref (process channel), held while a 'message' or 'disconnect' listener exists */
function cpSetRef(on) {
  if (on === cpState.held) return;
  cpState.held = on;
  holdRef(on ? 1 : -1);
}

function cpRefChild(child, on) {
  if (on) {
    if (!child._cpRef && !child._cpExited) {
      child._cpRef = true;
      holdRef(1);
    }
  } else if (child._cpRef) {
    child._cpRef = false;
    holdRef(-1);
  }
}

/* runs an action now if the child has started on the host, otherwise after its spawn settles */
function cpPost(child, action) {
  if (child._cpSpawned) action();
  else child._cpPending.push(action);
}

function cpClusterEmit(child, event, extra) {
  if (!child._cpCluster) return;
  var args = [event, child].concat(extra || []);
  child._cpCluster.emit.apply(child._cpCluster, args);
}

function cpEmitDisconnect(child) {
  child.emit('disconnect');
  cpClusterEmit(child, 'disconnect', []);
}

function cpSpawnCore(child, file, argv, options, extra) {
  var opts = options || {};
  var exe = String(file);
  var list = (argv || []).map(function (item) {
    return String(item);
  });
  var spawnfile = exe;
  if (opts.shell) {
    spawnfile = '/bin/sh';
    list = ['-c', [exe].concat(list).join(' ')];
    exe = 'sh';
  }
  var stdio = cpStdio(opts.stdio);
  var ipc = stdio.ipc || extra.ipc === true;
  var cwd = opts.cwd === undefined || opts.cwd === null ? undefined : String(opts.cwd);
  if (cwd !== undefined && cwd.charAt(0) !== '/') cwd = proc.cwd().replace(/\/$/, '') + '/' + cwd;
  cpState.tokenCount += 1;
  var token = proc.pid + ':' + cpState.tokenCount;
  child.spawnfile = spawnfile;
  child.spawnargs = [spawnfile].concat(list);
  child.connected = ipc;
  child._cpWorker = extra.kind === 'worker';
  child._cpCluster = extra.cluster || null;
  child._cpSpawned = false;
  child._cpExited = false;
  child._cpRef = false;
  child._cpTimer = null;
  child._cpPending = [];
  child._cpQueue = [];
  var stream = requireBuiltin('stream');
  if (stdio.modes[1] === 'pipe') child.stdout = new stream.Readable({ read: function () {} });
  if (stdio.modes[2] === 'pipe') child.stderr = new stream.Readable({ read: function () {} });
  if (stdio.modes[0] === 'pipe') {
    child.stdin = new stream.Writable({
      write: function (chunk, encoding, done) {
        var text = String(chunk);
        cpPost(child, function () {
          callCap('child.stdin', { pid: child.pid, data: text });
        });
        done();
      }
    });
  }
  child.stdio = [child.stdin, child.stdout, child.stderr];
  child._cpTarget = createTarget(function (name, payload) {
    cpOnEvent(child, payload);
  });
  if (Number(opts.timeout) > 0) {
    child._cpTimer = setTimeout(function () {
      cpKill(child, opts.killSignal);
    }, Number(opts.timeout));
  }
  cpRefChild(child, true);
  if (ipc || extra.kind === 'worker') cpHookParentExit();
  callOp('child.spawn', {
    file: exe,
    args: list,
    cwd: cwd,
    env: opts.env && typeof opts.env === 'object' ? cpEnvObject(opts.env) : null,
    stdio: stdio.modes,
    ipc: ipc,
    ipcKind: extra.ipcKind || null,
    ipcData: extra.ipcData || {},
    token: token,
    kind: extra.kind,
    target: child._cpTarget
  }).then(function (result) {
    cpSpawnedOk(child, result.pid);
  }, function (error) {
    cpSpawnFailed(child, error);
  });
  return child;
}

function cpSpawnedOk(child, pid) {
  child.pid = pid;
  child._cpSpawned = true;
  if (child._cpWorker) child.emit('online');
  else child.emit('spawn');
  if (child._cpCluster) cpClusterEmit(child, 'online', []);
  var actions = child._cpPending.splice(0);
  for (var i = 0; i < actions.length; i++) actions[i]();
  var events = child._cpQueue.splice(0);
  for (var j = 0; j < events.length; j++) cpOnEvent(child, events[j]);
}

function cpSpawnFailed(child, error) {
  child._cpExited = true;
  child.connected = false;
  if (child._cpTimer) clearTimeout(child._cpTimer);
  cpRefChild(child, false);
  var errno = error && typeof error.errno === 'number' ? error.errno : -2;
  child.emit('error', error);
  proc.nextTick(function () {
    child.emit('close', errno, null);
  });
}

function cpOnEvent(child, ev) {
  if (!child._cpSpawned) {
    child._cpQueue.push(ev);
    return;
  }
  if (ev.k === 'out') {
    var stream = ev.fd === 2 ? child.stderr : child.stdout;
    if (stream) stream.push(Buffer.from(ev.s, 'utf8'));
  } else if (ev.k === 'exit') {
    cpExit(child, ev.code, ev.signal);
  } else if (ev.k === 'error') {
    child.emit('error', cpErrorFrom(ev.e));
  } else if (ev.k === 'ipc') {
    cpIpc(child, ev.f);
  } else if (ev.k === 'ipcdown') {
    if (child.connected) {
      child.connected = false;
      cpEmitDisconnect(child);
    }
  }
}

function cpExit(child, code, signal) {
  if (child._cpExited) return;
  child._cpExited = true;
  if (child._cpTimer) clearTimeout(child._cpTimer);
  var exitCode = child._cpWorker && code === null ? 0 : code;
  child.exitCode = exitCode;
  child.signalCode = signal;
  cpRefChild(child, false);
  if (child.connected) {
    child.connected = false;
    cpEmitDisconnect(child);
  }
  child.emit('exit', exitCode, signal);
  cpClusterEmit(child, 'exit', [exitCode, signal]);
  cpCloseWhenDone(child, exitCode, signal);
}

/* 'close' follows 'exit' once every piped stream that is being read has ended; unread streams do not hold it */
function cpCloseWhenDone(child, code, signal) {
  var waiting = [];
  var streams = [child.stdout, child.stderr];
  for (var i = 0; i < streams.length; i++) {
    var stream = streams[i];
    if (!stream) continue;
    stream.push(null);
    if (stream.listenerCount('data') > 0 || stream.readableFlowing === true) waiting.push(stream);
  }
  if (waiting.length === 0) {
    proc.nextTick(function () {
      child.emit('close', code, signal);
    });
    return;
  }
  var left = waiting.length;
  waiting.forEach(function (stream) {
    stream.once('end', function () {
      left -= 1;
      if (left === 0) child.emit('close', code, signal);
    });
  });
}

function cpIpc(child, frame) {
  if (frame.t === 'm') {
    var message = cpDecode(frame.v);
    child.emit('message', message, undefined);
    cpClusterEmit(child, 'message', [message]);
  } else if (frame.t === 'e') {
    child.emit('error', cpErrorFrom(frame.v));
  }
}

function cpKill(child, signal) {
  if (!child._cpSpawned || child._cpExited) return false;
  if (signal === 0 || signal === '0') return true;
  var name = typeof signal === 'number'
    ? (cpSignalNames[signal] || 'SIGTERM')
    : String(signal === undefined || signal === null ? 'SIGTERM' : signal);
  var ok = callCap('child.kill', { pid: child.pid, signal: name });
  if (ok) child.killed = true;
  return ok === true;
}

function cpSendToChild(child, message, callback) {
  if (!child.connected) {
    var closed = cpError('Channel closed', 'ERR_IPC_CHANNEL_CLOSED');
    if (typeof callback === 'function') proc.nextTick(callback, closed);
    else proc.nextTick(function () {
      child.emit('error', closed);
    });
    return false;
  }
  var frame = { t: 'm', v: cpEncode(message) };
  cpPost(child, function () {
    callCap('child.sendToChild', { pid: child.pid, frame: frame });
  });
  if (typeof callback === 'function') proc.nextTick(callback, null);
  return true;
}

function cpDisconnectChild(child) {
  if (!child.connected) return;
  child.connected = false;
  cpPost(child, function () {
    callCap('child.disconnectChild', { pid: child.pid });
  });
  proc.nextTick(function () {
    cpEmitDisconnect(child);
  });
}

function cpChannelSend(message, callback) {
  if (!cpState.connected) {
    var closed = cpError('Channel closed', 'ERR_IPC_CHANNEL_CLOSED');
    if (typeof callback === 'function') proc.nextTick(callback, closed);
    else proc.nextTick(function () {
      proc.emit('error', closed);
    });
    return false;
  }
  callCap('child.sendToParent', { frame: { t: 'm', v: cpEncode(message) } });
  if (typeof callback === 'function') proc.nextTick(callback, null);
  return true;
}

function cpChildClass() {
  if (cpState.childClass) return cpState.childClass;
  var EE = cpEE();
  function ChildProcess() {
    EE.call(this);
    this.pid = undefined;
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.connected = false;
    this.spawnfile = undefined;
    this.spawnargs = [];
    this.stdin = null;
    this.stdout = null;
    this.stderr = null;
    this.stdio = [null, null, null];
  }
  ChildProcess.prototype = Object.create(EE.prototype);
  ChildProcess.prototype.constructor = ChildProcess;
  ChildProcess.prototype.kill = function (signal) {
    return cpKill(this, signal);
  };
  ChildProcess.prototype.send = function (message) {
    return cpSendToChild(this, message, cpCallbackFrom(arguments));
  };
  ChildProcess.prototype.disconnect = function () {
    cpDisconnectChild(this);
  };
  ChildProcess.prototype.ref = function () {
    cpRefChild(this, true);
    return this;
  };
  ChildProcess.prototype.unref = function () {
    cpRefChild(this, false);
    return this;
  };
  cpState.childClass = ChildProcess;
  return ChildProcess;
}

function cpWorkerClass() {
  var Child = cpChildClass();
  function Worker(filename, options) {
    Child.call(this);
    var opts = options || {};
    cpState.threadCount += 1;
    var threadId = cpState.threadCount;
    this.threadId = threadId;
    this.resourceLimits = {};
    var argv = opts.eval === true ? ['-e', String(filename)] : [String(filename)];
    cpSpawnCore(this, 'node', argv, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'inherit', 'inherit']
    }, {
      kind: 'worker',
      ipc: true,
      ipcKind: 'worker',
      ipcData: { threadId: threadId, workerData: cpEncode(opts.workerData === undefined ? null : opts.workerData) }
    });
  }
  Worker.prototype = Object.create(Child.prototype);
  Worker.prototype.constructor = Worker;
  Worker.prototype.postMessage = function (value) {
    cpSendToChild(this, value, null);
  };
  Worker.prototype.terminate = function () {
    var self = this;
    return new Promise(function (resolve) {
      if (self._cpExited) {
        resolve(self.exitCode === null ? 0 : self.exitCode);
        return;
      }
      self.once('exit', function (code) {
        resolve(code);
      });
      cpPost(self, function () {
        cpKill(self, 'SIGTERM');
      });
    });
  };
  return Worker;
}

function cpSpawnApi(file, args, options) {
  var list = [];
  var opts = {};
  if (Array.isArray(args)) {
    list = args;
    if (options && typeof options === 'object') opts = options;
  } else if (args && typeof args === 'object') {
    opts = args;
  }
  return cpSpawnCore(new (cpChildClass())(), file, list, opts, { kind: 'child' });
}

/* collects stdout and stderr, then calls back once: on spawn failure, or on close after exit */
function cpCollect(child, opts, cmdText, callback) {
  var encoding = opts.encoding === undefined ? 'utf8' : opts.encoding;
  var outs = [];
  var errs = [];
  var done = false;
  if (child.stdout) child.stdout.on('data', function (chunk) {
    outs.push(chunk);
  });
  if (child.stderr) child.stderr.on('data', function (chunk) {
    errs.push(chunk);
  });
  function finish(error) {
    if (done) return;
    done = true;
    if (typeof callback !== 'function') return;
    var out = Buffer.concat(outs);
    var err = Buffer.concat(errs);
    var asBuffer = encoding === 'buffer' || encoding === null;
    callback(error, asBuffer ? out : out.toString(encoding), asBuffer ? err : err.toString(encoding));
  }
  child.on('error', function (error) {
    finish(error);
  });
  child.on('close', function (code, signal) {
    if (code === 0 && !signal) {
      finish(null);
      return;
    }
    var error = cpError('Command failed: ' + cmdText + '\n' + Buffer.concat(errs).toString('utf8'));
    error.code = code;
    error.killed = child.killed;
    error.signal = signal;
    error.cmd = cmdText;
    finish(error);
  });
}

function cpExec(command, rest) {
  var call = cpParseCall(rest);
  var cmd = String(command);
  var child = cpSpawnCore(new (cpChildClass())(), 'sh', ['-c', cmd], call.opts, { kind: 'child' });
  cpCollect(child, call.opts, cmd, call.cb);
  return child;
}

function cpExecFile(file, rest) {
  var call = cpParseCall(rest);
  var list = call.args.map(function (item) {
    return String(item);
  });
  var child = cpSpawnCore(new (cpChildClass())(), String(file), list, call.opts, { kind: 'child' });
  cpCollect(child, call.opts, [String(file)].concat(list).join(' '), call.cb);
  return child;
}

function cpForkApi(modulePath, args, options) {
  var list = [];
  var opts = {};
  if (Array.isArray(args)) {
    list = args;
    if (options && typeof options === 'object') opts = options;
  } else if (args && typeof args === 'object') {
    opts = args;
  }
  var silent = opts.silent === true;
  var stdio = opts.stdio !== undefined
    ? opts.stdio
    : (silent ? ['pipe', 'pipe', 'pipe'] : ['inherit', 'inherit', 'inherit']);
  return cpSpawnCore(new (cpChildClass())(), 'node', [String(modulePath)].concat(list.map(function (item) {
    return String(item);
  })), {
    cwd: opts.cwd,
    env: opts.env,
    stdio: stdio,
    timeout: opts.timeout,
    killSignal: opts.killSignal
  }, { kind: 'fork', ipc: true, ipcKind: 'fork', ipcData: {} });
}

/* synchronous family: the host runs the child to completion inside one call (child.spawnSync) */
function cpSyncCall(file, args, options) {
  var list = [];
  var opts = {};
  if (Array.isArray(args)) {
    list = args;
    if (options && typeof options === 'object') opts = options;
  } else if (args && typeof args === 'object') {
    opts = args;
  }
  return {
    file: String(file),
    list: list.map(function (item) {
      return String(item);
    }),
    opts: opts
  };
}

function cpSyncKillName(signal) {
  if (typeof signal === 'number') return cpSignalNames[signal] || 'SIGTERM';
  return String(signal === undefined || signal === null ? 'SIGTERM' : signal);
}

/* one run, shaped as Node's spawnSync result: status, signal, output, pid, stdout, stderr and error */
function cpSyncRun(file, list, opts) {
  var exe = file;
  var argv = list;
  if (opts.shell) {
    argv = ['-c', [exe].concat(list).join(' ')];
    exe = 'sh';
  }
  var stdio = cpStdio(opts.stdio);
  var cwd = opts.cwd === undefined || opts.cwd === null ? undefined : String(opts.cwd);
  if (cwd !== undefined && cwd.charAt(0) !== '/') cwd = proc.cwd().replace(/\/$/, '') + '/' + cwd;
  var input = null;
  if (opts.input !== undefined && opts.input !== null) {
    input = typeof opts.input === 'string' ? opts.input : Buffer.from(opts.input).toString('utf8');
  }
  var raw = callCap('child.spawnSync', {
    file: exe,
    args: argv,
    cwd: cwd,
    env: opts.env && typeof opts.env === 'object' ? cpEnvObject(opts.env) : null,
    stdio: stdio.modes,
    input: input,
    timeout: Number(opts.timeout) > 0 ? Number(opts.timeout) : 0,
    killSignal: cpSyncKillName(opts.killSignal)
  });
  var encoding = opts.encoding === undefined ? null : opts.encoding;
  function shaped(text, fd) {
    if (stdio.modes[fd] !== 'pipe' || text === null || text === undefined) return null;
    var buffer = Buffer.from(text, 'utf8');
    return encoding === null || encoding === 'buffer' ? buffer : buffer.toString(encoding);
  }
  var output = raw.spawned ? [null, shaped(raw.stdout, 1), shaped(raw.stderr, 2)] : undefined;
  var result = {
    status: raw.status,
    signal: raw.signal,
    output: output,
    pid: raw.pid,
    stdout: output ? output[1] : undefined,
    stderr: output ? output[2] : undefined
  };
  if (raw.error) {
    var error = new Error(raw.error.message);
    error.code = raw.error.code;
    if (raw.error.errno !== undefined) error.errno = raw.error.errno;
    if (raw.error.syscall !== undefined) error.syscall = raw.error.syscall;
    if (raw.error.path !== undefined) error.path = raw.error.path;
    if (raw.error.spawnargs !== undefined) error.spawnargs = raw.error.spawnargs;
    result.error = error;
  }
  return result;
}

/* a failed run as the call site throws it: the run's error, or 'Command failed', with the run's fields attached */
function cpSyncFailure(ret, cmdText) {
  var failure = null;
  if (ret.error) {
    failure = ret.error;
  } else if (ret.status !== 0) {
    var message = 'Command failed: ' + cmdText;
    if (ret.stderr && ret.stderr.length > 0) message += '\n' + String(ret.stderr);
    failure = cpError(message);
  } else {
    return null;
  }
  failure.status = ret.status;
  failure.signal = ret.signal;
  failure.output = ret.output;
  failure.pid = ret.pid;
  failure.stdout = ret.stdout;
  failure.stderr = ret.stderr;
  return failure;
}

function cpSpawnSyncApi(file, args, options) {
  var call = cpSyncCall(file, args, options);
  return cpSyncRun(call.file, call.list, call.opts);
}

function cpExecSyncApi(command, options) {
  var opts = options && typeof options === 'object' ? options : {};
  var cmd = String(command);
  var ret = cpSyncRun('sh', ['-c', cmd], opts);
  if (opts.stdio === undefined && ret.stderr) proc.stderr.write(ret.stderr);
  var failure = cpSyncFailure(ret, cmd);
  if (failure) throw failure;
  return ret.stdout;
}

function cpExecFileSyncApi(file, args, options) {
  var call = cpSyncCall(file, args, options);
  var ret = cpSyncRun(call.file, call.list, call.opts);
  if (call.opts.stdio === undefined && ret.stderr) proc.stderr.write(ret.stderr);
  var failure = cpSyncFailure(ret, [call.file].concat(call.list).join(' '));
  if (failure) throw failure;
  return ret.stdout;
}

/* the parent exits: worker threads are terminated and IPC children are disconnected, as in Node */
function cpHookParentExit() {
  if (cpState.exitHooked) return;
  cpState.exitHooked = true;
  proc.once('exit', function () {
    try {
      callCap('child.parentExit', {});
    } catch (ignored) {
      // the process is exiting: nothing is left to notify
    }
  });
}

/* the child side of fork and cluster: process.send, process.connected, process.disconnect and the ref */
function cpWireProcess() {
  proc.connected = true;
  proc.send = function (message) {
    return cpChannelSend(message, cpCallbackFrom(arguments));
  };
  proc.disconnect = function () {
    if (!cpState.connected) return;
    cpState.connected = false;
    proc.connected = false;
    cpSetRef(false);
    callCap('child.disconnectSelf', {});
    proc.nextTick(function () {
      proc.emit('disconnect');
    });
  };
  proc.on('newListener', function (ev) {
    if (cpState.connected && (ev === 'message' || ev === 'disconnect')) cpSetRef(true);
  });
  proc.on('removeListener', function (ev) {
    if (ev !== 'message' && ev !== 'disconnect') return;
    cpSetRef(cpState.connected && proc.listenerCount('message') + proc.listenerCount('disconnect') > 0);
  });
}

/* frames from the parent: 'm' carries a message, 'd' closes the channel */
function cpOnFrame(name, frame) {
  if (name !== 'ipc' || !frame) return;
  if (frame.t === 'm') {
    var message = cpDecode(frame.v);
    if (cpState.kind === 'worker') cpState.port._enqueue(message);
    else proc.emit('message', message, undefined);
  } else if (frame.t === 'd' && cpState.connected) {
    cpState.connected = false;
    proc.connected = false;
    cpSetRef(false);
    proc.nextTick(function () {
      proc.emit('disconnect');
    });
  }
}

/* a worker thread reports an uncaught error to its parent before the error text ends the thread */
function cpWireWorkerErrors() {
  var base = api.formatUncaught;
  api.formatUncaught = function (err) {
    try {
      callCap('child.sendToParent', { frame: { t: 'e', v: cpErrorJson(err) } });
    } catch (ignored) {
      // the parent may already be gone
    }
    return base(err);
  };
}

BF['child_process'] = function () {
  var ChildProcess = cpChildClass();
  return {
    ChildProcess: ChildProcess,
    spawn: function (file, args, options) {
      return cpSpawnApi(file, args, options);
    },
    exec: function (command) {
      return cpExec(command, Array.prototype.slice.call(arguments, 1));
    },
    execFile: function (file) {
      return cpExecFile(file, Array.prototype.slice.call(arguments, 1));
    },
    fork: function (modulePath, args, options) {
      return cpForkApi(modulePath, args, options);
    },
    spawnSync: function (file, args, options) {
      return cpSpawnSyncApi(file, args, options);
    },
    execSync: function (command, options) {
      return cpExecSyncApi(command, options);
    },
    execFileSync: function (file, args, options) {
      return cpExecFileSyncApi(file, args, options);
    }
  };
};

BF['worker_threads'] = function () {
  var Worker = cpWorkerClass();
  var Port = cpPortClass();
  var BroadcastChannel = cpBroadcastClass();
  function MessageChannel() {
    var pair = cpMakeChannel();
    this.port1 = pair.port1;
    this.port2 = pair.port2;
  }
  var isWorker = cpState.kind === 'worker';
  return {
    isMainThread: !isWorker,
    parentPort: isWorker ? cpState.port : null,
    workerData: isWorker ? cpDecode(cpState.data.workerData) : null,
    threadId: isWorker ? cpState.data.threadId : 0,
    resourceLimits: {},
    SHARE_ENV: typeof Symbol === 'function' ? Symbol('nodejs.worker_threads.SHARE_ENV') : {},
    Worker: Worker,
    MessageChannel: MessageChannel,
    MessagePort: Port,
    BroadcastChannel: BroadcastChannel,
    receiveMessageOnPort: function (port) {
      if (!port || !port._q || port._q.length === 0) return undefined;
      return { message: port._q.shift() };
    },
    markAsUntransferable: function () {},
    isMarkedAsUntransferable: function () {
      return false;
    },
    getEnvironmentData: function () {
      return undefined;
    },
    setEnvironmentData: function () {}
  };
};

BF['cluster'] = function () {
  var EE = cpEE();
  var cluster = Object.create(EE.prototype);
  EE.call(cluster);
  var Child = cpChildClass();
  var isWorker = cpState.kind === 'cluster';
  var nextId = 1;
  cluster.isWorker = isWorker;
  cluster.isPrimary = !isWorker;
  cluster.isMaster = !isWorker;
  cluster.workers = {};
  cluster.settings = {};
  cluster.schedulingPolicy = 2;
  cluster.SCHED_NONE = 1;
  cluster.SCHED_RR = 2;
  cluster.worker = undefined;
  cluster.setupPrimary = function (settings) {
    Object.assign(cluster.settings, settings || {});
  };
  cluster.setupMaster = cluster.setupPrimary;
  cluster.fork = function (env) {
    var id = nextId++;
    var workerEnv = {};
    Object.keys(proc.env).forEach(function (key) {
      workerEnv[key] = proc.env[key];
    });
    if (env && typeof env === 'object') {
      Object.keys(env).forEach(function (key) {
        workerEnv[key] = String(env[key]);
      });
    }
    workerEnv.NODE_UNIQUE_ID = String(id);
    var worker = new Child();
    worker.id = id;
    worker.process = worker;
    worker.exitedAfterDisconnect = false;
    worker.isDead = function () {
      return worker._cpExited === true;
    };
    worker.isConnected = function () {
      return worker.connected;
    };
    worker.disconnect = function () {
      worker.exitedAfterDisconnect = true;
      cpDisconnectChild(worker);
    };
    cluster.workers[id] = worker;
    cpSpawnCore(worker, 'node', [proc.argv[1]].concat(proc.argv.slice(2)), {
      env: workerEnv,
      stdio: ['inherit', 'inherit', 'inherit']
    }, { kind: 'cluster', cluster: cluster, ipc: true, ipcKind: 'cluster', ipcData: { id: id } });
    cluster.emit('fork', worker);
    return worker;
  };
  cluster.disconnect = function (callback) {
    Object.keys(cluster.workers).forEach(function (id) {
      cluster.workers[id].disconnect();
    });
    if (typeof callback === 'function') proc.nextTick(callback);
  };
  cluster.on('exit', function (worker) {
    delete cluster.workers[worker.id];
  });
  if (isWorker) {
    cluster.worker = {
      id: Number(cpState.data.id),
      process: proc,
      send: function (message, callback) {
        return proc.send(message, callback);
      },
      disconnect: function () {
        proc.disconnect();
      },
      isConnected: function () {
        return cpState.connected;
      },
      isDead: function () {
        return false;
      }
    };
  }
  return cluster;
};

(function cpBootChild() {
  var env = proc.env;
  if (!env || env.OWC_IPC_KIND === undefined) return;
  cpState.kind = String(env.OWC_IPC_KIND);
  cpState.data = JSON.parse(env.OWC_IPC_DATA || '{}');
  delete env.OWC_IPC_KIND;
  delete env.OWC_IPC_DATA;
  if (cpState.kind === 'cluster') delete env.NODE_UNIQUE_ID;
  cpState.connected = true;
  cpState.target = createTarget(cpOnFrame);
  if (cpState.kind === 'worker') {
    var Port = cpPortClass();
    cpState.port = new Port();
    cpState.port._remote = function (encoded) {
      callCap('child.sendToParent', { frame: { t: 'm', v: encoded } });
    };
    cpWireWorkerErrors();
  } else {
    cpWireProcess();
  }
  callCap('child.ipcAttach', {
    targetId: cpState.target,
    token: cpState.data.token === undefined ? null : cpState.data.token
  });
})();
`;
