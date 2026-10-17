/**
 * Guest-side `zlib` built-in for the in-browser Node runtime. Sync, callback and stream forms share
 * the host's zlib capabilities (fflate underneath); brotli and zstd report ERR_NOT_SUPPORTED.
 * Plain JavaScript inside a String.raw snippet: no backticks and no template interpolation.
 */
export const SRC = String.raw`
BF['zlib'] = function () {
  var Buf = requireBuiltin('buffer').Buffer;
  var SYNC_INPUT = 'of type string or an instance of Buffer, TypedArray, DataView, or ArrayBuffer';
  var CHUNK_INPUT = 'of type string or an instance of Buffer, TypedArray, or DataView';

  var CONSTANTS = {
    Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3, Z_FINISH: 4, Z_BLOCK: 5,
    Z_OK: 0, Z_STREAM_END: 1, Z_NEED_DICT: 2, Z_ERRNO: -1, Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3,
    Z_MEM_ERROR: -4, Z_BUF_ERROR: -5, Z_VERSION_ERROR: -6,
    Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1,
    Z_FILTERED: 1, Z_HUFFMAN_ONLY: 2, Z_RLE: 3, Z_FIXED: 4, Z_DEFAULT_STRATEGY: 0,
    ZLIB_VERNUM: 4880, DEFLATE: 1, INFLATE: 2, GZIP: 3, GUNZIP: 4, DEFLATERAW: 5, INFLATERAW: 6,
    UNZIP: 7, BROTLI_DECODE: 8, BROTLI_ENCODE: 9, ZSTD_DECOMPRESS: 11, ZSTD_COMPRESS: 10,
    Z_MIN_WINDOWBITS: 8, Z_MAX_WINDOWBITS: 15, Z_DEFAULT_WINDOWBITS: 15, Z_MIN_CHUNK: 64,
    Z_MAX_CHUNK: Infinity, Z_DEFAULT_CHUNK: 16384, Z_MIN_MEMLEVEL: 1, Z_MAX_MEMLEVEL: 9,
    Z_DEFAULT_MEMLEVEL: 8, Z_MIN_LEVEL: -1, Z_MAX_LEVEL: 9, Z_DEFAULT_LEVEL: -1,
    BROTLI_OPERATION_PROCESS: 0, BROTLI_OPERATION_FLUSH: 1, BROTLI_OPERATION_FINISH: 2,
    BROTLI_OPERATION_EMIT_METADATA: 3, BROTLI_PARAM_MODE: 0, BROTLI_MODE_GENERIC: 0,
    BROTLI_MODE_TEXT: 1, BROTLI_MODE_FONT: 2, BROTLI_DEFAULT_MODE: 0, BROTLI_PARAM_QUALITY: 1,
    BROTLI_MIN_QUALITY: 0, BROTLI_MAX_QUALITY: 11, BROTLI_DEFAULT_QUALITY: 11, BROTLI_PARAM_LGWIN: 2,
    BROTLI_MIN_WINDOW_BITS: 10, BROTLI_MAX_WINDOW_BITS: 24, BROTLI_LARGE_MAX_WINDOW_BITS: 30,
    BROTLI_DEFAULT_WINDOW: 22, BROTLI_PARAM_LGBLOCK: 3, BROTLI_MIN_INPUT_BLOCK_BITS: 16,
    BROTLI_MAX_INPUT_BLOCK_BITS: 24, BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING: 4,
    BROTLI_PARAM_SIZE_HINT: 5, BROTLI_PARAM_LARGE_WINDOW: 6, BROTLI_PARAM_NPOSTFIX: 7,
    BROTLI_PARAM_NDIRECT: 8, BROTLI_DECODER_RESULT_ERROR: 0, BROTLI_DECODER_RESULT_SUCCESS: 1,
    BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT: 2, BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT: 3,
    BROTLI_DECODER_PARAM_DISABLE_RING_BUFFER_REALLOCATION: 0, BROTLI_DECODER_PARAM_LARGE_WINDOW: 1,
    BROTLI_DECODER_NO_ERROR: 0, BROTLI_DECODER_SUCCESS: 1, BROTLI_DECODER_NEEDS_MORE_INPUT: 2,
    BROTLI_DECODER_NEEDS_MORE_OUTPUT: 3, BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_NIBBLE: -1,
    BROTLI_DECODER_ERROR_FORMAT_RESERVED: -2, BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_META_NIBBLE: -3,
    BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_ALPHABET: -4, BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_SAME: -5,
    BROTLI_DECODER_ERROR_FORMAT_CL_SPACE: -6, BROTLI_DECODER_ERROR_FORMAT_HUFFMAN_SPACE: -7,
    BROTLI_DECODER_ERROR_FORMAT_CONTEXT_MAP_REPEAT: -8, BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_1: -9,
    BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_2: -10, BROTLI_DECODER_ERROR_FORMAT_TRANSFORM: -11,
    BROTLI_DECODER_ERROR_FORMAT_DICTIONARY: -12, BROTLI_DECODER_ERROR_FORMAT_WINDOW_BITS: -13,
    BROTLI_DECODER_ERROR_FORMAT_PADDING_1: -14, BROTLI_DECODER_ERROR_FORMAT_PADDING_2: -15,
    BROTLI_DECODER_ERROR_FORMAT_DISTANCE: -16, BROTLI_DECODER_ERROR_DICTIONARY_NOT_SET: -19,
    BROTLI_DECODER_ERROR_INVALID_ARGUMENTS: -20, BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MODES: -21,
    BROTLI_DECODER_ERROR_ALLOC_TREE_GROUPS: -22, BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MAP: -25,
    BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_1: -26, BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_2: -27,
    BROTLI_DECODER_ERROR_ALLOC_BLOCK_TYPE_TREES: -30, BROTLI_DECODER_ERROR_UNREACHABLE: -31,
    ZSTD_e_continue: 0, ZSTD_e_flush: 1, ZSTD_e_end: 2, ZSTD_fast: 1, ZSTD_dfast: 2, ZSTD_greedy: 3,
    ZSTD_lazy: 4, ZSTD_lazy2: 5, ZSTD_btlazy2: 6, ZSTD_btopt: 7, ZSTD_btultra: 8, ZSTD_btultra2: 9,
    ZSTD_c_compressionLevel: 100, ZSTD_c_windowLog: 101, ZSTD_c_hashLog: 102, ZSTD_c_chainLog: 103,
    ZSTD_c_searchLog: 104, ZSTD_c_minMatch: 105, ZSTD_c_targetLength: 106, ZSTD_c_strategy: 107,
    ZSTD_c_enableLongDistanceMatching: 160, ZSTD_c_ldmHashLog: 161, ZSTD_c_ldmMinMatch: 162,
    ZSTD_c_ldmBucketSizeLog: 163, ZSTD_c_ldmHashRateLog: 164, ZSTD_c_contentSizeFlag: 200,
    ZSTD_c_checksumFlag: 201, ZSTD_c_dictIDFlag: 202, ZSTD_c_nbWorkers: 400, ZSTD_c_jobSize: 401,
    ZSTD_c_overlapLog: 402, ZSTD_d_windowLogMax: 100, ZSTD_CLEVEL_DEFAULT: 3,
    ZSTD_error_no_error: 0, ZSTD_error_GENERIC: 1, ZSTD_error_prefix_unknown: 10,
    ZSTD_error_version_unsupported: 12, ZSTD_error_frameParameter_unsupported: 14,
    ZSTD_error_frameParameter_windowTooLarge: 16, ZSTD_error_corruption_detected: 20,
    ZSTD_error_checksum_wrong: 22, ZSTD_error_literals_headerWrong: 24, ZSTD_error_dictionary_corrupted: 30,
    ZSTD_error_dictionary_wrong: 32, ZSTD_error_dictionaryCreation_failed: 34,
    ZSTD_error_parameter_unsupported: 40, ZSTD_error_parameter_combination_unsupported: 41,
    ZSTD_error_parameter_outOfBound: 42, ZSTD_error_tableLog_tooLarge: 44,
    ZSTD_error_maxSymbolValue_tooLarge: 46, ZSTD_error_maxSymbolValue_tooSmall: 48,
    ZSTD_error_stabilityCondition_notRespected: 50, ZSTD_error_stage_wrong: 60, ZSTD_error_init_missing: 62,
    ZSTD_error_memory_allocation: 64, ZSTD_error_workSpace_tooSmall: 66, ZSTD_error_dstSize_tooSmall: 70,
    ZSTD_error_srcSize_wrong: 72, ZSTD_error_dstBuffer_null: 74, ZSTD_error_noForwardProgress_destFull: 80,
    ZSTD_error_noForwardProgress_inputEmpty: 82
  };

  var CODE_NAMES = [['Z_OK', 0], ['Z_STREAM_END', 1], ['Z_NEED_DICT', 2], ['Z_ERRNO', -1], ['Z_STREAM_ERROR', -2],
   ['Z_DATA_ERROR', -3], ['Z_MEM_ERROR', -4], ['Z_BUF_ERROR', -5], ['Z_VERSION_ERROR', -6]];
  var CODES = {};
  CODE_NAMES.forEach(function (pair) { CODES[pair[0]] = pair[1]; });
  CODE_NAMES.forEach(function (pair) { if (pair[1] >= 0) CODES[pair[1]] = pair[0]; });
  CODE_NAMES.forEach(function (pair) { if (pair[1] < 0) CODES[pair[1]] = pair[0]; });
  Object.freeze(CODES);

  // Base64 for the host transport. Table driven, so a megabyte moves in well under a second; the
  // codec's indexOf-based versions cost several times more on the same bytes.
  var B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var B64_VALUE = new Int16Array(128);
  for (var b64 = 0; b64 < 128; b64++) B64_VALUE[b64] = -1;
  for (var b64i = 0; b64i < 64; b64i++) B64_VALUE[B64_ALPHABET.charCodeAt(b64i)] = b64i;

  function toBase64(bytes) {
    var parts = [];
    var codes = [];
    var n = bytes.length;
    var i = 0;
    for (; i + 2 < n; i += 3) {
      var v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      codes.push(B64_ALPHABET.charCodeAt((v >> 18) & 63), B64_ALPHABET.charCodeAt((v >> 12) & 63),
        B64_ALPHABET.charCodeAt((v >> 6) & 63), B64_ALPHABET.charCodeAt(v & 63));
      if (codes.length >= 8192) {
        parts.push(String.fromCharCode.apply(null, codes));
        codes = [];
      }
    }
    var rest = n - i;
    if (rest === 1) {
      var v1 = bytes[i] << 16;
      codes.push(B64_ALPHABET.charCodeAt((v1 >> 18) & 63), B64_ALPHABET.charCodeAt((v1 >> 12) & 63), 61, 61);
    } else if (rest === 2) {
      var v2 = (bytes[i] << 16) | (bytes[i + 1] << 8);
      codes.push(B64_ALPHABET.charCodeAt((v2 >> 18) & 63), B64_ALPHABET.charCodeAt((v2 >> 12) & 63),
        B64_ALPHABET.charCodeAt((v2 >> 6) & 63), 61);
    }
    parts.push(String.fromCharCode.apply(null, codes));
    return parts.join('');
  }

  function fromBase64(text) {
    var out = new Uint8Array(Math.floor((text.length * 3) / 4) + 3);
    var len = 0;
    var acc = 0;
    var bits = 0;
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      var v = c < 128 ? B64_VALUE[c] : -1;
      if (v < 0) continue;
      acc = ((acc << 6) | v) & 0xffffff;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[len++] = (acc >> bits) & 0xff;
      }
    }
    return out.slice(0, len);
  }

  function failure(Kind, code, message) {
    var err = new Kind(message);
    err.code = code;
    return err;
  }

  function describeReceived(value) {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (typeof value === 'function') return 'function ' + value.name;
    if (typeof value === 'object') return 'an instance of ' + ((value.constructor && value.constructor.name) || 'Object');
    return 'type ' + typeof value + ' (' + (typeof value === 'string' ? "'" + value + "'" : String(value)) + ')';
  }

  function argTypeError(name, expected, value) {
    var noun = name.indexOf('options.') === 0 ? ' property' : ' argument';
    return failure(TypeError, 'ERR_INVALID_ARG_TYPE',
      'The "' + name + '"' + noun + ' must be ' + expected + '. Received ' + describeReceived(value));
  }

  function notSupported(name) {
    return failure(Error, 'ERR_NOT_SUPPORTED',
      'zlib.' + name + ' is not supported in this runtime (deflate, gzip and zlib framing only)');
  }

  function inputBytes(value, name, expected, allowArrayBuffer) {
    if (typeof value === 'string') return encodeUtf8(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (allowArrayBuffer && value instanceof ArrayBuffer) return new Uint8Array(value);
    throw argTypeError(name, expected, value);
  }

  function levelOption(options) {
    var level = options && typeof options === 'object' ? options.level : undefined;
    if (level === undefined) return -1;
    if (typeof level !== 'number') throw argTypeError('options.level', 'of type number', level);
    if (!(level >= -1 && level <= 9)) {
      throw failure(RangeError, 'ERR_OUT_OF_RANGE',
        'The value of "options.level" is out of range. It must be >= -1 and <= 9. Received ' + level);
    }
    return Math.trunc(level);
  }

  function dictionaryOption(options) {
    var dictionary = options && typeof options === 'object' ? options.dictionary : undefined;
    if (dictionary === undefined) return undefined;
    return toBase64(inputBytes(dictionary, 'options.dictionary', SYNC_INPUT, true));
  }

  function concatBytes(list) {
    var total = 0;
    for (var i = 0; i < list.length; i++) total += list[i].length;
    var out = new Uint8Array(total);
    var pos = 0;
    for (var j = 0; j < list.length; j++) {
      out.set(list[j], pos);
      pos += list[j].length;
    }
    return out;
  }

  function runZlib(format, compress, bytes, level, dictionary) {
    var args = { format: format, data: toBase64(bytes) };
    if (compress) args.level = level;
    if (dictionary !== undefined) args.dictionary = dictionary;
    var encoded = callCap(compress ? 'zlib.compress' : 'zlib.decompress', args);
    var result = fromBase64(encoded);
    return Buf.from(result.buffer);
  }

  function syncOp(format, compress) {
    return function (buffer, options) {
      var bytes = inputBytes(buffer, 'buffer', SYNC_INPUT, true);
      var level = compress ? levelOption(options) : undefined;
      return runZlib(format, compress, bytes, level, dictionaryOption(options));
    };
  }

  // Callback forms validate their arguments synchronously, as Node does, then deliver the result
  // on a later macrotask, so the callback never runs inside the caller's stack frame.
  function callbackOp(format, compress) {
    return function (chunk, options, callback) {
      if (typeof options === 'function') {
        callback = options;
        options = undefined;
      }
      if (typeof callback !== 'function') throw argTypeError('callback', 'of type function', callback);
      var bytes = inputBytes(chunk, 'chunk', CHUNK_INPUT, false);
      var level = compress ? levelOption(options) : undefined;
      var dictionary = dictionaryOption(options);
      var result = null;
      var error = null;
      try {
        result = runZlib(format, compress, bytes, level, dictionary);
      } catch (err) {
        error = err;
      }
      setImmediateImpl(function () {
        if (error) callback(error);
        else callback(null, result);
      });
    };
  }

  /*
   * Brotli and zstd are not implemented here, by decision: the only pure-JS brotli on npm is a
   * ~2.2 MB package, and zstd compression has no small pure-JS implementation (fzstd, 65 KB, is
   * decompress-only). Both belong to the WebAssembly bridge as codec modules, which is where the
   * container already carries large native code. Until they land there these stay unavailable.
   */
  function unsupportedSync(name) {
    return function () {
      throw notSupported(name);
    };
  }

  function unsupportedCallback(name) {
    return function (chunk, options, callback) {
      if (typeof options === 'function') callback = options;
      if (typeof callback !== 'function') throw argTypeError('callback', 'of type function', callback);
      var err = notSupported(name);
      setImmediateImpl(function () {
        callback(err);
      });
    };
  }

  // Stream classes extend the stream module's Transform. The input is buffered and the whole
  // result is pushed once, on flush. The stream module is looked up when a class is first used.
  var streamClasses = Object.create(null);

  function streamClass(name, format, compress) {
    if (streamClasses[name]) return streamClasses[name];
    var streamModule = requireBuiltin('stream');
    var Transform = streamModule && streamModule.Transform;
    if (typeof Transform !== 'function') throw new Error('zlib streams need the stream module');

    function ZlibStream(options) {
      var self = Reflect.construct(Transform, [options || {}], ZlibStream);
      self._owcChunks = [];
      self._owcLevel = compress ? levelOption(options) : -1;
      self._owcDictionary = dictionaryOption(options);
      self.bytesWritten = 0;
      return self;
    }
    ZlibStream.prototype = Object.create(Transform.prototype, {
      constructor: { value: ZlibStream, writable: true, configurable: true }
    });
    Object.defineProperty(ZlibStream, 'name', { value: name });

    ZlibStream.prototype._transform = function (chunk, encoding, callback) {
      var bytes = typeof chunk === 'string' ? encodeString(chunk, encoding) : inputBytes(chunk, 'chunk', CHUNK_INPUT, false);
      // Copied now: the caller may reuse its buffer before the stream ends.
      this._owcChunks.push(bytes.slice(0));
      this.bytesWritten += bytes.length;
      callback();
    };

    ZlibStream.prototype._flush = function (callback) {
      var out;
      try {
        var input = concatBytes(this._owcChunks);
        this._owcChunks = [];
        out = runZlib(format, compress, input, this._owcLevel, this._owcDictionary);
      } catch (err) {
        callback(err);
        return;
      }
      if (out.length > 0) this.push(out);
      callback();
    };

    ZlibStream.prototype.params = function (level, strategy, callback) {
      this._owcLevel = levelOption({ level: level });
      if (typeof callback === 'function') setImmediateImpl(callback);
    };

    ZlibStream.prototype.reset = function () {
      this._owcChunks = [];
      this.bytesWritten = 0;
    };

    ZlibStream.prototype.flush = function (kind, callback) {
      var done = typeof kind === 'function' ? kind : callback;
      if (typeof done === 'function') setImmediateImpl(done);
    };

    ZlibStream.prototype.close = function (callback) {
      if (typeof callback === 'function') this.once('close', callback);
      this.destroy();
    };

    streamClasses[name] = ZlibStream;
    return ZlibStream;
  }

  function createStream(name, format, compress, options) {
    var Ctor = streamClass(name, format, compress);
    return new Ctor(options);
  }

  // CRC-32 (IEEE, reflected), table driven; the second argument continues an earlier checksum.
  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c;
    }
    return table;
  })();

  function crc32(data, value) {
    var bytes = inputBytes(data, 'data', CHUNK_INPUT, false);
    var start = 0;
    if (value !== undefined) {
      if (typeof value !== 'number') throw argTypeError('value', 'of type number', value);
      if (!(value >= 0 && value <= 4294967295)) {
        throw failure(RangeError, 'ERR_OUT_OF_RANGE',
          'The value of "value" is out of range. It must be >= 0 && <= 4294967295. Received ' + value);
      }
      start = value;
    }
    var crc = start ^ 0xffffffff;
    for (var i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  var zlib = {};
  zlib.constants = CONSTANTS;
  zlib.codes = CODES;
  zlib.crc32 = crc32;

  zlib.gzipSync = syncOp('gzip', true);
  zlib.gunzipSync = syncOp('gzip', false);
  zlib.deflateSync = syncOp('deflate', true);
  zlib.inflateSync = syncOp('deflate', false);
  zlib.deflateRawSync = syncOp('deflate-raw', true);
  zlib.inflateRawSync = syncOp('deflate-raw', false);
  zlib.unzipSync = syncOp('unzip', false);

  zlib.gzip = callbackOp('gzip', true);
  zlib.gunzip = callbackOp('gzip', false);
  zlib.deflate = callbackOp('deflate', true);
  zlib.inflate = callbackOp('deflate', false);
  zlib.deflateRaw = callbackOp('deflate-raw', true);
  zlib.inflateRaw = callbackOp('deflate-raw', false);
  zlib.unzip = callbackOp('unzip', false);

  [
    ['Gzip', 'gzip', true],
    ['Gunzip', 'gzip', false],
    ['Deflate', 'deflate', true],
    ['Inflate', 'deflate', false],
    ['DeflateRaw', 'deflate-raw', true],
    ['InflateRaw', 'deflate-raw', false],
    ['Unzip', 'unzip', false]
  ].forEach(function (kind) {
    Object.defineProperty(zlib, kind[0], {
      enumerable: true,
      get: function () { return streamClass(kind[0], kind[1], kind[2]); }
    });
    zlib['create' + kind[0]] = function (options) {
      return createStream(kind[0], kind[1], kind[2], options);
    };
  });

  zlib.brotliCompressSync = unsupportedSync('brotliCompressSync');
  zlib.brotliDecompressSync = unsupportedSync('brotliDecompressSync');
  zlib.brotliCompress = unsupportedCallback('brotliCompress');
  zlib.brotliDecompress = unsupportedCallback('brotliDecompress');
  zlib.createBrotliCompress = unsupportedSync('createBrotliCompress');
  zlib.createBrotliDecompress = unsupportedSync('createBrotliDecompress');
  zlib.BrotliCompress = unsupportedSync('BrotliCompress');
  zlib.BrotliDecompress = unsupportedSync('BrotliDecompress');

  zlib.zstdCompressSync = unsupportedSync('zstdCompressSync');
  zlib.zstdDecompressSync = unsupportedSync('zstdDecompressSync');
  zlib.zstdCompress = unsupportedCallback('zstdCompress');
  zlib.zstdDecompress = unsupportedCallback('zstdDecompress');
  zlib.createZstdCompress = unsupportedSync('createZstdCompress');
  zlib.createZstdDecompress = unsupportedSync('createZstdDecompress');
  zlib.ZstdCompress = unsupportedSync('ZstdCompress');
  zlib.ZstdDecompress = unsupportedSync('ZstdDecompress');

  return zlib;
};
`;
