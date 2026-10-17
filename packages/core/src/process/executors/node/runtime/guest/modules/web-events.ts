/**
 * Guest-side DOM-style globals that Node provides and some packages load at import time: Event, CustomEvent,
 * EventTarget, DOMException, MessageEvent, MessagePort and MessageChannel. Plain JavaScript inside a String.raw
 * snippet, wrapped in one IIFE that installs the globals it does not already have. MessagePort delivers in
 * process only: postMessage clones with structuredClone and dispatches on the next immediate.
 */
export const SRC = String.raw`
(function () {
  var EVENT = new WeakMap();
  var TARGET = new WeakMap();
  var PORTS = new WeakMap();
  var PORT_TOKEN = {};

  var LEGACY_CODES = {
    IndexSizeError: 1, HierarchyRequestError: 3, WrongDocumentError: 4, InvalidCharacterError: 5,
    NoModificationAllowedError: 7, NotFoundError: 8, NotSupportedError: 9, InvalidStateError: 11,
    SyntaxError: 12, InvalidModificationError: 13, NamespaceError: 14, InvalidAccessError: 15,
    TypeMismatchError: 17, SecurityError: 18, NetworkError: 19, AbortError: 20, URLMismatchError: 21,
    QuotaExceededError: 22, TimeoutError: 23, InvalidNodeTypeError: 24, DataCloneError: 25
  };

  class DOMException extends Error {
    constructor(message, name) {
      super(message === undefined ? '' : String(message));
      Object.defineProperty(this, 'name', { value: name === undefined ? 'Error' : String(name), configurable: true });
      Object.defineProperty(this, 'code', { value: LEGACY_CODES[this.name] || 0, configurable: true });
    }
  }

  class Event {
    constructor(type, options) {
      if (arguments.length === 0) throw new TypeError('The "type" argument must be specified');
      var init = options === undefined || options === null ? {} : options;
      EVENT.set(this, {
        type: String(type),
        bubbles: !!init.bubbles,
        cancelable: !!init.cancelable,
        composed: !!init.composed,
        defaultPrevented: false,
        stopped: false,
        immediateStopped: false,
        target: null,
        currentTarget: null,
        timeStamp: Date.now()
      });
    }
    get type() { return EVENT.get(this).type; }
    get bubbles() { return EVENT.get(this).bubbles; }
    get cancelable() { return EVENT.get(this).cancelable; }
    get composed() { return EVENT.get(this).composed; }
    get defaultPrevented() { return EVENT.get(this).defaultPrevented; }
    get target() { return EVENT.get(this).target; }
    get currentTarget() { return EVENT.get(this).currentTarget; }
    get srcElement() { return EVENT.get(this).target; }
    get timeStamp() { return EVENT.get(this).timeStamp; }
    get isTrusted() { return false; }
    get eventPhase() { return EVENT.get(this).currentTarget === null ? 0 : 2; }
    get returnValue() { return !EVENT.get(this).defaultPrevented; }
    get cancelBubble() { return EVENT.get(this).stopped; }
    preventDefault() {
      var st = EVENT.get(this);
      if (st.cancelable) st.defaultPrevented = true;
    }
    stopPropagation() { EVENT.get(this).stopped = true; }
    stopImmediatePropagation() {
      var st = EVENT.get(this);
      st.stopped = true;
      st.immediateStopped = true;
    }
    composedPath() {
      var st = EVENT.get(this);
      return st.currentTarget === null ? [] : [st.currentTarget];
    }
  }
  Object.defineProperty(Event, 'NONE', { value: 0, enumerable: true });
  Object.defineProperty(Event, 'CAPTURING_PHASE', { value: 1, enumerable: true });
  Object.defineProperty(Event, 'AT_TARGET', { value: 2, enumerable: true });
  Object.defineProperty(Event, 'BUBBLING_PHASE', { value: 3, enumerable: true });

  class CustomEvent extends Event {
    constructor(type, options) {
      super(type, options);
      var init = options === undefined || options === null ? {} : options;
      EVENT.get(this).detail = init.detail === undefined ? null : init.detail;
    }
    get detail() { return EVENT.get(this).detail; }
  }

  class MessageEvent extends Event {
    constructor(type, options) {
      super(type, options);
      var init = options === undefined || options === null ? {} : options;
      var st = EVENT.get(this);
      st.data = init.data === undefined ? null : init.data;
      st.origin = init.origin === undefined ? '' : String(init.origin);
      st.lastEventId = init.lastEventId === undefined ? '' : String(init.lastEventId);
      st.source = init.source === undefined ? null : init.source;
      st.ports = init.ports === undefined ? [] : Array.prototype.slice.call(init.ports);
    }
    get data() { return EVENT.get(this).data; }
    get origin() { return EVENT.get(this).origin; }
    get lastEventId() { return EVENT.get(this).lastEventId; }
    get source() { return EVENT.get(this).source; }
    get ports() { return EVENT.get(this).ports; }
  }

  class EventTarget {
    constructor() {
      TARGET.set(this, { listeners: Object.create(null) });
    }
    addEventListener(type, listener, options) {
      if (listener === null || listener === undefined) return;
      var st = TARGET.get(this);
      var name = String(type);
      var once = !!(options && typeof options === 'object' && options.once);
      var signal = options && typeof options === 'object' ? options.signal : undefined;
      if (signal && signal.aborted) return;
      var list = st.listeners[name] || (st.listeners[name] = []);
      for (var i = 0; i < list.length; i++) {
        if (list[i].listener === listener) return;
      }
      list.push({ listener: listener, once: once });
      if (signal) {
        var target = this;
        signal.addEventListener('abort', function () { target.removeEventListener(name, listener); });
      }
    }
    removeEventListener(type, listener) {
      var list = TARGET.get(this).listeners[String(type)];
      if (!list) return;
      for (var i = 0; i < list.length; i++) {
        if (list[i].listener === listener) {
          list.splice(i, 1);
          return;
        }
      }
    }
    dispatchEvent(event) {
      if (!(event instanceof Event)) throw new TypeError('The "event" argument must be an instance of Event');
      var st = EVENT.get(event);
      if (st.target !== null) throw new DOMException('The event is already being dispatched', 'InvalidStateError');
      st.target = this;
      st.currentTarget = this;
      var list = TARGET.get(this).listeners[st.type];
      if (list) {
        var snapshot = list.slice();
        for (var i = 0; i < snapshot.length; i++) {
          var entry = snapshot[i];
          if (entry.once) this.removeEventListener(st.type, entry.listener);
          try {
            if (typeof entry.listener === 'function') entry.listener.call(this, event);
            else if (entry.listener && typeof entry.listener.handleEvent === 'function') entry.listener.handleEvent(event);
          } catch (error) {
            setImmediate(function () { throw error; });
          }
          if (st.immediateStopped) break;
        }
      }
      st.currentTarget = null;
      return !st.defaultPrevented;
    }
  }

  function deliverMessage(port, data) {
    var st = PORTS.get(port);
    if (st.closed) return;
    if (!st.started) {
      st.queue.push(data);
      return;
    }
    port.dispatchEvent(new MessageEvent('message', { data: data }));
  }

  class MessagePort extends EventTarget {
    constructor(token) {
      if (token !== PORT_TOKEN) throw new TypeError('Illegal constructor');
      super();
      PORTS.set(this, { peer: null, started: false, closed: false, queue: [], handler: null });
    }
    postMessage(message) {
      var st = PORTS.get(this);
      if (st.closed || st.peer === null) return;
      var data = structuredClone(message);
      var peer = st.peer;
      setImmediate(function () { deliverMessage(peer, data); });
    }
    start() {
      var st = PORTS.get(this);
      if (st.started) return;
      st.started = true;
      var queued = st.queue;
      st.queue = [];
      for (var i = 0; i < queued.length; i++) deliverMessage(this, queued[i]);
    }
    close() {
      var st = PORTS.get(this);
      st.closed = true;
      if (st.peer !== null) PORTS.get(st.peer).closed = true;
    }
    ref() {}
    unref() {}
    get onmessage() {
      return PORTS.get(this).handler;
    }
    set onmessage(handler) {
      var st = PORTS.get(this);
      if (st.handler !== null) this.removeEventListener('message', st.handler);
      st.handler = typeof handler === 'function' ? handler : null;
      if (st.handler !== null) {
        this.addEventListener('message', st.handler);
        this.start();
      }
    }
  }

  class MessageChannel {
    constructor() {
      var port1 = new MessagePort(PORT_TOKEN);
      var port2 = new MessagePort(PORT_TOKEN);
      PORTS.get(port1).peer = port2;
      PORTS.get(port2).peer = port1;
      this.port1 = port1;
      this.port2 = port2;
    }
  }

  function isObjectLike(value) {
    return value !== null && (typeof value === 'object' || typeof value === 'function');
  }

  /* This engine build has no GC observation: WeakRef keeps its target and FinalizationRegistry never runs its cleanup. register and unregister still answer as Node does. */
  var WEAK_TARGET = new WeakMap();
  class WeakRef {
    constructor(target) {
      if (!isObjectLike(target)) throw new TypeError('WeakRef: target must be an object');
      WEAK_TARGET.set(this, target);
    }
    deref() {
      return WEAK_TARGET.get(this);
    }
  }
  Object.defineProperty(WeakRef.prototype, Symbol.toStringTag, { value: 'WeakRef', configurable: true });

  var REGISTRY_TOKENS = new WeakMap();
  class FinalizationRegistry {
    constructor(cleanup) {
      if (typeof cleanup !== 'function') throw new TypeError('FinalizationRegistry: cleanup must be callable');
      REGISTRY_TOKENS.set(this, []);
    }
    register(target, heldValue, unregisterToken) {
      if (!isObjectLike(target)) throw new TypeError('FinalizationRegistry.prototype.register: target must be an object');
      if (target === heldValue) throw new TypeError('FinalizationRegistry.prototype.register: target and holdings must not be same');
      if (unregisterToken !== undefined) {
        if (!isObjectLike(unregisterToken)) throw new TypeError('FinalizationRegistry.prototype.register: unregisterToken must be an object');
        REGISTRY_TOKENS.get(this).push(unregisterToken);
      }
    }
    unregister(unregisterToken) {
      if (!isObjectLike(unregisterToken)) throw new TypeError('FinalizationRegistry.prototype.unregister: unregisterToken must be an object');
      var tokens = REGISTRY_TOKENS.get(this);
      var before = tokens.length;
      REGISTRY_TOKENS.set(this, tokens.filter(function (token) { return token !== unregisterToken; }));
      return REGISTRY_TOKENS.get(this).length !== before;
    }
  }
  Object.defineProperty(FinalizationRegistry.prototype, Symbol.toStringTag, { value: 'FinalizationRegistry', configurable: true });

  var installed = {
    Event: Event,
    CustomEvent: CustomEvent,
    EventTarget: EventTarget,
    DOMException: DOMException,
    MessageEvent: MessageEvent,
    MessagePort: MessagePort,
    MessageChannel: MessageChannel,
    WeakRef: WeakRef,
    FinalizationRegistry: FinalizationRegistry
  };
  Object.keys(installed).forEach(function (name) {
    if (typeof globalThis[name] === 'undefined') {
      Object.defineProperty(globalThis, name, { value: installed[name], writable: true, configurable: true, enumerable: false });
    }
  });
})();
`;
