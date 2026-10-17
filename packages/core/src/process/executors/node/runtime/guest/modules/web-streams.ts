/**
 * Guest-side Web Streams: ReadableStream (default and byte streams, with a BYOB reader), WritableStream,
 * TransformStream, their readers, writers and controllers, the queuing strategies, TextEncoderStream and
 * TextDecoderStream, the stream/web built-in and the matching globals. Plain JavaScript inside a String.raw
 * snippet, wrapped in one IIFE. The algorithms follow the WHATWG Streams standard; internal slots live in a
 * WeakMap so they do not show on the instances. Two simplifications, both listed in Readme.md: byte streams copy
 * chunks instead of transferring their buffers, and controller.byobRequest is null.
 */
export const SRC = String.raw`
(function () {
  var SLOTS = new WeakMap();
  var CREATE = {};
  var CLOSE_SENTINEL = {};

  function isObject(value) {
    return value !== null && (typeof value === 'object' || typeof value === 'function');
  }
  function slotsOf(obj, kind) {
    var slots = isObject(obj) ? SLOTS.get(obj) : undefined;
    if (slots === undefined || slots.kind !== kind) throw new TypeError('Illegal invocation');
    return slots;
  }
  function requireCreate(token) {
    if (token !== CREATE) throw new TypeError('Illegal constructor');
  }
  function deferred() {
    var d = {};
    d.promise = new Promise(function (resolve, reject) {
      d.resolve = resolve;
      d.reject = reject;
    });
    return d;
  }
  function handled(promise) {
    promise.then(undefined, function () {});
    return promise;
  }
  function attempt(fn, args) {
    try {
      return Promise.resolve(fn.apply(undefined, args));
    } catch (error) {
      return Promise.reject(error);
    }
  }
  function invoke(target, method, args) {
    try {
      return Promise.resolve(method.apply(target, args));
    } catch (error) {
      return Promise.reject(error);
    }
  }
  function highWaterMarkOf(strategy, fallback) {
    if (strategy.highWaterMark === undefined) return fallback;
    var number = Number(strategy.highWaterMark);
    if (number !== number || number < 0) throw new RangeError('Invalid highWaterMark');
    return number;
  }
  function sizeOf(strategy) {
    var size = strategy.size;
    if (size === undefined) return function () { return 1; };
    if (typeof size !== 'function') throw new TypeError('The size option must be a function');
    return function (chunk) { return size(chunk); };
  }
  function strategyOf(strategy) {
    if (strategy === undefined) return {};
    if (!isObject(strategy)) throw new TypeError('The strategy argument must be an object');
    return strategy;
  }
  function sourceOf(source) {
    if (source === undefined || source === null) return null;
    if (!isObject(source)) throw new TypeError('The underlying source must be an object');
    return source;
  }
  function methodOf(source, name) {
    if (source === null) return undefined;
    var method = source[name];
    if (method !== undefined && typeof method !== 'function') throw new TypeError(name + ' must be a function');
    return method;
  }

  function queueWithSize(container, value, size) {
    if (typeof size !== 'number' || size !== size || size === Infinity || size < 0) throw new RangeError('Invalid chunk size');
    container.queue.push({ value: value, size: size });
    container.queueTotalSize += size;
  }
  function dequeue(container) {
    var entry = container.queue.shift();
    container.queueTotalSize -= entry.size;
    if (container.queueTotalSize < 0) container.queueTotalSize = 0;
    return entry.value;
  }
  function resetQueue(container) {
    container.queue = [];
    container.queueTotalSize = 0;
  }
  function rebuildView(view, byteCount) {
    if (view instanceof DataView) return new DataView(view.buffer, view.byteOffset, byteCount);
    return new view.constructor(view.buffer, view.byteOffset, Math.floor(byteCount / view.BYTES_PER_ELEMENT));
  }

  function readableState(stream) {
    return slotsOf(stream, 'ReadableStream');
  }
  function writableState(stream) {
    return slotsOf(stream, 'WritableStream');
  }
  function isLocked(stream) {
    return readableState(stream).reader !== undefined;
  }
  function pendingReadCount(stream) {
    var reader = readableState(stream).reader;
    return reader === undefined ? 0 : SLOTS.get(reader).requests.length;
  }
  function isByteStream(stream) {
    var controller = readableState(stream).controller;
    return controller !== undefined && SLOTS.get(controller).kind === 'ReadableByteStreamController';
  }

  /* ---- readable side: state transitions ---- */
  function readableClose(stream) {
    var s = readableState(stream);
    s.state = 'closed';
    if (s.reader === undefined) return;
    var r = SLOTS.get(s.reader);
    r.closed.resolve(undefined);
    var requests = r.requests;
    r.requests = [];
    for (var i = 0; i < requests.length; i++) {
      if (r.kind === 'ReadableStreamBYOBReader') requests[i].resolve({ value: rebuildView(requests[i].view, 0), done: true });
      else requests[i].resolve({ value: undefined, done: true });
    }
  }
  function readableError(stream, error) {
    var s = readableState(stream);
    if (s.state !== 'readable') return;
    s.state = 'errored';
    s.storedError = error;
    if (s.reader === undefined) return;
    var r = SLOTS.get(s.reader);
    handled(r.closed.promise);
    r.closed.reject(error);
    var requests = r.requests;
    r.requests = [];
    for (var i = 0; i < requests.length; i++) requests[i].reject(error);
  }
  function readableCancel(stream, reason) {
    var s = readableState(stream);
    s.disturbed = true;
    if (s.state === 'closed') return Promise.resolve(undefined);
    if (s.state === 'errored') return Promise.reject(s.storedError);
    readableClose(stream);
    return SLOTS.get(s.controller).cancelSteps(reason).then(function () {});
  }
  function readableRead(stream, request) {
    var s = readableState(stream);
    s.disturbed = true;
    if (s.state === 'closed') request.resolve({ value: undefined, done: true });
    else if (s.state === 'errored') request.reject(s.storedError);
    else SLOTS.get(s.controller).pullSteps(request);
  }

  /* ---- readers ---- */
  function attachReader(reader, stream) {
    var s = readableState(stream);
    if (s.reader !== undefined) throw new TypeError('ReadableStream is locked');
    var r = SLOTS.get(reader);
    r.stream = stream;
    r.closed = deferred();
    s.reader = reader;
    if (s.state === 'closed') {
      r.closed.resolve(undefined);
    } else if (s.state === 'errored') {
      handled(r.closed.promise);
      r.closed.reject(s.storedError);
    }
  }
  function detachReader(reader) {
    var r = SLOTS.get(reader);
    var s = readableState(r.stream);
    var error = new TypeError('Reader was released');
    if (s.state !== 'readable') r.closed = deferred();
    handled(r.closed.promise);
    r.closed.reject(error);
    var requests = r.requests;
    r.requests = [];
    for (var i = 0; i < requests.length; i++) requests[i].reject(error);
    r.stream = undefined;
    s.reader = undefined;
  }
  function byobRead(reader, view, request) {
    var r = SLOTS.get(reader);
    var stream = r.stream;
    var s = readableState(stream);
    s.disturbed = true;
    if (s.state === 'errored') {
      request.reject(s.storedError);
      return;
    }
    var cs = SLOTS.get(s.controller);
    if (cs.queue.length > 0) {
      var target = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      var written = 0;
      while (written < target.byteLength && cs.queue.length > 0) {
        var head = cs.queue[0];
        var take = Math.min(head.value.byteLength, target.byteLength - written);
        target.set(head.value.subarray(0, take), written);
        written += take;
        if (take === head.value.byteLength) {
          dequeue(cs);
        } else {
          head.value = head.value.subarray(take);
          head.size -= take;
          cs.queueTotalSize -= take;
        }
      }
      var filled = rebuildView(view, written);
      if (cs.closeRequested && cs.queue.length === 0) {
        cs.cancelAlgorithm = undefined;
        cs.pullAlgorithm = undefined;
        readableClose(stream);
      } else {
        callPullIfNeeded(cs);
      }
      request.resolve({ value: filled, done: false });
      return;
    }
    if (s.state === 'closed') {
      request.resolve({ value: rebuildView(view, 0), done: true });
      return;
    }
    r.requests.push({ view: view, resolve: request.resolve, reject: request.reject });
    callPullIfNeeded(cs);
  }

  /* ---- readable controllers ---- */
  function desiredSizeOf(cs) {
    var state = readableState(cs.stream).state;
    if (state === 'errored') return null;
    if (state === 'closed') return 0;
    return cs.highWaterMark - cs.queueTotalSize;
  }
  function canCloseOrEnqueue(cs) {
    return readableState(cs.stream).state === 'readable' && !cs.closeRequested;
  }
  function clearAlgorithms(cs) {
    cs.pullAlgorithm = undefined;
    cs.cancelAlgorithm = undefined;
    cs.sizeAlgorithm = undefined;
  }
  function shouldCallPull(cs) {
    if (!canCloseOrEnqueue(cs) || !cs.started) return false;
    if (pendingReadCount(cs.stream) > 0) return true;
    return desiredSizeOf(cs) > 0;
  }
  function callPullIfNeeded(cs) {
    if (!shouldCallPull(cs)) return;
    if (cs.pulling) {
      cs.pullAgain = true;
      return;
    }
    cs.pulling = true;
    cs.pullAlgorithm().then(function () {
      cs.pulling = false;
      if (cs.pullAgain) {
        cs.pullAgain = false;
        callPullIfNeeded(cs);
      }
    }, function (error) {
      readableControllerError(cs, error);
    });
  }
  function readableControllerError(cs, error) {
    if (readableState(cs.stream).state !== 'readable') return;
    resetQueue(cs);
    clearAlgorithms(cs);
    readableError(cs.stream, error);
  }
  function defaultPullSteps(cs, request) {
    var stream = cs.stream;
    if (cs.queue.length > 0) {
      var chunk = dequeue(cs);
      if (cs.closeRequested && cs.queue.length === 0) {
        clearAlgorithms(cs);
        readableClose(stream);
      } else {
        callPullIfNeeded(cs);
      }
      request.resolve({ value: chunk, done: false });
      return;
    }
    SLOTS.get(readableState(stream).reader).requests.push(request);
    callPullIfNeeded(cs);
  }
  function defaultCancelSteps(cs, reason) {
    resetQueue(cs);
    var result = cs.cancelAlgorithm(reason);
    clearAlgorithms(cs);
    return result;
  }
  function defaultEnqueue(cs, chunk) {
    if (!canCloseOrEnqueue(cs)) throw new TypeError('Invalid state: Controller is already closed');
    if (pendingReadCount(cs.stream) > 0) {
      var request = SLOTS.get(readableState(cs.stream).reader).requests.shift();
      request.resolve({ value: chunk, done: false });
    } else {
      try {
        queueWithSize(cs, chunk, cs.sizeAlgorithm(chunk));
      } catch (error) {
        readableControllerError(cs, error);
        throw error;
      }
    }
    callPullIfNeeded(cs);
  }
  function byteEnqueue(cs, chunk) {
    if (!canCloseOrEnqueue(cs)) throw new TypeError('Invalid state: Controller is already closed');
    if (!ArrayBuffer.isView(chunk)) throw new TypeError('chunk must be an ArrayBuffer view');
    if (chunk.byteLength === 0) throw new TypeError('chunk must have a non-zero byteLength');
    var bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength).slice();
    if (pendingReadCount(cs.stream) > 0) {
      var requests = SLOTS.get(readableState(cs.stream).reader).requests;
      var request = requests.shift();
      if (request.view === undefined) {
        request.resolve({ value: bytes, done: false });
      } else {
        var target = new Uint8Array(request.view.buffer, request.view.byteOffset, request.view.byteLength);
        var count = Math.min(target.byteLength, bytes.byteLength);
        target.set(bytes.subarray(0, count), 0);
        if (count < bytes.byteLength) {
          var rest = bytes.subarray(count);
          cs.queue.unshift({ value: rest, size: rest.byteLength });
          cs.queueTotalSize += rest.byteLength;
        }
        request.resolve({ value: rebuildView(request.view, count), done: false });
      }
    } else {
      queueWithSize(cs, bytes, bytes.byteLength);
    }
    callPullIfNeeded(cs);
  }
  function defaultClose(cs) {
    if (!canCloseOrEnqueue(cs)) throw new TypeError('Invalid state: Controller is already closed');
    cs.closeRequested = true;
    if (cs.queue.length === 0) {
      clearAlgorithms(cs);
      readableClose(cs.stream);
    }
  }
  function setupReadableController(kind, stream, source, start, pull, cancel, highWaterMark, sizeAlgorithm, controller) {
    var cs = {
      kind: kind,
      stream: stream,
      queue: [],
      queueTotalSize: 0,
      started: false,
      closeRequested: false,
      pulling: false,
      pullAgain: false,
      highWaterMark: highWaterMark,
      sizeAlgorithm: sizeAlgorithm
    };
    SLOTS.set(controller, cs);
    cs.pullAlgorithm = function () {
      return pull === undefined ? Promise.resolve(undefined) : invoke(source, pull, [controller]);
    };
    cs.cancelAlgorithm = function (reason) {
      return cancel === undefined ? Promise.resolve(undefined) : invoke(source, cancel, [reason]);
    };
    cs.pullSteps = function (request) {
      defaultPullSteps(cs, request);
    };
    cs.cancelSteps = function (reason) {
      return defaultCancelSteps(cs, reason);
    };
    readableState(stream).controller = controller;
    var startResult = start === undefined ? undefined : start.call(source, controller);
    Promise.resolve(startResult).then(function () {
      cs.started = true;
      callPullIfNeeded(cs);
    }, function (error) {
      readableControllerError(cs, error);
    });
  }

  /* ---- ReadableStream and its readers ---- */
  class ReadableStreamDefaultController {
    constructor(token) {
      requireCreate(token);
    }
    get desiredSize() {
      return desiredSizeOf(slotsOf(this, 'ReadableStreamDefaultController'));
    }
    close() {
      defaultClose(slotsOf(this, 'ReadableStreamDefaultController'));
    }
    enqueue(chunk) {
      defaultEnqueue(slotsOf(this, 'ReadableStreamDefaultController'), chunk);
    }
    error(error) {
      readableControllerError(slotsOf(this, 'ReadableStreamDefaultController'), error);
    }
  }

  class ReadableByteStreamController {
    constructor(token) {
      requireCreate(token);
    }
    get byobRequest() {
      slotsOf(this, 'ReadableByteStreamController');
      return null;
    }
    get desiredSize() {
      return desiredSizeOf(slotsOf(this, 'ReadableByteStreamController'));
    }
    close() {
      defaultClose(slotsOf(this, 'ReadableByteStreamController'));
    }
    enqueue(chunk) {
      byteEnqueue(slotsOf(this, 'ReadableByteStreamController'), chunk);
    }
    error(error) {
      readableControllerError(slotsOf(this, 'ReadableByteStreamController'), error);
    }
  }

  class ReadableStreamBYOBRequest {
    constructor(token) {
      requireCreate(token);
    }
  }

  class ReadableStreamDefaultReader {
    constructor(stream) {
      if (!(stream instanceof ReadableStream)) throw new TypeError('stream must be a ReadableStream');
      SLOTS.set(this, { kind: 'ReadableStreamDefaultReader', stream: undefined, closed: undefined, requests: [] });
      attachReader(this, stream);
    }
    get closed() {
      return slotsOf(this, 'ReadableStreamDefaultReader').closed.promise;
    }
    cancel(reason) {
      var r = slotsOf(this, 'ReadableStreamDefaultReader');
      if (r.stream === undefined) return Promise.reject(new TypeError('Reader was released'));
      return readableCancel(r.stream, reason);
    }
    read() {
      var r = slotsOf(this, 'ReadableStreamDefaultReader');
      if (r.stream === undefined) return Promise.reject(new TypeError('Reader was released'));
      var request = deferred();
      readableRead(r.stream, request);
      return request.promise;
    }
    releaseLock() {
      var r = slotsOf(this, 'ReadableStreamDefaultReader');
      if (r.stream !== undefined) detachReader(this);
    }
  }

  class ReadableStreamBYOBReader {
    constructor(stream) {
      if (!(stream instanceof ReadableStream)) throw new TypeError('stream must be a ReadableStream');
      if (!isByteStream(stream)) throw new TypeError('Cannot use a BYOB reader with a non-byte stream');
      SLOTS.set(this, { kind: 'ReadableStreamBYOBReader', stream: undefined, closed: undefined, requests: [] });
      attachReader(this, stream);
    }
    get closed() {
      return slotsOf(this, 'ReadableStreamBYOBReader').closed.promise;
    }
    cancel(reason) {
      var r = slotsOf(this, 'ReadableStreamBYOBReader');
      if (r.stream === undefined) return Promise.reject(new TypeError('Reader was released'));
      return readableCancel(r.stream, reason);
    }
    read(view) {
      var r = slotsOf(this, 'ReadableStreamBYOBReader');
      if (!ArrayBuffer.isView(view)) return Promise.reject(new TypeError('view must be an ArrayBuffer view'));
      if (view.byteLength === 0) return Promise.reject(new TypeError('view must have a non-zero byteLength'));
      if (r.stream === undefined) return Promise.reject(new TypeError('Reader was released'));
      var request = deferred();
      byobRead(this, view, request);
      return request.promise;
    }
    releaseLock() {
      var r = slotsOf(this, 'ReadableStreamBYOBReader');
      if (r.stream !== undefined) detachReader(this);
    }
  }

  function asyncIteratorOf(reader, preventCancel) {
    var finished = false;
    var iterator = {
      next: function () {
        if (finished) return Promise.resolve({ value: undefined, done: true });
        return reader.read().then(function (step) {
          if (step.done) {
            finished = true;
            reader.releaseLock();
            return { value: undefined, done: true };
          }
          return { value: step.value, done: false };
        }, function (error) {
          finished = true;
          reader.releaseLock();
          throw error;
        });
      },
      return: function (value) {
        if (finished) return Promise.resolve({ value: value, done: true });
        finished = true;
        if (preventCancel) {
          reader.releaseLock();
          return Promise.resolve({ value: value, done: true });
        }
        return reader.cancel(value).then(function () {
          reader.releaseLock();
          return { value: value, done: true };
        }, function (error) {
          reader.releaseLock();
          throw error;
        });
      }
    };
    iterator[Symbol.asyncIterator] = function () {
      return this;
    };
    return iterator;
  }

  function pipeOptions(options) {
    var opts = options === undefined ? {} : options;
    if (!isObject(opts)) throw new TypeError('options must be an object');
    if (opts.signal !== undefined && (opts.signal === null || typeof opts.signal.addEventListener !== 'function')) {
      throw new TypeError('signal must be an AbortSignal');
    }
    return {
      preventClose: !!opts.preventClose,
      preventAbort: !!opts.preventAbort,
      preventCancel: !!opts.preventCancel,
      signal: opts.signal
    };
  }

  function readableFrom(asyncIterable) {
    var iterator;
    var isAsync = false;
    if (asyncIterable !== null && asyncIterable !== undefined && typeof asyncIterable[Symbol.asyncIterator] === 'function') {
      iterator = asyncIterable[Symbol.asyncIterator]();
      isAsync = true;
    } else if (asyncIterable !== null && asyncIterable !== undefined && typeof asyncIterable[Symbol.iterator] === 'function') {
      iterator = asyncIterable[Symbol.iterator]();
    } else {
      throw new TypeError('The argument must be an iterable or an async iterable');
    }
    return new ReadableStream({
      pull: function (controller) {
        return Promise.resolve(iterator.next()).then(function (step) {
          if (step.done) {
            controller.close();
            return undefined;
          }
          if (isAsync) {
            controller.enqueue(step.value);
            return undefined;
          }
          return Promise.resolve(step.value).then(function (chunk) {
            controller.enqueue(chunk);
          });
        });
      },
      cancel: function (reason) {
        if (typeof iterator.return !== 'function') return undefined;
        return Promise.resolve(iterator.return(reason)).then(function () {});
      }
    }, { highWaterMark: 0 });
  }

  function teeReadable(stream) {
    var reader = new ReadableStreamDefaultReader(stream);
    var reading = false;
    var readAgain = false;
    var canceled1 = false;
    var canceled2 = false;
    var reason1;
    var reason2;
    var cancelResult = deferred();
    var controller1;
    var controller2;
    function pull() {
      if (reading) {
        readAgain = true;
        return Promise.resolve(undefined);
      }
      reading = true;
      reader.read().then(function (step) {
        if (step.done) {
          reading = false;
          if (!canceled1) controller1.close();
          if (!canceled2) controller2.close();
          if (!canceled1 || !canceled2) cancelResult.resolve(undefined);
          return;
        }
        Promise.resolve(undefined).then(function () {
          readAgain = false;
          if (!canceled1) controller1.enqueue(step.value);
          if (!canceled2) controller2.enqueue(step.value);
          reading = false;
          if (readAgain) pull();
        });
      }, function () {
        reading = false;
      });
      return Promise.resolve(undefined);
    }
    reader.closed.then(undefined, function (error) {
      controller1.error(error);
      controller2.error(error);
      if (!canceled1 || !canceled2) cancelResult.resolve(undefined);
    });
    var branch1 = new ReadableStream({
      start: function (c) {
        controller1 = c;
      },
      pull: function () {
        return pull();
      },
      cancel: function (reason) {
        canceled1 = true;
        reason1 = reason;
        if (canceled2) cancelResult.resolve(readableCancel(stream, [reason1, reason2]));
        return cancelResult.promise;
      }
    });
    var branch2 = new ReadableStream({
      start: function (c) {
        controller2 = c;
      },
      pull: function () {
        return pull();
      },
      cancel: function (reason) {
        canceled2 = true;
        reason2 = reason;
        if (canceled1) cancelResult.resolve(readableCancel(stream, [reason1, reason2]));
        return cancelResult.promise;
      }
    });
    return [branch1, branch2];
  }

  class ReadableStream {
    constructor(underlyingSource, strategy) {
      var source = sourceOf(underlyingSource);
      var options = strategyOf(strategy);
      var type = source === null ? undefined : source.type;
      var start = methodOf(source, 'start');
      var pull = methodOf(source, 'pull');
      var cancel = methodOf(source, 'cancel');
      SLOTS.set(this, { kind: 'ReadableStream', state: 'readable', storedError: undefined, reader: undefined, controller: undefined, disturbed: false });
      if (type === undefined) {
        var highWaterMark = highWaterMarkOf(options, 1);
        var size = sizeOf(options);
        setupReadableController('ReadableStreamDefaultController', this, source, start, pull, cancel, highWaterMark, size, new ReadableStreamDefaultController(CREATE));
      } else if (String(type) === 'bytes') {
        if (options.size !== undefined) throw new RangeError('A byte stream does not take a size option');
        var byteHighWaterMark = highWaterMarkOf(options, 0);
        setupReadableController('ReadableByteStreamController', this, source, start, pull, cancel, byteHighWaterMark, null, new ReadableByteStreamController(CREATE));
      } else {
        throw new RangeError('Invalid type is specified');
      }
    }
    get locked() {
      return isLocked(this);
    }
    cancel(reason) {
      if (isLocked(this)) return Promise.reject(new TypeError('Cannot cancel a locked ReadableStream'));
      return readableCancel(this, reason);
    }
    getReader(options) {
      var mode = options === undefined || options === null ? undefined : options.mode;
      if (mode === undefined) return new ReadableStreamDefaultReader(this);
      if (String(mode) === 'byob') return new ReadableStreamBYOBReader(this);
      throw new RangeError('Invalid mode is specified');
    }
    pipeThrough(transform, options) {
      if (!isObject(transform) || !isObject(transform.writable) || !isObject(transform.readable)) {
        throw new TypeError('transform must have readable and writable streams');
      }
      if (isLocked(this)) throw new TypeError('ReadableStream is locked');
      if (transform.writable.locked) throw new TypeError('WritableStream is locked');
      var opts = pipeOptions(options);
      handled(pipeReadableTo(this, transform.writable, opts));
      return transform.readable;
    }
    pipeTo(destination, options) {
      if (!(destination instanceof WritableStream)) return Promise.reject(new TypeError('destination must be a WritableStream'));
      if (isLocked(this)) return Promise.reject(new TypeError('ReadableStream is locked'));
      if (destination.locked) return Promise.reject(new TypeError('WritableStream is locked'));
      var opts;
      try {
        opts = pipeOptions(options);
      } catch (error) {
        return Promise.reject(error);
      }
      return pipeReadableTo(this, destination, opts);
    }
    tee() {
      return teeReadable(this);
    }
    values(options) {
      var preventCancel = options !== undefined && options !== null && !!options.preventCancel;
      return asyncIteratorOf(new ReadableStreamDefaultReader(this), preventCancel);
    }
    static from(asyncIterable) {
      return readableFrom(asyncIterable);
    }
  }
  Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, {
    value: ReadableStream.prototype.values,
    writable: true,
    configurable: true
  });

  /* ---- writable side ---- */
  function closeQueuedOrInFlight(s) {
    return s.closeRequest !== undefined || s.inFlightClose !== undefined;
  }
  function desiredWritable(cs) {
    return cs.highWaterMark - cs.queueTotalSize;
  }
  function updateBackpressure(stream, backpressure) {
    var s = writableState(stream);
    if (s.writer !== undefined) {
      var w = SLOTS.get(s.writer);
      if (backpressure) {
        if (w.readyDone) {
          w.ready = deferred();
          w.readyDone = false;
        }
      } else if (!w.readyDone) {
        w.ready.resolve(undefined);
        w.readyDone = true;
      }
    }
    s.backpressure = backpressure;
  }
  function ensureReadyRejected(w, error) {
    if (w.readyDone) w.ready = deferred();
    handled(w.ready.promise);
    w.ready.reject(error);
    w.readyDone = true;
  }
  function ensureClosedRejected(w, error) {
    if (w.closedDone) w.closed = deferred();
    handled(w.closed.promise);
    w.closed.reject(error);
    w.closedDone = true;
  }
  function attachWriter(writer, stream) {
    var s = writableState(stream);
    if (s.writer !== undefined) throw new TypeError('WritableStream is locked');
    var w = SLOTS.get(writer);
    w.stream = stream;
    w.ready = deferred();
    w.readyDone = false;
    w.closed = deferred();
    w.closedDone = false;
    s.writer = writer;
    if (s.state === 'writable') {
      if (!closeQueuedOrInFlight(s) && s.backpressure) return;
      w.ready.resolve(undefined);
      w.readyDone = true;
    } else if (s.state === 'erroring') {
      ensureReadyRejected(w, s.storedError);
    } else if (s.state === 'closed') {
      w.ready.resolve(undefined);
      w.readyDone = true;
      w.closed.resolve(undefined);
      w.closedDone = true;
    } else {
      ensureReadyRejected(w, s.storedError);
      ensureClosedRejected(w, s.storedError);
    }
  }
  function releaseWriter(writer) {
    var w = SLOTS.get(writer);
    var s = writableState(w.stream);
    var error = new TypeError('Writer was released');
    ensureReadyRejected(w, error);
    ensureClosedRejected(w, error);
    s.writer = undefined;
    w.stream = undefined;
  }
  function rejectCloseAndClosedIfNeeded(stream) {
    var s = writableState(stream);
    if (s.state !== 'errored') return;
    if (s.closeRequest !== undefined) {
      s.closeRequest.reject(s.storedError);
      s.closeRequest = undefined;
    }
    if (s.writer !== undefined) ensureClosedRejected(SLOTS.get(s.writer), s.storedError);
  }
  function finishErroring(stream) {
    var s = writableState(stream);
    s.state = 'errored';
    resetQueue(SLOTS.get(s.controller));
    var storedError = s.storedError;
    var requests = s.writeRequests;
    s.writeRequests = [];
    for (var i = 0; i < requests.length; i++) requests[i].reject(storedError);
    var pending = s.pendingAbort;
    if (pending === undefined) {
      rejectCloseAndClosedIfNeeded(stream);
      return;
    }
    s.pendingAbort = undefined;
    if (pending.wasAlreadyErroring) {
      pending.deferred.reject(storedError);
      rejectCloseAndClosedIfNeeded(stream);
      return;
    }
    attempt(SLOTS.get(s.controller).abortAlgorithm, [pending.reason]).then(function () {
      pending.deferred.resolve(undefined);
      rejectCloseAndClosedIfNeeded(stream);
    }, function (error) {
      pending.deferred.reject(error);
      rejectCloseAndClosedIfNeeded(stream);
    });
  }
  function startErroring(stream, reason) {
    var s = writableState(stream);
    s.state = 'erroring';
    s.storedError = reason;
    if (s.writer !== undefined) ensureReadyRejected(SLOTS.get(s.writer), reason);
    if (s.inFlightWrite === undefined && s.inFlightClose === undefined && SLOTS.get(s.controller).started) finishErroring(stream);
  }
  function dealWithRejection(stream, error) {
    if (writableState(stream).state === 'writable') {
      startErroring(stream, error);
      return;
    }
    finishErroring(stream);
  }
  function writableControllerError(cs, error) {
    cs.writeAlgorithm = undefined;
    cs.closeAlgorithm = undefined;
    cs.sizeAlgorithm = undefined;
    startErroring(cs.stream, error);
  }
  function controllerErrorIfNeeded(cs, error) {
    if (writableState(cs.stream).state === 'writable') writableControllerError(cs, error);
  }
  function processWrite(cs, chunk) {
    var stream = cs.stream;
    var s = writableState(stream);
    var request = s.writeRequests.shift();
    s.inFlightWrite = request;
    attempt(cs.writeAlgorithm, [chunk]).then(function () {
      s.inFlightWrite = undefined;
      request.resolve(undefined);
      dequeue(cs);
      if (!closeQueuedOrInFlight(s) && s.state === 'writable') updateBackpressure(stream, desiredWritable(cs) <= 0);
      advanceQueue(cs);
    }, function (error) {
      s.inFlightWrite = undefined;
      request.reject(error);
      dealWithRejection(stream, error);
    });
  }
  function processClose(cs) {
    var stream = cs.stream;
    var s = writableState(stream);
    s.inFlightClose = s.closeRequest;
    s.closeRequest = undefined;
    dequeue(cs);
    var closing = attempt(cs.closeAlgorithm, []);
    cs.writeAlgorithm = undefined;
    cs.closeAlgorithm = undefined;
    cs.sizeAlgorithm = undefined;
    closing.then(function () {
      var request = s.inFlightClose;
      s.inFlightClose = undefined;
      request.resolve(undefined);
      if (s.state === 'erroring') {
        s.storedError = undefined;
        if (s.pendingAbort !== undefined) {
          s.pendingAbort.deferred.resolve(undefined);
          s.pendingAbort = undefined;
        }
      }
      s.state = 'closed';
      if (s.writer !== undefined) {
        var w = SLOTS.get(s.writer);
        if (!w.closedDone) {
          w.closed.resolve(undefined);
          w.closedDone = true;
        }
      }
    }, function (error) {
      var request = s.inFlightClose;
      s.inFlightClose = undefined;
      request.reject(error);
      if (s.pendingAbort !== undefined) {
        s.pendingAbort.deferred.reject(error);
        s.pendingAbort = undefined;
      }
      dealWithRejection(stream, error);
    });
  }
  function advanceQueue(cs) {
    if (!cs.started) return;
    var stream = cs.stream;
    var s = writableState(stream);
    if (s.inFlightWrite !== undefined) return;
    if (s.state === 'errored') return;
    if (s.state === 'erroring') {
      finishErroring(stream);
      return;
    }
    if (cs.queue.length === 0) return;
    var value = cs.queue[0].value;
    if (value === CLOSE_SENTINEL) processClose(cs);
    else processWrite(cs, value);
  }
  function controllerWrite(cs, chunk, size) {
    try {
      queueWithSize(cs, chunk, size);
    } catch (error) {
      controllerErrorIfNeeded(cs, error);
      return;
    }
    var s = writableState(cs.stream);
    if (!closeQueuedOrInFlight(s) && s.state === 'writable') updateBackpressure(cs.stream, desiredWritable(cs) <= 0);
    advanceQueue(cs);
  }
  function writerWrite(stream, chunk) {
    var s = writableState(stream);
    if (s.state === 'errored' || s.state === 'erroring') return Promise.reject(s.storedError);
    if (closeQueuedOrInFlight(s) || s.state === 'closed') return Promise.reject(new TypeError('Cannot write to a closing or closed stream'));
    var cs = SLOTS.get(s.controller);
    var chunkSize;
    try {
      chunkSize = cs.sizeAlgorithm(chunk);
    } catch (error) {
      controllerErrorIfNeeded(cs, error);
      return Promise.reject(error);
    }
    var request = deferred();
    s.writeRequests.push(request);
    controllerWrite(cs, chunk, chunkSize);
    return request.promise;
  }
  function writableClose(stream) {
    var s = writableState(stream);
    var request = deferred();
    s.closeRequest = request;
    if (s.backpressure && s.state === 'writable' && s.writer !== undefined) {
      var w = SLOTS.get(s.writer);
      if (!w.readyDone) {
        w.ready.resolve(undefined);
        w.readyDone = true;
      }
    }
    var cs = SLOTS.get(s.controller);
    cs.queue.push({ value: CLOSE_SENTINEL, size: 0 });
    advanceQueue(cs);
    return request.promise;
  }
  function writableAbort(stream, reason) {
    var s = writableState(stream);
    if (s.state === 'closed' || s.state === 'errored') return Promise.resolve(undefined);
    var cs = SLOTS.get(s.controller);
    if (cs.abortController !== undefined) cs.abortController.abort(reason);
    if (s.pendingAbort !== undefined) return s.pendingAbort.deferred.promise;
    var wasAlreadyErroring = s.state === 'erroring';
    var request = { reason: wasAlreadyErroring ? undefined : reason, wasAlreadyErroring: wasAlreadyErroring, deferred: deferred() };
    s.pendingAbort = request;
    if (!wasAlreadyErroring) startErroring(stream, reason);
    return request.deferred.promise;
  }
  function setupWritableController(stream, sink, start, write, close, abort, highWaterMark, size) {
    var controller = new WritableStreamDefaultController(CREATE);
    var cs = {
      kind: 'WritableStreamDefaultController',
      stream: stream,
      queue: [],
      queueTotalSize: 0,
      started: false,
      highWaterMark: highWaterMark,
      sizeAlgorithm: size,
      abortController: new AbortController()
    };
    SLOTS.set(controller, cs);
    cs.writeAlgorithm = function (chunk) {
      return write === undefined ? Promise.resolve(undefined) : invoke(sink, write, [chunk, controller]);
    };
    cs.closeAlgorithm = function () {
      return close === undefined ? Promise.resolve(undefined) : invoke(sink, close, []);
    };
    cs.abortAlgorithm = function (reason) {
      return abort === undefined ? Promise.resolve(undefined) : invoke(sink, abort, [reason]);
    };
    writableState(stream).controller = controller;
    updateBackpressure(stream, desiredWritable(cs) <= 0);
    var startResult = start === undefined ? undefined : start.call(sink, controller);
    Promise.resolve(startResult).then(function () {
      cs.started = true;
      advanceQueue(cs);
    }, function (error) {
      writableControllerError(cs, error);
    });
  }

  class WritableStreamDefaultController {
    constructor(token) {
      requireCreate(token);
    }
    get signal() {
      return slotsOf(this, 'WritableStreamDefaultController').abortController.signal;
    }
    error(error) {
      var cs = slotsOf(this, 'WritableStreamDefaultController');
      if (writableState(cs.stream).state === 'writable') writableControllerError(cs, error);
    }
  }

  class WritableStreamDefaultWriter {
    constructor(stream) {
      if (!(stream instanceof WritableStream)) throw new TypeError('stream must be a WritableStream');
      SLOTS.set(this, { kind: 'WritableStreamDefaultWriter', stream: undefined, ready: undefined, readyDone: false, closed: undefined, closedDone: false });
      attachWriter(this, stream);
    }
    get closed() {
      return slotsOf(this, 'WritableStreamDefaultWriter').closed.promise;
    }
    get desiredSize() {
      var w = slotsOf(this, 'WritableStreamDefaultWriter');
      if (w.stream === undefined) throw new TypeError('Writer was released');
      var s = writableState(w.stream);
      if (s.state === 'errored' || s.state === 'erroring') return null;
      if (s.state === 'closed') return 0;
      var cs = SLOTS.get(s.controller);
      return cs.highWaterMark - cs.queueTotalSize;
    }
    get ready() {
      return slotsOf(this, 'WritableStreamDefaultWriter').ready.promise;
    }
    abort(reason) {
      var w = slotsOf(this, 'WritableStreamDefaultWriter');
      if (w.stream === undefined) return Promise.reject(new TypeError('Writer was released'));
      return writableAbort(w.stream, reason);
    }
    close() {
      var w = slotsOf(this, 'WritableStreamDefaultWriter');
      if (w.stream === undefined) return Promise.reject(new TypeError('Writer was released'));
      var s = writableState(w.stream);
      if (closeQueuedOrInFlight(s) || s.state === 'closed' || s.state === 'errored') {
        return Promise.reject(new TypeError('Cannot close a closing or closed stream'));
      }
      return writableClose(w.stream);
    }
    releaseLock() {
      var w = slotsOf(this, 'WritableStreamDefaultWriter');
      if (w.stream !== undefined) releaseWriter(this);
    }
    write(chunk) {
      var w = slotsOf(this, 'WritableStreamDefaultWriter');
      if (w.stream === undefined) return Promise.reject(new TypeError('Writer was released'));
      return writerWrite(w.stream, chunk);
    }
  }

  class WritableStream {
    constructor(underlyingSink, strategy) {
      var sink = sourceOf(underlyingSink);
      var options = strategyOf(strategy);
      if (sink !== null && sink.type !== undefined) throw new RangeError('Invalid type is specified');
      var start = methodOf(sink, 'start');
      var write = methodOf(sink, 'write');
      var close = methodOf(sink, 'close');
      var abort = methodOf(sink, 'abort');
      var highWaterMark = highWaterMarkOf(options, 1);
      var size = sizeOf(options);
      SLOTS.set(this, {
        kind: 'WritableStream',
        state: 'writable',
        storedError: undefined,
        writer: undefined,
        controller: undefined,
        inFlightWrite: undefined,
        inFlightClose: undefined,
        closeRequest: undefined,
        writeRequests: [],
        pendingAbort: undefined,
        backpressure: false
      });
      setupWritableController(this, sink, start, write, close, abort, highWaterMark, size);
    }
    get locked() {
      return writableState(this).writer !== undefined;
    }
    abort(reason) {
      if (this.locked) return Promise.reject(new TypeError('Cannot abort a locked WritableStream'));
      return writableAbort(this, reason);
    }
    close() {
      var s = writableState(this);
      if (s.writer !== undefined) return Promise.reject(new TypeError('Cannot close a locked WritableStream'));
      if (s.state === 'closed' || s.state === 'errored' || closeQueuedOrInFlight(s)) {
        return Promise.reject(new TypeError('Cannot close a WritableStream that is closed or closing'));
      }
      return writableClose(this);
    }
    getWriter() {
      return new WritableStreamDefaultWriter(this);
    }
  }

  /* ---- transform streams ---- */
  function setBackpressure(state, value) {
    if (state.backpressureChange !== undefined) state.backpressureChange.resolve(undefined);
    state.backpressureChange = deferred();
    state.backpressure = value;
  }
  function errorWritableAndUnblockWrite(state, error) {
    var wc = SLOTS.get(writableState(state.writable).controller);
    if (writableState(state.writable).state === 'writable') writableControllerError(wc, error);
    if (state.backpressure) setBackpressure(state, false);
  }
  function transformError(state, error) {
    state.readableController.error(error);
    errorWritableAndUnblockWrite(state, error);
  }
  function enqueueReadable(state, chunk) {
    var rcs = SLOTS.get(readableState(state.readable).controller);
    if (!canCloseOrEnqueue(rcs)) throw new TypeError('Invalid state: Controller is already closed');
    try {
      state.readableController.enqueue(chunk);
    } catch (error) {
      errorWritableAndUnblockWrite(state, error);
      throw error;
    }
    var hasBackpressure = state.readableController.desiredSize <= 0;
    if (hasBackpressure !== state.backpressure) setBackpressure(state, hasBackpressure);
  }
  function performTransform(state, chunk) {
    var result;
    try {
      if (state.transformFn === undefined) {
        enqueueReadable(state, chunk);
        result = Promise.resolve(undefined);
      } else {
        result = invoke(state.transform, state.transformFn, [chunk, state.controller]);
      }
    } catch (error) {
      transformError(state, error);
      return Promise.reject(error);
    }
    return result.then(undefined, function (error) {
      transformError(state, error);
      throw error;
    });
  }
  function transformWrite(state, chunk) {
    if (!state.backpressure) return performTransform(state, chunk);
    return state.backpressureChange.promise.then(function () {
      if (writableState(state.writable).state === 'erroring') throw writableState(state.writable).storedError;
      return performTransform(state, chunk);
    });
  }
  function transformClose(state) {
    var flush = state.flushFn === undefined ? Promise.resolve(undefined) : invoke(state.transform, state.flushFn, [state.controller]);
    return flush.then(function () {
      var rs = readableState(state.readable);
      if (rs.state === 'errored') throw rs.storedError;
      if (canCloseOrEnqueue(SLOTS.get(rs.controller))) state.readableController.close();
    }, function (error) {
      transformError(state, error);
      throw error;
    });
  }
  function transformAbort(state, reason) {
    var cancel = state.cancelFn === undefined ? Promise.resolve(undefined) : invoke(state.transform, state.cancelFn, [reason]);
    return cancel.then(function () {
      state.readableController.error(reason);
    }, function (error) {
      state.readableController.error(error);
      throw error;
    });
  }
  function transformTerminate(state) {
    if (canCloseOrEnqueue(SLOTS.get(readableState(state.readable).controller))) state.readableController.close();
    errorWritableAndUnblockWrite(state, new TypeError('The stream has been terminated'));
  }

  class TransformStreamDefaultController {
    constructor(token) {
      requireCreate(token);
    }
    get desiredSize() {
      return slotsOf(this, 'TransformStreamDefaultController').desiredSize();
    }
    enqueue(chunk) {
      slotsOf(this, 'TransformStreamDefaultController').enqueue(chunk);
    }
    error(reason) {
      slotsOf(this, 'TransformStreamDefaultController').error(reason);
    }
    terminate() {
      slotsOf(this, 'TransformStreamDefaultController').terminate();
    }
  }

  class TransformStream {
    constructor(transformer, writableStrategy, readableStrategy) {
      var transform = sourceOf(transformer);
      if (transform !== null && (transform.readableType !== undefined || transform.writableType !== undefined)) {
        throw new RangeError('Invalid readableType or writableType is specified');
      }
      var writableOptions = strategyOf(writableStrategy);
      var readableOptions = strategyOf(readableStrategy);
      var writableHighWaterMark = highWaterMarkOf(writableOptions, 1);
      var readableHighWaterMark = highWaterMarkOf(readableOptions, 0);
      var start = methodOf(transform, 'start');
      var state = {
        backpressure: undefined,
        backpressureChange: undefined,
        transform: transform,
        transformFn: methodOf(transform, 'transform'),
        flushFn: methodOf(transform, 'flush'),
        cancelFn: methodOf(transform, 'cancel'),
        readable: undefined,
        writable: undefined,
        controller: undefined,
        readableController: undefined
      };
      setBackpressure(state, true);
      var startDeferred = deferred();
      state.readable = new ReadableStream({
        start: function (c) {
          state.readableController = c;
          return startDeferred.promise;
        },
        pull: function () {
          setBackpressure(state, false);
          return state.backpressureChange.promise;
        },
        cancel: function (reason) {
          errorWritableAndUnblockWrite(state, reason);
          return state.cancelFn === undefined ? Promise.resolve(undefined) : invoke(transform, state.cancelFn, [reason]);
        }
      }, { highWaterMark: readableHighWaterMark, size: readableOptions.size });
      state.writable = new WritableStream({
        start: function () {
          return startDeferred.promise;
        },
        write: function (chunk) {
          return transformWrite(state, chunk);
        },
        close: function () {
          return transformClose(state);
        },
        abort: function (reason) {
          return transformAbort(state, reason);
        }
      }, { highWaterMark: writableHighWaterMark, size: writableOptions.size });
      var controller = new TransformStreamDefaultController(CREATE);
      SLOTS.set(controller, {
        kind: 'TransformStreamDefaultController',
        desiredSize: function () {
          return state.readableController.desiredSize;
        },
        enqueue: function (chunk) {
          enqueueReadable(state, chunk);
        },
        error: function (reason) {
          transformError(state, reason);
        },
        terminate: function () {
          transformTerminate(state);
        }
      });
      state.controller = controller;
      SLOTS.set(this, { kind: 'TransformStream', state: state });
      var startResult = start === undefined ? undefined : start.call(transform, controller);
      Promise.resolve(startResult).then(function () {
        startDeferred.resolve(undefined);
      }, function (error) {
        startDeferred.reject(error);
      });
    }
    get readable() {
      return slotsOf(this, 'TransformStream').state.readable;
    }
    get writable() {
      return slotsOf(this, 'TransformStream').state.writable;
    }
  }

  /* ---- piping ---- */
  function pipeReadableTo(source, dest, options) {
    var reader = new ReadableStreamDefaultReader(source);
    var writer = new WritableStreamDefaultWriter(dest);
    var result = deferred();
    var finished = false;
    var shuttingDown = false;
    var pendingWrite = Promise.resolve(undefined);
    var signal = options.signal;
    var onAbort = null;

    function finalize(error) {
      if (finished) return;
      finished = true;
      if (signal !== undefined && onAbort !== null) signal.removeEventListener('abort', onAbort);
      writer.releaseLock();
      reader.releaseLock();
      if (error === undefined) result.resolve(undefined);
      else result.reject(error);
    }
    function shutdownWith(action, originalError, waitForWrites) {
      if (shuttingDown) return;
      shuttingDown = true;
      var before = waitForWrites ? pendingWrite : Promise.resolve(undefined);
      before.then(function () {
        return action();
      }).then(function () {
        finalize(originalError);
      }, function (newError) {
        finalize(originalError === undefined ? newError : originalError);
      });
    }
    function abortAction(reason) {
      var actions = [];
      if (!options.preventAbort) actions.push(function () { return writableAbort(dest, reason); });
      if (!options.preventCancel) actions.push(function () { return readableCancel(source, reason); });
      shutdownWith(function () {
        return Promise.all(actions.map(function (run) { return run(); }));
      }, reason, false);
    }
    function next() {
      if (finished || shuttingDown) return;
      writer.ready.then(function () {
        if (finished || shuttingDown) return undefined;
        return reader.read().then(function (step) {
          if (finished || shuttingDown) return;
          if (step.done) {
            if (options.preventClose) finalize(undefined);
            else shutdownWith(function () { return writer.close(); }, undefined, true);
            return;
          }
          pendingWrite = writer.write(step.value);
          pendingWrite.then(undefined, function () {});
          next();
        }, function () {});
      }, function () {});
    }

    reader.closed.then(undefined, function (error) {
      if (finished || shuttingDown) return;
      if (options.preventAbort) shutdownWith(function () { return undefined; }, error, false);
      else shutdownWith(function () { return writableAbort(dest, error); }, error, false);
    });
    writer.closed.then(undefined, function (error) {
      if (finished || shuttingDown) return;
      if (options.preventCancel) shutdownWith(function () { return undefined; }, error, false);
      else shutdownWith(function () { return readableCancel(source, error); }, error, false);
    });
    if (signal !== undefined) {
      if (signal.aborted) {
        abortAction(signal.reason);
      } else {
        onAbort = function () {
          abortAction(signal.reason);
        };
        signal.addEventListener('abort', onAbort);
      }
    }
    next();
    return result.promise;
  }

  /* ---- queuing strategies ---- */
  var byteLengthSize = function size(chunk) {
    return chunk.byteLength;
  };
  var countSize = function size() {
    return 1;
  };
  class ByteLengthQueuingStrategy {
    constructor(init) {
      if (!isObject(init)) throw new TypeError('init must be an object');
      if (init.highWaterMark === undefined) throw new TypeError('highWaterMark is required');
      SLOTS.set(this, { kind: 'ByteLengthQueuingStrategy', highWaterMark: Number(init.highWaterMark) });
    }
    get highWaterMark() {
      return slotsOf(this, 'ByteLengthQueuingStrategy').highWaterMark;
    }
    get size() {
      slotsOf(this, 'ByteLengthQueuingStrategy');
      return byteLengthSize;
    }
  }
  class CountQueuingStrategy {
    constructor(init) {
      if (!isObject(init)) throw new TypeError('init must be an object');
      if (init.highWaterMark === undefined) throw new TypeError('highWaterMark is required');
      SLOTS.set(this, { kind: 'CountQueuingStrategy', highWaterMark: Number(init.highWaterMark) });
    }
    get highWaterMark() {
      return slotsOf(this, 'CountQueuingStrategy').highWaterMark;
    }
    get size() {
      slotsOf(this, 'CountQueuingStrategy');
      return countSize;
    }
  }

  /* ---- text streams ---- */
  class TextEncoderStream {
    constructor() {
      var encoder = new TextEncoder();
      var pending = '';
      var transform = new TransformStream({
        transform: function (chunk, controller) {
          var text = pending + String(chunk);
          pending = '';
          if (text.length > 0) {
            var last = text.charCodeAt(text.length - 1);
            if (last >= 0xD800 && last <= 0xDBFF) {
              pending = text.slice(-1);
              text = text.slice(0, -1);
            }
          }
          if (text.length > 0) controller.enqueue(encoder.encode(text));
        },
        flush: function (controller) {
          if (pending.length > 0) controller.enqueue(encoder.encode(pending));
          pending = '';
        }
      });
      SLOTS.set(this, { kind: 'TextEncoderStream', transform: transform });
    }
    get encoding() {
      slotsOf(this, 'TextEncoderStream');
      return 'utf-8';
    }
    get readable() {
      return slotsOf(this, 'TextEncoderStream').transform.readable;
    }
    get writable() {
      return slotsOf(this, 'TextEncoderStream').transform.writable;
    }
  }
  class TextDecoderStream {
    constructor(label, options) {
      var opts = options === undefined || options === null ? {} : options;
      var decoder = new TextDecoder(label === undefined ? 'utf-8' : label, { fatal: !!opts.fatal, ignoreBOM: !!opts.ignoreBOM });
      var transform = new TransformStream({
        transform: function (chunk, controller) {
          var text = decoder.decode(chunk, { stream: true });
          if (text.length > 0) controller.enqueue(text);
        },
        flush: function (controller) {
          var text = decoder.decode();
          if (text.length > 0) controller.enqueue(text);
        }
      });
      SLOTS.set(this, { kind: 'TextDecoderStream', decoder: decoder, transform: transform });
    }
    get encoding() {
      return slotsOf(this, 'TextDecoderStream').decoder.encoding;
    }
    get fatal() {
      return slotsOf(this, 'TextDecoderStream').decoder.fatal;
    }
    get ignoreBOM() {
      return slotsOf(this, 'TextDecoderStream').decoder.ignoreBOM;
    }
    get readable() {
      return slotsOf(this, 'TextDecoderStream').transform.readable;
    }
    get writable() {
      return slotsOf(this, 'TextDecoderStream').transform.writable;
    }
  }

  var exported = {
    ReadableStream: ReadableStream,
    ReadableStreamDefaultReader: ReadableStreamDefaultReader,
    ReadableStreamBYOBReader: ReadableStreamBYOBReader,
    ReadableStreamBYOBRequest: ReadableStreamBYOBRequest,
    ReadableByteStreamController: ReadableByteStreamController,
    ReadableStreamDefaultController: ReadableStreamDefaultController,
    TransformStream: TransformStream,
    TransformStreamDefaultController: TransformStreamDefaultController,
    WritableStream: WritableStream,
    WritableStreamDefaultWriter: WritableStreamDefaultWriter,
    WritableStreamDefaultController: WritableStreamDefaultController,
    ByteLengthQueuingStrategy: ByteLengthQueuingStrategy,
    CountQueuingStrategy: CountQueuingStrategy,
    TextEncoderStream: TextEncoderStream,
    TextDecoderStream: TextDecoderStream
  };
  Object.keys(exported).forEach(function (name) {
    var ctor = exported[name];
    if (ctor.prototype && !Object.prototype.hasOwnProperty.call(ctor.prototype, Symbol.toStringTag)) {
      Object.defineProperty(ctor.prototype, Symbol.toStringTag, { value: name, configurable: true });
    }
  });
  BF['stream/web'] = function () {
    return exported;
  };
  Object.keys(exported).forEach(function (name) {
    if (typeof globalThis[name] === 'undefined') {
      Object.defineProperty(globalThis, name, { value: exported[name], writable: true, configurable: true, enumerable: false });
    }
  });
})();
`;
