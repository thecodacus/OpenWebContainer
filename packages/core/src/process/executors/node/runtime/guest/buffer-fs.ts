/**
 * Guest-side `buffer` (Buffer on a Uint8Array prototype chain) and `fs` built-ins.
 * fs is sync-first over the host bridge; callback and promise forms wrap the sync
 * implementation. Plain JavaScript inside a String.raw snippet.
 */
export const BUFFER_FS_SRC = String.raw`
BF.buffer = function () {
  function Buffer(arg, encodingOrOffset, length) {
    return Buffer.from(arg, encodingOrOffset, length);
  }
  Buffer.prototype = Object.create(Uint8Array.prototype);
  Buffer.prototype.constructor = Buffer;

  function wrapBytes(bytes) {
    Object.setPrototypeOf(bytes, Buffer.prototype);
    return bytes;
  }

  Buffer.from = function (value, encodingOrOffset, length) {
    if (typeof value === 'string') return wrapBytes(encodeString(value, encodingOrOffset || 'utf8'));
    if (value instanceof ArrayBuffer) {
      var offset = encodingOrOffset || 0;
      var len = length === undefined ? value.byteLength - offset : length;
      return wrapBytes(new Uint8Array(value, offset, len));
    }
    if (ArrayBuffer.isView(value)) {
      var copy = new Uint8Array(value.byteLength);
      copy.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      return wrapBytes(copy);
    }
    if (Array.isArray(value)) {
      var arr = new Uint8Array(value.length);
      for (var i = 0; i < value.length; i++) arr[i] = value[i] & 0xff;
      return wrapBytes(arr);
    }
    if (value && value.type === 'Buffer' && Array.isArray(value.data)) return Buffer.from(value.data);
    throw new TypeError('The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array');
  };

  Buffer.alloc = function (size, fill, encoding) {
    var bytes = wrapBytes(new Uint8Array(size));
    if (fill !== undefined && fill !== 0) bytes.fill(fill, 0, size, encoding);
    return bytes;
  };
  Buffer.allocUnsafe = Buffer.alloc;
  Buffer.allocUnsafeSlow = Buffer.alloc;

  Buffer.isBuffer = function (value) {
    return value instanceof Buffer;
  };
  Buffer.isEncoding = function (encoding) {
    var known = ['utf8', 'utf-8', 'hex', 'base64', 'base64url', 'ascii', 'latin1', 'binary', 'ucs2', 'ucs-2', 'utf16le', 'utf-16le'];
    return typeof encoding === 'string' && known.indexOf(encoding.toLowerCase()) >= 0;
  };
  Buffer.byteLength = function (value, encoding) {
    if (typeof value === 'string') return encodeString(value, encoding || 'utf8').length;
    return value.byteLength;
  };
  Buffer.concat = function (list, totalLength) {
    var total = 0;
    for (var i = 0; i < list.length; i++) total += list[i].length;
    var size = totalLength === undefined ? total : totalLength;
    var out = wrapBytes(new Uint8Array(size));
    var pos = 0;
    for (var j = 0; j < list.length && pos < size; j++) {
      var chunk = list[j];
      for (var k = 0; k < chunk.length && pos < size; k++) out[pos++] = chunk[k];
    }
    return out;
  };
  Buffer.compare = function (a, b) {
    return Buffer.prototype.compare.call(a, b);
  };

  Buffer.prototype.toString = function (encoding, start, end) {
    return decodeBytes(this, encoding || 'utf8', start, end);
  };
  Buffer.prototype.toJSON = function () {
    return { type: 'Buffer', data: Array.from(this) };
  };
  Buffer.prototype.equals = function (other) {
    return this.compare(other) === 0;
  };
  Buffer.prototype.compare = function (other) {
    var n = Math.min(this.length, other.length);
    for (var i = 0; i < n; i++) {
      if (this[i] !== other[i]) return this[i] < other[i] ? -1 : 1;
    }
    if (this.length === other.length) return 0;
    return this.length < other.length ? -1 : 1;
  };
  Buffer.prototype.slice = function (start, end) {
    return wrapBytes(Uint8Array.prototype.subarray.call(this, start, end));
  };
  Buffer.prototype.subarray = Buffer.prototype.slice;
  Buffer.prototype.write = function (string, offset, encoding) {
    var start = typeof offset === 'number' ? offset : 0;
    var bytes = encodeString(string, encoding || 'utf8');
    var written = 0;
    for (var i = 0; i < bytes.length && start + i < this.length; i++) {
      this[start + i] = bytes[i];
      written++;
    }
    return written;
  };
  Buffer.prototype.fill = function (value, offset, end, encoding) {
    var start = typeof offset === 'number' ? offset : 0;
    var stop = typeof end === 'number' ? end : this.length;
    if (typeof offset === 'string') encoding = offset;
    if (typeof value === 'number') {
      for (var n = start; n < stop; n++) this[n] = value & 0xff;
      return this;
    }
    var pattern = typeof value === 'string' ? encodeString(value, encoding || 'utf8') : value;
    if (pattern.length === 0) return this;
    for (var i = start, k = 0; i < stop; i++, k = (k + 1) % pattern.length) this[i] = pattern[k];
    return this;
  };
  Buffer.prototype.indexOf = function (value, byteOffset, encoding) {
    var needle = typeof value === 'number' ? Uint8Array.of(value & 0xff)
      : typeof value === 'string' ? encodeString(value, encoding || 'utf8') : value;
    var from = typeof byteOffset === 'number' ? (byteOffset < 0 ? Math.max(0, this.length + byteOffset) : byteOffset) : 0;
    for (var i = from; i + needle.length <= this.length; i++) {
      var match = true;
      for (var j = 0; j < needle.length; j++) {
        if (this[i + j] !== needle[j]) {
          match = false;
          break;
        }
      }
      if (match) return i;
    }
    return -1;
  };
  Buffer.prototype.includes = function (value, byteOffset, encoding) {
    return this.indexOf(value, byteOffset, encoding) !== -1;
  };
  Buffer.prototype.lastIndexOf = function (value, byteOffset, encoding) {
    var needle = typeof value === 'number' ? Uint8Array.of(value & 0xff)
      : typeof value === 'string' ? encodeString(value, encoding || 'utf8') : value;
    var from = typeof byteOffset === 'number' ? byteOffset : this.length - needle.length;
    for (var i = Math.min(from, this.length - needle.length); i >= 0; i--) {
      var match = true;
      for (var j = 0; j < needle.length; j++) {
        if (this[i + j] !== needle[j]) {
          match = false;
          break;
        }
      }
      if (match) return i;
    }
    return -1;
  };
  Buffer.prototype.readUInt8 = function (offset) {
    return this[offset || 0];
  };
  Buffer.prototype.readInt8 = function (offset) {
    var v = this[offset || 0];
    return v > 127 ? v - 256 : v;
  };
  Buffer.prototype.readUInt16BE = function (offset) {
    var o = offset || 0;
    return (this[o] << 8) | this[o + 1];
  };
  Buffer.prototype.readUInt16LE = function (offset) {
    var o = offset || 0;
    return this[o] | (this[o + 1] << 8);
  };
  Buffer.prototype.readInt16BE = function (offset) {
    var v = this.readUInt16BE(offset);
    return v > 0x7fff ? v - 0x10000 : v;
  };
  Buffer.prototype.readInt16LE = function (offset) {
    var v = this.readUInt16LE(offset);
    return v > 0x7fff ? v - 0x10000 : v;
  };
  Buffer.prototype.writeUInt16BE = function (value, offset) {
    var o = offset || 0;
    this[o] = (value >>> 8) & 0xff;
    this[o + 1] = value & 0xff;
    return o + 2;
  };
  Buffer.prototype.writeUInt16LE = function (value, offset) {
    var o = offset || 0;
    this[o] = value & 0xff;
    this[o + 1] = (value >>> 8) & 0xff;
    return o + 2;
  };
  Buffer.prototype.readInt32BE = function (offset) {
    return this.readUInt32BE(offset) | 0;
  };
  Buffer.prototype.readInt32LE = function (offset) {
    return this.readUInt32LE(offset) | 0;
  };
  Buffer.prototype.writeUInt8 = function (value, offset) {
    this[offset || 0] = value & 0xff;
    return (offset || 0) + 1;
  };
  Buffer.prototype.readUInt32BE = function (offset) {
    var o = offset || 0;
    return ((this[o] << 24) >>> 0) + (this[o + 1] << 16) + (this[o + 2] << 8) + this[o + 3];
  };
  Buffer.prototype.readUInt32LE = function (offset) {
    var o = offset || 0;
    return ((this[o + 3] << 24) >>> 0) + (this[o + 2] << 16) + (this[o + 1] << 8) + this[o];
  };
  Buffer.prototype.writeUInt32BE = function (value, offset) {
    var o = offset || 0;
    this[o] = (value >>> 24) & 0xff;
    this[o + 1] = (value >>> 16) & 0xff;
    this[o + 2] = (value >>> 8) & 0xff;
    this[o + 3] = value & 0xff;
    return o + 4;
  };
  Buffer.prototype.writeUInt32LE = function (value, offset) {
    var o = offset || 0;
    this[o] = value & 0xff;
    this[o + 1] = (value >>> 8) & 0xff;
    this[o + 2] = (value >>> 16) & 0xff;
    this[o + 3] = (value >>> 24) & 0xff;
    return o + 4;
  };
  Buffer.poolSize = 8192;

  var MAX_BUFFER_LENGTH = 9007199254740991;
  var MAX_STRING_LENGTH = 536870888;

  function bufErr(Kind, code, message) {
    var err = new Kind(message);
    err.code = code;
    return err;
  }

  function describeArg(value) {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (typeof value === 'function') return 'function ' + value.name;
    if (typeof value === 'object') return 'an instance of ' + ((value.constructor && value.constructor.name) || 'Object');
    return 'type ' + typeof value + ' (' + String(value) + ')';
  }

  function checkOffset(buf, offset, size) {
    var o = offset === undefined ? 0 : offset;
    if (typeof o !== 'number') throw bufErr(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "offset" argument must be of type number. Received ' + describeArg(o));
    if (o !== Math.floor(o)) throw bufErr(RangeError, 'ERR_OUT_OF_RANGE', 'The value of "offset" is out of range. It must be an integer. Received ' + o);
    if (buf.length - size < 0) throw bufErr(RangeError, 'ERR_BUFFER_OUT_OF_BOUNDS', 'Attempt to access memory outside buffer bounds');
    if (o < 0 || o > buf.length - size) {
      throw bufErr(RangeError, 'ERR_OUT_OF_RANGE', 'The value of "offset" is out of range. It must be >= 0 and <= ' + (buf.length - size) + '. Received ' + o);
    }
    return o;
  }

  function viewOf(buf) {
    return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  Buffer.prototype.readFloatLE = function (offset) {
    return viewOf(this).getFloat32(checkOffset(this, offset, 4), true);
  };
  Buffer.prototype.readFloatBE = function (offset) {
    return viewOf(this).getFloat32(checkOffset(this, offset, 4), false);
  };
  Buffer.prototype.readDoubleLE = function (offset) {
    return viewOf(this).getFloat64(checkOffset(this, offset, 8), true);
  };
  Buffer.prototype.readDoubleBE = function (offset) {
    return viewOf(this).getFloat64(checkOffset(this, offset, 8), false);
  };
  Buffer.prototype.writeFloatLE = function (value, offset) {
    var o = checkOffset(this, offset, 4);
    viewOf(this).setFloat32(o, value, true);
    return o + 4;
  };
  Buffer.prototype.writeFloatBE = function (value, offset) {
    var o = checkOffset(this, offset, 4);
    viewOf(this).setFloat32(o, value, false);
    return o + 4;
  };
  Buffer.prototype.writeDoubleLE = function (value, offset) {
    var o = checkOffset(this, offset, 8);
    viewOf(this).setFloat64(o, value, true);
    return o + 8;
  };
  Buffer.prototype.writeDoubleBE = function (value, offset) {
    var o = checkOffset(this, offset, 8);
    viewOf(this).setFloat64(o, value, false);
    return o + 8;
  };

  Buffer.prototype.readBigInt64LE = function (offset) {
    return viewOf(this).getBigInt64(checkOffset(this, offset, 8), true);
  };
  Buffer.prototype.readBigInt64BE = function (offset) {
    return viewOf(this).getBigInt64(checkOffset(this, offset, 8), false);
  };
  Buffer.prototype.readBigUInt64LE = function (offset) {
    return viewOf(this).getBigUint64(checkOffset(this, offset, 8), true);
  };
  Buffer.prototype.readBigUInt64BE = function (offset) {
    return viewOf(this).getBigUint64(checkOffset(this, offset, 8), false);
  };
  Buffer.prototype.writeBigInt64LE = function (value, offset) {
    var o = checkOffset(this, offset, 8);
    viewOf(this).setBigInt64(o, value, true);
    return o + 8;
  };
  Buffer.prototype.writeBigInt64BE = function (value, offset) {
    var o = checkOffset(this, offset, 8);
    viewOf(this).setBigInt64(o, value, false);
    return o + 8;
  };
  Buffer.prototype.writeBigUInt64LE = function (value, offset) {
    var o = checkOffset(this, offset, 8);
    viewOf(this).setBigUint64(o, value, true);
    return o + 8;
  };
  Buffer.prototype.writeBigUInt64BE = function (value, offset) {
    var o = checkOffset(this, offset, 8);
    viewOf(this).setBigUint64(o, value, false);
    return o + 8;
  };

  Buffer.prototype.writeInt8 = function (value, offset) {
    var o = checkOffset(this, offset, 1);
    this[o] = value & 0xff;
    return o + 1;
  };
  Buffer.prototype.writeInt16LE = function (value, offset) {
    var o = checkOffset(this, offset, 2);
    viewOf(this).setInt16(o, value, true);
    return o + 2;
  };
  Buffer.prototype.writeInt16BE = function (value, offset) {
    var o = checkOffset(this, offset, 2);
    viewOf(this).setInt16(o, value, false);
    return o + 2;
  };
  Buffer.prototype.writeInt32LE = function (value, offset) {
    var o = checkOffset(this, offset, 4);
    viewOf(this).setInt32(o, value, true);
    return o + 4;
  };
  Buffer.prototype.writeInt32BE = function (value, offset) {
    var o = checkOffset(this, offset, 4);
    viewOf(this).setInt32(o, value, false);
    return o + 4;
  };

  function byteLengthOf(byteLength) {
    if (typeof byteLength !== 'number' || byteLength !== Math.floor(byteLength) || byteLength < 1 || byteLength > 6) {
      throw bufErr(RangeError, 'ERR_OUT_OF_RANGE', 'The value of "byteLength" is out of range. It must be >= 1 and <= 6. Received ' + byteLength);
    }
    return byteLength;
  }

  function readUintVar(buf, offset, byteLength, little) {
    var bl = byteLengthOf(byteLength);
    var o = checkOffset(buf, offset, bl);
    var val = 0;
    for (var i = 0; i < bl; i++) {
      val = val * 256 + buf[little ? o + bl - 1 - i : o + i];
    }
    return val;
  }

  function readIntVar(buf, offset, byteLength, little) {
    var bl = byteLengthOf(byteLength);
    var val = readUintVar(buf, offset, bl, little);
    var limit = Math.pow(2, 8 * bl - 1);
    return val >= limit ? val - 2 * limit : val;
  }

  function writeUintVar(buf, value, offset, byteLength, little) {
    var bl = byteLengthOf(byteLength);
    var max = Math.pow(2, 8 * bl);
    if (typeof value !== 'number' || value < 0 || value >= max) {
      throw bufErr(RangeError, 'ERR_OUT_OF_RANGE', 'The value of "value" is out of range. It must be >= 0 and <= ' + (max - 1) + '. Received ' + value);
    }
    var o = checkOffset(buf, offset, bl);
    var v = value;
    for (var i = 0; i < bl; i++) {
      buf[little ? o + i : o + bl - 1 - i] = v % 256;
      v = Math.floor(v / 256);
    }
    return o + bl;
  }

  function writeIntVar(buf, value, offset, byteLength, little) {
    var bl = byteLengthOf(byteLength);
    var limit = Math.pow(2, 8 * bl - 1);
    if (typeof value !== 'number' || value < -limit || value >= limit) {
      throw bufErr(RangeError, 'ERR_OUT_OF_RANGE', 'The value of "value" is out of range. It must be >= ' + (-limit) + ' and <= ' + (limit - 1) + '. Received ' + value);
    }
    return writeUintVar(buf, value < 0 ? value + 2 * limit : value, offset, bl, little);
  }

  Buffer.prototype.readUIntLE = function (offset, byteLength) {
    return readUintVar(this, offset, byteLength, true);
  };
  Buffer.prototype.readUIntBE = function (offset, byteLength) {
    return readUintVar(this, offset, byteLength, false);
  };
  Buffer.prototype.readIntLE = function (offset, byteLength) {
    return readIntVar(this, offset, byteLength, true);
  };
  Buffer.prototype.readIntBE = function (offset, byteLength) {
    return readIntVar(this, offset, byteLength, false);
  };
  Buffer.prototype.writeUIntLE = function (value, offset, byteLength) {
    return writeUintVar(this, value, offset, byteLength, true);
  };
  Buffer.prototype.writeUIntBE = function (value, offset, byteLength) {
    return writeUintVar(this, value, offset, byteLength, false);
  };
  Buffer.prototype.writeIntLE = function (value, offset, byteLength) {
    return writeIntVar(this, value, offset, byteLength, true);
  };
  Buffer.prototype.writeIntBE = function (value, offset, byteLength) {
    return writeIntVar(this, value, offset, byteLength, false);
  };

  function swapBytes(buf, size) {
    if (buf.length % size !== 0) {
      throw bufErr(RangeError, 'ERR_INVALID_BUFFER_SIZE', 'Buffer size must be a multiple of ' + (size * 8) + '-bits');
    }
    for (var i = 0; i < buf.length; i += size) {
      for (var a = i, b = i + size - 1; a < b; a++, b--) {
        var t = buf[a];
        buf[a] = buf[b];
        buf[b] = t;
      }
    }
    return buf;
  }
  Buffer.prototype.swap16 = function () {
    return swapBytes(this, 2);
  };
  Buffer.prototype.swap32 = function () {
    return swapBytes(this, 4);
  };
  Buffer.prototype.swap64 = function () {
    return swapBytes(this, 8);
  };

  Buffer.prototype.copy = function (target, targetStart, sourceStart, sourceEnd) {
    var ts = targetStart === undefined ? 0 : targetStart;
    var ss = sourceStart === undefined ? 0 : sourceStart;
    var se = sourceEnd === undefined ? this.length : Math.min(sourceEnd, this.length);
    if (ss >= se || ts >= target.length) return 0;
    var n = Math.min(se - ss, target.length - ts);
    Uint8Array.prototype.set.call(target, Uint8Array.prototype.subarray.call(this, ss, ss + n), ts);
    return n;
  };

  Buffer.prototype.readUint8 = Buffer.prototype.readUInt8;
  Buffer.prototype.readUint16LE = Buffer.prototype.readUInt16LE;
  Buffer.prototype.readUint16BE = Buffer.prototype.readUInt16BE;
  Buffer.prototype.readUint32LE = Buffer.prototype.readUInt32LE;
  Buffer.prototype.readUint32BE = Buffer.prototype.readUInt32BE;
  Buffer.prototype.readUintLE = Buffer.prototype.readUIntLE;
  Buffer.prototype.readUintBE = Buffer.prototype.readUIntBE;
  Buffer.prototype.readBigUint64LE = Buffer.prototype.readBigUInt64LE;
  Buffer.prototype.readBigUint64BE = Buffer.prototype.readBigUInt64BE;
  Buffer.prototype.writeUint8 = Buffer.prototype.writeUInt8;
  Buffer.prototype.writeUint16LE = Buffer.prototype.writeUInt16LE;
  Buffer.prototype.writeUint16BE = Buffer.prototype.writeUInt16BE;
  Buffer.prototype.writeUint32LE = Buffer.prototype.writeUInt32LE;
  Buffer.prototype.writeUint32BE = Buffer.prototype.writeUInt32BE;
  Buffer.prototype.writeUintLE = Buffer.prototype.writeUIntLE;
  Buffer.prototype.writeUintBE = Buffer.prototype.writeUIntBE;
  Buffer.prototype.writeBigUint64LE = Buffer.prototype.writeBigUInt64LE;
  Buffer.prototype.writeBigUint64BE = Buffer.prototype.writeBigUInt64BE;

  function writeEncoded(buf, str, enc, offset, length) {
    var bytes = encodeString(String(str), enc);
    var o = offset === undefined ? 0 : offset;
    var room = buf.length - o;
    var max = length === undefined ? room : Math.min(length, room);
    var n = Math.min(bytes.length, max);
    Uint8Array.prototype.set.call(buf, bytes.subarray(0, n), o);
    return n;
  }

  ['ascii', 'base64', 'base64url', 'hex', 'latin1', 'ucs2', 'utf8'].forEach(function (name) {
    var enc = name === 'ucs2' ? 'utf16le' : name;
    Buffer.prototype[name + 'Slice'] = function (start, end) {
      return decodeBytes(this, enc, start, end);
    };
    Buffer.prototype[name + 'Write'] = function (string, offset, length) {
      return writeEncoded(this, string, enc, offset, length);
    };
  });

  Buffer.prototype.toLocaleString = Buffer.prototype.toString;
  Object.defineProperty(Buffer.prototype, 'parent', {
    enumerable: true,
    configurable: true,
    get: function () {
      return this.buffer;
    }
  });
  Object.defineProperty(Buffer.prototype, 'offset', {
    enumerable: true,
    configurable: true,
    get: function () {
      return this.byteOffset;
    }
  });
  Buffer.of = function () {
    return Buffer.from(Array.prototype.slice.call(arguments));
  };
  Buffer.copyBytesFrom = function (view, offset, length) {
    var size = view.BYTES_PER_ELEMENT || 1;
    var start = offset === undefined ? 0 : offset;
    var count = length === undefined ? view.length - start : length;
    return Buffer.from(new Uint8Array(view.buffer, view.byteOffset + start * size, count * size));
  };

  var kBlobBytes = Symbol('owcBlobBytes');
  var kBlobType = Symbol('owcBlobType');

  function blobType(value) {
    var text = String(value);
    return /^[\x20-\x7e]*$/.test(text) ? text.toLowerCase() : '';
  }

  function blobIndex(value, size, fallback) {
    if (value === undefined) return fallback;
    var n = Math.trunc(Number(value));
    if (Number.isNaN(n)) return 0;
    if (n < 0) return Math.max(size + n, 0);
    return Math.min(n, size);
  }

  class Blob {
    constructor(sources, options) {
      var list = Array.from(sources === undefined ? [] : sources);
      var parts = [];
      var total = 0;
      for (var i = 0; i < list.length; i++) {
        var item = list[i];
        var bytes;
        if (item instanceof Blob) bytes = item[kBlobBytes];
        else if (ArrayBuffer.isView(item)) bytes = new Uint8Array(item.buffer, item.byteOffset, item.byteLength);
        else if (item instanceof ArrayBuffer) bytes = new Uint8Array(item);
        else bytes = encodeString(String(item), 'utf8');
        parts.push(bytes);
        total += bytes.length;
      }
      var out = new Uint8Array(total);
      var pos = 0;
      for (var j = 0; j < parts.length; j++) {
        out.set(parts[j], pos);
        pos += parts[j].length;
      }
      this[kBlobBytes] = out;
      this[kBlobType] = options && options.type !== undefined ? blobType(options.type) : '';
    }
    get size() {
      return this[kBlobBytes].length;
    }
    get type() {
      return this[kBlobType];
    }
    text() {
      return Promise.resolve(decodeBytes(this[kBlobBytes], 'utf8'));
    }
    arrayBuffer() {
      return Promise.resolve(this[kBlobBytes].slice().buffer);
    }
    bytes() {
      return Promise.resolve(this[kBlobBytes].slice());
    }
    slice(start, end, contentType) {
      var size = this[kBlobBytes].length;
      var s = blobIndex(start, size, 0);
      var e = blobIndex(end, size, size);
      var type = contentType === undefined ? '' : blobType(contentType);
      return makeBlob(this[kBlobBytes].slice(s, Math.max(e, s)), type);
    }
  }
  Object.defineProperty(Blob.prototype, Symbol.toStringTag, { value: 'Blob', configurable: true });

  function makeBlob(bytes, type) {
    var blob = Object.create(Blob.prototype);
    blob[kBlobBytes] = bytes;
    blob[kBlobType] = type;
    return blob;
  }

  var TRANSCODE_ENCODINGS = {
    ascii: 'ascii', latin1: 'latin1', binary: 'latin1',
    ucs2: 'utf16le', 'ucs-2': 'utf16le', utf16le: 'utf16le', 'utf-16le': 'utf16le',
    utf8: 'utf8', 'utf-8': 'utf8'
  };

  function transcodeName(enc) {
    var key = String(enc).toLowerCase();
    return Object.prototype.hasOwnProperty.call(TRANSCODE_ENCODINGS, key) ? TRANSCODE_ENCODINGS[key] : null;
  }

  function transcode(source, fromEnc, toEnc) {
    if (!ArrayBuffer.isView(source) && !(source instanceof ArrayBuffer)) {
      throw bufErr(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "source" argument must be an instance of Buffer or Uint8Array. Received ' + describeArg(source));
    }
    var from = transcodeName(fromEnc);
    var to = transcodeName(toEnc);
    if (from === null || to === null) {
      throw bufErr(Error, 'U_ILLEGAL_ARGUMENT_ERROR', 'Unable to transcode Buffer [U_ILLEGAL_ARGUMENT_ERROR]');
    }
    var bytes = source instanceof ArrayBuffer ? new Uint8Array(source) : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    var text = decodeBytes(bytes, from);
    var out;
    if (to === 'utf8' || to === 'utf16le') {
      out = encodeString(text, to);
    } else {
      // latin1 and ascii cannot hold every code point: each unrepresentable one becomes '?', as ICU substitutes it
      var limit = to === 'ascii' ? 128 : 256;
      var points = Array.from(text);
      out = new Uint8Array(points.length);
      for (var i = 0; i < points.length; i++) {
        var cp = points[i].codePointAt(0);
        out[i] = cp < limit ? cp : 63;
      }
    }
    return wrapBytes(out);
  }

  function inputBytes(value) {
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    throw bufErr(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "input" argument must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView. Received ' + describeArg(value));
  }

  // Strict UTF-8: no overlong forms, no surrogates, nothing above U+10FFFF.
  function utf8Valid(bytes) {
    var i = 0;
    var n = bytes.length;
    while (i < n) {
      var b = bytes[i];
      if (b < 0x80) {
        i++;
        continue;
      }
      var need;
      var cp;
      var min;
      if (b >= 0xc2 && b <= 0xdf) {
        need = 1;
        cp = b & 0x1f;
        min = 0x80;
      } else if (b >= 0xe0 && b <= 0xef) {
        need = 2;
        cp = b & 0x0f;
        min = 0x800;
      } else if (b >= 0xf0 && b <= 0xf4) {
        need = 3;
        cp = b & 0x07;
        min = 0x10000;
      } else {
        return false;
      }
      if (i + need >= n) return false;
      for (var k = 1; k <= need; k++) {
        var c = bytes[i + k];
        if ((c & 0xc0) !== 0x80) return false;
        cp = cp * 64 + (c & 0x3f);
      }
      if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return false;
      i += need + 1;
    }
    return true;
  }

  function isUtf8(input) {
    return utf8Valid(inputBytes(input));
  }

  function isAscii(input) {
    var bytes = inputBytes(input);
    for (var i = 0; i < bytes.length; i++) {
      if (bytes[i] > 0x7f) return false;
    }
    return true;
  }

  return {
    Buffer: Buffer,
    kMaxLength: MAX_BUFFER_LENGTH,
    kStringMaxLength: MAX_STRING_LENGTH,
    constants: { MAX_LENGTH: MAX_BUFFER_LENGTH, MAX_STRING_LENGTH: MAX_STRING_LENGTH },
    Blob: Blob,
    transcode: transcode,
    isUtf8: isUtf8,
    isAscii: isAscii
  };
};

BF.fs = function () {
  var P = requireBuiltin('path');
  var Buf = requireBuiltin('buffer').Buffer;

  var DESCRIPTIONS = {
    ENOENT: 'no such file or directory',
    EEXIST: 'file already exists',
    EISDIR: 'illegal operation on a directory',
    ENOTDIR: 'not a directory',
    ENOTEMPTY: 'directory not empty'
  };

  function fsError(code, syscall, path) {
    var err = new Error(code + ': ' + DESCRIPTIONS[code] + ', ' + syscall + " '" + path + "'");
    err.errno = code === 'ENOENT' ? -2 : -1;
    err.code = code;
    err.syscall = syscall;
    err.path = path;
    return err;
  }

  function toPathString(p) {
    var s = p && typeof p === 'object' && p.href ? p.href : String(p);
    if (s.indexOf('file://') === 0) s = decodeURIComponent(s.slice(7));
    return P.resolve(s);
  }

  function statOf(file) {
    var raw = host.statJSON(file);
    return raw === null ? null : JSON.parse(raw);
  }

  function optionsEncoding(opts) {
    if (typeof opts === 'string') return opts;
    if (opts && typeof opts === 'object' && opts.encoding) return opts.encoding;
    return undefined;
  }

  function makeStats(st) {
    var mtime = new Date(st.mtimeMs);
    return {
      dev: 0,
      mode: st.type === 'dir' ? 16877 : 33188,
      nlink: 1,
      uid: 0,
      gid: 0,
      rdev: 0,
      blksize: 4096,
      ino: 0,
      size: st.size,
      blocks: Math.ceil(st.size / 512),
      atimeMs: st.mtimeMs,
      mtimeMs: st.mtimeMs,
      ctimeMs: st.mtimeMs,
      birthtimeMs: st.mtimeMs,
      atime: mtime,
      mtime: mtime,
      ctime: mtime,
      birthtime: mtime,
      isFile: function () { return st.type === 'file'; },
      isDirectory: function () { return st.type === 'dir'; },
      isSymbolicLink: function () { return false; },
      isBlockDevice: function () { return false; },
      isCharacterDevice: function () { return false; },
      isFIFO: function () { return false; },
      isSocket: function () { return false; }
    };
  }

  function makeDirent(name, st, parentPath) {
    return {
      name: name,
      parentPath: parentPath,
      path: parentPath,
      isFile: function () { return st.type === 'file'; },
      isDirectory: function () { return st.type === 'dir'; },
      isSymbolicLink: function () { return false; },
      isBlockDevice: function () { return false; },
      isCharacterDevice: function () { return false; },
      isFIFO: function () { return false; },
      isSocket: function () { return false; }
    };
  }

  function readBytesOf(file) {
    return decodeBase64(host.readBase64(file));
  }

  function check(code, syscall, file) {
    if (code) throw fsError(code, syscall, file);
  }

  var fs = {};

  fs.readFileSync = function (p, opts) {
    var file = toPathString(p);
    var st = statOf(file);
    if (!st) throw fsError('ENOENT', 'open', String(p));
    if (st.type === 'dir') throw fsError('EISDIR', 'read', file);
    var enc = optionsEncoding(opts);
    if (enc && normalizeEncoding(enc) === 'utf8') return host.readText(file);
    var bytes = readBytesOf(file);
    if (enc) return decodeBytes(bytes, enc);
    return Buf.from(bytes);
  };

  fs.writeFileSync = function (p, data, opts) {
    var file = toPathString(p);
    var flag = opts && typeof opts === 'object' && opts.flag ? opts.flag : 'w';
    var bytes;
    if (typeof data === 'string') bytes = encodeString(data, optionsEncoding(opts) || 'utf8');
    else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else bytes = encodeString(String(data), 'utf8');
    if (flag.charAt(0) === 'a' && statOf(file)) {
      var existing = readBytesOf(file);
      var merged = new Uint8Array(existing.length + bytes.length);
      merged.set(existing, 0);
      merged.set(bytes, existing.length);
      bytes = merged;
    }
    check(host.writeBase64(file, encodeBase64(bytes)), 'open', file);
  };

  fs.appendFileSync = function (p, data, opts) {
    fs.writeFileSync(p, data, Object.assign({}, typeof opts === 'object' ? opts : { encoding: opts }, { flag: 'a' }));
  };

  fs.existsSync = function (p) {
    try {
      return statOf(toPathString(p)) !== null;
    } catch (err) {
      return false;
    }
  };

  fs.statSync = function (p, opts) {
    var file = toPathString(p);
    var st = statOf(file);
    if (!st) {
      if (opts && opts.throwIfNoEntry === false) return undefined;
      throw fsError('ENOENT', 'stat', file);
    }
    return makeStats(st);
  };
  fs.lstatSync = fs.statSync;

  // The host lists in creation order; Node (scandir with strcmp) lists sorted, so sort here.
  function sortedEntries(dir) {
    return JSON.parse(host.readdirJSON(dir)).slice().sort();
  }

  fs.readdirSync = function (p, opts) {
    var file = toPathString(p);
    var st = statOf(file);
    if (!st) throw fsError('ENOENT', 'scandir', file);
    if (st.type !== 'dir') throw fsError('ENOTDIR', 'scandir', file);
    var withTypes = !!(opts && typeof opts === 'object' && opts.withFileTypes);
    var recursive = !!(opts && typeof opts === 'object' && opts.recursive);
    var base = typeof p === 'string' ? p : file;
    if (!recursive) {
      var names = sortedEntries(file);
      if (!withTypes) return names;
      return names.map(function (name) {
        var child = statOf(P.join(file, name));
        return makeDirent(name, child || { type: 'file' }, base);
      });
    }
    // Node's recursive listing is breadth first: one directory's entries in sorted order, then the next level.
    var out = [];
    var queue = [{ abs: file, str: base, rel: '' }];
    for (var q = 0; q < queue.length; q++) {
      var cur = queue[q];
      var kids = sortedEntries(cur.abs);
      for (var k = 0; k < kids.length; k++) {
        var childAbs = P.join(cur.abs, kids[k]);
        var childSt = statOf(childAbs) || { type: 'file' };
        var childRel = cur.rel === '' ? kids[k] : cur.rel + '/' + kids[k];
        out.push(withTypes ? makeDirent(kids[k], childSt, cur.str) : childRel);
        if (childSt.type === 'dir') queue.push({ abs: childAbs, str: P.join(cur.str, kids[k]), rel: childRel });
      }
    }
    return out;
  };

  fs.mkdirSync = function (p, opts) {
    var file = toPathString(p);
    var recursive = !!(opts && typeof opts === 'object' && opts.recursive);
    var existing = statOf(file);
    if (existing) {
      if (recursive && existing.type === 'dir') return undefined;
      throw fsError('EEXIST', 'mkdir', file);
    }
    check(host.mkdir(file, recursive), 'mkdir', file);
    return recursive ? file : undefined;
  };

  fs.rmSync = function (p, opts) {
    var file = toPathString(p);
    if (!statOf(file)) {
      if (opts && opts.force) return;
      throw fsError('ENOENT', 'rm', file);
    }
    check(host.rm(file, !!(opts && opts.recursive)), 'rm', file);
  };

  fs.rmdirSync = function (p, opts) {
    var file = toPathString(p);
    var st = statOf(file);
    if (!st) throw fsError('ENOENT', 'rmdir', file);
    if (st.type !== 'dir') throw fsError('ENOTDIR', 'rmdir', file);
    check(host.rm(file, !!(opts && opts.recursive)), 'rmdir', file);
  };

  fs.unlinkSync = function (p) {
    var file = toPathString(p);
    var st = statOf(file);
    if (!st) throw fsError('ENOENT', 'unlink', file);
    if (st.type === 'dir') throw fsError('EISDIR', 'unlink', file);
    check(host.rm(file, false), 'unlink', file);
  };

  fs.renameSync = function (from, to) {
    var a = toPathString(from);
    if (!statOf(a)) throw fsError('ENOENT', 'rename', a);
    check(host.rename(a, toPathString(to)), 'rename', a);
  };

  fs.copyFileSync = function (from, to) {
    var src = toPathString(from);
    if (!statOf(src)) throw fsError('ENOENT', 'copyfile', src);
    check(host.writeBase64(toPathString(to), encodeBase64(readBytesOf(src))), 'copyfile', src);
  };

  fs.accessSync = function (p) {
    var file = toPathString(p);
    if (!statOf(file)) throw fsError('ENOENT', 'access', file);
  };

  fs.realpathSync = function (p) {
    var file = toPathString(p);
    if (!statOf(file)) throw fsError('ENOENT', 'realpath', file);
    return file;
  };

  fs.mkdtempSync = function (prefix) {
    var name = String(prefix) + Math.random().toString(36).slice(2, 8);
    fs.mkdirSync(name, { recursive: true });
    return name;
  };

  /*
   * Descriptors. The file system behind these calls is path based, so a descriptor is a small
   * integer handle over a byte buffer: 'r' starts from the file's bytes, 'w' starts empty and
   * truncates the file at once, 'a' starts from the file's bytes with the position at the end, and
   * a descriptor opened for writing pushes its buffer through the ordinary write path when it is
   * synced and again when it is closed. create-next-app writes every file this way: openSync,
   * writeSync, fsyncSync, closeSync, then chmodSync and chownSync on the temporary file.
   */
  var VALID_FLAGS = ['r', 'r+', 'rs', 'sr', 'rs+', 'sr+', 'w', 'wx', 'w+', 'wx+', 'xw', 'xw+', 'a', 'ax', 'a+', 'ax+', 'xa', 'xa+'];

  function badFlagError(flags) {
    var err = new TypeError("The argument 'flags' is invalid. Received '" + String(flags) + "'");
    err.code = 'ERR_INVALID_ARG_VALUE';
    return err;
  }

  function badFdError(syscall) {
    var err = new Error('EBADF: bad file descriptor, ' + syscall);
    err.errno = -9;
    err.code = 'EBADF';
    err.syscall = syscall;
    return err;
  }

  // Node accepts r, w and a with + (read and write), x (exclusive) and s (sync) modifiers: the
  // first r/w/a letter decides the mode, so 'wx' writes and 'ax+' appends and reads.
  function flagLetter(flags) {
    var f = String(flags);
    return f.charAt(0) === 'r' || f.charAt(0) === 'w' || f.charAt(0) === 'a' ? f.charAt(0) : f.charAt(1);
  }

  var DESCRIPTORS = {};
  var nextDescriptor = 3;

  function descriptorOf(fd, syscall) {
    var rec = typeof fd === 'number' ? DESCRIPTORS[fd] : undefined;
    if (rec === undefined) throw badFdError(syscall);
    return rec;
  }

  function writeBytes(data, encoding) {
    if (typeof data === 'string') return encodeString(data, encoding || 'utf8');
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    throw new TypeError('The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView');
  }

  function flushDescriptor(rec, syscall) {
    if (!rec.dirty) return;
    check(host.writeBase64(rec.path, encodeBase64(rec.bytes)), syscall, rec.path);
    rec.dirty = false;
  }

  fs.openSync = function (p, flags, mode) {
    var f = flags === undefined || flags === null ? 'r' : String(flags);
    if (VALID_FLAGS.indexOf(f) < 0) throw badFlagError(flags);
    var file = toPathString(p);
    var letter = flagLetter(f);
    var writable = letter === 'w' || letter === 'a';
    var st = statOf(file);
    var isDir = !!(st && st.type === 'dir');
    if (writable) {
      if (isDir) throw fsError('EISDIR', 'open', file);
      if (letter === 'w' || !st) check(host.writeBase64(file, encodeBase64(new Uint8Array(0))), 'open', file);
    } else if (!st) {
      throw fsError('ENOENT', 'open', file);
    }
    var bytes = letter === 'w' || !st || isDir ? new Uint8Array(0) : readBytesOf(file);
    var fd = nextDescriptor++;
    // The pty fds the node-pty shim hands out start at 1000; never hand a file one of those.
    while (DESCRIPTORS[fd] !== undefined || (globalThis.__owcPtyFds && globalThis.__owcPtyFds[fd] !== undefined)) fd = nextDescriptor++;
    DESCRIPTORS[fd] = {
      path: file,
      flags: f,
      bytes: bytes,
      position: letter === 'a' ? bytes.length : 0,
      writable: writable,
      readable: letter === 'r' || f.indexOf('+') >= 0,
      isDir: isDir,
      dirty: writable
    };
    return fd;
  };

  fs.writeSync = function (fd, data, position, encoding) {
    var rec = descriptorOf(fd, 'write');
    if (!rec.writable) throw badFdError('write');
    var bytes;
    var at;
    var explicit;
    if (typeof data === 'string') {
      bytes = writeBytes(data, typeof encoding === 'string' ? encoding : typeof position === 'string' ? position : 'utf8');
      at = typeof position === 'number' ? position : rec.position;
      explicit = typeof position === 'number';
    } else {
      // writeSync(fd, buffer[, offset[, length[, position]]])
      var view = writeBytes(data);
      var offset = typeof position === 'number' ? position : 0;
      var length = typeof encoding === 'number' ? encoding : view.length - offset;
      bytes = view.subarray(offset, offset + length);
      at = typeof arguments[4] === 'number' ? arguments[4] : rec.position;
      explicit = typeof arguments[4] === 'number';
    }
    if (bytes.length === 0) return 0;
    if (at + bytes.length > rec.bytes.length) {
      var grown = new Uint8Array(at + bytes.length);
      grown.set(rec.bytes, 0);
      rec.bytes = grown;
    }
    rec.bytes.set(bytes, at);
    if (!explicit) rec.position = at + bytes.length;
    rec.dirty = true;
    return bytes.length;
  };

  fs.readSync = function (fd, buffer, offset, length, position) {
    var rec = descriptorOf(fd, 'read');
    if (!rec.readable) throw badFdError('read');
    if (rec.isDir) throw fsError('EISDIR', 'read', rec.path);
    var opts = offset && typeof offset === 'object' ? offset : null;
    var off = opts ? opts.offset || 0 : typeof offset === 'number' ? offset : 0;
    var len = opts ? (opts.length === undefined ? buffer.length - off : opts.length)
      : (typeof length === 'number' ? length : buffer.length - off);
    var at = opts ? (typeof opts.position === 'number' ? opts.position : rec.position)
      : (typeof position === 'number' ? position : rec.position);
    var available = rec.bytes.length - at;
    if (available <= 0 || len <= 0) return 0;
    var n = Math.min(len, available, buffer.length - off);
    var target = ArrayBuffer.isView(buffer) ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) : buffer;
    for (var i = 0; i < n; i++) target[off + i] = rec.bytes[at + i];
    if (!explicitRead(offset, length, position)) rec.position = at + n;
    return n;
  };

  function explicitRead(offset, length, position) {
    if (offset && typeof offset === 'object') return typeof offset.position === 'number';
    return typeof position === 'number';
  }

  fs.fsyncSync = function (fd) {
    flushDescriptor(descriptorOf(fd, 'fsync'), 'fsync');
  };

  fs.closeSync = function (fd) {
    var rec = descriptorOf(fd, 'close');
    flushDescriptor(rec, 'close');
    delete DESCRIPTORS[fd];
  };

  // The file system has no owners or permission bits to set, so these only have to report the
  // error Node would for a path that is not there.
  fs.chmodSync = function (p, mode) {
    var file = toPathString(p);
    if (!statOf(file)) throw fsError('ENOENT', 'chmod', file);
  };

  fs.chownSync = function (p, uid, gid) {
    var file = toPathString(p);
    if (!statOf(file)) throw fsError('ENOENT', 'chown', file);
  };

  /* read streams read the file once and push it in highWaterMark-sized chunks; write streams append each chunk */
  fs.createReadStream = function (p, opts) {
    var Readable = requireBuiltin('stream').Readable;
    var Buf = requireBuiltin('buffer').Buffer;
    var options = typeof opts === 'string' ? { encoding: opts } : (opts || {});
    var file = toPathString(p);
    var chunkSize = options.highWaterMark || 65536;
    var rangeStart = typeof options.start === 'number' ? options.start : 0;
    var rangeEnd = typeof options.end === 'number' ? options.end : Infinity;
    var bytes = null;
    var offset = 0;
    var stream = new Readable({
      highWaterMark: chunkSize,
      read: function () {
        if (bytes === null) {
          try {
            bytes = readBytesOf(file);
            if (rangeStart > 0 || rangeEnd !== Infinity) bytes = bytes.subarray(rangeStart, Math.min(rangeEnd + 1, bytes.length));
          } catch (err) {
            stream.destroy(err);
            return;
          }
        }
        if (offset >= bytes.length) {
          stream.push(null);
          return;
        }
        var end = Math.min(offset + chunkSize, bytes.length);
        stream.push(Buf.from(bytes.subarray(offset, end)));
        offset = end;
      }
    });
    stream.path = file;
    if (options.encoding) stream.setEncoding(options.encoding);
    // like Node, the file is opened when the stream is created: a missing file is an 'error' even with no reader
    setImmediate(function () {
      if (!statOf(file)) {
        stream.destroy(fsError('ENOENT', 'open', file));
        return;
      }
      stream.emit('open', 3);
      stream.emit('ready');
    });
    return stream;
  };

  fs.createWriteStream = function (p, opts) {
    var Writable = requireBuiltin('stream').Writable;
    var options = typeof opts === 'string' ? { encoding: opts } : (opts || {});
    var file = toPathString(p);
    var flags = options.flags || 'w';
    var opened = false;
    var stream = new Writable({
      write: function (chunk, encoding, callback) {
        try {
          if (!opened) {
            opened = true;
            if (flags.charAt(0) === 'w') fs.writeFileSync(file, '');
            stream.emit('open', 3);
            stream.emit('ready');
          }
          fs.appendFileSync(file, chunk);
          stream.bytesWritten += chunk.length;
          callback();
        } catch (err) {
          callback(err);
        }
      }
    });
    stream.path = file;
    stream.bytesWritten = 0;
    return stream;
  };

  function dirClosedError() {
    var err = new Error('Directory handle was closed');
    err.code = 'ERR_DIR_CLOSED';
    return err;
  }

  function Dir(dirPath, entries) {
    this.path = dirPath;
    this._entries = entries;
    this._index = 0;
    this._closed = false;
  }

  Dir.prototype.readSync = function () {
    if (this._closed) throw dirClosedError();
    if (this._index >= this._entries.length) return null;
    return this._entries[this._index++];
  };

  Dir.prototype.read = function (callback) {
    var result = null;
    var error = null;
    try {
      result = this.readSync();
    } catch (err) {
      error = err;
    }
    if (typeof callback === 'function') {
      queueMicrotask(function () {
        if (error) callback(error);
        else callback(null, result);
      });
      return undefined;
    }
    return new Promise(function (resolve, reject) {
      if (error) reject(error);
      else resolve(result);
    });
  };

  Dir.prototype.closeSync = function () {
    if (this._closed) throw dirClosedError();
    this._closed = true;
  };

  Dir.prototype.close = function (callback) {
    var error = null;
    try {
      this.closeSync();
    } catch (err) {
      error = err;
    }
    if (typeof callback === 'function') {
      queueMicrotask(function () {
        callback(error);
      });
      return undefined;
    }
    return new Promise(function (resolve, reject) {
      if (error) reject(error);
      else resolve();
    });
  };

  Dir.prototype[Symbol.asyncIterator] = function () {
    var dir = this;
    var it = {
      next: function () {
        return new Promise(function (resolve, reject) {
          try {
            var entry = dir.readSync();
            if (entry === null) {
              dir._closed = true;
              resolve({ value: undefined, done: true });
            } else {
              resolve({ value: entry, done: false });
            }
          } catch (err) {
            reject(err);
          }
        });
      },
      return: function () {
        dir._closed = true;
        return Promise.resolve({ value: undefined, done: true });
      }
    };
    it[Symbol.asyncIterator] = function () {
      return this;
    };
    return it;
  };

  fs.Dir = Dir;

  fs.opendirSync = function (p) {
    var file = toPathString(p);
    var st = statOf(file);
    if (!st) throw fsError('ENOENT', 'opendir', file);
    if (st.type !== 'dir') throw fsError('ENOTDIR', 'opendir', file);
    var base = typeof p === 'string' ? p : file;
    var entries = sortedEntries(file).map(function (name) {
      var child = statOf(P.join(file, name));
      return makeDirent(name, child || { type: 'file' }, base);
    });
    return new Dir(base, entries);
  };

  // The browser has no file system events, so watching fails loudly instead of returning a dead watcher.
  function watchUnavailable(api) {
    var err = new TypeError(api + ' is not supported on this runtime: the browser cannot watch the file system');
    err.code = 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM';
    return err;
  }
  fs.watch = function () {
    throw watchUnavailable('fs.watch');
  };
  fs.watchFile = function () {
    throw watchUnavailable('fs.watchFile');
  };
  fs.unwatchFile = function () {};

  // Node's fs.constants on the reference platform, so flag and mode values match exactly.
  fs.constants = {"UV_FS_SYMLINK_DIR":1,"UV_FS_SYMLINK_JUNCTION":2,"O_RDONLY":0,"O_WRONLY":1,"O_RDWR":2,"UV_DIRENT_UNKNOWN":0,"UV_DIRENT_FILE":1,"UV_DIRENT_DIR":2,"UV_DIRENT_LINK":3,"UV_DIRENT_FIFO":4,"UV_DIRENT_SOCKET":5,"UV_DIRENT_CHAR":6,"UV_DIRENT_BLOCK":7,"S_IFMT":61440,"S_IFREG":32768,"S_IFDIR":16384,"S_IFCHR":8192,"S_IFBLK":24576,"S_IFIFO":4096,"S_IFLNK":40960,"S_IFSOCK":49152,"O_CREAT":512,"O_EXCL":2048,"UV_FS_O_FILEMAP":0,"O_NOCTTY":131072,"O_TRUNC":1024,"O_APPEND":8,"O_DIRECTORY":1048576,"O_NOFOLLOW":256,"O_SYNC":128,"O_DSYNC":4194304,"O_SYMLINK":2097152,"O_NONBLOCK":4,"S_IRWXU":448,"S_IRUSR":256,"S_IWUSR":128,"S_IXUSR":64,"S_IRWXG":56,"S_IRGRP":32,"S_IWGRP":16,"S_IXGRP":8,"S_IRWXO":7,"S_IROTH":4,"S_IWOTH":2,"S_IXOTH":1,"F_OK":0,"R_OK":4,"W_OK":2,"X_OK":1,"UV_FS_COPYFILE_EXCL":1,"COPYFILE_EXCL":1,"UV_FS_COPYFILE_FICLONE":2,"COPYFILE_FICLONE":2,"UV_FS_COPYFILE_FICLONE_FORCE":4,"COPYFILE_FICLONE_FORCE":4};
  fs.F_OK = 0;
  fs.R_OK = 4;
  fs.W_OK = 2;
  fs.X_OK = 1;

  var names = Object.keys(fs);
  var promises = {};
  fs.promises = promises;
  names.forEach(function (syncName) {
    if (syncName.slice(-4) !== 'Sync') return;
    var base = syncName.slice(0, -4);
    var impl = fs[syncName];
    fs[base] = function () {
      var args = Array.prototype.slice.call(arguments);
      var cb = args.pop();
      if (typeof cb !== 'function') throw new TypeError('The "cb" argument must be of type function');
      var result;
      var error = null;
      try {
        result = impl.apply(fs, args);
      } catch (err) {
        error = err;
      }
      queueMicrotask(function () {
        if (error) cb(error);
        else cb(null, result);
      });
    };
    promises[base] = function () {
      var args = Array.prototype.slice.call(arguments);
      return new Promise(function (resolve, reject) {
        try {
          resolve(impl.apply(fs, args));
        } catch (err) {
          reject(err);
        }
      });
    };
  });
  fs.exists = function (p, cb) {
    var found = fs.existsSync(p);
    queueMicrotask(function () { cb(found); });
  };
  /*
   * fs.write by descriptor. The file system here is path based and has no descriptors, except for
   * the pty fds the node-pty shim registers in globalThis.__owcPtyFds: node-pty's
   * lib/unixTerminal.js writes a pty's input with fs.write(fd, buffer, offset, callback), so a
   * write to one of those fds goes to the child's stdin and reports the bytes it took. Any other
   * fd goes through the descriptor layer above, which reports EBADF for one it does not know.
   */
  fs.write = function (fd, buffer, offset, length, position, callback) {
    // The callback is the last argument whatever the form: fs.write(fd, buffer[, offset[, length[,
    // position]]], cb) and fs.write(fd, string[, position[, encoding]], cb).
    var last = arguments.length > 1 ? arguments[arguments.length - 1] : undefined;
    var done = typeof last === 'function' ? last : null;
    var table = globalThis.__owcPtyFds;
    var rec = table && typeof fd === 'number' ? table[fd] : undefined;
    if (rec !== undefined && rec.write !== undefined) {
      var bytes = ArrayBuffer.isView(buffer) ? Buf.from(buffer.buffer, buffer.byteOffset, buffer.byteLength) : Buf.from(String(buffer));
      var from = Number(offset) > 0 ? Number(offset) : 0;
      var written = rec.write(bytes.slice(from).toString('utf8'));
      if (done) queueMicrotask(function () { done(null, written); });
      return;
    }
    var args = Array.prototype.slice.call(arguments, 1);
    if (done) args.pop();
    var error = null;
    var count = 0;
    try {
      count = fs.writeSync.apply(fs, [fd].concat(args));
    } catch (err) {
      error = err;
    }
    if (done) queueMicrotask(function () { done(error, count); });
    else if (error) throw error;
  };
  return fs;
};

BF.constants = function () {
  var fsConstants = requireBuiltin('fs').constants;
  var out = {};
  Object.keys(fsConstants).forEach(function (key) {
    out[key] = fsConstants[key];
  });
  return out;
};

BF['fs/promises'] = function () {
  return requireBuiltin('fs').promises;
};
`;
