/**
 * Guest source for the http family: `http` and `https`, carried over the in-container
 * virtual network. Plain JavaScript inside a String.raw snippet; each family registers BF.<name>.
 *
 * - Servers and client sockets are BF.net sockets, so every byte stays on the hub. The request and
 *   status lines, headers, Content-Length and chunked bodies are framed and parsed here.
 * - Every exchange is Connection: close. A server socket serves one request and then ends; a client
 *   socket is destroyed when its response completes. There is no keep-alive pooling.
 * - https is the same code over the tls module (TLS 1.3, tls.ts): https.request/get connect with
 *   tls.connect (servername from the Host header or host, never an IP; ca, cert, key,
 *   rejectUnauthorized and the other TLS options from the request and the agent), and https.Server
 *   is an http.Server over tls.createServer that serves requests after 'secureConnection'. https
 *   servers are not announced to the host preview path, which speaks plain HTTP.
 * - A client request to a loopback address or a registered name goes over the hub. Any other host
 *   goes through the 'http.fetch' capability, which runs the request in the browser (TLS and CORS
 *   apply). The response is read whole; 'timeout' and socket options do not apply to those requests.
 * - http2 lives in ./http2 (RFC 9113 framing and RFC 7541 HPACK over BF.net and BF.tls sockets).
 */
export const SRC = String.raw`
(function () {
var HTTP_STATUS_CODES = {"100":"Continue","101":"Switching Protocols","102":"Processing","103":"Early Hints","200":"OK","201":"Created","202":"Accepted","203":"Non-Authoritative Information","204":"No Content","205":"Reset Content","206":"Partial Content","207":"Multi-Status","208":"Already Reported","226":"IM Used","300":"Multiple Choices","301":"Moved Permanently","302":"Found","303":"See Other","304":"Not Modified","305":"Use Proxy","307":"Temporary Redirect","308":"Permanent Redirect","400":"Bad Request","401":"Unauthorized","402":"Payment Required","403":"Forbidden","404":"Not Found","405":"Method Not Allowed","406":"Not Acceptable","407":"Proxy Authentication Required","408":"Request Timeout","409":"Conflict","410":"Gone","411":"Length Required","412":"Precondition Failed","413":"Payload Too Large","414":"URI Too Long","415":"Unsupported Media Type","416":"Range Not Satisfiable","417":"Expectation Failed","418":"I'm a Teapot","421":"Misdirected Request","422":"Unprocessable Entity","423":"Locked","424":"Failed Dependency","425":"Too Early","426":"Upgrade Required","428":"Precondition Required","429":"Too Many Requests","431":"Request Header Fields Too Large","451":"Unavailable For Legal Reasons","500":"Internal Server Error","501":"Not Implemented","502":"Bad Gateway","503":"Service Unavailable","504":"Gateway Timeout","505":"HTTP Version Not Supported","506":"Variant Also Negotiates","507":"Insufficient Storage","508":"Loop Detected","509":"Bandwidth Limit Exceeded","510":"Not Extended","511":"Network Authentication Required"};
var HTTP_METHODS = ["ACL","BIND","CHECKOUT","CONNECT","COPY","DELETE","GET","HEAD","LINK","LOCK","M-SEARCH","MERGE","MKACTIVITY","MKCALENDAR","MKCOL","MOVE","NOTIFY","OPTIONS","PATCH","POST","PROPFIND","PROPPATCH","PURGE","PUT","QUERY","REBIND","REPORT","SEARCH","SOURCE","SUBSCRIBE","TRACE","UNBIND","UNLINK","UNLOCK","UNSUBSCRIBE"];
var NO_BODY_METHODS = { GET: true, HEAD: true, DELETE: true, OPTIONS: true, TRACE: true, CONNECT: true };
var MAX_HEAD_BYTES = 16384;
var DUPLICATE_DISCARDED = { age: true, authorization: true, 'content-length': true, 'content-type': true, etag: true, expires: true, from: true, host: true, 'if-modified-since': true, 'if-unmodified-since': true, 'last-modified': true, location: true, 'max-forwards': true, 'proxy-authorization': true, referer: true, 'retry-after': true, server: true, 'user-agent': true };
var HTTP_CORE = null;

function httpError(Ctor, code, message) {
  var err = new Ctor(message);
  err.code = code;
  return err;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function httpEmitterBase() {
  var base = requireBuiltin('events');
  return typeof base === 'function' ? base : base.EventEmitter;
}

function bufIndexOfCrlf(buf, from) {
  for (var i = from; i + 1 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10) return i;
  }
  return -1;
}

function bufIndexOfHeadEnd(buf) {
  for (var i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i;
  }
  return -1;
}

/* Flat [name, value, name, value ...] pairs to Node's headers object: lower-case names, joined duplicates */
function headersFromPairs(pairs) {
  var out = {};
  for (var i = 0; i < pairs.length; i += 2) {
    var key = pairs[i].toLowerCase();
    var value = pairs[i + 1];
    if (key === 'set-cookie') {
      out[key] = hasOwn(out, key) ? out[key].concat([value]) : [value];
    } else if (hasOwn(out, key)) {
      if (DUPLICATE_DISCARDED[key] === true) continue;
      out[key] = out[key] + (key === 'cookie' ? '; ' : ', ') + value;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function pairValue(pairs, name) {
  for (var i = 0; i < pairs.length; i += 2) {
    if (pairs[i].toLowerCase() === name) return pairs[i + 1];
  }
  return undefined;
}

/* An Upgrade request: an Upgrade header, and a Connection header that lists the upgrade token */
function isUpgradeHead(head) {
  var upgrade = pairValue(head.pairs, 'upgrade');
  var connection = pairValue(head.pairs, 'connection');
  return upgrade !== undefined && connection !== undefined && /(^|,)\s*upgrade\s*(,|$)/i.test(connection);
}

/* HTTP/1.1 keeps the connection unless the request says close; HTTP/1.0 keeps it only when it asks */
function wantsKeepAlive(head) {
  var connection = pairValue(head.pairs, 'connection');
  var value = connection === undefined ? '' : connection.toLowerCase();
  if (value.indexOf('close') >= 0) return false;
  if (head.minor === 1) return true;
  return value.indexOf('keep-alive') >= 0;
}

function parseStatusHead(text) {
  var lines = text.split('\r\n');
  var m = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(lines[0]);
  if (!m) return null;
  var pairs = [];
  for (var i = 1; i < lines.length; i++) {
    var line = lines[i];
    if (line === '') continue;
    var colon = line.indexOf(':');
    if (colon <= 0) return null;
    pairs.push(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return { status: Number(m[1]), statusText: m[2] || '', pairs: pairs };
}

function parseRequestHead(text) {
  var lines = text.split('\r\n');
  var m = /^([A-Za-z-]+) (\S+) HTTP\/1\.([01])$/.exec(lines[0]);
  if (!m) return null;
  var pairs = [];
  for (var i = 1; i < lines.length; i++) {
    var line = lines[i];
    if (line === '') continue;
    var colon = line.indexOf(':');
    if (colon <= 0) return null;
    pairs.push(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return { method: m[1], url: m[2], minor: Number(m[3]), pairs: pairs };
}

function validateHeaderName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9!#$%&'*+.^_|~-]+$/.test(name)) {
    throw httpError(TypeError, 'ERR_INVALID_HTTP_TOKEN', 'Header name must be a valid HTTP token ["' + String(name) + '"]');
  }
}

function byteLengthOf(chunk, encoding) {
  return typeof chunk === 'string' ? Buffer.from(chunk, encoding || 'utf8').length : chunk.length;
}

/* Ends our write side, then destroys the socket once the bytes are out: the peer sees EOF, then close */
function closeSocket(socket) {
  if (socket.destroyed) return;
  socket.end();
  if (socket.writableFinished) socket.destroy();
  else socket.once('finish', function () { socket.destroy(); });
}

/* A host that the hub resolves (loopback, registered names) is a guest server; anything else is external */
function routesToGuest(hostname) {
  // a name the table cannot answer (a container without /etc/hosts included) is external, not an error
  var mapped = null;
  try {
    mapped = callCap('net.resolveHost', { name: hostname });
  } catch (failure) {
    mapped = null;
  }
  if (mapped !== null) return true;
  return /^127\./.test(hostname);
}

function urlOptions(u) {
  var hostname = u.hostname.charAt(0) === '[' ? u.hostname.slice(1, -1) : u.hostname;
  var options = { protocol: u.protocol, hostname: hostname, path: u.pathname + u.search };
  if (u.port) options.port = Number(u.port);
  if (u.username) options.auth = decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password);
  return options;
}

/* request(url | URL | options, [options], [callback]) */
function normalizeRequestArgs(args) {
  var list = Array.prototype.slice.call(args);
  var callback = typeof list[list.length - 1] === 'function' ? list.pop() : undefined;
  var first = list[0];
  var options;
  if (typeof first === 'string') options = urlOptions(new URL(first));
  else if (typeof URL === 'function' && first instanceof URL) options = urlOptions(first);
  else options = Object.assign({}, first || {});
  if (list[1] && typeof list[1] === 'object') Object.assign(options, list[1]);
  return { options: options, callback: callback };
}

/*
 * Incremental HTTP/1.x message parser for one socket. isRequest selects the request or the status
 * line; a response body without framing runs until the peer closes. Body bytes are handed to the
 * sink as they arrive, never buffered whole.
 */
function MessageParser(isRequest, method, sink) {
  this.isRequest = isRequest;
  this.method = method;
  this.sink = sink;
  this.buf = null;
  this.state = 'head';
  this.mode = 'none';
  this.remaining = 0;
  this.chunkState = 'size';
  this.done = false;
}

MessageParser.prototype.feed = function (chunk) {
  if (this.done || !chunk || chunk.length === 0) return;
  this.buf = this.buf ? Buffer.concat([this.buf, chunk]) : chunk;
  this.pump();
};

MessageParser.prototype.finish = function () {
  if (this.done) return;
  if (this.state === 'body' && this.mode === 'eof') this.complete();
  else this.fail(httpError(Error, 'ECONNRESET', 'socket hang up'));
};

MessageParser.prototype.complete = function () {
  if (this.done) return;
  this.done = true;
  this.sink.onEnd();
};

MessageParser.prototype.fail = function (err) {
  if (this.done) return;
  this.done = true;
  this.sink.onError(err);
};

MessageParser.prototype.pump = function () {
  while (!this.done) {
    var buf = this.buf;
    if (!buf || buf.length === 0) return;
    if (this.state === 'head') {
      var end = bufIndexOfHeadEnd(buf);
      if (end < 0) {
        if (buf.length > MAX_HEAD_BYTES) this.fail(httpError(Error, 'HPE_HEADER_OVERFLOW', 'Parse Error: Header overflow'));
        return;
      }
      var text = buf.toString('latin1', 0, end);
      this.buf = buf.length > end + 4 ? buf.subarray(end + 4) : null;
      var head = this.isRequest ? parseRequestHead(text) : parseStatusHead(text);
      if (!head) {
        this.fail(httpError(Error, 'HPE_INVALID_CONSTANT', 'Parse Error: Expected HTTP/'));
        return;
      }
      if (!this.isRequest && head.status >= 100 && head.status < 200 && head.status !== 101) continue;
      this.state = 'body';
      this.sink.onHead(head);
      var noBody = !this.isRequest && (this.method === 'HEAD' || head.status === 101 || head.status === 204 || head.status === 304);
      if (noBody) {
        this.complete();
        return;
      }
      var te = pairValue(head.pairs, 'transfer-encoding');
      var cl = pairValue(head.pairs, 'content-length');
      if (te !== undefined && /chunked/i.test(te)) {
        this.mode = 'chunked';
        this.chunkState = 'size';
      } else if (cl !== undefined) {
        this.mode = 'length';
        this.remaining = Number(cl);
        if (!(this.remaining >= 0) || this.remaining % 1 !== 0) {
          this.fail(httpError(Error, 'HPE_INVALID_CONTENT_LENGTH', 'Parse Error: Invalid Content-Length'));
          return;
        }
        if (this.remaining === 0) {
          this.complete();
          return;
        }
      } else {
        this.mode = this.isRequest ? 'none' : 'eof';
        if (this.mode === 'none') {
          this.complete();
          return;
        }
      }
      continue;
    }
    if (this.mode === 'eof') {
      this.buf = null;
      this.sink.onBody(buf);
      return;
    }
    if (this.mode === 'length') {
      var take = Math.min(this.remaining, buf.length);
      this.remaining -= take;
      this.buf = buf.length > take ? buf.subarray(take) : null;
      this.sink.onBody(buf.subarray(0, take));
      if (this.remaining === 0) this.complete();
      continue;
    }
    if (!this.chunkStep(buf)) return;
  }
};

/* One step of chunked decoding; false when more bytes are needed */
MessageParser.prototype.chunkStep = function (buf) {
  if (this.chunkState === 'size') {
    var lineEnd = bufIndexOfCrlf(buf, 0);
    if (lineEnd < 0) return false;
    var sizeText = buf.toString('latin1', 0, lineEnd).split(';')[0].trim();
    this.buf = buf.length > lineEnd + 2 ? buf.subarray(lineEnd + 2) : null;
    if (!/^[0-9a-fA-F]+$/.test(sizeText)) {
      this.fail(httpError(Error, 'HPE_INVALID_CHUNK_SIZE', 'Parse Error: Invalid character in chunk size'));
      return false;
    }
    this.remaining = parseInt(sizeText, 16);
    this.chunkState = this.remaining === 0 ? 'trailer' : 'data';
    return true;
  }
  if (this.chunkState === 'data') {
    var take = Math.min(this.remaining, buf.length);
    this.remaining -= take;
    this.buf = buf.length > take ? buf.subarray(take) : null;
    this.sink.onBody(buf.subarray(0, take));
    if (this.remaining === 0) this.chunkState = 'dataEnd';
    return true;
  }
  if (this.chunkState === 'dataEnd') {
    if (buf.length < 2) return false;
    this.buf = buf.length > 2 ? buf.subarray(2) : null;
    this.chunkState = 'size';
    return true;
  }
  var trailerEnd = bufIndexOfCrlf(buf, 0);
  if (trailerEnd < 0) return false;
  var trailer = buf.toString('latin1', 0, trailerEnd);
  this.buf = buf.length > trailerEnd + 2 ? buf.subarray(trailerEnd + 2) : null;
  if (trailer === '') this.complete();
  return true;
};

BF['http'] = function () {
  var EventEmitter = httpEmitterBase();
  var streams = requireBuiltin('stream');
  var Readable = streams.Readable;
  var Writable = streams.Writable;
  var net = requireBuiltin('net');

  function IncomingMessage(socket) {
    Readable.call(this, { read: function () {} });
    this.socket = socket || null;
    this.connection = this.socket;
    this.httpVersion = '1.1';
    this.httpVersionMajor = 1;
    this.httpVersionMinor = 1;
    this.method = null;
    this.url = '';
    this.statusCode = null;
    this.statusMessage = null;
    this.headers = {};
    this.rawHeaders = [];
    this.trailers = {};
    this.rawTrailers = [];
    this.complete = false;
    this.aborted = false;
    this.upgrade = false;
  }
  Object.setPrototypeOf(IncomingMessage.prototype, Readable.prototype);
  IncomingMessage.prototype.setTimeout = function setTimeout(ms, callback) {
    if (typeof callback === 'function') this.once('timeout', callback);
    return this;
  };
  /* Destroying a message that has ended must not close its socket: the auto-destroy after 'end' would end a keep-alive connection */
  IncomingMessage.prototype.destroy = function destroy(error) {
    if (this.socket && !this.socket.destroyed && !this.complete) this.socket.destroy();
    return Readable.prototype.destroy.call(this, error);
  };

  function OutgoingMessage(options) {
    Writable.call(this, options || {});
    this._hdr = Object.create(null);
    this._headSent = false;
    this._chunked = false;
    this._hasBody = true;
    this.socket = null;
    this.connection = null;
  }
  Object.setPrototypeOf(OutgoingMessage.prototype, Writable.prototype);
  Object.defineProperty(OutgoingMessage.prototype, 'headersSent', {
    get: function () {
      return this._headSent;
    },
    configurable: true
  });
  Object.defineProperty(OutgoingMessage.prototype, 'finished', {
    get: function () {
      return this.writableEnded;
    },
    configurable: true
  });
  OutgoingMessage.prototype.setHeader = function setHeader(name, value) {
    if (this._headSent) throw httpError(Error, 'ERR_HTTP_HEADERS_SENT', 'Cannot set headers after they are sent to the client');
    validateHeaderName(name);
    if (value === undefined) throw httpError(TypeError, 'ERR_HTTP_INVALID_HEADER_VALUE', 'Invalid value "undefined" for header "' + name + '"');
    this._hdr[String(name).toLowerCase()] = { name: String(name), value: value };
    return this;
  };
  OutgoingMessage.prototype.getHeader = function getHeader(name) {
    var entry = this._hdr[String(name).toLowerCase()];
    return entry ? entry.value : undefined;
  };
  OutgoingMessage.prototype.getHeaders = function getHeaders() {
    var out = Object.create(null);
    var names = Object.keys(this._hdr);
    for (var i = 0; i < names.length; i++) out[names[i]] = this._hdr[names[i]].value;
    return out;
  };
  OutgoingMessage.prototype.getHeaderNames = function getHeaderNames() {
    return Object.keys(this._hdr);
  };
  OutgoingMessage.prototype.getRawHeaderNames = function getRawHeaderNames() {
    var names = Object.keys(this._hdr);
    var out = [];
    for (var i = 0; i < names.length; i++) out.push(this._hdr[names[i]].name);
    return out;
  };
  OutgoingMessage.prototype.hasHeader = function hasHeader(name) {
    return hasOwn(this._hdr, String(name).toLowerCase());
  };
  OutgoingMessage.prototype.removeHeader = function removeHeader(name) {
    if (this._headSent) throw httpError(Error, 'ERR_HTTP_HEADERS_SENT', 'Cannot remove headers after they are sent to the client');
    delete this._hdr[String(name).toLowerCase()];
  };
  /* header lines as the message is written; the connection header is always close */
  OutgoingMessage.prototype._headerLines = function _headerLines() {
    var lines = [];
    var names = Object.keys(this._hdr);
    for (var i = 0; i < names.length; i++) {
      var key = names[i];
      if (key === 'connection') continue;
      var entry = this._hdr[key];
      var values = Array.isArray(entry.value) ? entry.value : [entry.value];
      for (var j = 0; j < values.length; j++) lines.push(entry.name + ': ' + values[j]);
    }
    return lines;
  };

  function ServerResponse(req) {
    OutgoingMessage.call(this, {});
    this.req = req || null;
    this.statusCode = 200;
    this.statusMessage = undefined;
    this.sendDate = true;
    this._hasBody = !(req && req.method === 'HEAD');
    this._keepAlive = false;
    this._keepAliveSeconds = 5;
  }
  Object.setPrototypeOf(ServerResponse.prototype, OutgoingMessage.prototype);
  ServerResponse.prototype.writeHead = function writeHead(statusCode, reason, headers) {
    if (this._headSent) throw httpError(Error, 'ERR_HTTP_HEADERS_SENT', 'Cannot write headers after they are sent to the client');
    var message = reason;
    var extra = headers;
    if (typeof reason !== 'string') {
      message = undefined;
      extra = reason;
    }
    var code = Number(statusCode);
    if (!(code >= 100 && code <= 999) || code % 1 !== 0) throw httpError(RangeError, 'ERR_HTTP_INVALID_STATUS_CODE', 'Invalid status code: ' + statusCode);
    this.statusCode = code;
    this.statusMessage = message;
    if (Array.isArray(extra)) {
      for (var i = 0; i + 1 < extra.length; i += 2) this.setHeader(extra[i], extra[i + 1]);
    } else if (extra && typeof extra === 'object') {
      var keys = Object.keys(extra);
      for (var j = 0; j < keys.length; j++) this.setHeader(keys[j], extra[keys[j]]);
    }
    this._commitHead(null);
    return this;
  };
  /* Writes the status line and headers. length is the body size when known (Content-Length), null means chunked. */
  ServerResponse.prototype._commitHead = function _commitHead(length) {
    if (this._headSent) return;
    this._headSent = true;
    var status = this.statusCode;
    var bodyAllowed = this._hasBody && status >= 200 && status !== 204 && status !== 304;
    var reason = this.statusMessage || HTTP_STATUS_CODES[String(status)] || 'unknown';
    var lines = ['HTTP/1.1 ' + status + ' ' + reason].concat(this._headerLines());
    var hasLength = hasOwn(this._hdr, 'content-length');
    var hasEncoding = hasOwn(this._hdr, 'transfer-encoding');
    if (this.sendDate && !hasOwn(this._hdr, 'date')) lines.push('Date: ' + new Date().toUTCString());
    var userConnection = hasOwn(this._hdr, 'connection') ? String(this._hdr.connection.value).toLowerCase() : '';
    if (userConnection.indexOf('close') >= 0) this._keepAlive = false;
    if (this._keepAlive) {
      lines.push('Connection: keep-alive');
      lines.push('Keep-Alive: timeout=' + this._keepAliveSeconds);
    } else {
      lines.push('Connection: close');
    }
    if (hasEncoding && /chunked/i.test(String(this._hdr['transfer-encoding'].value))) {
      this._chunked = bodyAllowed;
    } else if (bodyAllowed && !hasLength) {
      if (typeof length === 'number') {
        lines.push('Content-Length: ' + length);
      } else {
        this._chunked = true;
        lines.push('Transfer-Encoding: chunked');
      }
    }
    this._header = lines.join('\r\n') + '\r\n\r\n';
    this.socket.write(Buffer.from(this._header, 'latin1'));
  };
  ServerResponse.prototype._write = function _write(chunk, encoding, callback) {
    if (!this._headSent) this._commitHead(null);
    if (this._hasBody && chunk.length > 0) {
      if (this._chunked) {
        this.socket.write(Buffer.concat([Buffer.from(chunk.length.toString(16) + '\r\n', 'latin1'), chunk, Buffer.from('\r\n', 'latin1')]));
      } else {
        this.socket.write(chunk);
      }
    }
    callback();
  };
  ServerResponse.prototype._final = function _final(callback) {
    if (!this._headSent) this._commitHead(0);
    if (this._chunked) this.socket.write(Buffer.from('0\r\n\r\n', 'latin1'));
    callback();
  };
  ServerResponse.prototype.end = function end(chunk, encoding, callback) {
    if (typeof chunk === 'function') {
      callback = chunk;
      chunk = undefined;
      encoding = undefined;
    } else if (typeof encoding === 'function') {
      callback = encoding;
      encoding = undefined;
    }
    if (!this._headSent) this._commitHead(chunk === undefined || chunk === null ? 0 : byteLengthOf(chunk, encoding));
    return OutgoingMessage.prototype.end.call(this, chunk, encoding, callback);
  };
  ServerResponse.prototype.flushHeaders = function flushHeaders() {
    this._commitHead(null);
  };
  ServerResponse.prototype.writeContinue = function writeContinue(callback) {
    this.socket.write(Buffer.from('HTTP/1.1 100 Continue\r\n\r\n', 'latin1'));
    if (typeof callback === 'function') callback();
  };
  ServerResponse.prototype.setTimeout = function setTimeout(ms, callback) {
    if (typeof callback === 'function') this.once('timeout', callback);
    if (this.socket) this.socket.setTimeout(ms);
    return this;
  };
  ServerResponse.prototype.addTrailers = function addTrailers() {};
  ServerResponse.prototype.assignSocket = function assignSocket(socket) {
    if (socket._httpMessage) throw httpError(Error, 'ERR_HTTP_SOCKET_ASSIGNED', 'Socket already assigned');
    socket._httpMessage = this;
    this.socket = socket;
    this.connection = socket;
    this.emit('socket', socket);
  };
  ServerResponse.prototype.detachSocket = function detachSocket(socket) {
    if (socket._httpMessage === this) socket._httpMessage = null;
    this.socket = null;
    this.connection = null;
  };

  class ClientRequest extends OutgoingMessage {
    constructor(target, callback) {
      super({ autoDestroy: false });
      this.method = target.method;
      this.path = target.path;
      this.protocol = target.protocol;
      this.host = target.hostname;
      this.port = target.port;
      this.reusedSocket = false;
      this.maxHeadersCount = null;
      this.aborted = false;
      this._target = target;
      this._virtual = target.virtual;
      this._hostHeader = target.hostHeader;
      this._url = target.url;
      this._socket = null;
      this._res = null;
      this._parser = null;
      this._done = false;
      this._failed = false;
      this._closeEmitted = false;
      this._bodyParts = [];
      this._pendingWrites = [];
      this._timeoutMs = 0;
      var headers = target.headers || {};
      var names = Object.keys(headers);
      for (var i = 0; i < names.length; i++) this.setHeader(names[i], headers[names[i]]);
      if (target.auth && !this.hasHeader('authorization')) {
        this.setHeader('Authorization', 'Basic ' + Buffer.from(String(target.auth)).toString('base64'));
      }
      if (typeof callback === 'function') this.once('response', callback);
      if (target.timeout) this.setTimeout(target.timeout);
      if (this._virtual) this._connect();
    }
    /* The agent owns the socket: it hands over an idle one, opens one while the pool is under
       maxSockets, or queues this request until a socket frees up */
    _connect() {
      var agent = this._target.agent;
      if (agent && typeof agent.addRequest === 'function') {
        agent.addRequest(this, this._poolOptions());
        return;
      }
      this.onSocket(this._openSocket());
    }
    _poolOptions() {
      return Object.assign({ host: this._target.hostname, port: this._target.port }, this._tlsOptions() || {});
    }
    /* Bytes written before the agent assigns a socket wait in _pendingWrites */
    _out(chunk) {
      if (this._socket) this._socket.write(chunk);
      else this._pendingWrites.push(chunk);
    }
    onSocket(socket) {
      if (this._socket === socket) return;
      this._attach(socket);
      if (this._timeoutMs) socket.setTimeout(this._timeoutMs);
      var waiting = this._pendingWrites;
      this._pendingWrites = [];
      for (var i = 0; i < waiting.length; i++) socket.write(waiting[i]);
      var req = this;
      // Node assigns the socket on a later tick, so a 'socket' listener added after request() sees it
      queueMicrotask(function () { req.emit('socket', socket); });
    }
    /* Node asks for keep-alive whenever the agent can reuse the socket: a keep-alive agent, or one
       with a finite maxSockets whose sockets go back into the pool instead of being abandoned */
    _agentKeepsAlive() {
      var agent = this._target.agent;
      if (!agent) return false;
      return agent.keepAlive || agent.maxSockets !== Infinity;
    }
    /* https: the connection is tls.connect with the request's TLS options and Node's default servername */
    _tlsOptions() {
      var t = this._target;
      if (!t.tls) return null;
      if (!this._tlsResolved) {
        var opts = Object.assign({}, t.tls);
        if (opts.servername === undefined) opts.servername = httpsServerName(this.getHeader('host'), t.hostname);
        this._tlsResolved = opts;
      }
      return this._tlsResolved;
    }
    _openSocket() {
      var t = this._target;
      var where = { host: t.hostname, port: t.port, lookup: t.lookup, family: t.family };
      var tlsOpts = this._tlsOptions();
      if (!tlsOpts) return net.connect(where);
      return requireBuiltin('tls').connect(Object.assign({}, tlsOpts, where));
    }
    _poolKey() {
      return this._target.agent.getName(this._poolOptions());
    }
    /* Wires the response parser and this request's listeners to a socket, new or pooled */
    _attach(socket) {
      var req = this;
      this._socket = socket;
      this.socket = socket;
      this.connection = socket;
      this._released = false;
      this._parser = new MessageParser(false, this.method, {
        onHead: function (head) { req._onHead(head); },
        onBody: function (chunk) { if (req._res) req._res.push(chunk); },
        onEnd: function () { req._onEnd(); },
        onError: function (err) { req._fail(err); }
      });
      this._listeners = {
        data: function (chunk) { if (req._parser) req._parser.feed(chunk); },
        end: function () { if (req._parser) req._parser.finish(); },
        error: function (err) { req._fail(err); },
        close: function () { req._onSocketClose(); },
        timeout: function () { req.emit('timeout'); }
      };
      for (var name in this._listeners) socket.on(name, this._listeners[name]);
    }
    _detach() {
      var listeners = this._listeners;
      this._listeners = null;
      if (!listeners || !this._socket) return;
      for (var name in listeners) this._socket.removeListener(name, listeners[name]);
    }
    /* 101 Switching Protocols: the socket leaves HTTP and goes to the 'upgrade' listener, with the bytes after the head */
    _onUpgrade(head) {
      var socket = this._socket;
      var rest = this._parser ? this._parser.buf : null;
      if (this._parser) {
        this._parser.buf = null;
        this._parser.done = true;
      }
      if (this.listenerCount('upgrade') === 0) {
        this._destroySocket();
        return;
      }
      var res = new IncomingMessage(socket);
      res.statusCode = head.status;
      res.statusMessage = head.statusText;
      res.rawHeaders = head.pairs.slice();
      res.headers = headersFromPairs(head.pairs);
      res.req = this;
      res.upgrade = true;
      this._done = true;
      this._detach();
      this.emit('upgrade', res, socket, rest || Buffer.from(''));
    }
    _onHead(head) {
      if (head.status === 101) {
        this._onUpgrade(head);
        return;
      }
      var res = new IncomingMessage(this._socket);
      res.statusCode = head.status;
      res.statusMessage = head.statusText;
      res.rawHeaders = head.pairs.slice();
      res.headers = headersFromPairs(head.pairs);
      res.req = this;
      this._res = res;
      this.emit('response', res);
    }
    /* 'close' is delivered once: the stream's own emission on destroy must not repeat ours */
    emit(type) {
      if (type === 'close') {
        if (this._closeDelivered) return false;
        this._closeDelivered = true;
      }
      return super.emit.apply(this, arguments);
    }
    _onEnd() {
      this._done = true;
      if (this._res) {
        this._res.complete = true;
        this._res.push(null);
      }
      // settled on a later tick, so the response's 'end' reaches its listeners before this request closes
      var req = this;
      queueMicrotask(function () {
        if (req._keepsAlive()) req._release();
        else req._destroySocket();
      });
    }
    /* The socket may serve another request: an agent that reuses sockets, no close from either side, a framed (not close-delimited) body */
    _keepsAlive() {
      var agent = this._target.agent;
      if (!agent || !this._agentKeepsAlive() || !this._res || !this._socket || this._socket.destroyed) return false;
      if (!this._parser || this._parser.mode === 'eof') return false;
      var sent = hasOwn(this._hdr, 'connection') ? String(this._hdr.connection.value).toLowerCase() : '';
      if (sent.indexOf('close') >= 0 || sent.indexOf('upgrade') >= 0) return false;
      var answered = this._res.headers.connection;
      if (answered !== undefined) return String(answered).toLowerCase().indexOf('close') < 0;
      return this._res.httpVersionMinor === 1;
    }
    /* Hands a finished, reusable socket back to its agent's free list */
    _release() {
      var socket = this._socket;
      this._detach();
      this._parser = null;
      this._released = true;
      this._target.agent._releaseSocket(this._poolKey(), socket);
      var req = this;
      // the request closes after its response has ended, as Node orders them
      queueMicrotask(function () { req._emitClose(); });
    }
    _fail(err) {
      if (this._done || this._failed) return;
      this._failed = true;
      if (this._res) {
        this._res.aborted = true;
        this._res.emit('aborted');
        this._res.destroy();
      } else {
        this.emit('error', err);
      }
      this._destroySocket();
      this._emitClose();
    }
    _onSocketClose() {
      if (!this._done && !this._failed) this._fail(httpError(Error, 'ECONNRESET', 'socket hang up'));
      this._emitClose();
    }
    _emitClose() {
      if (this._closeEmitted) return;
      this._closeEmitted = true;
      this.emit('close');
    }
    _destroySocket() {
      if (this._released) return;
      if (this._socket && !this._socket.destroyed) this._socket.destroy();
    }
    _destroy(error, callback) {
      // A request destroyed before its response reports the hang-up, as Node does (abort() stays silent)
      var hangUp = !this._res && !this._done && !this._failed && !this.aborted;
      var failure = error || (hangUp ? httpError(Error, 'ECONNRESET', 'socket hang up') : null);
      this._failed = true;
      this._closeEmitted = true;
      this._destroySocket();
      callback(failure);
    }
    /* Writes the request line and headers once. length is the body size when known; null means chunked for body methods. */
    _sendHead(length) {
      if (this._headSent) return;
      this._headSent = true;
      var hdr = this._hdr;
      var bodyAllowed = !NO_BODY_METHODS[this.method];
      var lines = [this.method + ' ' + this.path + ' HTTP/1.1'];
      if (this._target.setHost !== false && !hasOwn(hdr, 'host')) lines.push('Host: ' + this._hostHeader);
      lines = lines.concat(this._headerLines());
      if (hasOwn(hdr, 'connection')) lines.push('Connection: ' + String(hdr.connection.value));
      else lines.push(this._agentKeepsAlive() ? 'Connection: keep-alive' : 'Connection: close');
      var hasLength = hasOwn(hdr, 'content-length');
      var hasEncoding = hasOwn(hdr, 'transfer-encoding');
      if (hasEncoding && /chunked/i.test(String(hdr['transfer-encoding'].value))) {
        this._chunked = true;
      } else if (!hasLength && !hasEncoding) {
        if (typeof length === 'number') {
          if (length > 0 || bodyAllowed) lines.push('Content-Length: ' + length);
        } else if (bodyAllowed) {
          this._chunked = true;
          lines.push('Transfer-Encoding: chunked');
        }
      }
      this._out(Buffer.from(lines.join('\r\n') + '\r\n\r\n', 'latin1'));
    }
    _write(chunk, encoding, callback) {
      if (this._virtual) {
        this._sendHead(null);
        if (this._chunked) {
          if (chunk.length > 0) this._out(Buffer.concat([Buffer.from(chunk.length.toString(16) + '\r\n', 'latin1'), chunk, Buffer.from('\r\n', 'latin1')]));
        } else {
          this._out(chunk);
        }
      } else {
        this._bodyParts.push(chunk);
      }
      callback();
    }
    _final(callback) {
      if (this._virtual) {
        this._sendHead(0);
        if (this._chunked) this._out(Buffer.from('0\r\n\r\n', 'latin1'));
        callback();
        return;
      }
      callback();
      this._dispatch(Buffer.concat(this._bodyParts));
    }
    end(chunk, encoding, callback) {
      if (typeof chunk === 'function') {
        callback = chunk;
        chunk = undefined;
        encoding = undefined;
      } else if (typeof encoding === 'function') {
        callback = encoding;
        encoding = undefined;
      }
      if (this._virtual && !this._headSent) this._sendHead(chunk === undefined || chunk === null ? 0 : byteLengthOf(chunk, encoding));
      return super.end(chunk, encoding, callback);
    }
    /* External host: the whole request goes to the 'http.fetch' capability, and the response is replayed as one message */
    _dispatch(body) {
      var req = this;
      var headers = {};
      var names = Object.keys(this._hdr);
      for (var i = 0; i < names.length; i++) headers[this._hdr[names[i]].name] = this._hdr[names[i]].value;
      var payload = {
        url: this._url,
        method: this.method,
        headers: headers,
        body: body.length > 0 ? body.toString('base64') : null
      };
      callOp('http.fetch', payload).then(function (result) {
        if (req.destroyed || req._failed) return;
        req._done = true;
        var pairs = [];
        var keys = Object.keys(result.headers || {});
        for (var k = 0; k < keys.length; k++) {
          var value = result.headers[keys[k]];
          if (Array.isArray(value)) {
            for (var v = 0; v < value.length; v++) pairs.push(keys[k], value[v]);
          } else {
            pairs.push(keys[k], value);
          }
        }
        req._onHead({ status: result.status, statusText: result.statusText || '', pairs: pairs });
        if (result.body) req._res.push(Buffer.from(result.body, 'base64'));
        req._res.complete = true;
        req._res.push(null);
        req._emitClose();
      }, function (err) {
        if (req.destroyed || req._failed) return;
        req._failed = true;
        req.emit('error', err);
        req._emitClose();
      });
    }
    setTimeout(ms, callback) {
      if (typeof callback === 'function') this.once('timeout', callback);
      this._timeoutMs = Number(ms) || 0;
      if (this._socket) this._socket.setTimeout(this._timeoutMs);
      return this;
    }
    setNoDelay() {
      return this;
    }
    setSocketKeepAlive() {
      return this;
    }
    flushHeaders() {
      if (this._virtual) this._sendHead(null);
    }
    abort() {
      if (this.aborted) return;
      this.aborted = true;
      this.emit('abort');
      this.destroy();
    }
  }

  class Agent extends EventEmitter {
    constructor(options) {
      super();
      this.options = Object.assign({}, options || {});
      this.keepAlive = !!(options && options.keepAlive);
      this.keepAliveMsecs = (options && options.keepAliveMsecs) || 1000;
      this.maxSockets = (options && options.maxSockets) || Infinity;
      this.maxFreeSockets = (options && options.maxFreeSockets) || 256;
      this.maxTotalSockets = (options && options.maxTotalSockets) || Infinity;
      this.scheduling = (options && options.scheduling) || 'lifo';
      this.totalSocketCount = 0;
      this.sockets = Object.create(null);
      this.freeSockets = Object.create(null);
      this.requests = Object.create(null);
      this.defaultPort = 80;
      this.protocol = 'http:';
    }
    destroy() {
      var names = Object.keys(this.freeSockets);
      for (var i = 0; i < names.length; i++) {
        var idle = this.freeSockets[names[i]].slice();
        for (var j = 0; j < idle.length; j++) {
          this._dropFree(names[i], idle[j]);
          idle[j].destroy();
        }
      }
    }
    createConnection(options, callback) {
      return net.connect(options, callback);
    }
    /* Node's addRequest: an idle socket serves the request at once, a new one is opened while the
       name stays under maxSockets, and the rest wait in requests[name] until a socket frees up */
    addRequest(req, options) {
      var name = this.getName(options);
      var pooled = this._takeFreeSocket(name);
      if (pooled) {
        req.reusedSocket = true;
        this._track(name, pooled, options);
        req.onSocket(pooled);
        return;
      }
      if (!this._canOpen(name)) {
        var queue = this.requests[name] || (this.requests[name] = []);
        queue.push(req);
        return;
      }
      this.createSocket(req, options);
    }
    /* A name never holds more than maxSockets connections at once, busy and idle counted together */
    _canOpen(name) {
      var busy = this.sockets[name] ? this.sockets[name].length : 0;
      var idle = this.freeSockets[name] ? this.freeSockets[name].length : 0;
      if (busy + idle >= this.maxSockets) return false;
      if (this.maxTotalSockets !== Infinity && this.totalSocketCount >= this.maxTotalSockets) return false;
      return true;
    }
    createSocket(req, options) {
      var socket = req._openSocket();
      this._track(this.getName(options), socket, options);
      req.onSocket(socket);
      return socket;
    }
    _track(name, socket, options) {
      var list = this.sockets[name] || (this.sockets[name] = []);
      if (list.indexOf(socket) >= 0) return;
      list.push(socket);
      this.totalSocketCount += 1;
      socket._agentOptions = options;
      var self = this;
      if (!socket._agentClose) {
        socket._agentClose = function () { self.removeSocket(socket, options); };
        socket.on('close', socket._agentClose);
      }
    }
    _untrack(name, socket) {
      var list = this.sockets[name];
      if (list) {
        var index = list.indexOf(socket);
        if (index >= 0) {
          list.splice(index, 1);
          this.totalSocketCount -= 1;
        }
        if (list.length === 0) delete this.sockets[name];
      }
      if (socket._agentClose) {
        socket.removeListener('close', socket._agentClose);
        socket._agentClose = null;
      }
    }
    removeSocket(socket, options) {
      var name = this.getName(options);
      this._untrack(name, socket);
      this._dropFree(name, socket);
      this._drain(name, options);
    }
    /* Requests that waited for a socket: an idle one is handed over first, then a new one while the pool has room */
    _drain(name, options) {
      var queue = this.requests[name];
      if (!queue) return;
      while (queue.length > 0) {
        var req = queue[0];
        if (req.destroyed || req._failed) {
          queue.shift();
          continue;
        }
        var pooled = this._takeFreeSocket(name);
        if (pooled) {
          queue.shift();
          req.reusedSocket = true;
          this._track(name, pooled, options);
          req.onSocket(pooled);
          continue;
        }
        if (!this._canOpen(name)) break;
        queue.shift();
        this.createSocket(req, options);
      }
      if (queue.length === 0) delete this.requests[name];
    }
    /* A finished socket waits here for the next request to the same name, as Node's 'free' handler does */
    _releaseSocket(name, socket) {
      var options = socket._agentOptions || {};
      this._untrack(name, socket);
      this.emit('free', socket, options);
      var queue = this.requests[name];
      if (queue && queue.length > 0) {
        var req = queue.shift();
        if (queue.length === 0) delete this.requests[name];
        this._track(name, socket, options);
        req.reusedSocket = true;
        req.onSocket(socket);
        return;
      }
      var list = this.freeSockets[name] || (this.freeSockets[name] = []);
      if (list.length >= this.maxFreeSockets) {
        socket.destroy();
        return;
      }
      list.push(socket);
      socket.setTimeout(0);
      socket.unref();
      var agent = this;
      var drop = function () {
        agent._dropFree(name, socket);
        socket.destroy();
      };
      socket._agentWatch = {
        close: function () { agent._dropFree(name, socket); },
        end: drop,
        error: drop,
        timeout: drop
      };
      for (var key in socket._agentWatch) socket.on(key, socket._agentWatch[key]);
    }
    _takeFreeSocket(name) {
      var list = this.freeSockets[name];
      while (list && list.length > 0) {
        var socket = this.scheduling === 'fifo' ? list[0] : list[list.length - 1];
        this._dropFree(name, socket);
        if (!socket.destroyed) {
          socket.ref();
          return socket;
        }
        list = this.freeSockets[name];
      }
      return undefined;
    }
    _dropFree(name, socket) {
      var list = this.freeSockets[name];
      if (list) {
        var index = list.indexOf(socket);
        if (index >= 0) list.splice(index, 1);
        if (list.length === 0) delete this.freeSockets[name];
      }
      var watch = socket._agentWatch;
      if (watch) {
        socket._agentWatch = null;
        for (var key in watch) socket.removeListener(key, watch[key]);
      }
    }
    getName(options) {
      return (options.host || 'localhost') + ':' + (options.port || '') + ':' + (options.localAddress || '');
    }
  }

  var globalAgent = new Agent({ keepAlive: true, scheduling: 'lifo', timeout: 5000 });

  /* The agent of a request: the protocol's globalAgent by default, a fresh non-pooling Agent for false, a caller's Agent as given */
  function resolveAgent(value, fallback) {
    var standard = fallback || globalAgent;
    if (value === undefined || value === null) return standard;
    if (value === false) return new Agent();
    return typeof value === 'object' ? value : standard;
  }

  /* TLS options an https request passes to tls.connect; the agent's own options win, as in Node's Agent.addRequest */
  var HTTPS_TLS_KEYS = ['ca', 'cert', 'key', 'pfx', 'passphrase', 'ciphers', 'ecdhCurve', 'minVersion', 'maxVersion',
    'secureProtocol', 'secureContext', 'rejectUnauthorized', 'servername', 'checkServerIdentity', 'ALPNProtocols',
    'honorCipherOrder', 'sigalgs', 'allowPartialTrustChain', 'session', 'highWaterMark'];

  function httpsTlsOptions(options, agent) {
    var merged = Object.assign({}, options, agent && typeof agent === 'object' && agent.options ? agent.options : {});
    var out = {};
    for (var i = 0; i < HTTPS_TLS_KEYS.length; i++) {
      if (merged[HTTPS_TLS_KEYS[i]] !== undefined) out[HTTPS_TLS_KEYS[i]] = merged[HTTPS_TLS_KEYS[i]];
    }
    return out;
  }

  /* Node's calculateServerName: the Host header's name (or the host), never an IP address */
  function httpsServerName(hostHeader, hostname) {
    var name = hostname;
    if (typeof hostHeader === 'string' && hostHeader !== '') {
      if (hostHeader.charAt(0) === '[') {
        var close = hostHeader.indexOf(']');
        name = close === -1 ? hostHeader : hostHeader.slice(1, close);
      } else {
        name = hostHeader.split(':')[0];
      }
    }
    return net.isIP(name) ? '' : name;
  }

  function createClientRequest(options, callback, defaultProtocol, defaultAgent) {
    var protocol = options.protocol || defaultProtocol;
    if (protocol !== defaultProtocol) {
      throw httpError(Error, 'ERR_INVALID_PROTOCOL', 'Protocol "' + protocol + '" not supported. Expected "' + defaultProtocol + '"');
    }
    var rawHost = options.hostname || (typeof options.host === 'string' ? options.host.replace(/:\d+$/, '') : '') || 'localhost';
    var hostname = rawHost.charAt(0) === '[' ? rawHost.slice(1, -1) : rawHost;
    var defaultPort = defaultProtocol === 'https:' ? 443 : 80;
    var port = options.port !== undefined && options.port !== null && options.port !== '' ? Number(options.port) : defaultPort;
    var path = options.path ? String(options.path) : '/';
    var hostHeader = (hostname.indexOf(':') >= 0 ? '[' + hostname + ']' : hostname) + (port === defaultPort ? '' : ':' + port);
    return new ClientRequest({
      method: String(options.method || 'GET').toUpperCase(),
      path: path,
      protocol: defaultProtocol,
      hostname: hostname,
      port: port,
      headers: options.headers,
      auth: options.auth,
      timeout: options.timeout,
      setHost: options.setHost,
      agent: resolveAgent(options.agent, defaultAgent),
      lookup: options.lookup,
      family: options.family,
      virtual: routesToGuest(hostname),
      hostHeader: hostHeader,
      url: defaultProtocol + '//' + hostHeader + path,
      tls: defaultProtocol === 'https:' ? httpsTlsOptions(options, resolveAgent(options.agent, defaultAgent)) : null
    }, callback);
  }

  function request() {
    var args = normalizeRequestArgs(arguments);
    return createClientRequest(args.options, args.callback, 'http:');
  }

  function get() {
    var req = request.apply(null, arguments);
    req.end();
    return req;
  }

  /*
   * One accepted socket. Requests are parsed one at a time: a keep-alive response hands the socket to the
   * next request, a close response ends it, and an Upgrade request hands the socket and the bytes after its
   * head to the server's 'upgrade' listener. Bytes that arrive while a response is written wait in pending.
   */
  function serveSocket(server, socket) {
    var state = {
      socket: socket,
      parser: null,
      req: null,
      res: null,
      pending: [],
      responding: false,
      upgraded: false,
      dead: false,
      peerEnded: false,
      idleTimer: null
    };
    server._connStates.add(state);

    function makeSink() {
      return {
        onHead: function (head) { startRequest(head); },
        onBody: function (chunk) { if (state.req) state.req.push(chunk); },
        onEnd: function () {
          if (state.req) {
            state.req.complete = true;
            state.req.push(null);
          }
        },
        onError: function (err) { rejectRequest(err); }
      };
    }

    function feedParser(chunk) {
      state.parser.feed(chunk);
      if (state.parser.done && state.parser.buf) {
        state.pending.push(state.parser.buf);
        state.parser.buf = null;
      }
    }

    function startRequest(head) {
      var req = new IncomingMessage(socket);
      req.method = head.method;
      req.url = head.url;
      req.httpVersion = '1.' + head.minor;
      req.httpVersionMinor = head.minor;
      req.rawHeaders = head.pairs.slice();
      req.headers = headersFromPairs(head.pairs);
      state.req = req;
      if (isUpgradeHead(head) && server.listenerCount('upgrade') > 0) {
        req.upgrade = true;
        var parts = [];
        if (state.parser.buf) parts.push(state.parser.buf);
        state.parser.buf = null;
        state.parser.done = true;
        state.upgraded = true;
        state.pending = [];
        cancelIdle();
        server._connStates.delete(state);
        socket.removeListener('data', onData);
        socket.removeListener('end', onEnd);
        socket.removeListener('error', onSocketError);
        socket.removeListener('close', onClose);
        socket.removeListener('timeout', onTimeout);
        server.emit('upgrade', req, socket, parts.length > 0 ? Buffer.concat(parts) : Buffer.from(''));
        return;
      }
      var res = new ServerResponse(req);
      res.socket = socket;
      res.connection = socket;
      res._keepAlive = wantsKeepAlive(head) && !server._closing;
      res._keepAliveSeconds = Math.round(server.keepAliveTimeout / 1000) || 5;
      state.res = res;
      state.responding = true;
      res.on('finish', function () { onResponseDone(res); });
      var expectation = pairValue(head.pairs, 'expect');
      if (expectation !== undefined && expectation.toLowerCase() === '100-continue') {
        socket.write(Buffer.from('HTTP/1.1 100 Continue\r\n\r\n', 'latin1'));
      }
      server.emit('request', req, res);
    }

    function onResponseDone(res) {
      if (state.res !== res) return;
      state.res = null;
      state.responding = false;
      if (state.dead || state.upgraded) return;
      if (!res._keepAlive || socket.destroyed) {
        closeSocket(socket);
        return;
      }
      queueMicrotask(pump);
    }

    /* Starts parsing the next request once the socket is idle and bytes are waiting for it */
    function pump() {
      if (state.dead || state.upgraded || state.responding) return;
      if (state.parser && !state.parser.done) return;
      if (state.pending.length === 0) {
        if (state.peerEnded) closeSocket(socket);
        else armIdle();
        return;
      }
      cancelIdle();
      var queued = state.pending;
      state.pending = [];
      state.parser = new MessageParser(true, null, makeSink());
      for (var i = 0; i < queued.length; i++) {
        if (state.parser.done) state.pending.push(queued[i]);
        else feedParser(queued[i]);
      }
      if (state.upgraded && state.pending.length > 0) {
        // bytes queued behind an upgrade request reach the upgraded socket as data, once its listeners are attached
        var late = state.pending;
        state.pending = [];
        queueMicrotask(function () {
          for (var k = 0; k < late.length; k++) socket.emit('data', late[k]);
        });
      }
    }

    function onData(chunk) {
      if (state.dead || state.upgraded) return;
      if (state.parser && !state.parser.done) feedParser(chunk);
      else state.pending.push(chunk);
      pump();
    }

    function onEnd() {
      state.peerEnded = true;
      if (state.dead || state.upgraded) return;
      if (state.parser && !state.parser.done) {
        state.parser.finish();
        return;
      }
      if (!state.responding && state.pending.length === 0) closeSocket(socket);
    }

    function rejectRequest(err) {
      if (err && err.code === 'ECONNRESET') {
        closeSocket(socket);
        return;
      }
      var status = err && err.code === 'HPE_HEADER_OVERFLOW' ? 431 : 400;
      server.emit('clientError', err, socket);
      if (!socket.destroyed) {
        socket.write(Buffer.from('HTTP/1.1 ' + status + ' ' + HTTP_STATUS_CODES[String(status)] + '\r\nConnection: close\r\n\r\n', 'latin1'));
      }
      closeSocket(socket);
    }

    function onSocketError(err) {
      server.emit('clientError', err, socket);
      socket.destroy();
    }

    function onClose() {
      state.dead = true;
      cancelIdle();
      server._connStates.delete(state);
      if (state.res && !state.res.writableFinished) state.res.destroy();
    }

    function onTimeout() {
      if (state.res) state.res.emit('timeout');
    }

    /* A keep-alive socket with no request for keepAliveTimeout ms is closed; the timer does not keep the process alive */
    function armIdle() {
      cancelIdle();
      var ms = server.keepAliveTimeout;
      if (!(ms > 0)) return;
      state.idleTimer = setTimeout(function () {
        state.idleTimer = null;
        if (!state.responding && !state.upgraded && !state.dead) closeSocket(socket);
      }, ms);
      if (state.idleTimer && typeof state.idleTimer.unref === 'function') state.idleTimer.unref();
    }

    function cancelIdle() {
      if (state.idleTimer) {
        clearTimeout(state.idleTimer);
        state.idleTimer = null;
      }
    }

    socket.on('data', onData);
    socket.on('end', onEnd);
    socket.on('error', onSocketError);
    socket.on('close', onClose);
    socket.on('timeout', onTimeout);
  }

  class Server extends EventEmitter {
    constructor(options, listener) {
      super();
      if (typeof options === 'function') {
        listener = options;
        options = undefined;
      }
      this.timeout = 0;
      this.keepAliveTimeout = 5000;
      this.headersTimeout = 60000;
      this.requestTimeout = 300000;
      this.maxHeadersCount = null;
      this.maxRequestsPerSocket = 0;
      this._notifiedPort = null;
      this._connStates = new Set();
      this._closing = false;
      this._secure = false;
      this._net = this._createNetServer(options);
      var server = this;
      this._net.on('connection', function (socket) {
        server.emit('connection', socket);
        if (!server._secure) serveSocket(server, socket);
      });
      if (this._secure) {
        /* https: requests start once the TLS handshake completes. As https.Server is a tls.Server in Node, the
           request handling is its first 'secureConnection' listener and the event reaches user listeners after it. */
        this._net.on('secureConnection', function (socket) {
          serveSocket(server, socket);
          server.emit('secureConnection', socket);
        });
        this._net.on('tlsClientError', function (err, socket) { server.emit('tlsClientError', err, socket); });
        this._net.on('keylog', function (line, socket) { server.emit('keylog', line, socket); });
      }
      this._net.on('listening', function () { server._onListening(); });
      this._net.on('error', function (err) { server.emit('error', err); });
      this._net.on('close', function () { server._onClosed(); });
      if (typeof listener === 'function') this.on('request', listener);
    }
    get listening() {
      return this._net.listening;
    }
    /* allowHalfOpen: a client's end of its request must not close our side before we respond */
    _createNetServer() {
      return net.createServer({ allowHalfOpen: true });
    }
    listen() {
      this._closing = false;
      var args = Array.prototype.slice.call(arguments);
      var callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined;
      if (typeof callback === 'function') this.once('listening', callback);
      this._net.listen.apply(this._net, args);
      return this;
    }
    close(callback) {
      this._closing = true;
      this.closeIdleConnections();
      this._net.close(callback);
      return this;
    }
    /* Closes the keep-alive connections that wait for a request, as Node does on close */
    closeIdleConnections() {
      var states = Array.from(this._connStates);
      for (var i = 0; i < states.length; i++) {
        var state = states[i];
        if (!state.responding && !state.upgraded && !state.dead && (!state.parser || state.parser.done) && state.pending.length === 0) {
          state.socket.destroy();
        }
      }
    }
    address() {
      return this._net.address();
    }
    getConnections(callback) {
      this._net.getConnections(callback);
      return this;
    }
    setTimeout(ms, callback) {
      if (typeof callback === 'function') this.on('timeout', callback);
      this.timeout = Number(ms) || 0;
      return this;
    }
    ref() {
      this._net.ref();
      return this;
    }
    unref() {
      this._net.unref();
      return this;
    }
    /* The host's preview path speaks plain HTTP, so only plain servers are announced to it */
    _onListening() {
      var address = this._net.address();
      this._notifiedPort = address ? address.port : 0;
      if (!this._secure) callCap('http.serverListening', { port: this._notifiedPort });
      this.emit('listening');
    }
    _onClosed() {
      if (this._notifiedPort !== null) {
        var port = this._notifiedPort;
        this._notifiedPort = null;
        if (!this._secure) callCap('http.serverClosed', { port: port });
      }
      this.emit('close');
    }
  }

  function createServer(options, listener) {
    return new Server(options, listener);
  }

  HTTP_CORE = {
    Server: Server,
    ClientRequest: ClientRequest,
    IncomingMessage: IncomingMessage,
    ServerResponse: ServerResponse,
    Agent: Agent,
    normalizeArgs: normalizeRequestArgs,
    createClientRequest: createClientRequest
  };

  return {
    Agent: Agent,
    ClientRequest: ClientRequest,
    IncomingMessage: IncomingMessage,
    OutgoingMessage: OutgoingMessage,
    Server: Server,
    ServerResponse: ServerResponse,
    createServer: createServer,
    request: request,
    get: get,
    globalAgent: globalAgent,
    METHODS: HTTP_METHODS.slice(),
    STATUS_CODES: Object.assign({}, HTTP_STATUS_CODES),
    maxHeaderSize: MAX_HEAD_BYTES,
    setMaxIdleHTTPParsers: function () {},
    validateHeaderName: validateHeaderName,
    validateHeaderValue: function (name, value) {
      validateHeaderName(name);
      if (value === undefined) throw httpError(TypeError, 'ERR_HTTP_INVALID_HEADER_VALUE', 'Invalid value "undefined" for header "' + name + '"');
    }
  };
};

BF['https'] = function () {
  var http = requireBuiltin('http');
  var tls = requireBuiltin('tls');
  var core = HTTP_CORE;
  /* The TLS options Node's https.Agent folds into a connection pool name */
  var NAME_KEYS = ['ca', 'cert', 'ciphers', 'key', 'pfx', 'rejectUnauthorized', 'servername', 'minVersion', 'maxVersion',
    'secureProtocol', 'crl', 'honorCipherOrder', 'ecdhCurve', 'dhparam', 'secureOptions', 'sessionIdContext', 'sigalgs',
    'privateKeyIdentifier', 'privateKeyEngine'];

  class Agent extends http.Agent {
    constructor(options) {
      super(options);
      this.defaultPort = 443;
      this.protocol = 'https:';
    }
    createConnection(options, callback) {
      return tls.connect(options, callback);
    }
    getName(options) {
      var o = options || {};
      var name = super.getName(o);
      for (var i = 0; i < NAME_KEYS.length; i++) {
        var v = o[NAME_KEYS[i]];
        name += ':' + (v === undefined || v === null ? '' : String(v));
      }
      return name;
    }
  }

  var globalAgent = new Agent({ keepAlive: true });

  /* https.Server is http.Server over a tls.Server: requests start at 'secureConnection' */
  class Server extends http.Server {
    constructor(options, listener) {
      if (typeof options === 'function') {
        listener = options;
        options = undefined;
      }
      super(options || {}, listener);
    }
    _createNetServer(options) {
      this._secure = true;
      return tls.createServer(Object.assign({}, options || {}, { allowHalfOpen: true }));
    }
    addContext(hostname, context) {
      this._net.addContext(hostname, context);
    }
    setSecureContext(options) {
      this._net.setSecureContext(options);
    }
    getTicketKeys() {
      return this._net.getTicketKeys();
    }
    setTicketKeys(keys) {
      this._net.setTicketKeys(keys);
    }
  }

  function createServer(options, listener) {
    return new Server(options, listener);
  }

  function request() {
    var args = core.normalizeArgs(arguments);
    return core.createClientRequest(args.options, args.callback, 'https:', globalAgent);
  }

  function get() {
    var req = request.apply(null, arguments);
    req.end();
    return req;
  }

  return {
    Agent: Agent,
    Server: Server,
    createServer: createServer,
    request: request,
    get: get,
    globalAgent: globalAgent
  };
};
})();
`;
