/**
 * Guest source for `undici`, an npm package the container serves itself.
 *
 * Why. The package builds its HTTP/1.1 parser, llhttp, from WebAssembly: lib/dispatcher/client-h1.js
 * runs `let llhttpPromise = lazyllhttp(); llhttpPromise.catch()` at module scope. This runtime has no
 * WebAssembly, so lazyllhttp() rejects there, and `.catch()` with no callable handler does not suppress
 * it -- Node 24.15 ends a process the same way for `Promise.reject(e).catch()`. Requiring undici was
 * therefore enough to abort any program that touches it, including cheerio, which imports it only for
 * `fromURL` and never uses it for a document it already holds.
 *
 * What. The container serves undici over its own http and https modules instead of loading the package:
 * request, stream, pipeline and fetch are real HTTP, an Agent keeps the container's keep-alive pool, and
 * the surface that needs a raw socket or a WebSocket (connect, upgrade, WebSocket, EventSource) is not
 * available here and reports ERR_NOT_SUPPORTED, the way the container's own fetch does.
 */
export const SRC = String.raw`
(function () {
function unsupported(what) {
  return function () {
    var err = new Error(what + ' is not supported by this runtime');
    err.code = 'ERR_NOT_SUPPORTED';
    return Promise.reject(err);
  };
}

function isHttps(target, options) {
  var url = typeof target === 'string' ? target : (target && target.href !== undefined ? String(target.href) : '');
  if (url.indexOf('https:') === 0) return true;
  if (options && (options.protocol === 'https:' || options.protocol === 'https')) return true;
  return false;
}

function transport(target, options) {
  return isHttps(target, options) ? requireBuiltin('https') : requireBuiltin('http');
}

/* undici takes method, headers and body; http takes method, headers and a stream it is handed the body on. */
function httpOptions(options) {
  var opts = {};
  if (!options) return opts;
  for (var key in options) {
    if (key === 'body' || key === 'dispatcher' || key === 'maxRedirections' || key === 'onInfo' || key === 'throwOnError') continue;
    opts[key] = options[key];
  }
  if (options.headers) opts.headers = options.headers;
  if (options.method) opts.method = options.method;
  return opts;
}

function bodyOf(chunks) {
  var buffer = Buffer.concat(chunks);
  return {
    text: function () { return Promise.resolve(buffer.toString('utf8')); },
    json: function () { return Promise.resolve(JSON.parse(buffer.toString('utf8'))); },
    bytes: function () { return Promise.resolve(new Uint8Array(buffer)); },
    arrayBuffer: function () { return Promise.resolve(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)); },
    dump: function () { return Promise.resolve(); }
  };
}

/* request(url, options) -> { statusCode, headers, body }, as undici's request resolves. */
function request(target, options) {
  return new Promise(function (resolve, reject) {
    var mod = transport(target, options);
    var req = mod.request(target, httpOptions(options), function (res) {
      var chunks = [];
      res.on('data', function (chunk) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); });
      res.on('end', function () {
        resolve({ statusCode: res.statusCode, statusText: res.statusMessage, headers: res.headers, body: bodyOf(chunks) });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    var body = options && options.body !== undefined && options.body !== null ? options.body : null;
    if (body !== null) req.end(body); else req.end();
  });
}

/* stream(url, options, factory): factory is called with the head and returns the writable the body is
   piped into, and the promise resolves with whatever factory returned. */
function stream(target, options, factory) {
  return new Promise(function (resolve, reject) {
    var mod = transport(target, options);
    var req = mod.request(target, httpOptions(options), function (res) {
      var sink = factory({ statusCode: res.statusCode, headers: res.headers, context: {} });
      res.on('data', function (chunk) { if (sink && typeof sink.write === 'function') sink.write(chunk); });
      res.on('end', function () {
        if (sink && typeof sink.end === 'function') sink.end();
        resolve(sink);
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    var body = options && options.body !== undefined && options.body !== null ? options.body : null;
    if (body !== null) req.end(body); else req.end();
  });
}

function pipeline(target, options, handler) {
  return request(target, options).then(function (res) { return handler(res); });
}

function Headers(init) {
  this.map = Object.create(null);
  if (!init) return;
  if (typeof init.forEach === 'function' && typeof init.get !== 'function') {
    var self = this;
    init.forEach(function (value, key) { self.append(String(key), String(value)); });
    return;
  }
  for (var key in init) this.append(key, String(init[key]));
}
Headers.prototype.append = function (name, value) {
  var lower = String(name).toLowerCase();
  if (this.map[lower] === undefined) this.map[lower] = String(value);
  else this.map[lower] = this.map[lower] + ', ' + String(value);
};
Headers.prototype.set = function (name, value) { this.map[String(name).toLowerCase()] = String(value); };
Headers.prototype.get = function (name) {
  var value = this.map[String(name).toLowerCase()];
  return value === undefined ? null : value;
};
Headers.prototype.has = function (name) { return this.map[String(name).toLowerCase()] !== undefined; };
Headers.prototype.delete = function (name) { delete this.map[String(name).toLowerCase()]; };
Headers.prototype.forEach = function (fn) {
  for (var key in this.map) fn(this.map[key], key, this);
};

function Response(body, init) {
  init = init || {};
  this.status = init.status === undefined ? 200 : init.status;
  this.statusText = init.statusText === undefined ? '' : init.statusText;
  this.ok = this.status >= 200 && this.status < 300;
  this.headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers);
  this.body = body === undefined || body === null ? '' : String(body);
  this.url = init.url === undefined ? '' : init.url;
}
Response.prototype.text = function () { return Promise.resolve(this.body); };
Response.prototype.json = function () { return Promise.resolve(JSON.parse(this.body)); };
Response.prototype.arrayBuffer = function () { return Promise.resolve(Buffer.from(this.body, 'utf8')); };
Response.prototype.clone = function () { return new Response(this.body, { status: this.status, statusText: this.statusText, headers: this.headers, url: this.url }); };

function Request(target, options) {
  options = options || {};
  this.url = String(target && target.href !== undefined ? target.href : target);
  this.method = (options.method || 'GET').toUpperCase();
  this.headers = options.headers instanceof Headers ? options.headers : new Headers(options.headers);
}

function fetch(target, options) {
  var url = String(target && target.href !== undefined ? target.href : target);
  return request(url, options).then(function (res) {
    return res.body.text().then(function (text) {
      return new Response(text, { status: res.statusCode, statusText: res.statusText, headers: res.headers, url: url });
    });
  });
}

/* A dispatcher over the container's keep-alive pool. undici's Agent is per-origin and queues requests;
   this one hands each request to http or https with its own agent, which is the same pool. */
function Agent(options) {
  this.options = options || {};
}
Agent.prototype.dispatch = function (opts, handler) {
  return request(opts.origin && opts.path ? String(opts.origin) + String(opts.path) : String(opts.path), {
    method: opts.method, headers: opts.headers, body: opts.body
  }).then(function (res) {
    if (handler && typeof handler.onConnect === 'function') handler.onConnect(function () {});
    if (handler && typeof handler.onHeaders === 'function') handler.onHeaders(res.statusCode, res.headers, function () {}, res.statusText);
    return res.body.text().then(function (text) {
      if (handler && typeof handler.onData === 'function') handler.onData(Buffer.from(text));
    }).then(function () {
      if (handler && typeof handler.onComplete === 'function') handler.onComplete([]);
    });
  }, function (err) {
    if (handler && typeof handler.onError === 'function') handler.onError(err);
    else throw err;
  });
};
Agent.prototype.close = function () { return Promise.resolve(); };
Agent.prototype.destroy = function () { return Promise.resolve(); };

function Pool(origin, options) {
  this.origin = String(origin || '');
  this.options = options || {};
  this.agent = new Agent(this.options);
}
Pool.prototype.request = function (opts) {
  var url = this.origin.replace(/\/+$/, '') + String(opts && opts.path ? opts.path : '/');
  return request(url, opts);
};
Pool.prototype.close = function () { return Promise.resolve(); };
Pool.prototype.destroy = function () { return Promise.resolve(); };

function Client(origin, options) {
  Pool.call(this, origin, options);
}
Client.prototype = Object.create(Pool.prototype);
Client.prototype.constructor = Client;

function Dispatcher() {}
Dispatcher.prototype.close = function () { return Promise.resolve(); };
Dispatcher.prototype.destroy = function () { return Promise.resolve(); };

var globalDispatcher = new Agent();

var errors = {
  UndiciError: Error,
  ConnectTimeoutError: Error,
  HeadersTimeoutError: Error,
  BodyTimeoutError: Error,
  ResponseStatusCodeError: Error,
  InvalidArgumentError: Error,
  RequestAbortedError: Error,
  RequestContentLengthMismatchError: Error,
  ClientDestroyedError: Error,
  ClientClosedError: Error,
  SocketError: Error,
  NotSupportedError: Error,
  InformationalError: Error
};

var interceptors = {
  redirect: function (opts) { return function (dispatch) { return dispatch; }; },
  decompress: function (opts) { return function (dispatch) { return dispatch; }; },
  retry: function (opts) { return function (dispatch) { return dispatch; }; },
  dump: function (opts) { return function (dispatch) { return dispatch; }; },
  responseError: function (opts) { return function (dispatch) { return dispatch; }; }
};

BF['undici'] = function () {
  return {
    fetch: fetch,
    request: request,
    stream: stream,
    pipeline: pipeline,
    connect: unsupported('undici.connect'),
    upgrade: unsupported('undici.upgrade'),
    Agent: Agent,
    Pool: Pool,
    Client: Client,
    Dispatcher: Dispatcher,
    BalancedPool: function BalancedPool() { throw new Error('undici.BalancedPool is not supported by this runtime'); },
    ProxyAgent: function ProxyAgent() { throw new Error('undici.ProxyAgent is not supported by this runtime'); },
    EnvHttpProxyAgent: function EnvHttpProxyAgent() { throw new Error('undici.EnvHttpProxyAgent is not supported by this runtime'); },
    RetryAgent: function RetryAgent() { throw new Error('undici.RetryAgent is not supported by this runtime'); },
    MockAgent: function MockAgent() { throw new Error('undici.MockAgent is not supported by this runtime'); },
    MockClient: function MockClient() { throw new Error('undici.MockClient is not supported by this runtime'); },
    MockPool: function MockPool() { throw new Error('undici.MockPool is not supported by this runtime'); },
    buildConnector: function () { throw new Error('undici.buildConnector is not supported by this runtime'); },
    WebSocket: function WebSocket() { throw new Error('undici.WebSocket is not supported by this runtime'); },
    EventSource: function EventSource() { throw new Error('undici.EventSource is not supported by this runtime'); },
    setGlobalDispatcher: function (agent) { globalDispatcher = agent; },
    getGlobalDispatcher: function () { return globalDispatcher; },
    interceptors: interceptors,
    errors: errors,
    Headers: Headers,
    Response: Response,
    Request: Request
  };
};
})();
`;
