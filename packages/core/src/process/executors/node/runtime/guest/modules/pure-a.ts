/**
 * Guest-side pure built-ins, family A: querystring, string_decoder, punycode,
 * diagnostics_channel, async_hooks, perf_hooks and v8. Plain JavaScript inside a
 * String.raw snippet (no backticks, no template interpolation).
 *
 * The whole family runs inside one IIFE so its helper names never collide with the
 * other guest snippets, which share a single function scope after bootstrap.
 *
 * Fidelity notes (Node 24 is the reference):
 * - querystring, string_decoder and punycode follow Node's algorithms, including the
 *   lenient percent-decoding fallback, Node's per-chunk StringDecoder output and the
 *   punycode 2.1.0 source that Node bundles.
 * - AsyncLocalStorage propagates the store through synchronous calls, through promise
 *   reactions (Promise.prototype.then, which also covers catch, finally,
 *   queueMicrotask and process.nextTick) and through AsyncResource scopes. It does
 *   NOT propagate through await continuations, timers, or host callbacks, because the
 *   runtime has no engine hook for those.
 * - v8.serialize/deserialize use a JSON tagged encoding (owc-v8-json, version 1), not
 *   V8's wire format. Round trips cover the Node structured-clone types and cycles.
 * - Heap, code and event-loop statistics are fixed placeholders: the runtime measures
 *   none of them.
 */
export const SRC = String.raw`
(function () {
  var BufferCls = null;
  function getBuffer() {
    if (BufferCls === null) BufferCls = requireBuiltin('buffer').Buffer;
    return BufferCls;
  }

  // ---- shared helpers -------------------------------------------------------

  function paError(Ctor, code, message) {
    var err = new Ctor(message);
    err.code = code;
    return err;
  }

  function receivedText(value) {
    if (value === null) return 'Received null';
    if (value === undefined) return 'Received undefined';
    if (typeof value === 'function') return 'Received function ' + (value.name || '');
    if (typeof value === 'object') {
      var ctorName = value.constructor && value.constructor.name;
      return ctorName ? 'Received an instance of ' + ctorName : 'Received ' + inspectValue(value, { depth: -1 });
    }
    var shown = typeof value === 'string' ? "'" + value + "'" : String(value);
    if (shown.length > 28) shown = shown.slice(0, 25) + '...';
    return 'Received type ' + typeof value + ' (' + shown + ')';
  }

  function invalidArgType(name, expected, value) {
    return paError(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "' + name + '" argument must be ' + expected + '. ' + receivedText(value));
  }

  // Like Node's process.emitWarning, the line is written on the next tick, after the
  // synchronous part of the program has produced its output.
  var warnedDeprecations = Object.create(null);
  function emitDeprecation(code, message) {
    if (warnedDeprecations[code]) return;
    warnedDeprecations[code] = true;
    var proc = globalThis.process;
    if (!proc || !proc.stderr) return;
    proc.nextTick(function () {
      proc.stderr.write('(node:' + proc.pid + ') [' + code + '] DeprecationWarning: ' + message +
        '\n(Use \x60node --trace-deprecation ...\x60 to show where the warning was created)\n');
    });
  }

  function viewBytes(value, name) {
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw invalidArgType(name, 'an instance of Buffer, TypedArray, or DataView', value);
  }

  // WHATWG UTF-8 decoding: one U+FFFD per maximal invalid subpart, as V8 does.
  function utf8Decode(bytes, start, end) {
    var i = start === undefined ? 0 : start;
    var n = end === undefined ? bytes.length : end;
    var parts = [];
    var chunk = [];
    while (i < n) {
      var b = bytes[i];
      var cp = 0xfffd;
      if (b < 0x80) {
        cp = b;
        i += 1;
      } else {
        var need = 0;
        var lo = 0x80;
        var hi = 0xbf;
        var acc = 0;
        if (b >= 0xc2 && b <= 0xdf) {
          need = 1;
          acc = b & 0x1f;
        } else if (b >= 0xe0 && b <= 0xef) {
          need = 2;
          acc = b & 0x0f;
          if (b === 0xe0) lo = 0xa0;
          else if (b === 0xed) hi = 0x9f;
        } else if (b >= 0xf0 && b <= 0xf4) {
          need = 3;
          acc = b & 0x07;
          if (b === 0xf0) lo = 0x90;
          else if (b === 0xf4) hi = 0x8f;
        }
        if (need === 0) {
          i += 1;
        } else {
          var j = i + 1;
          var ok = true;
          for (var k = 0; k < need; k++) {
            if (j >= n) {
              ok = false;
              break;
            }
            var c = bytes[j];
            if (c < lo || c > hi) {
              ok = false;
              break;
            }
            acc = (acc << 6) | (c & 0x3f);
            lo = 0x80;
            hi = 0xbf;
            j++;
          }
          if (ok) cp = acc;
          i = j;
        }
      }
      chunk.push(cp);
      if (chunk.length >= 4096) {
        parts.push(String.fromCodePoint.apply(null, chunk));
        chunk = [];
      }
    }
    if (chunk.length > 0) parts.push(String.fromCodePoint.apply(null, chunk));
    return parts.join('');
  }

  function unitsToString(units) {
    var parts = [];
    for (var i = 0; i < units.length; i += 4096) {
      parts.push(String.fromCharCode.apply(null, units.slice(i, i + 4096)));
    }
    return parts.join('');
  }

  // ---- querystring ----------------------------------------------------------

  function qsHexValue(code) {
    if (code >= 48 && code <= 57) return code - 48;
    if (code >= 65 && code <= 70) return code - 55;
    if (code >= 97 && code <= 102) return code - 87;
    return -1;
  }

  // Node's unescapeBuffer walk: '+' becomes a space when decodeSpaces is set, and each
  // valid %XX becomes one byte. Bytes are masked to 8 bits like a Uint8Array store.
  function qsUnescapeBytes(s, decodeSpaces) {
    var out = [];
    var index = 0;
    var maxLength = s.length - 2;
    while (index < s.length) {
      var currentChar = s.charCodeAt(index);
      if (currentChar === 43 && decodeSpaces) {
        out.push(32);
        index++;
        continue;
      }
      if (currentChar === 37 && index < maxLength) {
        currentChar = s.charCodeAt(++index);
        var hexHigh = qsHexValue(currentChar);
        if (!(hexHigh >= 0)) {
          out.push(37);
          continue;
        }
        var nextChar = s.charCodeAt(++index);
        var hexLow = qsHexValue(nextChar);
        if (!(hexLow >= 0)) {
          out.push(37);
          index--;
        } else {
          currentChar = hexHigh * 16 + hexLow;
        }
      }
      out.push(currentChar & 0xff);
      index++;
    }
    return out;
  }

  function qsUnescapeBuffer(s, decodeSpaces) {
    return getBuffer().from(qsUnescapeBytes(String(s), decodeSpaces));
  }

  function qsUnescape(s, decodeSpaces) {
    try {
      return decodeURIComponent(s);
    } catch (err) {
      return utf8Decode(qsUnescapeBytes(String(s), decodeSpaces));
    }
  }

  function qsEscape(str) {
    var s = str;
    if (typeof s !== 'string') {
      if (typeof s === 'object') s = String(s);
      else s = s + '';
    }
    try {
      return encodeURIComponent(s);
    } catch (err) {
      throw paError(URIError, 'ERR_INVALID_URI', 'URI malformed');
    }
  }

  function qsAddKeyVal(obj, key, value) {
    var current = obj[key];
    if (current === undefined) obj[key] = value;
    else if (Array.isArray(current)) current.push(value);
    else obj[key] = [current, value];
  }

  function qsParse(qs, sep, eq, options) {
    var obj = Object.create(null);
    if (typeof qs !== 'string' || qs.length === 0) return obj;
    var sepStr = sep ? String(sep) : '&';
    var eqStr = eq ? String(eq) : '=';
    var pairs = 1000;
    if (options && typeof options.maxKeys === 'number') pairs = options.maxKeys > 0 ? options.maxKeys : -1;
    var decode = qsUnescape;
    var custom = false;
    if (options && typeof options.decodeURIComponent === 'function') {
      decode = options.decodeURIComponent;
      custom = true;
    }
    var plus = custom ? '%20' : ' ';

    function decodePiece(raw) {
      if (raw.length === 0) return raw;
      var s = raw.split('+').join(plus);
      try {
        return decode(s);
      } catch (err) {
        return qsUnescape(s, true);
      }
    }

    var pos = 0;
    for (;;) {
      var found = qsIndexOf(qs, sepStr, pos);
      var last = found === -1;
      var end = last ? qs.length : found;
      if (last && end === pos) break;
      var seg = qs.slice(pos, end);
      var eqAt = qsIndexOf(seg, eqStr, 0);
      if (eqAt !== -1) {
        qsAddKeyVal(obj, decodePiece(seg.slice(0, eqAt)), decodePiece(seg.slice(eqAt + eqStr.length)));
      } else if (seg.length > 0) {
        qsAddKeyVal(obj, decodePiece(seg), '');
      }
      if (last) break;
      pos = found + sepStr.length;
      if (--pairs === 0) break;
    }
    return obj;
  }

  function qsIndexOf(text, needle, from) {
    return text.indexOf(needle, from);
  }

  function qsPrimitive(v) {
    if (typeof v === 'string') return v;
    if (typeof v === 'number' && isFinite(v)) return '' + v;
    if (typeof v === 'bigint') return '' + v;
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    return '';
  }

  function qsConvert(v, encode, custom) {
    if (custom) return encode(qsPrimitive(v));
    if (typeof v === 'string') return v.length ? encode(v) : '';
    if (typeof v === 'number' && isFinite(v)) return Math.abs(v) < 1e21 ? '' + v : encode('' + v);
    if (typeof v === 'bigint') return '' + v;
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    return '';
  }

  function qsStringify(obj, sep, eq, options) {
    var sepStr = sep || '&';
    var eqStr = eq || '=';
    var encode = qsEscape;
    var custom = false;
    if (options && typeof options.encodeURIComponent === 'function') {
      encode = options.encodeURIComponent;
      custom = true;
    }
    if (obj === null || typeof obj !== 'object') return '';
    var keys = Object.keys(obj);
    var fields = '';
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var v = obj[k];
      var ks = qsConvert(k, encode, custom) + eqStr;
      if (Array.isArray(v)) {
        if (v.length === 0) continue;
        if (fields) fields += sepStr;
        for (var j = 0; j < v.length; j++) {
          if (j) fields += sepStr;
          fields += ks + qsConvert(v[j], encode, custom);
        }
      } else {
        if (fields) fields += sepStr;
        fields += ks + qsConvert(v, encode, custom);
      }
    }
    return fields;
  }

  BF.querystring = function () {
    return {
      unescapeBuffer: qsUnescapeBuffer,
      unescape: qsUnescape,
      escape: qsEscape,
      stringify: qsStringify,
      encode: qsStringify,
      parse: qsParse,
      decode: qsParse
    };
  };

  // ---- string_decoder -------------------------------------------------------

  var SD_ENCODINGS = {
    utf8: 'utf8',
    'utf-8': 'utf8',
    ucs2: 'utf16le',
    'ucs-2': 'utf16le',
    utf16le: 'utf16le',
    'utf-16le': 'utf16le',
    latin1: 'latin1',
    binary: 'latin1',
    ascii: 'ascii',
    hex: 'hex',
    base64: 'base64',
    base64url: 'base64url'
  };

  function sdNormalize(enc) {
    if (enc === undefined || enc === null) return 'utf8';
    var name = String(enc);
    if (name.length === 0) return 'utf8';
    var key = name.toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(SD_ENCODINGS, key)) {
      throw paError(TypeError, 'ERR_UNKNOWN_ENCODING', 'Unknown encoding: ' + name);
    }
    return SD_ENCODINGS[key];
  }

  var sdStates = new WeakMap();
  function sdState(decoder) {
    var st = sdStates.get(decoder);
    if (st === undefined) throw new TypeError('Illegal invocation');
    return st;
  }

  function sdEncodeBase64(bytes, encoding) {
    var text = encodeBase64(bytes);
    if (encoding === 'base64url') return text.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return text;
  }

  function sdUnits(bytes, start, end) {
    var units = [];
    for (var i = start; i + 1 < end; i += 2) units.push(bytes[i] | (bytes[i + 1] << 8));
    return unitsToString(units);
  }

  function sdWriteUtf8(st, bytes) {
    var all = st.pending.concat(Array.prototype.slice.call(bytes));
    var n = all.length;
    var hold = 0;
    for (var i = n - 1, seen = 0; i >= 0 && seen < 4; i--, seen++) {
      var b = all[i];
      if ((b & 0xc0) !== 0x80) {
        var need = 0;
        if (b >= 0xc0 && b <= 0xdf) need = 2;
        else if (b >= 0xe0 && b <= 0xef) need = 3;
        else if (b >= 0xf0 && b <= 0xf7) need = 4;
        if (need > 0 && n - i < need) hold = n - i;
        break;
      }
    }
    var complete = hold > 0 ? all.slice(0, n - hold) : all;
    st.pending = hold > 0 ? all.slice(n - hold) : [];
    return utf8Decode(complete, 0, complete.length);
  }

  function sdWriteUtf16(st, bytes) {
    var prefix = '';
    var pos = 0;
    var n = bytes.length;
    if (st.need > 0) {
      var take = Math.min(n, st.need);
      for (var k = 0; k < take; k++) st.pending.push(bytes[k]);
      st.need -= take;
      pos = take;
      if (st.need === 0) {
        prefix = sdUnits(st.pending, 0, st.pending.length);
        st.pending = [];
      }
    }
    if (n - pos === 0) return prefix;
    var hold = 0;
    if ((n - pos) % 2 === 1) hold = 1;
    else if ((bytes[n - 1] & 0xfc) === 0xd8) hold = 2;
    var bodyEnd = n - hold;
    var body = bodyEnd > pos ? sdUnits(bytes, pos, bodyEnd) : '';
    if (hold > 0) {
      st.pending = Array.prototype.slice.call(bytes, n - hold, n);
      st.need = hold;
    }
    return prefix + body;
  }

  function sdWriteBase64(st, bytes) {
    var all = st.pending.concat(Array.prototype.slice.call(bytes));
    var usable = all.length - (all.length % 3);
    st.pending = all.slice(usable);
    st.need = st.pending.length > 0 ? 3 - st.pending.length : 0;
    if (usable === 0) return '';
    return sdEncodeBase64(all.slice(0, usable), st.encoding);
  }

  function sdWriteStateless(encoding, bytes) {
    if (encoding === 'hex') return encodeHex(bytes);
    var out = [];
    if (encoding === 'latin1') {
      for (var i = 0; i < bytes.length; i++) out.push(String.fromCharCode(bytes[i]));
    } else {
      for (var j = 0; j < bytes.length; j++) out.push(String.fromCharCode(bytes[j] & 0x7f));
    }
    return out.join('');
  }

  function sdWrite(st, bytes) {
    if (st.encoding === 'utf8') return sdWriteUtf8(st, bytes);
    if (st.encoding === 'utf16le') return sdWriteUtf16(st, bytes);
    if (st.encoding === 'base64' || st.encoding === 'base64url') return sdWriteBase64(st, bytes);
    return sdWriteStateless(st.encoding, bytes);
  }

  function sdFlush(st) {
    var out = '';
    if (st.encoding === 'utf8') {
      if (st.pending.length > 0) out = utf8Decode(st.pending, 0, st.pending.length);
    } else if (st.encoding === 'utf16le') {
      var len = st.pending.length % 2 === 1 ? st.pending.length - 1 : st.pending.length;
      if (len > 0) out = sdUnits(st.pending, 0, len);
    } else if (st.encoding === 'base64' || st.encoding === 'base64url') {
      if (st.pending.length > 0) out = sdEncodeBase64(st.pending, st.encoding);
    }
    st.pending = [];
    st.need = 0;
    return out;
  }

  function sdMissing(st) {
    if (st.encoding === 'utf8') {
      if (st.pending.length === 0) return 0;
      var lead = st.pending[0];
      var total = lead >= 0xf0 ? 4 : (lead >= 0xe0 ? 3 : 2);
      return total - st.pending.length;
    }
    if (st.encoding === 'utf16le') return st.need;
    if (st.encoding === 'base64' || st.encoding === 'base64url') return st.pending.length > 0 ? 3 - st.pending.length : 0;
    return 0;
  }

  function StringDecoder(encoding) {
    if (!(this instanceof StringDecoder)) return new StringDecoder(encoding);
    var enc = sdNormalize(encoding);
    this.encoding = enc;
    sdStates.set(this, { encoding: enc, pending: [], need: 0 });
  }

  StringDecoder.prototype.write = function (buf) {
    if (typeof buf === 'string') return buf;
    return sdWrite(sdState(this), viewBytes(buf, 'buf'));
  };

  StringDecoder.prototype.end = function (buf) {
    var out = '';
    if (buf !== undefined) out = this.write(buf);
    return out + sdFlush(sdState(this));
  };

  StringDecoder.prototype.text = function (buf, offset) {
    var st = sdState(this);
    st.pending = [];
    st.need = 0;
    return this.write(buf.slice(offset));
  };

  Object.defineProperty(StringDecoder.prototype, 'lastChar', {
    configurable: true,
    get: function () {
      var st = sdState(this);
      var four = [0, 0, 0, 0];
      for (var i = 0; i < st.pending.length && i < 4; i++) four[i] = st.pending[i];
      return getBuffer().from(four);
    }
  });

  Object.defineProperty(StringDecoder.prototype, 'lastNeed', {
    configurable: true,
    get: function () {
      return sdMissing(sdState(this));
    }
  });

  Object.defineProperty(StringDecoder.prototype, 'lastTotal', {
    configurable: true,
    get: function () {
      var st = sdState(this);
      return st.pending.length > 0 ? st.pending.length + sdMissing(st) : 0;
    }
  });

  BF.string_decoder = function () {
    return { StringDecoder: StringDecoder };
  };

  // ---- punycode (RFC 3492, the punycode 2.1.0 algorithm Node bundles) -------

  var PY_MAX_INT = 2147483647;
  var PY_BASE = 36;
  var PY_T_MIN = 1;
  var PY_T_MAX = 26;
  var PY_SKEW = 38;
  var PY_DAMP = 700;
  var PY_INITIAL_BIAS = 72;
  var PY_INITIAL_N = 128;
  var PY_DELIMITER = '-';
  var PY_BASE_MINUS_T_MIN = PY_BASE - PY_T_MIN;
  var PY_ERRORS = {
    'overflow': 'Overflow: input needs wider integers to process',
    'not-basic': 'Illegal input >= 0x80 (not a basic code point)',
    'invalid-input': 'Invalid input'
  };
  var PY_REGEX_PUNYCODE = /^xn--/;
  var PY_REGEX_NON_ASCII = /[^\0-\x7E]/;
  var PY_REGEX_SEPARATORS = /[\x2E。．｡]/g;

  function pyError(type) {
    throw new RangeError(PY_ERRORS[type]);
  }

  function pyMap(array, fn) {
    var result = [];
    for (var i = 0; i < array.length; i++) result.push(fn(array[i]));
    return result;
  }

  function pyMapDomain(string, fn) {
    var parts = string.split('@');
    var result = '';
    var domain = string;
    if (parts.length > 1) {
      result = parts[0] + '@';
      domain = parts[1];
    }
    domain = domain.replace(PY_REGEX_SEPARATORS, '\x2E');
    return result + pyMap(domain.split('.'), fn).join('.');
  }

  function pyUcs2Decode(string) {
    var output = [];
    var counter = 0;
    var length = string.length;
    while (counter < length) {
      var value = string.charCodeAt(counter++);
      if (value >= 0xd800 && value <= 0xdbff && counter < length) {
        var extra = string.charCodeAt(counter++);
        if ((extra & 0xfc00) === 0xdc00) {
          output.push(((value & 0x3ff) << 10) + (extra & 0x3ff) + 0x10000);
        } else {
          output.push(value);
          counter--;
        }
      } else {
        output.push(value);
      }
    }
    return output;
  }

  function pyUcs2Encode(codePoints) {
    return String.fromCodePoint.apply(String, codePoints);
  }

  function pyBasicToDigit(codePoint) {
    if (codePoint - 0x30 < 0x0a) return codePoint - 0x16;
    if (codePoint - 0x41 < 0x1a) return codePoint - 0x41;
    if (codePoint - 0x61 < 0x1a) return codePoint - 0x61;
    return PY_BASE;
  }

  function pyDigitToBasic(digit, flag) {
    return digit + 22 + 75 * (digit < 26 ? 1 : 0) - ((flag !== 0 ? 1 : 0) << 5);
  }

  function pyAdapt(delta, numPoints, firstTime) {
    var k = 0;
    delta = firstTime ? Math.floor(delta / PY_DAMP) : (delta >> 1);
    delta += Math.floor(delta / numPoints);
    for (; delta > ((PY_BASE_MINUS_T_MIN * PY_T_MAX) >> 1); k += PY_BASE) {
      delta = Math.floor(delta / PY_BASE_MINUS_T_MIN);
    }
    return Math.floor(k + (PY_BASE_MINUS_T_MIN + 1) * delta / (delta + PY_SKEW));
  }

  function pyDecode(input) {
    var output = [];
    var inputLength = input.length;
    var i = 0;
    var n = PY_INITIAL_N;
    var bias = PY_INITIAL_BIAS;
    var basic = input.lastIndexOf(PY_DELIMITER);
    if (basic < 0) basic = 0;
    for (var j = 0; j < basic; ++j) {
      if (input.charCodeAt(j) >= 0x80) pyError('not-basic');
      output.push(input.charCodeAt(j));
    }
    for (var index = basic > 0 ? basic + 1 : 0; index < inputLength;) {
      var oldi = i;
      for (var w = 1, k = PY_BASE; ; k += PY_BASE) {
        if (index >= inputLength) pyError('invalid-input');
        var digit = pyBasicToDigit(input.charCodeAt(index++));
        if (digit >= PY_BASE) pyError('invalid-input');
        if (digit > Math.floor((PY_MAX_INT - i) / w)) pyError('overflow');
        i += digit * w;
        var t = k <= bias ? PY_T_MIN : (k >= bias + PY_T_MAX ? PY_T_MAX : k - bias);
        if (digit < t) break;
        var baseMinusT = PY_BASE - t;
        if (w > Math.floor(PY_MAX_INT / baseMinusT)) pyError('overflow');
        w *= baseMinusT;
      }
      var out = output.length + 1;
      bias = pyAdapt(i - oldi, out, oldi === 0);
      if (Math.floor(i / out) > PY_MAX_INT - n) pyError('overflow');
      n += Math.floor(i / out);
      i %= out;
      output.splice(i++, 0, n);
    }
    return String.fromCodePoint.apply(String, output);
  }

  function pyEncode(input) {
    var output = [];
    var codePoints = pyUcs2Decode(input);
    var inputLength = codePoints.length;
    var n = PY_INITIAL_N;
    var delta = 0;
    var bias = PY_INITIAL_BIAS;
    var i;
    for (i = 0; i < inputLength; i++) {
      if (codePoints[i] < 0x80) output.push(String.fromCharCode(codePoints[i]));
    }
    var basicLength = output.length;
    var handledCPCount = basicLength;
    if (basicLength) output.push(PY_DELIMITER);
    while (handledCPCount < inputLength) {
      var m = PY_MAX_INT;
      for (i = 0; i < inputLength; i++) {
        if (codePoints[i] >= n && codePoints[i] < m) m = codePoints[i];
      }
      var handledCPCountPlusOne = handledCPCount + 1;
      if (m - n > Math.floor((PY_MAX_INT - delta) / handledCPCountPlusOne)) pyError('overflow');
      delta += (m - n) * handledCPCountPlusOne;
      n = m;
      for (i = 0; i < inputLength; i++) {
        var currentValue = codePoints[i];
        if (currentValue < n && ++delta > PY_MAX_INT) pyError('overflow');
        if (currentValue === n) {
          var q = delta;
          for (var k = PY_BASE; ; k += PY_BASE) {
            var t = k <= bias ? PY_T_MIN : (k >= bias + PY_T_MAX ? PY_T_MAX : k - bias);
            if (q < t) break;
            var qMinusT = q - t;
            var baseMinusT = PY_BASE - t;
            output.push(String.fromCharCode(pyDigitToBasic(t + qMinusT % baseMinusT, 0)));
            q = Math.floor(qMinusT / baseMinusT);
          }
          output.push(String.fromCharCode(pyDigitToBasic(q, 0)));
          bias = pyAdapt(delta, handledCPCountPlusOne, handledCPCount === basicLength);
          delta = 0;
          ++handledCPCount;
        }
      }
      ++delta;
      ++n;
    }
    return output.join('');
  }

  function pyToUnicode(input) {
    return pyMapDomain(input, function (string) {
      return PY_REGEX_PUNYCODE.test(string) ? pyDecode(string.slice(4).toLowerCase()) : string;
    });
  }

  function pyToASCII(input) {
    return pyMapDomain(input, function (string) {
      return PY_REGEX_NON_ASCII.test(string) ? 'xn--' + pyEncode(string) : string;
    });
  }

  BF.punycode = function () {
    if (!globalThis.__owcDependencyRequire) emitDeprecation('DEP0040','The \x60punycode\x60 module is deprecated. Please use a userland alternative instead.');
    return {
      version: '2.1.0',
      ucs2: { decode: pyUcs2Decode, encode: pyUcs2Encode },
      encode: pyEncode,
      decode: pyDecode,
      toASCII: pyToASCII,
      toUnicode: pyToUnicode
    };
  };

  // ---- diagnostics_channel --------------------------------------------------

  var dcChannels = new Map();
  var dcIndexCounter = 0;

  function DcChannel(name) {
    this._subscribers = undefined;
    this._stores = undefined;
    this.name = name;
    this._index = dcIndexCounter++;
  }

  Object.defineProperty(DcChannel.prototype, 'hasSubscribers', {
    configurable: true,
    get: function () {
      return (this._subscribers !== undefined && this._subscribers.length > 0) ||
        (this._stores !== undefined && this._stores.size > 0);
    }
  });

  DcChannel.prototype.subscribe = function (subscription) {
    if (typeof subscription !== 'function') throw invalidArgType('subscription', 'of type function', subscription);
    if (this._subscribers === undefined) this._subscribers = [];
    this._subscribers.push(subscription);
  };

  DcChannel.prototype.unsubscribe = function (subscription) {
    if (this._subscribers === undefined) return false;
    var idx = this._subscribers.indexOf(subscription);
    if (idx === -1) return false;
    this._subscribers.splice(idx, 1);
    return true;
  };

  DcChannel.prototype.publish = function (data) {
    if (this._subscribers === undefined) return;
    var list = this._subscribers.slice();
    for (var i = 0; i < list.length; i++) {
      try {
        list[i](data, this.name);
      } catch (err) {
        process.nextTick(function () {
          throw err;
        });
      }
    }
  };

  DcChannel.prototype.bindStore = function (store, transform) {
    if (this._stores === undefined) this._stores = new Map();
    this._stores.set(store, transform);
  };

  DcChannel.prototype.unbindStore = function (store) {
    if (this._stores === undefined) return false;
    return this._stores.delete(store);
  };

  DcChannel.prototype.runStores = function (data, fn, thisArg) {
    var args = Array.prototype.slice.call(arguments, 3);
    var self = this;
    var entries = this._stores === undefined ? [] : Array.from(this._stores.entries());
    function runAt(i) {
      if (i === entries.length) {
        self.publish(data);
        return fn.apply(thisArg, args);
      }
      var store = entries[i][0];
      var transform = entries[i][1];
      var transformed = transform ? transform(data) : data;
      return store.run(transformed, function () {
        return runAt(i + 1);
      });
    }
    return runAt(0);
  };

  function dcChannel(name) {
    if (typeof name !== 'string' && typeof name !== 'symbol') {
      throw invalidArgType('channel', 'one of type string or symbol', name);
    }
    var found = dcChannels.get(name);
    if (found === undefined) {
      found = new DcChannel(name);
      dcChannels.set(name, found);
    }
    return found;
  }

  var TRACE_EVENTS = ['start', 'end', 'asyncStart', 'asyncEnd', 'error'];

  function TracingChannel(nameOrChannels) {
    for (var i = 0; i < TRACE_EVENTS.length; i++) {
      var ev = TRACE_EVENTS[i];
      var chan = typeof nameOrChannels === 'string'
        ? dcChannel('tracing:' + nameOrChannels + ':' + ev)
        : nameOrChannels[ev];
      Object.defineProperty(this, ev, { value: chan, enumerable: false, writable: false, configurable: false });
    }
  }

  Object.defineProperty(TracingChannel.prototype, 'hasSubscribers', {
    configurable: true,
    get: function () {
      return this.start.hasSubscribers || this.end.hasSubscribers || this.asyncStart.hasSubscribers ||
        this.asyncEnd.hasSubscribers || this.error.hasSubscribers;
    }
  });

  TracingChannel.prototype.subscribe = function (handlers) {
    for (var i = 0; i < TRACE_EVENTS.length; i++) {
      var ev = TRACE_EVENTS[i];
      if (handlers[ev]) this[ev].subscribe(handlers[ev]);
    }
  };

  TracingChannel.prototype.unsubscribe = function (handlers) {
    var done = true;
    for (var i = 0; i < TRACE_EVENTS.length; i++) {
      var ev = TRACE_EVENTS[i];
      if (handlers[ev] && !this[ev].unsubscribe(handlers[ev])) done = false;
    }
    return done;
  };

  TracingChannel.prototype.traceSync = function (fn, context, thisArg) {
    var args = Array.prototype.slice.call(arguments, 3);
    var ctx = context === undefined ? {} : context;
    if (!this.hasSubscribers) return fn.apply(thisArg, args);
    var self = this;
    return this.start.runStores(ctx, function () {
      try {
        var result = fn.apply(thisArg, args);
        ctx.result = result;
        return result;
      } catch (err) {
        ctx.error = err;
        self.error.publish(ctx);
        throw err;
      } finally {
        self.end.publish(ctx);
      }
    });
  };

  TracingChannel.prototype.tracePromise = function (fn, context, thisArg) {
    var args = Array.prototype.slice.call(arguments, 3);
    var ctx = context === undefined ? {} : context;
    if (!this.hasSubscribers) return fn.apply(thisArg, args);
    var self = this;
    function reject(err) {
      ctx.error = err;
      self.error.publish(ctx);
      self.asyncStart.publish(ctx);
      self.asyncEnd.publish(ctx);
      return Promise.reject(err);
    }
    function resolve(result) {
      ctx.result = result;
      self.asyncStart.publish(ctx);
      self.asyncEnd.publish(ctx);
      return result;
    }
    return this.start.runStores(ctx, function () {
      try {
        var promise = fn.apply(thisArg, args);
        if (!(promise instanceof Promise)) promise = Promise.resolve(promise);
        return promise.then(resolve, reject);
      } catch (err) {
        ctx.error = err;
        self.error.publish(ctx);
        throw err;
      } finally {
        self.end.publish(ctx);
      }
    });
  };

  TracingChannel.prototype.traceCallback = function (fn, position, context, thisArg) {
    var args = Array.prototype.slice.call(arguments, 4);
    var pos = position === undefined ? -1 : position;
    var ctx = context === undefined ? {} : context;
    if (!this.hasSubscribers) return fn.apply(thisArg, args);
    var self = this;
    var idx = pos < 0 ? args.length + pos : pos;
    var cb = args[idx];
    if (typeof cb !== 'function') throw invalidArgType('callback', 'of type function', cb);
    args[idx] = function (err, result) {
      if (err) {
        ctx.error = err;
        self.error.publish(ctx);
      } else {
        ctx.result = result;
      }
      self.asyncStart.publish(ctx);
      try {
        return cb.apply(this, arguments);
      } finally {
        self.asyncEnd.publish(ctx);
      }
    };
    return this.start.runStores(ctx, function () {
      try {
        return fn.apply(thisArg, args);
      } catch (err) {
        ctx.error = err;
        self.error.publish(ctx);
        throw err;
      } finally {
        self.end.publish(ctx);
      }
    });
  };

  BF.diagnostics_channel = function () {
    return {
      channel: dcChannel,
      hasSubscribers: function (name) {
        var found = dcChannels.get(name);
        return found === undefined ? false : found.hasSubscribers;
      },
      subscribe: function (name, subscription) {
        dcChannel(name).subscribe(subscription);
      },
      unsubscribe: function (name, subscription) {
        var found = dcChannels.get(name);
        return found === undefined ? false : found.unsubscribe(subscription);
      },
      tracingChannel: function (nameOrChannels) {
        return new TracingChannel(nameOrChannels);
      },
      Channel: DcChannel
    };
  };

  // ---- async_hooks: AsyncLocalStorage frames -------------------------------

  // The current async context is an immutable map from AsyncLocalStorage id to
  // { store }, or null when no storage is active.
  var currentFrame = null;
  var alsCounter = 0;
  var alsStates = new WeakMap();
  var originalThen = null;

  function frameWithStore(frame, id, store) {
    var next = Object.create(null);
    if (frame !== null) {
      var keys = Object.keys(frame);
      for (var i = 0; i < keys.length; i++) next[keys[i]] = frame[keys[i]];
    }
    next[id] = { store: store };
    return next;
  }

  function frameWithout(frame, id) {
    var next = Object.create(null);
    var keys = Object.keys(frame);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i] !== String(id)) next[keys[i]] = frame[keys[i]];
    }
    return next;
  }

  function runWithFrame(frame, fn, thisArg, args) {
    var prev = currentFrame;
    currentFrame = frame;
    try {
      return fn.apply(thisArg, args);
    } finally {
      currentFrame = prev;
    }
  }

  function bindFrameCallback(cb, frame) {
    if (typeof cb !== 'function') return cb;
    return function () {
      return runWithFrame(frame, cb, this, arguments);
    };
  }

  // Installed on the first run/enterWith. Reactions registered while a frame is
  // active run with that frame restored; with no active frame it is a passthrough.
  function installAsyncContextHook() {
    if (originalThen !== null) return;
    originalThen = Promise.prototype.then;
    Promise.prototype.then = function then(onFulfilled, onRejected) {
      var frame = currentFrame;
      if (frame === null) return originalThen.call(this, onFulfilled, onRejected);
      return originalThen.call(this, bindFrameCallback(onFulfilled, frame), bindFrameCallback(onRejected, frame));
    };
  }

  function alsState(storage) {
    var st = alsStates.get(storage);
    if (st === undefined) throw new TypeError('Illegal invocation');
    return st;
  }

  function AsyncLocalStorage() {
    alsCounter++;
    alsStates.set(this, { id: alsCounter, enabled: false });
  }

  AsyncLocalStorage.prototype.run = function (store, callback) {
    var st = alsState(this);
    var args = Array.prototype.slice.call(arguments, 2);
    installAsyncContextHook();
    st.enabled = true;
    return runWithFrame(frameWithStore(currentFrame, st.id, store), callback, undefined, args);
  };

  AsyncLocalStorage.prototype.exit = function (callback) {
    var st = alsState(this);
    var args = Array.prototype.slice.call(arguments, 1);
    return runWithFrame(frameWithStore(currentFrame, st.id, undefined), callback, undefined, args);
  };

  AsyncLocalStorage.prototype.getStore = function () {
    var st = alsState(this);
    if (!st.enabled || currentFrame === null) return undefined;
    var entry = currentFrame[st.id];
    return entry === undefined ? undefined : entry.store;
  };

  AsyncLocalStorage.prototype.enterWith = function (store) {
    var st = alsState(this);
    installAsyncContextHook();
    st.enabled = true;
    currentFrame = frameWithStore(currentFrame, st.id, store);
  };

  AsyncLocalStorage.prototype.disable = function () {
    var st = alsState(this);
    if (currentFrame !== null && currentFrame[st.id] !== undefined) currentFrame = frameWithout(currentFrame, st.id);
    st.enabled = false;
  };

  AsyncLocalStorage.snapshot = function () {
    var frame = currentFrame;
    return function runInAsyncScope(fn) {
      return runWithFrame(frame, fn, undefined, Array.prototype.slice.call(arguments, 1));
    };
  };

  AsyncLocalStorage.bind = function (fn) {
    var frame = currentFrame;
    return function () {
      return runWithFrame(frame, fn, this, arguments);
    };
  };

  // ---- async_hooks: async ids and resources ---------------------------------

  var asyncIdCounter = 1;
  var currentExecId = 1;
  var currentTriggerId = 0;
  var topResource = {};
  var currentResource = topResource;
  var resourceStates = new WeakMap();

  function resourceState(resource) {
    var st = resourceStates.get(resource);
    if (st === undefined) throw new TypeError('Illegal invocation');
    return st;
  }

  function AsyncResource(type, options) {
    if (typeof type !== 'string') throw invalidArgType('type', 'of type string', type);
    asyncIdCounter++;
    var triggerId = currentExecId;
    if (typeof options === 'number') triggerId = options;
    else if (options && options.triggerAsyncId !== undefined) triggerId = options.triggerAsyncId;
    resourceStates.set(this, { type: type, asyncId: asyncIdCounter, triggerId: triggerId, frame: currentFrame });
  }

  AsyncResource.prototype.runInAsyncScope = function (fn, thisArg) {
    var st = resourceState(this);
    var args = Array.prototype.slice.call(arguments, 2);
    var prevExec = currentExecId;
    var prevTrigger = currentTriggerId;
    var prevResource = currentResource;
    currentExecId = st.asyncId;
    currentTriggerId = st.triggerId;
    currentResource = this;
    try {
      return runWithFrame(st.frame, fn, thisArg, args);
    } finally {
      currentExecId = prevExec;
      currentTriggerId = prevTrigger;
      currentResource = prevResource;
    }
  };

  AsyncResource.prototype.emitDestroy = function () {
    resourceState(this);
    return this;
  };

  AsyncResource.prototype.asyncId = function () {
    return resourceState(this).asyncId;
  };

  AsyncResource.prototype.triggerAsyncId = function () {
    return resourceState(this).triggerId;
  };

  AsyncResource.prototype.bind = function (fn, thisArg) {
    var self = this;
    resourceState(self);
    var bound = function () {
      var target = thisArg === undefined ? this : thisArg;
      return self.runInAsyncScope.apply(self, [fn, target].concat(Array.prototype.slice.call(arguments)));
    };
    Object.defineProperty(bound, 'asyncResource', {
      configurable: true,
      enumerable: false,
      get: function () {
        emitDeprecation('DEP0172', 'The asyncResource property on bound functions is deprecated');
        return self;
      }
    });
    return bound;
  };

  AsyncResource.bind = function (fn, type, thisArg) {
    var name = type || fn.name || 'bound-anonymous-fn';
    return new AsyncResource(name).bind(fn, thisArg);
  };

  function asyncExecutionAsyncId() {
    return currentExecId;
  }

  function asyncTriggerAsyncId() {
    return currentTriggerId;
  }

  function asyncExecutionAsyncResource() {
    return currentResource;
  }

  function asyncCreateHook() {
    var hook = {
      enable: function () {
        return hook;
      },
      disable: function () {
        return hook;
      }
    };
    return hook;
  }

  var ASYNC_WRAP_PROVIDERS = {
    NONE: 0, DIRHANDLE: 1, DNSCHANNEL: 2, ELDHISTOGRAM: 3, FILEHANDLE: 4, FILEHANDLECLOSEREQ: 5,
    BLOBREADER: 6, FSEVENTWRAP: 7, FSREQCALLBACK: 8, FSREQPROMISE: 9, GETADDRINFOREQWRAP: 10,
    GETNAMEINFOREQWRAP: 11, HEAPSNAPSHOT: 12, HTTP2SESSION: 13, HTTP2STREAM: 14, HTTP2PING: 15,
    HTTP2SETTINGS: 16, HTTPINCOMINGMESSAGE: 17, HTTPCLIENTREQUEST: 18, LOCKS: 19, JSSTREAM: 20,
    JSUDPWRAP: 21, MESSAGEPORT: 22, PIPECONNECTWRAP: 23, PIPESERVERWRAP: 24, PIPEWRAP: 25,
    PROCESSWRAP: 26, PROMISE: 27, QUERYWRAP: 28, QUIC_ENDPOINT: 29, QUIC_LOGSTREAM: 30,
    QUIC_PACKET: 31, QUIC_SESSION: 32, QUIC_STREAM: 33, QUIC_UDP: 34, SHUTDOWNWRAP: 35,
    SIGNALWRAP: 36, STATWATCHER: 37, STREAMPIPE: 38, TCPCONNECTWRAP: 39, TCPSERVERWRAP: 40,
    TCPWRAP: 41, TTYWRAP: 42, UDPSENDWRAP: 43, UDPWRAP: 44, SIGINTWATCHDOG: 45, WORKER: 46,
    WORKERCPUPROFILE: 47, WORKERCPUUSAGE: 48, WORKERHEAPPROFILE: 49, WORKERHEAPSNAPSHOT: 50,
    WORKERHEAPSTATISTICS: 51, WRITEWRAP: 52, ZLIB: 53, CHECKPRIMEREQUEST: 54, PBKDF2REQUEST: 55,
    KEYPAIRGENREQUEST: 56, KEYGENREQUEST: 57, KEYEXPORTREQUEST: 58, ARGON2REQUEST: 59,
    CIPHERREQUEST: 60, DERIVEBITSREQUEST: 61, HASHREQUEST: 62, RANDOMBYTESREQUEST: 63,
    RANDOMPRIMEREQUEST: 64, SCRYPTREQUEST: 65, SIGNREQUEST: 66, TLSWRAP: 67, VERIFYREQUEST: 68
  };

  BF.async_hooks = function () {
    ASYNC_CONTEXT.capture = function () {
      return currentFrame;
    };
    ASYNC_CONTEXT.run = function (token, fn) {
      return runWithFrame(token, fn, undefined, []);
    };
    return {
      AsyncLocalStorage: AsyncLocalStorage,
      AsyncResource: AsyncResource,
      asyncWrapProviders: ASYNC_WRAP_PROVIDERS,
      createHook: asyncCreateHook,
      executionAsyncId: asyncExecutionAsyncId,
      executionAsyncResource: asyncExecutionAsyncResource,
      triggerAsyncId: asyncTriggerAsyncId
    };
  };

  // ---- perf_hooks -----------------------------------------------------------

  var PERF_SUPPORTED = ['dns', 'function', 'gc', 'http', 'http2', 'mark', 'measure', 'net', 'resource'];
  var perfEntryData = new WeakMap();
  var perfSeq = 0;
  var perfTimeline = [];
  var perfObserverStates = new WeakMap();
  var perfObservers = [];
  var perfListData = new WeakMap();
  var perfHistData = new WeakMap();

  function illegalConstructor() {
    return paError(TypeError, 'ERR_ILLEGAL_CONSTRUCTOR', 'Illegal constructor');
  }

  function perfNow() {
    return globalThis.performance.now();
  }

  function perfTimestamp(value) {
    if (typeof value !== 'number' || value < 0 || value !== value) {
      throw paError(TypeError, 'ERR_PERFORMANCE_INVALID_TIMESTAMP', String(value) + ' is not a valid timestamp');
    }
    return value;
  }

  function perfEntryOf(entry) {
    var data = perfEntryData.get(entry);
    if (data === undefined) throw new TypeError('Illegal invocation');
    return data;
  }

  function perfInit(entry, name, entryType, startTime, duration, detail) {
    perfSeq++;
    perfEntryData.set(entry, {
      name: name,
      entryType: entryType,
      startTime: startTime,
      duration: duration,
      detail: detail,
      seq: perfSeq
    });
    return entry;
  }

  function perfSortEntries(list) {
    return list.slice().sort(function (a, b) {
      var da = perfEntryOf(a);
      var db = perfEntryOf(b);
      return (da.startTime - db.startTime) || (da.seq - db.seq);
    });
  }

  function perfNotifyObservers(entry) {
    var type = perfEntryOf(entry).entryType;
    for (var i = 0; i < perfObservers.length; i++) {
      var st = perfObservers[i];
      if (st.types.indexOf(type) >= 0) {
        st.pending.push(entry);
        perfScheduleDelivery(st);
      }
    }
  }

  function perfBuffer(entry) {
    perfTimeline.push(entry);
    perfNotifyObservers(entry);
    return entry;
  }

  function perfScheduleDelivery(st) {
    if (st.scheduled) return;
    st.scheduled = true;
    setImmediateImpl(function () {
      st.scheduled = false;
      if (!st.connected || st.pending.length === 0) return;
      var batch = st.pending;
      st.pending = [];
      st.callback.call(st.observer, perfMakeList(batch), st.observer);
    });
  }

  function PerformanceEntry() {
    throw illegalConstructor();
  }

  Object.defineProperty(PerformanceEntry.prototype, 'name', {
    configurable: true,
    get: function () { return perfEntryOf(this).name; }
  });
  Object.defineProperty(PerformanceEntry.prototype, 'entryType', {
    configurable: true,
    get: function () { return perfEntryOf(this).entryType; }
  });
  Object.defineProperty(PerformanceEntry.prototype, 'startTime', {
    configurable: true,
    get: function () { return perfEntryOf(this).startTime; }
  });
  Object.defineProperty(PerformanceEntry.prototype, 'duration', {
    configurable: true,
    get: function () { return perfEntryOf(this).duration; }
  });
  PerformanceEntry.prototype.toJSON = function () {
    var data = perfEntryOf(this);
    return { name: data.name, entryType: data.entryType, startTime: data.startTime, duration: data.duration };
  };

  function PerformanceMark(name, options) {
    var opts = options || {};
    var startTime = opts.startTime !== undefined ? perfTimestamp(opts.startTime) : perfNow();
    var detail = opts.detail !== undefined ? opts.detail : null;
    perfInit(this, String(name), 'mark', startTime, 0, detail);
  }
  PerformanceMark.prototype = Object.create(PerformanceEntry.prototype);
  PerformanceMark.prototype.constructor = PerformanceMark;
  Object.defineProperty(PerformanceMark.prototype, 'detail', {
    configurable: true,
    get: function () { return perfEntryOf(this).detail; }
  });
  PerformanceMark.prototype.toJSON = function () {
    var data = perfEntryOf(this);
    return { name: data.name, entryType: data.entryType, startTime: data.startTime, duration: data.duration, detail: data.detail };
  };

  function PerformanceMeasure() {
    throw illegalConstructor();
  }
  PerformanceMeasure.prototype = Object.create(PerformanceEntry.prototype);
  PerformanceMeasure.prototype.constructor = PerformanceMeasure;
  Object.defineProperty(PerformanceMeasure.prototype, 'detail', {
    configurable: true,
    get: function () { return perfEntryOf(this).detail; }
  });
  PerformanceMeasure.prototype.toJSON = function () {
    var data = perfEntryOf(this);
    return { name: data.name, entryType: data.entryType, startTime: data.startTime, duration: data.duration, detail: data.detail };
  };

  function perfResolveMark(value) {
    if (typeof value === 'number') return value;
    var name = String(value);
    var found = null;
    for (var i = 0; i < perfTimeline.length; i++) {
      var data = perfEntryOf(perfTimeline[i]);
      if (data.entryType === 'mark' && data.name === name) found = perfTimeline[i];
    }
    if (found === null) {
      var err = new SyntaxError('The "' + name + '" performance mark has not been set');
      err.code = 12;
      throw err;
    }
    return perfEntryOf(found).startTime;
  }

  function PerformanceObserverEntryList() {
    throw illegalConstructor();
  }

  function perfMakeList(entries) {
    var list = Object.create(PerformanceObserverEntryList.prototype);
    perfListData.set(list, perfSortEntries(entries));
    return list;
  }

  function perfListOf(list) {
    var data = perfListData.get(list);
    if (data === undefined) throw new TypeError('Illegal invocation');
    return data;
  }

  PerformanceObserverEntryList.prototype.getEntries = function () {
    return perfListOf(this).slice();
  };
  PerformanceObserverEntryList.prototype.getEntriesByName = function (name, type) {
    var wanted = String(name);
    return perfListOf(this).filter(function (e) {
      var d = perfEntryOf(e);
      return d.name === wanted && (type === undefined || d.entryType === String(type));
    });
  };
  PerformanceObserverEntryList.prototype.getEntriesByType = function (type) {
    var wanted = String(type);
    return perfListOf(this).filter(function (e) { return perfEntryOf(e).entryType === wanted; });
  };

  function PerformanceObserver(callback) {
    if (typeof callback !== 'function') throw invalidArgType('callback', 'of type function', callback);
    perfObserverStates.set(this, { observer: this, callback: callback, types: [], pending: [], scheduled: false, connected: false });
  }

  PerformanceObserver.supportedEntryTypes = PERF_SUPPORTED.slice();

  function perfObserverState(observer) {
    var st = perfObserverStates.get(observer);
    if (st === undefined) throw new TypeError('Illegal invocation');
    return st;
  }

  PerformanceObserver.prototype.observe = function (options) {
    var st = perfObserverState(this);
    var requested = null;
    if (options && options.entryTypes !== undefined) requested = Array.isArray(options.entryTypes) ? options.entryTypes : [options.entryTypes];
    else if (options && options.type !== undefined) requested = [options.type];
    if (requested === null) {
      throw paError(TypeError, 'ERR_MISSING_ARGS', 'The "options.entryTypes" and "options.type" arguments must be specified');
    }
    var types = [];
    for (var i = 0; i < requested.length; i++) {
      var t = String(requested[i]);
      if (PERF_SUPPORTED.indexOf(t) >= 0 && types.indexOf(t) < 0) types.push(t);
    }
    st.types = types;
    st.connected = true;
    if (perfObservers.indexOf(st) < 0) perfObservers.push(st);
    if (options && options.buffered) {
      var existing = perfTimeline.filter(function (e) { return types.indexOf(perfEntryOf(e).entryType) >= 0; });
      if (existing.length > 0) {
        st.pending = st.pending.concat(existing);
        perfScheduleDelivery(st);
      }
    }
  };

  PerformanceObserver.prototype.disconnect = function () {
    var st = perfObserverState(this);
    st.connected = false;
    st.pending = [];
    var idx = perfObservers.indexOf(st);
    if (idx >= 0) perfObservers.splice(idx, 1);
  };

  PerformanceObserver.prototype.takeRecords = function () {
    var st = perfObserverState(this);
    var batch = st.pending;
    st.pending = [];
    return batch;
  };

  function perfMarkApi(name, options) {
    var opts = options || {};
    var startTime = opts.startTime !== undefined ? perfTimestamp(opts.startTime) : perfNow();
    var detail = opts.detail !== undefined ? opts.detail : null;
    var entry = Object.create(PerformanceMark.prototype);
    return perfBuffer(perfInit(entry, String(name), 'mark', startTime, 0, detail));
  }

  function perfMeasureApi(name, startOrOptions, endMark) {
    var startTime;
    var endTime;
    var detail = null;
    if (startOrOptions !== null && typeof startOrOptions === 'object') {
      var opts = startOrOptions;
      detail = opts.detail !== undefined ? opts.detail : null;
      var hasStart = opts.start !== undefined;
      var hasEnd = opts.end !== undefined;
      var hasDuration = opts.duration !== undefined;
      if (hasEnd) endTime = perfResolveMark(opts.end);
      if (hasStart) startTime = perfResolveMark(opts.start);
      if (startTime === undefined) startTime = hasEnd && hasDuration ? endTime - opts.duration : 0;
      if (endTime === undefined) endTime = hasDuration ? startTime + opts.duration : perfNow();
    } else {
      startTime = startOrOptions === undefined ? 0 : perfResolveMark(startOrOptions);
      endTime = endMark === undefined ? perfNow() : perfResolveMark(endMark);
    }
    var entry = Object.create(PerformanceMeasure.prototype);
    return perfBuffer(perfInit(entry, String(name), 'measure', startTime, endTime - startTime, detail));
  }

  function perfClearEntries(type, name) {
    var wanted = name === undefined ? undefined : String(name);
    perfTimeline = perfTimeline.filter(function (e) {
      var d = perfEntryOf(e);
      if (d.entryType !== type) return true;
      return wanted !== undefined && d.name !== wanted;
    });
  }

  function perfHistogramOf(histogram) {
    var data = perfHistData.get(histogram);
    if (data === undefined) throw new TypeError('Illegal invocation');
    return data;
  }

  // Nearest-rank percentile over the recorded samples (0 when there are none).
  function perfNearestRank(samples, p) {
    if (samples.length === 0) return 0;
    var sorted = samples.slice().sort(function (a, b) { return a - b; });
    var rank = Math.ceil((p / 100) * sorted.length);
    if (rank < 1) rank = 1;
    if (rank > sorted.length) rank = sorted.length;
    return sorted[rank - 1];
  }

  var HistogramProto = {
    record: function (value) {
      perfHistogramOf(this).samples.push(Number(value));
    },
    recordDelta: function () {
      var data = perfHistogramOf(this);
      var now = perfNow();
      if (data.last !== undefined) data.samples.push((now - data.last) * 1e6);
      data.last = now;
    },
    reset: function () {
      var data = perfHistogramOf(this);
      data.samples = [];
      data.last = undefined;
    },
    percentile: function (p) {
      var value = Number(p);
      if (!(value > 0 && value <= 100)) {
        throw paError(RangeError, 'ERR_OUT_OF_RANGE', 'The value of "percentile" is out of range. It must be > 0 && <= 100. Received ' + String(p));
      }
      return perfNearestRank(perfHistogramOf(this).samples, value);
    },
    enable: function () {
      var data = perfHistogramOf(this);
      if (data.enabled) return false;
      data.enabled = true;
      return true;
    },
    disable: function () {
      var data = perfHistogramOf(this);
      if (!data.enabled) return false;
      data.enabled = false;
      return true;
    }
  };

  Object.defineProperty(HistogramProto, 'min', {
    configurable: true,
    get: function () {
      var s = perfHistogramOf(this).samples;
      return s.length === 0 ? 9223372036854776000 : Math.min.apply(null, s);
    }
  });
  Object.defineProperty(HistogramProto, 'max', {
    configurable: true,
    get: function () {
      var s = perfHistogramOf(this).samples;
      return s.length === 0 ? 0 : Math.max.apply(null, s);
    }
  });
  Object.defineProperty(HistogramProto, 'mean', {
    configurable: true,
    get: function () {
      var s = perfHistogramOf(this).samples;
      if (s.length === 0) return NaN;
      var sum = 0;
      for (var i = 0; i < s.length; i++) sum += s[i];
      return sum / s.length;
    }
  });
  Object.defineProperty(HistogramProto, 'stddev', {
    configurable: true,
    get: function () {
      var s = perfHistogramOf(this).samples;
      if (s.length === 0) return NaN;
      var mean = 0;
      for (var i = 0; i < s.length; i++) mean += s[i];
      mean /= s.length;
      var variance = 0;
      for (var j = 0; j < s.length; j++) variance += (s[j] - mean) * (s[j] - mean);
      return Math.sqrt(variance / s.length);
    }
  });
  Object.defineProperty(HistogramProto, 'count', {
    configurable: true,
    get: function () { return perfHistogramOf(this).samples.length; }
  });
  Object.defineProperty(HistogramProto, 'exceeds', {
    configurable: true,
    get: function () { return 0; }
  });
  // Keys follow Node's histogram iteration: 0, then 50, 75, 87.5, ... (halving the
  // distance to 100) until a key reaches the largest sample, which is then followed by 100.
  Object.defineProperty(HistogramProto, 'percentiles', {
    configurable: true,
    get: function () {
      var samples = perfHistogramOf(this).samples;
      var map = new Map();
      if (samples.length === 0) {
        map.set(100, 0);
        return map;
      }
      var max = Math.max.apply(null, samples);
      var keys = [0];
      for (var k = 1; k < 60; k++) keys.push(100 - 100 / Math.pow(2, k));
      for (var i = 0; i < keys.length; i++) {
        var value = perfNearestRank(samples, keys[i]);
        map.set(keys[i], value);
        if (value >= max) {
          map.set(100, max);
          break;
        }
      }
      return map;
    }
  });

  function perfMakeHistogram(samplesEnabled) {
    var histogram = Object.create(HistogramProto);
    perfHistData.set(histogram, { samples: [], last: undefined, enabled: false, recordable: samplesEnabled });
    return histogram;
  }

  var PerformanceProto = {};

  function Performance() {
    throw illegalConstructor();
  }
  Performance.prototype = PerformanceProto;
  PerformanceProto.constructor = Performance;
  PerformanceProto.mark = perfMarkApi;
  PerformanceProto.measure = perfMeasureApi;
  PerformanceProto.clearMarks = function (name) {
    perfClearEntries('mark', name);
  };
  PerformanceProto.clearMeasures = function (name) {
    perfClearEntries('measure', name);
  };
  PerformanceProto.clearResourceTimings = function () {};
  PerformanceProto.markResourceTiming = function () {};
  PerformanceProto.setResourceTimingBufferSize = function () {};
  PerformanceProto.getEntries = function () {
    return perfSortEntries(perfTimeline);
  };
  PerformanceProto.getEntriesByName = function (name, type) {
    var wanted = String(name);
    return perfSortEntries(perfTimeline.filter(function (e) {
      var d = perfEntryOf(e);
      return d.name === wanted && (type === undefined || d.entryType === String(type));
    }));
  };
  PerformanceProto.getEntriesByType = function (type) {
    var wanted = String(type);
    return perfSortEntries(perfTimeline.filter(function (e) { return perfEntryOf(e).entryType === wanted; }));
  };
  PerformanceProto.eventLoopUtilization = function () {
    return { idle: 0, active: 0, utilization: 0 };
  };
  PerformanceProto.timerify = function (fn) {
    if (typeof fn !== 'function') throw invalidArgType('fn', 'of type function', fn);
    var timerified = function () {
      return fn.apply(this, arguments);
    };
    Object.defineProperty(timerified, 'name', { value: 'timerified ' + fn.name, configurable: true });
    Object.defineProperty(timerified, 'length', { value: fn.length, configurable: true });
    return timerified;
  };
  PerformanceProto.toJSON = function () {
    return { nodeTiming: this.nodeTiming, timeOrigin: this.timeOrigin, eventLoopUtilization: this.eventLoopUtilization() };
  };
  Object.defineProperty(PerformanceProto, 'nodeTiming', {
    configurable: true,
    get: function () {
      var now = perfNow();
      return {
        name: 'node',
        entryType: 'node',
        startTime: 0,
        duration: now,
        nodeStart: 0,
        v8Start: 0,
        bootstrapComplete: 0,
        environment: 0,
        loopStart: -1,
        loopExit: -1,
        idleTime: 0,
        uvMetricsInfo: { loopCount: 0, events: 0, eventsWaiting: 0 }
      };
    }
  });

  // The global performance object gains the user-timing methods it lacks, keeping
  // its identity so that require('perf_hooks').performance === globalThis.performance.
  if (globalThis.performance && typeof globalThis.performance.mark !== 'function') {
    Object.setPrototypeOf(globalThis.performance, PerformanceProto);
  }

  var PERF_CONSTANTS = {
    NODE_PERFORMANCE_GC_MAJOR: 4,
    NODE_PERFORMANCE_GC_MINOR: 1,
    NODE_PERFORMANCE_GC_INCREMENTAL: 8,
    NODE_PERFORMANCE_GC_WEAKCB: 16,
    NODE_PERFORMANCE_GC_FLAGS_NO: 0,
    NODE_PERFORMANCE_GC_FLAGS_CONSTRUCT_RETAINED: 2,
    NODE_PERFORMANCE_GC_FLAGS_FORCED: 4,
    NODE_PERFORMANCE_GC_FLAGS_SYNCHRONOUS_PHANTOM_PROCESSING: 8,
    NODE_PERFORMANCE_GC_FLAGS_ALL_AVAILABLE_GARBAGE: 16,
    NODE_PERFORMANCE_GC_FLAGS_ALL_EXTERNAL_MEMORY: 32,
    NODE_PERFORMANCE_GC_FLAGS_SCHEDULE_IDLE: 64
  };

  function PerformanceResourceTiming() {
    throw illegalConstructor();
  }

  BF.perf_hooks = function () {
    return {
      Performance: Performance,
      PerformanceEntry: PerformanceEntry,
      PerformanceMark: PerformanceMark,
      PerformanceMeasure: PerformanceMeasure,
      PerformanceObserver: PerformanceObserver,
      PerformanceObserverEntryList: PerformanceObserverEntryList,
      PerformanceResourceTiming: PerformanceResourceTiming,
      constants: PERF_CONSTANTS,
      createHistogram: function () {
        return perfMakeHistogram(true);
      },
      monitorEventLoopDelay: function () {
        return perfMakeHistogram(false);
      },
      eventLoopUtilization: function () {
        return PerformanceProto.eventLoopUtilization();
      },
      performance: globalThis.performance,
      timerify: function (fn) {
        return PerformanceProto.timerify(fn);
      }
    };
  };

  // ---- v8 -------------------------------------------------------------------

  var V8_FORMAT = 'owc-v8-json';
  var V8_VERSION = 1;

  function v8NotSupported(what) {
    return paError(Error, 'ERR_NOT_SUPPORTED', what + ' is not supported by this runtime');
  }

  function v8NumberTag(n) {
    if (Object.is(n, -0)) return '-0';
    if (n !== n) return 'NaN';
    if (n === Infinity) return 'Infinity';
    if (n === -Infinity) return '-Infinity';
    return n;
  }

  function v8NumberValue(tag) {
    if (typeof tag === 'number') return tag;
    if (tag === '-0') return -0;
    if (tag === 'NaN') return NaN;
    if (tag === 'Infinity') return Infinity;
    if (tag === '-Infinity') return -Infinity;
    throw new TypeError('bad number tag');
  }

  var V8_TYPED = {
    Int8Array: Int8Array,
    Uint8Array: Uint8Array,
    Uint8ClampedArray: Uint8ClampedArray,
    Int16Array: Int16Array,
    Uint16Array: Uint16Array,
    Int32Array: Int32Array,
    Uint32Array: Uint32Array,
    Float32Array: Float32Array,
    Float64Array: Float64Array,
    BigInt64Array: BigInt64Array,
    BigUint64Array: BigUint64Array
  };

  function v8CloneError(value) {
    return new Error(String(value) + ' could not be cloned.');
  }

  function v8Encode(value, ctx) {
    if (value === undefined) return ['u'];
    if (value === null) return ['z'];
    var t = typeof value;
    if (t === 'boolean') return ['b', value];
    if (t === 'number') return ['n', v8NumberTag(value)];
    if (t === 'string') return ['s', value];
    if (t === 'bigint') return ['i', value.toString()];
    if (t !== 'object') throw v8CloneError(value);
    var known = ctx.seen.get(value);
    if (known !== undefined) return ['r', known];
    var id = ctx.nextId++;
    ctx.seen.set(value, id);
    var tag = Object.prototype.toString.call(value);
    if (tag === '[object Promise]' || tag === '[object WeakMap]' || tag === '[object WeakSet]' || tag === '[object WeakRef]' || tag === '[object Generator]') {
      throw v8CloneError(tag.slice(8, -1) === 'Promise' ? '#<Promise>' : '#<' + tag.slice(8, -1) + '>');
    }
    if (value instanceof Date) return ['D', id, v8NumberTag(value.getTime())];
    if (value instanceof RegExp) return ['R', id, value.source, value.flags];
    if (value instanceof Error) {
      return ['E', id, String(value.name), String(value.message), value.stack === undefined ? '' : String(value.stack)];
    }
    if (value instanceof getBuffer()) {
      return ['T', id, 'Buffer', encodeBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))];
    }
    if (ArrayBuffer.isView(value)) {
      var viewName = value instanceof DataView ? 'DataView' : (value.constructor && value.constructor.name) || 'Uint8Array';
      return ['T', id, viewName, encodeBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))];
    }
    if (value instanceof ArrayBuffer) return ['AB', id, encodeBase64(new Uint8Array(value))];
    if (Array.isArray(value)) {
      var items = [];
      for (var i = 0; i < value.length; i++) items.push(v8Encode(value[i], ctx));
      return ['A', id, items];
    }
    if (value instanceof Map) {
      var entries = [];
      value.forEach(function (v, k) {
        entries.push([v8Encode(k, ctx), v8Encode(v, ctx)]);
      });
      return ['M', id, entries];
    }
    if (value instanceof Set) {
      var members = [];
      value.forEach(function (v) {
        members.push(v8Encode(v, ctx));
      });
      return ['S', id, members];
    }
    var keys = Object.keys(value);
    var pairs = [];
    for (var j = 0; j < keys.length; j++) pairs.push([keys[j], v8Encode(value[keys[j]], ctx)]);
    return ['O', id, pairs];
  }

  function v8Decode(node, table) {
    var tag = node[0];
    if (tag === 'u') return undefined;
    if (tag === 'z') return null;
    if (tag === 'b' || tag === 's') return node[1];
    if (tag === 'n') return v8NumberValue(node[1]);
    if (tag === 'i') return BigInt(node[1]);
    if (tag === 'r') {
      if (!(node[1] in table)) throw new TypeError('bad reference');
      return table[node[1]];
    }
    var id = node[1];
    if (tag === 'A') {
      var arr = [];
      table[id] = arr;
      for (var i = 0; i < node[2].length; i++) arr.push(v8Decode(node[2][i], table));
      return arr;
    }
    if (tag === 'O') {
      var obj = {};
      table[id] = obj;
      for (var j = 0; j < node[2].length; j++) {
        Object.defineProperty(obj, node[2][j][0], {
          value: v8Decode(node[2][j][1], table),
          enumerable: true,
          writable: true,
          configurable: true
        });
      }
      return obj;
    }
    if (tag === 'M') {
      var map = new Map();
      table[id] = map;
      for (var m = 0; m < node[2].length; m++) map.set(v8Decode(node[2][m][0], table), v8Decode(node[2][m][1], table));
      return map;
    }
    if (tag === 'S') {
      var set = new Set();
      table[id] = set;
      for (var s = 0; s < node[2].length; s++) set.add(v8Decode(node[2][s], table));
      return set;
    }
    if (tag === 'D') {
      var date = new Date(v8NumberValue(node[2]));
      table[id] = date;
      return date;
    }
    if (tag === 'R') {
      var re = new RegExp(node[2], node[3]);
      table[id] = re;
      return re;
    }
    if (tag === 'E') {
      var known = ['Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError'];
      var errName = known.indexOf(node[2]) >= 0 ? node[2] : 'Error';
      var err = new (globalThis[errName])(node[3]);
      if (node[4]) err.stack = node[4];
      table[id] = err;
      return err;
    }
    if (tag === 'AB') {
      var rawBytes = decodeBase64(node[2]);
      var buffer = new ArrayBuffer(rawBytes.length);
      new Uint8Array(buffer).set(rawBytes);
      table[id] = buffer;
      return buffer;
    }
    if (tag === 'T') {
      var bytes = decodeBase64(node[3]);
      var storage = new ArrayBuffer(bytes.length);
      new Uint8Array(storage).set(bytes);
      var view;
      if (node[2] === 'Buffer') view = getBuffer().from(storage);
      else if (node[2] === 'DataView') view = new DataView(storage);
      else view = new V8_TYPED[node[2]](storage);
      table[id] = view;
      return view;
    }
    throw new TypeError('unknown tag');
  }

  function v8Serialize(value) {
    var ctx = { seen: new Map(), nextId: 1 };
    var root = v8Encode(value, ctx);
    var json = JSON.stringify({ format: V8_FORMAT, version: V8_VERSION, root: root });
    return getBuffer().from(json, 'utf8');
  }

  function v8Deserialize(buffer) {
    if (!ArrayBuffer.isView(buffer)) {
      throw paError(TypeError, 'ERR_INVALID_ARG_TYPE', 'buffer must be a TypedArray or a DataView');
    }
    var bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    var doc;
    try {
      doc = JSON.parse(utf8Decode(bytes, 0, bytes.length));
    } catch (err) {
      doc = null;
    }
    if (doc === null || typeof doc !== 'object' || doc.format !== V8_FORMAT || doc.version !== V8_VERSION) {
      throw new Error('Unable to deserialize cloned data due to invalid or unsupported version.');
    }
    return v8Decode(doc.root, []);
  }

  function v8HeapStatistics() {
    var limit = 4345298944;
    var used = 4194304;
    return {
      total_heap_size: 8388608,
      total_heap_size_executable: 524288,
      total_physical_size: 8388608,
      total_available_size: limit - used,
      used_heap_size: used,
      heap_size_limit: limit,
      malloced_memory: 262144,
      peak_malloced_memory: 524288,
      does_zap_garbage: 0,
      number_of_native_contexts: 1,
      number_of_detached_contexts: 0,
      total_global_handles_size: 8192,
      used_global_handles_size: 4096,
      external_memory: 1048576
    };
  }

  function v8CodeStatistics() {
    return {
      code_and_metadata_size: 0,
      bytecode_and_metadata_size: 0,
      external_script_source_size: 0,
      cpu_profiler_metadata_size: 0
    };
  }

  function v8ThrowingClass(name) {
    var Cls = function () {
      throw v8NotSupported(name);
    };
    Object.defineProperty(Cls, 'name', { value: name });
    return Cls;
  }

  BF.v8 = function () {
    var cachedTag = 1147835408;
    return {
      cachedDataVersionTag: function () {
        return cachedTag;
      },
      getHeapStatistics: v8HeapStatistics,
      getHeapCodeStatistics: v8CodeStatistics,
      getHeapSpaceStatistics: function () {
        return [];
      },
      getCppHeapStatistics: function () {
        return { committed_size_bytes: 0, resident_size_bytes: 0, used_size_bytes: 0, space_statistics: [], type_names: [] };
      },
      setFlagsFromString: function (flags) {
        if (typeof flags !== 'string') throw invalidArgType('flags', 'of type string', flags);
      },
      setHeapSnapshotNearHeapLimit: function (limit) {
        if (typeof limit !== 'number' || !(limit >= 1 && limit <= 4294967295)) {
          throw paError(RangeError, 'ERR_OUT_OF_RANGE', 'The value of "limit" is out of range. It must be >= 1 && <= 4294967295. Received ' + String(limit));
        }
      },
      takeCoverage: function () {},
      stopCoverage: function () {},
      isStringOneByteRepresentation: function (content) {
        if (typeof content !== 'string') throw invalidArgType('content', 'of type string', content);
        for (var i = 0; i < content.length; i++) {
          if (content.charCodeAt(i) > 0xff) return false;
        }
        return true;
      },
      serialize: v8Serialize,
      deserialize: v8Deserialize,
      writeHeapSnapshot: function () {
        throw v8NotSupported('writeHeapSnapshot');
      },
      getHeapSnapshot: function () {
        throw v8NotSupported('getHeapSnapshot');
      },
      queryObjects: function () {
        throw v8NotSupported('queryObjects');
      },
      startCpuProfile: function () {
        throw v8NotSupported('startCpuProfile');
      },
      promiseHooks: {
        createHook: function () { return function () {}; },
        onInit: function () { return function () {}; },
        onSettled: function () { return function () {}; },
        onBefore: function () { return function () {}; },
        onAfter: function () { return function () {}; }
      },
      startupSnapshot: {
        isBuildingSnapshot: function () { return false; },
        addSerializeCallback: function () {},
        addDeserializeCallback: function () {},
        setDeserializeMainFunction: function () {}
      },
      Serializer: v8ThrowingClass('Serializer'),
      Deserializer: v8ThrowingClass('Deserializer'),
      DefaultSerializer: v8ThrowingClass('DefaultSerializer'),
      DefaultDeserializer: v8ThrowingClass('DefaultDeserializer'),
      GCProfiler: v8ThrowingClass('GCProfiler')
    };
  };
})();
`;
