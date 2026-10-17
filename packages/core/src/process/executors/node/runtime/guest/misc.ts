/**
 * Guest-side remaining built-ins: os, timers, timers/promises, url, crypto, module,
 * tty and http (the existing in-memory network bridge). Plain JavaScript inside a
 * String.raw snippet.
 */
export const MISC_SRC = String.raw`
BF.os = function () {
  var signals = {
    SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGIOT: 6, SIGBUS: 7,
    SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14,
    SIGTERM: 15, SIGCHLD: 17, SIGSTKFLT: 16, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21,
    SIGTTOU: 22, SIGURG: 23, SIGXCPU: 24, SIGXFSZ: 25, SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28,
    SIGIO: 29, SIGPOLL: 29, SIGPWR: 30, SIGSYS: 31
  };
  var errno = {
    E2BIG: 7, EACCES: 13, EADDRINUSE: 98, EADDRNOTAVAIL: 99, EAFNOSUPPORT: 97, EAGAIN: 11,
    EALREADY: 114, EBADF: 9, EBADMSG: 74, EBUSY: 16, ECANCELED: 125, ECHILD: 10,
    ECONNABORTED: 103, ECONNREFUSED: 111, ECONNRESET: 104, EDEADLK: 35, EDESTADDRREQ: 89,
    EDOM: 33, EDQUOT: 122, EEXIST: 17, EFAULT: 14, EFBIG: 27, EHOSTUNREACH: 113, EIDRM: 43,
    EILSEQ: 84, EINPROGRESS: 115, EINTR: 4, EINVAL: 22, EIO: 5, EISCONN: 106, EISDIR: 21,
    ELOOP: 40, EMFILE: 24, EMLINK: 31, EMSGSIZE: 90, EMULTIHOP: 72, ENAMETOOLONG: 36,
    ENETDOWN: 100, ENETRESET: 102, ENETUNREACH: 101, ENFILE: 23, ENOBUFS: 105, ENODATA: 61,
    ENODEV: 19, ENOENT: 2, ENOEXEC: 8, ENOLCK: 37, ENOLINK: 67, ENOMEM: 12, ENOMSG: 42,
    ENOPROTOOPT: 92, ENOSPC: 28, ENOSR: 63, ENOSTR: 60, ENOSYS: 38, ENOTCONN: 107, ENOTDIR: 20,
    ENOTEMPTY: 39, ENOTSOCK: 88, ENOTSUP: 95, ENOTTY: 25, ENXIO: 6, EOPNOTSUPP: 95,
    EOVERFLOW: 75, EPERM: 1, EPIPE: 32, EPROTO: 71, EPROTONOSUPPORT: 93, EPROTOTYPE: 91,
    ERANGE: 34, EROFS: 30, ESPIPE: 29, ESRCH: 3, ESTALE: 116, ETIME: 62, ETIMEDOUT: 110,
    ETXTBSY: 26, EWOULDBLOCK: 11, EXDEV: 18
  };
  return {
    EOL: '\n',
    devNull: '/dev/null',
    platform: function () { return 'linux'; },
    type: function () { return 'Linux'; },
    arch: function () { return 'x64'; },
    release: function () { return '6.0.0'; },
    hostname: function () { return 'localhost'; },
    homedir: function () { return (globalThis.process && process.env.HOME) || '/home'; },
    tmpdir: function () { return '/tmp'; },
    endianness: function () { return 'LE'; },
    cpus: function () { return []; },
    availableParallelism: function () { return 1; },
    totalmem: function () { return 4294967296; },
    freemem: function () { return 2147483648; },
    uptime: function () { return 0; },
    loadavg: function () { return [0, 0, 0]; },
    networkInterfaces: function () { return {}; },
    userInfo: function () { return { username: 'user', uid: 1000, gid: 1000, shell: '/bin/sh', homedir: '/home' }; },
    constants: { signals: signals, errno: errno }
  };
};

BF.timers = function () {
  return {
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimer,
    setInterval: setIntervalImpl,
    clearInterval: clearTimer,
    setImmediate: setImmediateImpl,
    clearImmediate: clearTimer
  };
};

BF['timers/promises'] = function () {
  function Scheduler() {}
  Scheduler.prototype.wait = function (delay, options) {
    return new Promise(function (resolve) {
      setTimeoutImpl(function () { resolve(undefined); }, delay);
    });
  };
  Scheduler.prototype.yield = function () {
    return new Promise(function (resolve) {
      setImmediateImpl(function () { resolve(undefined); });
    });
  };
  /* one value per interval tick; ticks that elapse while the consumer is busy are yielded in turn */
  async function* intervalValues(delay, value) {
    var pending = 0;
    var wake = null;
    var handle = setIntervalImpl(function () {
      pending++;
      if (wake !== null) {
        var resume = wake;
        wake = null;
        resume();
      }
    }, delay);
    try {
      while (true) {
        if (pending === 0) {
          await new Promise(function (resolve) { wake = resolve; });
        }
        while (pending > 0) {
          pending--;
          yield value;
        }
      }
    } finally {
      clearTimer(handle);
    }
  }
  return {
    setTimeout: function (ms, value) {
      return new Promise(function (resolve) {
        setTimeoutImpl(function () { resolve(value); }, ms);
      });
    },
    setImmediate: function (value) {
      return new Promise(function (resolve) {
        setImmediateImpl(function () { resolve(value); });
      });
    },
    setInterval: function (delay, value) {
      return intervalValues(delay, value);
    },
    scheduler: new Scheduler()
  };
};

BF.url = function () {
  var P = requireBuiltin('path');

  function decodeComponent(s) {
    try {
      return decodeURIComponent(s.replace(/\+/g, ' '));
    } catch (err) {
      return s;
    }
  }

  function encodeComponent(s) {
    return encodeURIComponent(s).replace(/%20/g, '+');
  }

  function URLSearchParams(init) {
    this._list = [];
    if (typeof init === 'string') {
      var s = init.charAt(0) === '?' ? init.slice(1) : init;
      if (s.length) {
        var pairs = s.split('&');
        for (var i = 0; i < pairs.length; i++) {
          if (!pairs[i]) continue;
          var idx = pairs[i].indexOf('=');
          var k = idx >= 0 ? pairs[i].slice(0, idx) : pairs[i];
          var v = idx >= 0 ? pairs[i].slice(idx + 1) : '';
          this._list.push([decodeComponent(k), decodeComponent(v)]);
        }
      }
    } else if (init && typeof init === 'object') {
      var keys = Object.keys(init);
      for (var j = 0; j < keys.length; j++) this._list.push([keys[j], String(init[keys[j]])]);
    }
  }
  URLSearchParams.prototype.append = function (k, v) {
    this._list.push([String(k), String(v)]);
  };
  URLSearchParams.prototype.set = function (k, v) {
    var key = String(k);
    var found = false;
    var out = [];
    for (var i = 0; i < this._list.length; i++) {
      if (this._list[i][0] === key) {
        if (!found) out.push([key, String(v)]);
        found = true;
      } else {
        out.push(this._list[i]);
      }
    }
    if (!found) out.push([key, String(v)]);
    this._list = out;
  };
  URLSearchParams.prototype.get = function (k) {
    for (var i = 0; i < this._list.length; i++) {
      if (this._list[i][0] === String(k)) return this._list[i][1];
    }
    return null;
  };
  URLSearchParams.prototype.getAll = function (k) {
    return this._list.filter(function (pair) { return pair[0] === String(k); }).map(function (pair) { return pair[1]; });
  };
  URLSearchParams.prototype.has = function (k) {
    return this._list.some(function (pair) { return pair[0] === String(k); });
  };
  URLSearchParams.prototype.delete = function (k) {
    this._list = this._list.filter(function (pair) { return pair[0] !== String(k); });
  };
  URLSearchParams.prototype.forEach = function (cb, thisArg) {
    for (var i = 0; i < this._list.length; i++) cb.call(thisArg, this._list[i][1], this._list[i][0], this);
  };
  URLSearchParams.prototype.keys = function () {
    return this._list.map(function (pair) { return pair[0]; });
  };
  URLSearchParams.prototype.values = function () {
    return this._list.map(function (pair) { return pair[1]; });
  };
  URLSearchParams.prototype.entries = function () {
    return this._list.map(function (pair) { return [pair[0], pair[1]]; });
  };
  URLSearchParams.prototype[Symbol.iterator] = URLSearchParams.prototype.entries;
  URLSearchParams.prototype.toString = function () {
    return this._list.map(function (pair) { return encodeComponent(pair[0]) + '=' + encodeComponent(pair[1]); }).join('&');
  };

  var SCHEME_RE = /^([A-Za-z][A-Za-z0-9+.\-]*:)/;
  var DEFAULT_PORTS = { 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443', 'ftp:': '21' };

  function invalidUrl(input) {
    var err = new TypeError('Invalid URL');
    err.code = 'ERR_INVALID_URL';
    err.input = input;
    return err;
  }

  function URL(input, base) {
    var str = String(input).trim();
    if (!SCHEME_RE.test(str)) {
      if (base === undefined) throw invalidUrl(str);
      var b = base instanceof URL ? base : new URL(String(base));
      str = resolveAgainst(b, str);
    }
    var m = /^([A-Za-z][A-Za-z0-9+.\-]*:)(\/\/(?:([^:@\/?#]*)(?::([^@\/?#]*))?@)?([^:\/?#]*)(?::(\d*))?)?([^?#]*)(\?[^#]*)?(#.*)?$/.exec(str);
    if (!m) throw invalidUrl(String(input));
    this.protocol = m[1].toLowerCase();
    var authority = m[2] !== undefined;
    this.username = authority ? (m[3] || '') : '';
    this.password = authority ? (m[4] || '') : '';
    this.hostname = authority ? (m[5] || '').toLowerCase() : '';
    var port = authority && m[6] ? m[6] : '';
    this.port = DEFAULT_PORTS[this.protocol] === port ? '' : port;
    this.pathname = m[7] !== undefined && m[7] !== '' ? m[7] : (authority ? '/' : '');
    this.search = m[8] && m[8].length > 1 ? m[8] : '';
    this.hash = m[9] && m[9].length > 1 ? m[9] : '';
    this.searchParams = new URLSearchParams(this.search);
  }

  function resolveAgainst(base, rel) {
    // origin is the string 'null' for file: URLs, so the prefix is rebuilt from protocol and host
    var prefix = base.protocol + '//' + base.host;
    if (rel.indexOf('//') === 0) return base.protocol + rel;
    if (rel.charAt(0) === '/') return prefix + rel;
    if (rel.charAt(0) === '?') return prefix + base.pathname + rel;
    if (rel.charAt(0) === '#') return prefix + base.pathname + base.search + rel;
    // a base path that ends in '/' names a directory, so the reference is appended inside it;
    // only otherwise is the last segment the file to be replaced (WHATWG URL, reference resolution)
    if (base.pathname.charAt(base.pathname.length - 1) === '/') return prefix + P.join(base.pathname, rel);
    return prefix + P.join(P.dirname(base.pathname), rel);
  }

  Object.defineProperty(URL.prototype, 'host', {
    get: function () { return this.hostname + (this.port ? ':' + this.port : ''); }
  });
  Object.defineProperty(URL.prototype, 'origin', {
    get: function () { return this.protocol === 'file:' ? 'null' : this.protocol + '//' + this.host; }
  });
  Object.defineProperty(URL.prototype, 'href', {
    get: function () {
      var auth = '';
      if (this.hostname || this.protocol === 'file:' || this.protocol === 'http:' || this.protocol === 'https:') {
        var userinfo = this.username ? this.username + (this.password ? ':' + this.password : '') + '@' : '';
        auth = '//' + userinfo + this.host;
      }
      var query = this.searchParams.toString();
      return this.protocol + auth + this.pathname + (query ? '?' + query : '') + this.hash;
    }
  });
  URL.prototype.toString = function () { return this.href; };
  URL.prototype.toJSON = function () { return this.href; };
  URL.canParse = function (input, base) {
    try {
      new URL(input, base);
      return true;
    } catch (err) {
      return false;
    }
  };

  function fileURLToPath(u) {
    var href = typeof u === 'string' ? u : u.href;
    if (href.indexOf('file://') !== 0) {
      var err = new TypeError('The URL must be of scheme file');
      err.code = 'ERR_INVALID_URL_SCHEME';
      throw err;
    }
    return decodeURIComponent(new URL(href).pathname);
  }

  function pathToFileURL(p) {
    return new URL('file://' + encodeURI(P.resolve(String(p))));
  }

  /* legacy url.parse: the fields of the WHATWG parse, in the legacy Url shape (null where Node uses null) */
  function parse(input, parseQuery) {
    var text = String(input);
    var absolute = SCHEME_RE.test(text);
    var u = absolute ? new URL(text) : new URL(text, 'http://relative.invalid');
    var hasHost = absolute && u.host !== '';
    var search = u.search || null;
    var query = search ? search.slice(1) : null;
    if (parseQuery) {
      query = {};
      u.searchParams.forEach(function (value, key) {
        if (Object.prototype.hasOwnProperty.call(query, key)) query[key] = [].concat(query[key], value);
        else query[key] = value;
      });
    }
    var path = u.pathname + (search || '');
    return {
      protocol: absolute ? u.protocol : null,
      slashes: hasHost ? true : null,
      auth: u.username ? decodeURIComponent(u.username) + (u.password ? ':' + decodeURIComponent(u.password) : '') : null,
      host: hasHost ? u.host : null,
      port: u.port || null,
      hostname: hasHost ? u.hostname : null,
      hash: u.hash || null,
      search: search,
      query: query,
      pathname: u.pathname,
      path: path,
      href: absolute ? u.href : path + (u.hash || '')
    };
  }

  function resolveUrl(from, to) {
    var absolute = SCHEME_RE.test(String(from)) || SCHEME_RE.test(String(to));
    var base = new URL(String(from), 'http://relative.invalid');
    var target = new URL(String(to), base);
    return absolute ? target.href : target.pathname + target.search + target.hash;
  }

  /* legacy url.format: a URL, a string, or a Url-shaped object (protocol, host or hostname and port, pathname, search or query, hash) */
  function formatUrl(u) {
    if (u instanceof URL) return u.href;
    if (typeof u === 'string') return u;
    var protocol = u.protocol ? String(u.protocol) : '';
    if (protocol && protocol.charAt(protocol.length - 1) !== ':') protocol += ':';
    var host = u.host ? String(u.host) : (u.hostname ? String(u.hostname) + (u.port ? ':' + u.port : '') : '');
    var auth = u.auth ? encodeURIComponent(String(u.auth)).replace(/%3A/i, ':') + '@' : '';
    var slashes = (u.slashes || /^(https?|ftp|file|wss?):$/.test(protocol)) ? '//' : '';
    var search = '';
    if (u.search) search = String(u.search);
    else if (u.query && typeof u.query === 'object') search = new URLSearchParams(u.query).toString();
    else if (u.query) search = String(u.query);
    if (search && search.charAt(0) !== '?') search = '?' + search;
    var hash = u.hash ? String(u.hash) : '';
    if (hash && hash.charAt(0) !== '#') hash = '#' + hash;
    return protocol + ((host || slashes) ? slashes + auth + host : '') + (u.pathname ? String(u.pathname) : '') + search + hash;
  }

  return {
    URL: URL,
    URLSearchParams: URLSearchParams,
    fileURLToPath: fileURLToPath,
    pathToFileURL: pathToFileURL,
    parse: parse,
    resolve: resolveUrl,
    format: formatUrl
  };
};

BF.crypto = function () {
  var Buf = requireBuiltin('buffer').Buffer;

  /* key bytes and CryptoKey state live here, never on the key objects, so user code sees only Node's surface */
  var KEY_STATE = new WeakMap();

  function invalidArgType(name, expected, value) {
    var err = new TypeError('The "' + name + '" argument must be ' + expected + '. Received ' + (value === null ? 'null' : typeof value));
    err.code = 'ERR_INVALID_ARG_TYPE';
    return err;
  }

  function outOfRange(name, range, value) {
    var err = new RangeError('The value of "' + name + '" is out of range. It must be ' + range + '. Received ' + value);
    err.code = 'ERR_OUT_OF_RANGE';
    return err;
  }

  /* exports this runtime does not implement (Diffie-Hellman, key generation): present so modules load, and they fail clearly when called */
  function featureUnavailable(name) {
    var err = new Error(name + ' is not available in this runtime');
    err.code = 'ERR_FEATURE_UNAVAILABLE';
    return err;
  }

  function unavailable(name) {
    return function () {
      throw featureUnavailable(name);
    };
  }

  function asymmetricUnavailable(what) {
    var err = new Error(what + ' is not available: this runtime has no asymmetric key support (RSA, EC or Ed25519)');
    err.code = 'ERR_FEATURE_UNAVAILABLE';
    return err;
  }

  function randomBytes(size, callback) {
    var bytes = Buf.from(decodeBase64(host.randomBase64(size)));
    if (typeof callback === 'function') {
      queueMicrotask(function () { callback(null, bytes); });
      return undefined;
    }
    return bytes;
  }

  function randomUUID() {
    var b = randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = b.toString('hex');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  function randomInt(min, max) {
    if (max === undefined) {
      max = min;
      min = 0;
    }
    var r = randomBytes(4).readUInt32BE(0) / 4294967296;
    return min + Math.floor(r * (max - min));
  }

  function getRandomValues(typed) {
    var bytes = decodeBase64(host.randomBase64(typed.byteLength));
    new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength).set(bytes);
    return typed;
  }

  /* the view a random fill writes into: offset and size count elements of a typed array, as Node reads them */
  function fillTarget(buf, offset, size) {
    var isView = ArrayBuffer.isView(buf);
    if (!isView && !(buf instanceof ArrayBuffer)) {
      throw invalidArgType('buf', 'an instance of ArrayBuffer or ArrayBufferView', buf);
    }
    var elementSize = isView && buf.BYTES_PER_ELEMENT ? buf.BYTES_PER_ELEMENT : 1;
    var elements = buf.byteLength / elementSize;
    var start = offset === undefined ? 0 : offset;
    if (typeof start !== 'number' || !(start >= 0 && start <= elements) || Math.floor(start) !== start) {
      throw outOfRange('offset', '>= 0 && <= ' + elements, start);
    }
    var count = size === undefined ? elements - start : size;
    if (typeof count !== 'number' || !(count >= 0 && start + count <= elements) || Math.floor(count) !== count) {
      throw outOfRange('size', '>= 0 && <= ' + (elements - start), count);
    }
    var base = isView ? buf.byteOffset : 0;
    var backing = isView ? buf.buffer : buf;
    return new Uint8Array(backing, base + start * elementSize, count * elementSize);
  }

  function randomFillSync(buf, offset, size) {
    var view = fillTarget(buf, offset, size);
    if (view.length > 0) view.set(decodeBase64(host.randomBase64(view.length)));
    return buf;
  }

  function randomFill(buf, offset, size, callback) {
    var done = callback;
    var start = offset;
    var count = size;
    if (typeof offset === 'function') {
      done = offset;
      start = undefined;
      count = undefined;
    } else if (typeof size === 'function') {
      done = size;
      count = undefined;
    }
    if (typeof done !== 'function') throw invalidArgType('callback', 'of type function', done);
    randomFillSync(buf, start, count);
    queueMicrotask(function () { done(null, buf); });
  }

  /* bytes from a string (with its encoding), a Buffer, a TypedArray, a DataView or an ArrayBuffer */
  function toBytes(data, encoding, name) {
    if (typeof data === 'string') return Buf.from(data, encoding || 'utf8');
    if (data instanceof ArrayBuffer) return Buf.from(data);
    if (ArrayBuffer.isView(data)) return Buf.from(data.buffer, data.byteOffset, data.byteLength);
    var err = new TypeError('The "' + name + '" argument must be of type string or an instance of Buffer, TypedArray, or DataView.');
    err.code = 'ERR_INVALID_ARG_TYPE';
    throw err;
  }

  function outputOf(bytes, encoding) {
    return encoding === undefined || encoding === 'buffer' ? bytes : bytes.toString(encoding);
  }

  /* KeyObject: secret keys carry their bytes; asymmetric keys are not available in this runtime */
  function KeyObject(type, bytes) {
    KEY_STATE.set(this, { kind: 'key', type: type, bytes: bytes });
  }

  function keyStateOf(key, kind) {
    var state = key !== null && typeof key === 'object' ? KEY_STATE.get(key) : undefined;
    if (state === undefined || (kind !== undefined && state.kind !== kind)) return undefined;
    return state;
  }

  function base64url(bytes) {
    return Buf.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  Object.defineProperties(KeyObject.prototype, {
    type: { get: function () { return keyStateOf(this, 'key').type; } },
    symmetricKeySize: {
      get: function () {
        var state = keyStateOf(this, 'key');
        return state.type === 'secret' ? state.bytes.length : undefined;
      }
    },
    asymmetricKeyType: { get: function () { return undefined; } }
  });

  KeyObject.prototype.export = function (options) {
    var state = keyStateOf(this, 'key');
    if (state.type !== 'secret') throw asymmetricUnavailable('KeyObject.export');
    if (options !== undefined && options !== null && options.format === 'jwk') {
      return { kty: 'oct', k: base64url(state.bytes) };
    }
    return Buf.from(state.bytes);
  };

  KeyObject.prototype.equals = function (other) {
    if (!(other instanceof KeyObject)) throw invalidArgType('otherKeyObject', 'an instance of KeyObject', other);
    var a = keyStateOf(this, 'key');
    var b = keyStateOf(other, 'key');
    if (a.type !== b.type || a.bytes.length !== b.bytes.length) return false;
    return timingSafeEqual(a.bytes, b.bytes);
  };

  function createSecretKey(key, encoding) {
    var bytes = typeof key === 'string' ? Buf.from(key, encoding) : toBytes(key, undefined, 'key');
    return new KeyObject('secret', Buf.from(bytes));
  }

  function createPublicKey() {
    throw asymmetricUnavailable('createPublicKey');
  }

  function createPrivateKey() {
    throw asymmetricUnavailable('createPrivateKey');
  }

  function keyBytesOf(key) {
    var state = keyStateOf(key, 'key');
    if (state === undefined) return toBytes(key, undefined, 'key');
    if (state.type !== 'secret') throw asymmetricUnavailable('createHmac');
    return state.bytes;
  }

  /* createHash and createHmac: the bytes are collected here and digested by the host in one call */
  function Hash(algorithm, key) {
    this._algorithm = String(algorithm);
    this._key = key;
    this._chunks = [];
    this._finished = false;
  }
  Hash.prototype.update = function (data, encoding) {
    if (this._finished) {
      var sealed = new Error('Digest already called');
      sealed.code = 'ERR_CRYPTO_HASH_FINALIZED';
      throw sealed;
    }
    this._chunks.push(toBytes(data, encoding, 'data'));
    return this;
  };
  Hash.prototype.digest = function (encoding) {
    if (this._finished) {
      var again = new Error('Digest already called');
      again.code = 'ERR_CRYPTO_HASH_FINALIZED';
      throw again;
    }
    this._finished = true;
    var data = Buf.concat(this._chunks).toString('base64');
    var out = this._key === undefined
      ? callCap('crypto.digest', { algorithm: this._algorithm, data: data })
      : callCap('crypto.hmac', { algorithm: this._algorithm, key: this._key.toString('base64'), data: data });
    return outputOf(Buf.from(out, 'base64'), encoding);
  };
  Hash.prototype.copy = function () {
    var copy = new Hash(this._algorithm, this._key);
    copy._chunks = this._chunks.slice();
    return copy;
  };

  function createHash(algorithm) {
    return new Hash(algorithm, undefined);
  }

  function createHmac(algorithm, key) {
    return new Hash(algorithm, keyBytesOf(key));
  }

  function hash(algorithm, data, outputEncoding) {
    return createHash(algorithm).update(data).digest(outputEncoding === undefined ? 'hex' : outputEncoding);
  }

  function pbkdf2Sync(password, salt, iterations, keylen, digest) {
    var out = callCap('crypto.pbkdf2', {
      digest: digest === undefined ? 'sha1' : String(digest),
      password: toBytes(password, undefined, 'password').toString('base64'),
      salt: toBytes(salt, undefined, 'salt').toString('base64'),
      iterations: Number(iterations),
      keylen: Number(keylen)
    });
    return Buf.from(out, 'base64');
  }

  function pbkdf2(password, salt, iterations, keylen, digest, callback) {
    var key = pbkdf2Sync(password, salt, iterations, keylen, digest);
    queueMicrotask(function () { callback(null, key); });
  }

  function timingSafeEqual(a, b) {
    var left = toBytes(a, undefined, 'buf1');
    var right = toBytes(b, undefined, 'buf2');
    if (left.length !== right.length) {
      var length = new RangeError('Input buffers must have the same byte length');
      length.code = 'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH';
      throw length;
    }
    var diff = 0;
    for (var i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
    return diff === 0;
  }

  function getHashes() {
    return ['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512'];
  }

  /* SubtleCrypto: digests and HMAC run on the host through the asynchronous operation path */
  var SUBTLE_DIGESTS = { 'SHA-1': 'sha1', 'SHA-256': 'sha256', 'SHA-384': 'sha384', 'SHA-512': 'sha512' };

  function notSupported(message) {
    var err = new Error(message);
    err.name = 'NotSupportedError';
    return err;
  }

  function algorithmName(algorithm) {
    if (typeof algorithm === 'string') return algorithm;
    if (algorithm !== null && typeof algorithm === 'object' && typeof algorithm.name === 'string') return algorithm.name;
    throw invalidArgType('algorithm', 'a string or an object with a name', algorithm);
  }

  function digestOf(algorithm) {
    var name = String(algorithmName(algorithm)).toUpperCase();
    if (!Object.prototype.hasOwnProperty.call(SUBTLE_DIGESTS, name)) throw notSupported('Unrecognized algorithm name: ' + name);
    return { name: name, digest: SUBTLE_DIGESTS[name] };
  }

  function bufferSourceBytes(data, name) {
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return toBytes(data, undefined, name);
    throw invalidArgType(name, 'an instance of ArrayBuffer, Buffer, TypedArray, or DataView', data);
  }

  function arrayBufferOf(bytes) {
    var out = new ArrayBuffer(bytes.length);
    new Uint8Array(out).set(bytes);
    return out;
  }

  function settled(work) {
    return new Promise(function (resolve) { resolve(work()); });
  }

  function CryptoKey() {
    throw new TypeError('Illegal constructor');
  }

  function cryptoKeyState(key) {
    return keyStateOf(key, 'crypto-key');
  }

  Object.defineProperties(CryptoKey.prototype, {
    type: { get: function () { return cryptoKeyState(this).type; } },
    extractable: { get: function () { return cryptoKeyState(this).extractable; } },
    algorithm: { get: function () { return cryptoKeyState(this).algorithm; } },
    usages: { get: function () { return cryptoKeyState(this).usages; } }
  });

  function hmacKeyFor(algorithm, key, usage) {
    var state = cryptoKeyState(key);
    if (state === undefined) throw invalidArgType('key', 'an instance of CryptoKey', key);
    if (String(algorithmName(algorithm)).toUpperCase() !== state.algorithm.name) throw notSupported('Algorithm mismatch');
    if (state.usages.indexOf(usage) < 0) {
      var denied = new Error('Key does not support the ' + usage + ' operation');
      denied.name = 'InvalidAccessError';
      throw denied;
    }
    return state;
  }

  function hmacDigest(state, bytes) {
    return callOp('crypto.hmac', {
      algorithm: digestOf(state.algorithm.hash).digest,
      key: state.bytes.toString('base64'),
      data: bytes.toString('base64')
    });
  }

  var subtle = {
    digest: function (algorithm, data) {
      return settled(function () {
        var alg = digestOf(algorithm);
        var bytes = bufferSourceBytes(data, 'data');
        return callOp('crypto.digest', { algorithm: alg.digest, data: bytes.toString('base64') }).then(function (b64) {
          return arrayBufferOf(Buf.from(b64, 'base64'));
        });
      });
    },
    importKey: function (format, keyData, algorithm, extractable, usages) {
      return settled(function () {
        if (format !== 'raw') throw notSupported('Unable to import key: format ' + format + ' is not supported');
        if (String(algorithmName(algorithm)).toUpperCase() !== 'HMAC') {
          throw notSupported('Unrecognized algorithm name: ' + String(algorithmName(algorithm)).toUpperCase());
        }
        var hashName = digestOf(algorithm.hash).name;
        var bytes = Buf.from(bufferSourceBytes(keyData, 'keyData'));
        var key = Object.create(CryptoKey.prototype);
        KEY_STATE.set(key, {
          kind: 'crypto-key',
          type: 'secret',
          bytes: bytes,
          extractable: extractable === true,
          algorithm: { name: 'HMAC', length: bytes.length * 8, hash: { name: hashName } },
          usages: Array.prototype.slice.call(usages)
        });
        return key;
      });
    },
    sign: function (algorithm, key, data) {
      return settled(function () {
        var state = hmacKeyFor(algorithm, key, 'sign');
        return hmacDigest(state, bufferSourceBytes(data, 'data')).then(function (b64) {
          return arrayBufferOf(Buf.from(b64, 'base64'));
        });
      });
    },
    verify: function (algorithm, key, signature, data) {
      return settled(function () {
        var state = hmacKeyFor(algorithm, key, 'verify');
        var given = bufferSourceBytes(signature, 'signature');
        return hmacDigest(state, bufferSourceBytes(data, 'data')).then(function (b64) {
          var expected = Buf.from(b64, 'base64');
          return given.length === expected.length && timingSafeEqual(given, expected);
        });
      });
    }
  };

  var webcrypto = {
    CryptoKey: CryptoKey,
    getRandomValues: getRandomValues,
    randomUUID: randomUUID,
    subtle: subtle
  };

  /*
   * createCipheriv and createDecipheriv. The cipher itself runs on the host (@noble/ciphers); the
   * guest keeps the id and the surface Node's callers use. Errors the host raises are rebuilt with
   * the constructor Node uses, which the capability envelope cannot carry.
   */
  function cipherCap(op, args) {
    try {
      return callCap(op, args);
    } catch (err) {
      var Ctor = err && err.owcErrorClass === 'RangeError' ? RangeError : err && err.owcErrorClass === 'TypeError' ? TypeError : Error;
      var again = new Ctor(err && err.message !== undefined ? err.message : String(err));
      if (err && err.code !== undefined && !err.owcUncoded) again.code = err.code;
      if (err && err.errno !== undefined) again.errno = err.errno;
      throw again;
    }
  }

  function cipherStateError(message) {
    var err = new Error(message);
    err.code = 'ERR_CRYPTO_INVALID_STATE';
    return err;
  }

  function cipherBytes(data, encoding, name) {
    return typeof data === 'string' ? Buf.from(data, encoding || 'utf8') : toBytes(data, undefined, name);
  }

  function cipherKeyBytes(key) {
    var state = keyStateOf(key, 'key');
    if (state !== undefined) {
      if (state.type !== 'secret') throw asymmetricUnavailable('createCipheriv');
      return state.bytes;
    }
    return cipherBytes(key, undefined, 'key');
  }

  function Cipher(algorithm, direction, id, aead) {
    this._algorithm = algorithm;
    this._direction = direction;
    this._id = id;
    this._aead = aead;
    this._finalized = false;
    this._tag = undefined;
  }

  Cipher.prototype.update = function (data, inputEncoding, outputEncoding) {
    if (this._finalized) throw new Error('Trying to add data in unsupported state');
    var bytes = cipherBytes(data, inputEncoding, 'data');
    var out = Buf.from(cipherCap('crypto.cipher.update', { id: this._id, data: bytes.toString('base64') }), 'base64');
    return typeof outputEncoding === 'string' ? out.toString(outputEncoding) : out;
  };

  Cipher.prototype.final = function (outputEncoding) {
    if (this._finalized) throw cipherStateError('Invalid state');
    this._finalized = true;
    var result = cipherCap('crypto.cipher.final', { id: this._id });
    if (result.tag !== undefined) this._tag = Buf.from(result.tag, 'base64');
    var out = Buf.from(result.data, 'base64');
    return typeof outputEncoding === 'string' ? out.toString(outputEncoding) : out;
  };

  Cipher.prototype.setAutoPadding = function (autoPadding) {
    cipherCap('crypto.cipher.setAutoPadding', { id: this._id, on: autoPadding !== false });
    return this;
  };

  Cipher.prototype.setAAD = function (buffer, options) {
    var aad = cipherBytes(buffer, typeof options === 'string' ? options : undefined, 'buffer');
    cipherCap('crypto.cipher.setAAD', { id: this._id, aad: aad.toString('base64') });
    return this;
  };

  /* Node puts getAuthTag on a cipher and setAuthTag on a decipher, and neither on the other. */
  function cipherGetAuthTag() {
    if (!this._aead || !this._finalized || this._tag === undefined) throw cipherStateError('Invalid state for operation getAuthTag');
    return this._tag;
  }

  function decipherSetAuthTag(buffer, inputEncoding) {
    var tag = cipherBytes(buffer, inputEncoding, 'buffer');
    cipherCap('crypto.cipher.setAuthTag', { id: this._id, tag: tag.toString('base64') });
    return this;
  }

  function createCipher(direction) {
    return function (algorithm, key, iv, options) {
      var opened = cipherCap('crypto.cipher.open', {
        algorithm: String(algorithm),
        direction: direction,
        key: cipherKeyBytes(key).toString('base64'),
        iv: iv === null || iv === undefined ? null : cipherBytes(iv, undefined, 'iv').toString('base64')
      });
      var cipher = new Cipher(String(algorithm), direction, opened.id, opened.aead === true);
      if (direction === 'decrypt') cipher.setAuthTag = decipherSetAuthTag;
      else cipher.getAuthTag = cipherGetAuthTag;
      return cipher;
    };
  }

  return {
    randomBytes: randomBytes,
    randomUUID: randomUUID,
    randomInt: randomInt,
    randomFill: randomFill,
    randomFillSync: randomFillSync,
    getRandomValues: getRandomValues,
    createHash: createHash,
    createHmac: createHmac,
    hash: hash,
    pbkdf2Sync: pbkdf2Sync,
    pbkdf2: pbkdf2,
    timingSafeEqual: timingSafeEqual,
    getHashes: getHashes,
    KeyObject: KeyObject,
    createSecretKey: createSecretKey,
    createPublicKey: createPublicKey,
    createPrivateKey: createPrivateKey,
    subtle: subtle,
    webcrypto: webcrypto,
    constants: {
      RSA_PKCS1_PADDING: 1,
      RSA_NO_PADDING: 3,
      RSA_PKCS1_OAEP_PADDING: 4,
      RSA_PKCS1_PSS_PADDING: 6,
      POINT_CONVERSION_COMPRESSED: 2,
      POINT_CONVERSION_UNCOMPRESSED: 4,
      POINT_CONVERSION_HYBRID: 6,
      RSA_PSS_SALTLEN_DIGEST: -1,
      RSA_PSS_SALTLEN_MAX_SIGN: -2,
      RSA_PSS_SALTLEN_AUTO: -2
    },
    getCiphers: function () { return callCap('crypto.ciphers'); },
    sign: function sign(algorithm, data, key, callback) { throw featureUnavailable('sign'); },
    verify: function verify(algorithm, data, key, signature, callback) { throw featureUnavailable('verify'); },
    createCipheriv: createCipher('encrypt'),
    createDecipheriv: createCipher('decrypt'),
    diffieHellman: unavailable('diffieHellman'),
    generateKeyPair: unavailable('generateKeyPair'),
    privateDecrypt: unavailable('privateDecrypt'),
    publicEncrypt: unavailable('publicEncrypt')
  };
};

BF.module = function () {
  return {
    createRequire: function (filename) {
      return createRequireFor(String(filename));
    },
    isBuiltin: function (name) {
      return isBuiltinName(String(name));
    },
    builtinModules: Object.keys(BF).filter(function (n) { return n.indexOf('/') < 0; }).sort()
  };
};

BF.tty = function () {
  var EE = requireBuiltin('events');
  function recordOf(fd) {
    var table = globalThis.__owcPtyFds;
    return table ? table[fd] : undefined;
  }
  /*
   * A stream over a pty fd: an fd the node-pty shim (src/napi/node-pty) registered in
   * globalThis.__owcPtyFds when its fork() started a container child process. node-pty's
   * lib/unixTerminal.js builds one of these around the fd its add-on returns and reads the child's
   * output from it, and writes to it go through fs.write to the child's input.
   *
   * The container has no terminal, so this stream is not one: isTTY is false, and isatty below
   * answers false for every fd. A fd that is not one of the shim's gives an inert stream, so
   * new tty.ReadStream(0) does not fail.
   */
  function PtyReadStream(fd) {
    var self = this;
    var rec = recordOf(fd);
    EE.call(this);
    this.fd = fd;
    this.isTTY = false;
    this.readable = true;
    this.writable = false;
    this.columns = rec ? rec.cols : 80;
    this.rows = rec ? rec.rows : 24;
    this._encoding = undefined;
    this._decoder = undefined;
    this._paused = false;
    this._destroyed = false;
    if (rec) rec.socket = this;
    this._onData = function (chunk) {
      if (self._destroyed) return;
      self.emit('data', self._encoding ? chunk.toString(self._encoding) : chunk);
    };
    if (rec) rec.emitter.on('data', this._onData);
  }
  PtyReadStream.prototype = Object.create(EE.prototype);
  PtyReadStream.prototype.constructor = PtyReadStream;
  PtyReadStream.prototype.setEncoding = function (encoding) {
    this._encoding = encoding || undefined;
    this._decoder = encoding ? {} : undefined;
    return this;
  };
  PtyReadStream.prototype.pause = function () {
    this._paused = true;
    var rec = recordOf(this.fd);
    if (rec) rec.paused = true;
    return this;
  };
  PtyReadStream.prototype.resume = function () {
    this._paused = false;
    var rec = recordOf(this.fd);
    if (rec) {
      rec.paused = false;
      while (rec.queue.length > 0) rec.emitter.emit('data', rec.queue.shift());
    }
    return this;
  };
  PtyReadStream.prototype.destroy = function () {
    if (this._destroyed) return this;
    this._destroyed = true;
    this.readable = false;
    var rec = recordOf(this.fd);
    if (rec) {
      try { rec.emitter.removeListener('data', this._onData); } catch (e) {}
      if (rec.socket === this) rec.socket = null;
    }
    this.emit('close');
    return this;
  };
  PtyReadStream.prototype.end = function () { return this; };
  PtyReadStream.prototype.read = function () { return null; };
  PtyReadStream.prototype.pipe = function (dest) {
    var self = this;
    this.on('data', function (chunk) {
      try { dest.write(chunk); } catch (e) {}
    });
    return dest || self;
  };
  /* There is nothing to write to a terminal here: writes to a pty go through fs.write. */
  function PtyWriteStream(fd) {
    EE.call(this);
    this.fd = fd;
    this.isTTY = false;
    this.writable = true;
    this.columns = 80;
    this.rows = 24;
  }
  PtyWriteStream.prototype = Object.create(EE.prototype);
  PtyWriteStream.prototype.constructor = PtyWriteStream;
  PtyWriteStream.prototype.write = function () { return false; };
  PtyWriteStream.prototype.end = function () { return this; };
  return {
    isatty: function () { return false; },
    ReadStream: PtyReadStream,
    WriteStream: PtyWriteStream
  };
};

`;
