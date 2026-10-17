/**
 * Guest source for `http2`: RFC 9113 framing, stream states, flow control, SETTINGS, PING, GOAWAY, RST_STREAM,
 * CONTINUATION and the Node-shaped API (connect, createServer, createSecureServer, sessions, streams and the compat
 * Http2ServerRequest and Http2ServerResponse), with RFC 7541 HPACK (static and dynamic tables, integer and string
 * coding, Huffman coding).
 *
 * Plain JavaScript inside a String.raw snippet. It registers BF['http2'] and uses the guest builtins events, buffer,
 * stream, net and tls. The snippet has no backticks and no template interpolation.
 *
 * Tables: the HPACK static table and the Huffman code are RFC 7541 Appendix A and Appendix B. The constants object
 * and the default settings are Node 24.15's http2.constants and http2.getDefaultSettings().
 *
 * Not implemented: sending server push (pushStream reports ERR_HTTP2_PUSH_UNSUPPORTED), respondWithFile and
 * respondWithFD, ALTSVC and ORIGIN, the h2c Upgrade from HTTP/1.1, allowHTTP1, and session or stream timeouts.
 * PRIORITY signals are parsed and ignored (RFC 9113 section 5.3.2).
 */
export const SRC = String.raw`
(function () {
var H2_CONSTANTS = {"NGHTTP2_ERR_FRAME_SIZE_ERROR":-522,"NGHTTP2_SESSION_SERVER":0,"NGHTTP2_SESSION_CLIENT":1,"NGHTTP2_STREAM_STATE_IDLE":1,"NGHTTP2_STREAM_STATE_OPEN":2,"NGHTTP2_STREAM_STATE_RESERVED_LOCAL":3,"NGHTTP2_STREAM_STATE_RESERVED_REMOTE":4,"NGHTTP2_STREAM_STATE_HALF_CLOSED_LOCAL":5,"NGHTTP2_STREAM_STATE_HALF_CLOSED_REMOTE":6,"NGHTTP2_STREAM_STATE_CLOSED":7,"NGHTTP2_FLAG_NONE":0,"NGHTTP2_FLAG_END_STREAM":1,"NGHTTP2_FLAG_END_HEADERS":4,"NGHTTP2_FLAG_ACK":1,"NGHTTP2_FLAG_PADDED":8,"NGHTTP2_FLAG_PRIORITY":32,"DEFAULT_SETTINGS_HEADER_TABLE_SIZE":4096,"DEFAULT_SETTINGS_ENABLE_PUSH":1,"DEFAULT_SETTINGS_MAX_CONCURRENT_STREAMS":4294967295,"DEFAULT_SETTINGS_INITIAL_WINDOW_SIZE":65535,"DEFAULT_SETTINGS_MAX_FRAME_SIZE":16384,"DEFAULT_SETTINGS_MAX_HEADER_LIST_SIZE":65535,"DEFAULT_SETTINGS_ENABLE_CONNECT_PROTOCOL":0,"MAX_MAX_FRAME_SIZE":16777215,"MIN_MAX_FRAME_SIZE":16384,"MAX_INITIAL_WINDOW_SIZE":2147483647,"NGHTTP2_SETTINGS_HEADER_TABLE_SIZE":1,"NGHTTP2_SETTINGS_ENABLE_PUSH":2,"NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS":3,"NGHTTP2_SETTINGS_INITIAL_WINDOW_SIZE":4,"NGHTTP2_SETTINGS_MAX_FRAME_SIZE":5,"NGHTTP2_SETTINGS_MAX_HEADER_LIST_SIZE":6,"NGHTTP2_SETTINGS_ENABLE_CONNECT_PROTOCOL":8,"PADDING_STRATEGY_NONE":0,"PADDING_STRATEGY_ALIGNED":1,"PADDING_STRATEGY_MAX":2,"PADDING_STRATEGY_CALLBACK":1,"NGHTTP2_NO_ERROR":0,"NGHTTP2_PROTOCOL_ERROR":1,"NGHTTP2_INTERNAL_ERROR":2,"NGHTTP2_FLOW_CONTROL_ERROR":3,"NGHTTP2_SETTINGS_TIMEOUT":4,"NGHTTP2_STREAM_CLOSED":5,"NGHTTP2_FRAME_SIZE_ERROR":6,"NGHTTP2_REFUSED_STREAM":7,"NGHTTP2_CANCEL":8,"NGHTTP2_COMPRESSION_ERROR":9,"NGHTTP2_CONNECT_ERROR":10,"NGHTTP2_ENHANCE_YOUR_CALM":11,"NGHTTP2_INADEQUATE_SECURITY":12,"NGHTTP2_HTTP_1_1_REQUIRED":13,"NGHTTP2_DEFAULT_WEIGHT":16,"HTTP2_HEADER_STATUS":":status","HTTP2_HEADER_METHOD":":method","HTTP2_HEADER_AUTHORITY":":authority","HTTP2_HEADER_SCHEME":":scheme","HTTP2_HEADER_PATH":":path","HTTP2_HEADER_PROTOCOL":":protocol","HTTP2_HEADER_ACCEPT_ENCODING":"accept-encoding","HTTP2_HEADER_ACCEPT_LANGUAGE":"accept-language","HTTP2_HEADER_ACCEPT_RANGES":"accept-ranges","HTTP2_HEADER_ACCEPT":"accept","HTTP2_HEADER_ACCESS_CONTROL_ALLOW_CREDENTIALS":"access-control-allow-credentials","HTTP2_HEADER_ACCESS_CONTROL_ALLOW_HEADERS":"access-control-allow-headers","HTTP2_HEADER_ACCESS_CONTROL_ALLOW_METHODS":"access-control-allow-methods","HTTP2_HEADER_ACCESS_CONTROL_ALLOW_ORIGIN":"access-control-allow-origin","HTTP2_HEADER_ACCESS_CONTROL_EXPOSE_HEADERS":"access-control-expose-headers","HTTP2_HEADER_ACCESS_CONTROL_REQUEST_HEADERS":"access-control-request-headers","HTTP2_HEADER_ACCESS_CONTROL_REQUEST_METHOD":"access-control-request-method","HTTP2_HEADER_AGE":"age","HTTP2_HEADER_AUTHORIZATION":"authorization","HTTP2_HEADER_CACHE_CONTROL":"cache-control","HTTP2_HEADER_CONNECTION":"connection","HTTP2_HEADER_CONTENT_DISPOSITION":"content-disposition","HTTP2_HEADER_CONTENT_ENCODING":"content-encoding","HTTP2_HEADER_CONTENT_LENGTH":"content-length","HTTP2_HEADER_CONTENT_TYPE":"content-type","HTTP2_HEADER_COOKIE":"cookie","HTTP2_HEADER_DATE":"date","HTTP2_HEADER_ETAG":"etag","HTTP2_HEADER_FORWARDED":"forwarded","HTTP2_HEADER_HOST":"host","HTTP2_HEADER_IF_MODIFIED_SINCE":"if-modified-since","HTTP2_HEADER_IF_NONE_MATCH":"if-none-match","HTTP2_HEADER_IF_RANGE":"if-range","HTTP2_HEADER_LAST_MODIFIED":"last-modified","HTTP2_HEADER_LINK":"link","HTTP2_HEADER_LOCATION":"location","HTTP2_HEADER_RANGE":"range","HTTP2_HEADER_REFERER":"referer","HTTP2_HEADER_SERVER":"server","HTTP2_HEADER_SET_COOKIE":"set-cookie","HTTP2_HEADER_STRICT_TRANSPORT_SECURITY":"strict-transport-security","HTTP2_HEADER_TRANSFER_ENCODING":"transfer-encoding","HTTP2_HEADER_TE":"te","HTTP2_HEADER_UPGRADE_INSECURE_REQUESTS":"upgrade-insecure-requests","HTTP2_HEADER_UPGRADE":"upgrade","HTTP2_HEADER_USER_AGENT":"user-agent","HTTP2_HEADER_VARY":"vary","HTTP2_HEADER_X_CONTENT_TYPE_OPTIONS":"x-content-type-options","HTTP2_HEADER_X_FRAME_OPTIONS":"x-frame-options","HTTP2_HEADER_KEEP_ALIVE":"keep-alive","HTTP2_HEADER_PROXY_CONNECTION":"proxy-connection","HTTP2_HEADER_X_XSS_PROTECTION":"x-xss-protection","HTTP2_HEADER_ALT_SVC":"alt-svc","HTTP2_HEADER_CONTENT_SECURITY_POLICY":"content-security-policy","HTTP2_HEADER_EARLY_DATA":"early-data","HTTP2_HEADER_EXPECT_CT":"expect-ct","HTTP2_HEADER_ORIGIN":"origin","HTTP2_HEADER_PURPOSE":"purpose","HTTP2_HEADER_TIMING_ALLOW_ORIGIN":"timing-allow-origin","HTTP2_HEADER_X_FORWARDED_FOR":"x-forwarded-for","HTTP2_HEADER_PRIORITY":"priority","HTTP2_HEADER_ACCEPT_CHARSET":"accept-charset","HTTP2_HEADER_ACCESS_CONTROL_MAX_AGE":"access-control-max-age","HTTP2_HEADER_ALLOW":"allow","HTTP2_HEADER_CONTENT_LANGUAGE":"content-language","HTTP2_HEADER_CONTENT_LOCATION":"content-location","HTTP2_HEADER_CONTENT_MD5":"content-md5","HTTP2_HEADER_CONTENT_RANGE":"content-range","HTTP2_HEADER_DNT":"dnt","HTTP2_HEADER_EXPECT":"expect","HTTP2_HEADER_EXPIRES":"expires","HTTP2_HEADER_FROM":"from","HTTP2_HEADER_IF_MATCH":"if-match","HTTP2_HEADER_IF_UNMODIFIED_SINCE":"if-unmodified-since","HTTP2_HEADER_MAX_FORWARDS":"max-forwards","HTTP2_HEADER_PREFER":"prefer","HTTP2_HEADER_PROXY_AUTHENTICATE":"proxy-authenticate","HTTP2_HEADER_PROXY_AUTHORIZATION":"proxy-authorization","HTTP2_HEADER_REFRESH":"refresh","HTTP2_HEADER_RETRY_AFTER":"retry-after","HTTP2_HEADER_TRAILER":"trailer","HTTP2_HEADER_TK":"tk","HTTP2_HEADER_VIA":"via","HTTP2_HEADER_WARNING":"warning","HTTP2_HEADER_WWW_AUTHENTICATE":"www-authenticate","HTTP2_HEADER_HTTP2_SETTINGS":"http2-settings","HTTP2_METHOD_ACL":"ACL","HTTP2_METHOD_BASELINE_CONTROL":"BASELINE-CONTROL","HTTP2_METHOD_BIND":"BIND","HTTP2_METHOD_CHECKIN":"CHECKIN","HTTP2_METHOD_CHECKOUT":"CHECKOUT","HTTP2_METHOD_CONNECT":"CONNECT","HTTP2_METHOD_COPY":"COPY","HTTP2_METHOD_DELETE":"DELETE","HTTP2_METHOD_GET":"GET","HTTP2_METHOD_HEAD":"HEAD","HTTP2_METHOD_LABEL":"LABEL","HTTP2_METHOD_LINK":"LINK","HTTP2_METHOD_LOCK":"LOCK","HTTP2_METHOD_MERGE":"MERGE","HTTP2_METHOD_MKACTIVITY":"MKACTIVITY","HTTP2_METHOD_MKCALENDAR":"MKCALENDAR","HTTP2_METHOD_MKCOL":"MKCOL","HTTP2_METHOD_MKREDIRECTREF":"MKREDIRECTREF","HTTP2_METHOD_MKWORKSPACE":"MKWORKSPACE","HTTP2_METHOD_MOVE":"MOVE","HTTP2_METHOD_OPTIONS":"OPTIONS","HTTP2_METHOD_ORDERPATCH":"ORDERPATCH","HTTP2_METHOD_PATCH":"PATCH","HTTP2_METHOD_POST":"POST","HTTP2_METHOD_PRI":"PRI","HTTP2_METHOD_PROPFIND":"PROPFIND","HTTP2_METHOD_PROPPATCH":"PROPPATCH","HTTP2_METHOD_PUT":"PUT","HTTP2_METHOD_REBIND":"REBIND","HTTP2_METHOD_REPORT":"REPORT","HTTP2_METHOD_SEARCH":"SEARCH","HTTP2_METHOD_TRACE":"TRACE","HTTP2_METHOD_UNBIND":"UNBIND","HTTP2_METHOD_UNCHECKOUT":"UNCHECKOUT","HTTP2_METHOD_UNLINK":"UNLINK","HTTP2_METHOD_UNLOCK":"UNLOCK","HTTP2_METHOD_UPDATE":"UPDATE","HTTP2_METHOD_UPDATEREDIRECTREF":"UPDATEREDIRECTREF","HTTP2_METHOD_VERSION_CONTROL":"VERSION-CONTROL","HTTP_STATUS_CONTINUE":100,"HTTP_STATUS_SWITCHING_PROTOCOLS":101,"HTTP_STATUS_PROCESSING":102,"HTTP_STATUS_EARLY_HINTS":103,"HTTP_STATUS_OK":200,"HTTP_STATUS_CREATED":201,"HTTP_STATUS_ACCEPTED":202,"HTTP_STATUS_NON_AUTHORITATIVE_INFORMATION":203,"HTTP_STATUS_NO_CONTENT":204,"HTTP_STATUS_RESET_CONTENT":205,"HTTP_STATUS_PARTIAL_CONTENT":206,"HTTP_STATUS_MULTI_STATUS":207,"HTTP_STATUS_ALREADY_REPORTED":208,"HTTP_STATUS_IM_USED":226,"HTTP_STATUS_MULTIPLE_CHOICES":300,"HTTP_STATUS_MOVED_PERMANENTLY":301,"HTTP_STATUS_FOUND":302,"HTTP_STATUS_SEE_OTHER":303,"HTTP_STATUS_NOT_MODIFIED":304,"HTTP_STATUS_USE_PROXY":305,"HTTP_STATUS_TEMPORARY_REDIRECT":307,"HTTP_STATUS_PERMANENT_REDIRECT":308,"HTTP_STATUS_BAD_REQUEST":400,"HTTP_STATUS_UNAUTHORIZED":401,"HTTP_STATUS_PAYMENT_REQUIRED":402,"HTTP_STATUS_FORBIDDEN":403,"HTTP_STATUS_NOT_FOUND":404,"HTTP_STATUS_METHOD_NOT_ALLOWED":405,"HTTP_STATUS_NOT_ACCEPTABLE":406,"HTTP_STATUS_PROXY_AUTHENTICATION_REQUIRED":407,"HTTP_STATUS_REQUEST_TIMEOUT":408,"HTTP_STATUS_CONFLICT":409,"HTTP_STATUS_GONE":410,"HTTP_STATUS_LENGTH_REQUIRED":411,"HTTP_STATUS_PRECONDITION_FAILED":412,"HTTP_STATUS_PAYLOAD_TOO_LARGE":413,"HTTP_STATUS_URI_TOO_LONG":414,"HTTP_STATUS_UNSUPPORTED_MEDIA_TYPE":415,"HTTP_STATUS_RANGE_NOT_SATISFIABLE":416,"HTTP_STATUS_EXPECTATION_FAILED":417,"HTTP_STATUS_TEAPOT":418,"HTTP_STATUS_MISDIRECTED_REQUEST":421,"HTTP_STATUS_UNPROCESSABLE_ENTITY":422,"HTTP_STATUS_LOCKED":423,"HTTP_STATUS_FAILED_DEPENDENCY":424,"HTTP_STATUS_TOO_EARLY":425,"HTTP_STATUS_UPGRADE_REQUIRED":426,"HTTP_STATUS_PRECONDITION_REQUIRED":428,"HTTP_STATUS_TOO_MANY_REQUESTS":429,"HTTP_STATUS_REQUEST_HEADER_FIELDS_TOO_LARGE":431,"HTTP_STATUS_UNAVAILABLE_FOR_LEGAL_REASONS":451,"HTTP_STATUS_INTERNAL_SERVER_ERROR":500,"HTTP_STATUS_NOT_IMPLEMENTED":501,"HTTP_STATUS_BAD_GATEWAY":502,"HTTP_STATUS_SERVICE_UNAVAILABLE":503,"HTTP_STATUS_GATEWAY_TIMEOUT":504,"HTTP_STATUS_HTTP_VERSION_NOT_SUPPORTED":505,"HTTP_STATUS_VARIANT_ALSO_NEGOTIATES":506,"HTTP_STATUS_INSUFFICIENT_STORAGE":507,"HTTP_STATUS_LOOP_DETECTED":508,"HTTP_STATUS_BANDWIDTH_LIMIT_EXCEEDED":509,"HTTP_STATUS_NOT_EXTENDED":510,"HTTP_STATUS_NETWORK_AUTHENTICATION_REQUIRED":511};
var H2_DEFAULT_SETTINGS = {"headerTableSize":4096,"enablePush":true,"initialWindowSize":65535,"maxFrameSize":16384,"maxConcurrentStreams":4294967295,"maxHeaderSize":65535,"maxHeaderListSize":65535,"enableConnectProtocol":false};
var HPACK_STATIC = [[":authority",""],[":method","GET"],[":method","POST"],[":path","/"],[":path","/index.html"],[":scheme","http"],[":scheme","https"],[":status","200"],[":status","204"],[":status","206"],[":status","304"],[":status","400"],[":status","404"],[":status","500"],["accept-charset",""],["accept-encoding","gzip, deflate"],["accept-language",""],["accept-ranges",""],["accept",""],["access-control-allow-origin",""],["age",""],["allow",""],["authorization",""],["cache-control",""],["content-disposition",""],["content-encoding",""],["content-language",""],["content-length",""],["content-location",""],["content-range",""],["content-type",""],["cookie",""],["date",""],["etag",""],["expect",""],["expires",""],["from",""],["host",""],["if-match",""],["if-modified-since",""],["if-none-match",""],["if-range",""],["if-unmodified-since",""],["last-modified",""],["link",""],["location",""],["max-forwards",""],["proxy-authenticate",""],["proxy-authorization",""],["range",""],["referer",""],["refresh",""],["retry-after",""],["server",""],["set-cookie",""],["strict-transport-security",""],["transfer-encoding",""],["user-agent",""],["vary",""],["via",""],["www-authenticate",""]];
var HUFF_CODE = [8184,8388568,268435426,268435427,268435428,268435429,268435430,268435431,268435432,16777194,1073741820,268435433,268435434,1073741821,268435435,268435436,268435437,268435438,268435439,268435440,268435441,268435442,1073741822,268435443,268435444,268435445,268435446,268435447,268435448,268435449,268435450,268435451,20,1016,1017,4090,8185,21,248,2042,1018,1019,249,2043,250,22,23,24,0,1,2,25,26,27,28,29,30,31,92,251,32764,32,4091,1020,8186,33,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,252,115,253,8187,524272,8188,16380,34,32765,3,35,4,36,5,37,38,39,6,116,117,40,41,42,7,43,118,44,8,9,45,119,120,121,122,123,32766,2044,16381,8189,268435452,1048550,4194258,1048551,1048552,4194259,4194260,4194261,8388569,4194262,8388570,8388571,8388572,8388573,8388574,16777195,8388575,16777196,16777197,4194263,8388576,16777198,8388577,8388578,8388579,8388580,2097116,4194264,8388581,4194265,8388582,8388583,16777199,4194266,2097117,1048553,4194267,4194268,8388584,8388585,2097118,8388586,4194269,4194270,16777200,2097119,4194271,8388587,8388588,2097120,2097121,4194272,2097122,8388589,4194273,8388590,8388591,1048554,4194274,4194275,4194276,8388592,4194277,4194278,8388593,67108832,67108833,1048555,524273,4194279,8388594,4194280,33554412,67108834,67108835,67108836,134217694,134217695,67108837,16777201,33554413,524274,2097123,67108838,134217696,134217697,67108839,134217698,16777202,2097124,2097125,67108840,67108841,268435453,134217699,134217700,134217701,1048556,16777203,1048557,2097126,4194281,2097127,2097128,8388595,4194282,4194283,33554414,33554415,16777204,16777205,67108842,8388596,67108843,134217702,67108844,67108845,134217703,134217704,134217705,134217706,134217707,268435454,134217708,134217709,134217710,134217711,134217712,67108846,1073741823];
var HUFF_LEN = [13,23,28,28,28,28,28,28,28,24,30,28,28,30,28,28,28,28,28,28,28,28,30,28,28,28,28,28,28,28,28,28,6,10,10,12,13,6,8,11,10,10,8,11,8,6,6,6,5,5,5,6,6,6,6,6,6,6,7,8,15,6,12,10,13,6,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,8,7,8,13,19,13,14,6,15,5,6,5,6,5,6,6,6,5,7,7,6,6,6,5,6,7,6,5,5,6,7,7,7,7,7,15,11,14,13,28,20,22,20,20,22,22,22,23,22,23,23,23,23,23,24,23,24,24,22,23,24,23,23,23,23,21,22,23,22,23,23,24,22,21,20,22,22,23,23,21,23,22,22,24,21,22,23,23,21,21,22,21,23,22,23,23,20,22,22,22,23,22,22,23,26,26,20,19,22,23,22,25,26,26,26,27,27,26,24,25,19,21,26,27,27,26,27,24,21,21,26,26,28,27,27,27,20,24,20,21,22,21,21,23,22,22,25,25,24,24,26,23,26,27,26,26,27,27,27,27,27,28,27,27,27,27,27,26,30];
var H2_POW2 = [];
for (var h2p = 0; h2p <= 40; h2p++) H2_POW2.push(Math.pow(2, h2p));

BF['http2'] = function () {
  var EventEmitter = requireBuiltin('events');
  if (typeof EventEmitter !== 'function') EventEmitter = EventEmitter.EventEmitter;
  var Buffer = requireBuiltin('buffer').Buffer;
  var streams = requireBuiltin('stream');
  var Duplex = streams.Duplex;
  var Readable = streams.Readable;
  var net = requireBuiltin('net');
  var sensitiveHeaders = Symbol('nodejs.http2.sensitiveHeaders');
  var C = H2_CONSTANTS;
  var POW2 = H2_POW2;

  /* RFC 9113 section 7 error codes, as Node's constants name them. */
  var E = {
    NO_ERROR: 0, PROTOCOL_ERROR: 1, INTERNAL_ERROR: 2, FLOW_CONTROL_ERROR: 3, SETTINGS_TIMEOUT: 4,
    STREAM_CLOSED: 5, FRAME_SIZE_ERROR: 6, REFUSED_STREAM: 7, CANCEL: 8, COMPRESSION_ERROR: 9,
    CONNECT_ERROR: 10, ENHANCE_YOUR_CALM: 11, INADEQUATE_SECURITY: 12, HTTP_1_1_REQUIRED: 13
  };
  var ERROR_NAMES = ['NGHTTP2_NO_ERROR', 'NGHTTP2_PROTOCOL_ERROR', 'NGHTTP2_INTERNAL_ERROR', 'NGHTTP2_FLOW_CONTROL_ERROR',
    'NGHTTP2_SETTINGS_TIMEOUT', 'NGHTTP2_STREAM_CLOSED', 'NGHTTP2_FRAME_SIZE_ERROR', 'NGHTTP2_REFUSED_STREAM', 'NGHTTP2_CANCEL',
    'NGHTTP2_COMPRESSION_ERROR', 'NGHTTP2_CONNECT_ERROR', 'NGHTTP2_ENHANCE_YOUR_CALM', 'NGHTTP2_INADEQUATE_SECURITY',
    'NGHTTP2_HTTP_1_1_REQUIRED'];
  var T = { DATA: 0, HEADERS: 1, PRIORITY: 2, RST_STREAM: 3, SETTINGS: 4, PUSH_PROMISE: 5, PING: 6, GOAWAY: 7, WINDOW_UPDATE: 8, CONTINUATION: 9 };
  var F = { END_STREAM: 0x1, ACK: 0x1, END_HEADERS: 0x4, PADDED: 0x8, PRIORITY: 0x20 };
  var MAX_WINDOW = 2147483647;
  var DEFAULT_WINDOW = 65535;
  var DEFAULT_FRAME = 16384;
  var ENCODER_TABLE_LIMIT = 4096;
  var MAX_HEADER_BLOCK = 1048576;
  /* Node's limits on received field blocks (nghttp2 max_continuations, NGHTTP2_HD_MAX_NV, maxHeaderListPairs). */
  var MAX_CONTINUATIONS = 8;
  var MAX_FIELD_STRING = 65536;
  var DEFAULT_MAX_HEADER_PAIRS = 128;
  var CLOSED_MEMORY = 1024;
  var EMPTY = Buffer.alloc(0);
  var PREFACE = Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n', 'latin1');

  function nameOfCode(code) {
    return ERROR_NAMES[code] !== undefined ? ERROR_NAMES[code] : String(code);
  }

  function h2Error(Ctor, code, message) {
    var err = new Ctor(message);
    err.code = code;
    return err;
  }

  function streamError(code) {
    var err = h2Error(Error, 'ERR_HTTP2_STREAM_ERROR', 'Stream closed with error code ' + nameOfCode(code));
    return err;
  }

  function sessionError(code) {
    return h2Error(Error, 'ERR_HTTP2_SESSION_ERROR', 'Session closed with error code ' + code);
  }

  /* Protocol failure raised below the session: carries the RFC error code for a GOAWAY or RST_STREAM. */
  function protoFailure(code, message) {
    var err = new Error(message || nameOfCode(code));
    err.h2Code = code;
    return err;
  }

  /* ---------- Argument validation, with Node's error codes and wording ---------- */

  function receivedText(value) {
    if (value === null) return 'Received null';
    if (value === undefined) return 'Received undefined';
    if (typeof value === 'function') return 'Received function ' + (value.name || '');
    if (typeof value === 'object') {
      var ctorName = value.constructor && value.constructor.name;
      return ctorName ? 'Received an instance of ' + ctorName : 'Received ' + String(value);
    }
    var shown = typeof value === 'string' ? "'" + value + "'" : String(value);
    if (shown.length > 28) shown = shown.slice(0, 25) + '...';
    return 'Received type ' + typeof value + ' (' + shown + ')';
  }

  function argTypeError(name, expected, value) {
    return h2Error(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "' + name + '" argument must be ' + expected + '. ' + receivedText(value));
  }

  function inspectValue(value) {
    try {
      return requireBuiltin('util').inspect(value);
    } catch (failure) {
      return String(value);
    }
  }

  function argValueError(name, value, reason) {
    var kind = name.indexOf('.') >= 0 ? 'property' : 'argument';
    return h2Error(TypeError, 'ERR_INVALID_ARG_VALUE', 'The ' + kind + " '" + name + "' " + (reason || 'is invalid') + '. Received ' + inspectValue(value));
  }

  /* Node's addNumericalSeparator for large integers in ERR_OUT_OF_RANGE. */
  function numberText(value) {
    if (typeof value !== 'number' || !Number.isInteger(value) || Math.abs(value) <= 4294967296) return String(value);
    var digits = String(Math.abs(value));
    var out = '';
    while (digits.length > 3) {
      out = '_' + digits.slice(-3) + out;
      digits = digits.slice(0, -3);
    }
    return (value < 0 ? '-' : '') + digits + out;
  }

  function outOfRange(name, range, value) {
    return h2Error(RangeError, 'ERR_OUT_OF_RANGE', 'The value of "' + name + '" is out of range. It must be ' + range + '. Received ' + numberText(value));
  }

  function validateInteger(value, name, min, max) {
    if (typeof value !== 'number') throw argTypeError(name, 'of type number', value);
    if (!Number.isInteger(value)) throw outOfRange(name, 'an integer', value);
    if (value < min || value > max) throw outOfRange(name, '>= ' + min + ' && <= ' + max, value);
  }

  function validateNumber(value, name) {
    if (typeof value !== 'number') throw argTypeError(name, 'of type number', value);
  }

  function validateFunction(value, name) {
    if (typeof value !== 'function') throw argTypeError(name, 'of type function', value);
  }

  function validateBoolean(value, name) {
    if (typeof value !== 'boolean') throw argTypeError(name, 'of type boolean', value);
  }

  function validateString(value, name) {
    if (typeof value !== 'string') throw argTypeError(name, 'of type string', value);
  }

  function validateBuffer(value, name) {
    if (!ArrayBuffer.isView(value)) throw argTypeError(name, 'an instance of Buffer, TypedArray, or DataView', value);
  }

  /* Node's assertIsObject: undefined passes; null, arrays and primitives do not. */
  function assertIsObject(value, name, expected) {
    if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
      throw argTypeError(name, expected || 'of type object', value);
    }
  }

  function bytesOf(view) {
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  }

  function readU32(buf, pos) {
    return buf[pos] * 16777216 + (buf[pos + 1] << 16) + (buf[pos + 2] << 8) + buf[pos + 3];
  }

  function u32Bytes(value) {
    return Buffer.from([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
  }

  function frameBuffer(type, flags, streamId, payload) {
    var len = payload ? payload.length : 0;
    var out = Buffer.alloc(9 + len);
    out[0] = (len >>> 16) & 0xff;
    out[1] = (len >>> 8) & 0xff;
    out[2] = len & 0xff;
    out[3] = type;
    out[4] = flags;
    out[5] = (streamId >>> 24) & 0x7f;
    out[6] = (streamId >>> 16) & 0xff;
    out[7] = (streamId >>> 8) & 0xff;
    out[8] = streamId & 0xff;
    if (len > 0) out.set(payload, 9);
    return out;
  }

  /* ---------- HPACK integer and string coding (RFC 7541 sections 5.1 and 5.2) ---------- */

  function encodeInt(out, value, prefix, high) {
    var max = (1 << prefix) - 1;
    if (value < max) {
      out.push(high | value);
      return;
    }
    out.push(high | max);
    value -= max;
    while (value >= 128) {
      out.push((value % 128) | 128);
      value = Math.floor(value / 128);
    }
    out.push(value);
  }

  function readInt(buf, pos, prefix) {
    if (pos >= buf.length) throw protoFailure(E.COMPRESSION_ERROR, 'HPACK integer truncated');
    var max = (1 << prefix) - 1;
    var value = buf[pos] & max;
    pos++;
    if (value < max) return { value: value, pos: pos };
    var shift = 0;
    for (;;) {
      if (pos >= buf.length) throw protoFailure(E.COMPRESSION_ERROR, 'HPACK integer truncated');
      var b = buf[pos++];
      value += (b & 0x7f) * POW2[shift];
      shift += 7;
      if ((b & 0x80) === 0) break;
      if (shift > 28) throw protoFailure(E.COMPRESSION_ERROR, 'HPACK integer too large');
    }
    return { value: value, pos: pos };
  }

  /* ---------- Huffman code (RFC 7541 section 5.2 and Appendix B) ---------- */

  function huffmanLength(bytes) {
    var bits = 0;
    for (var i = 0; i < bytes.length; i++) bits += HUFF_LEN[bytes[i]];
    return Math.ceil(bits / 8);
  }

  function huffmanEncode(bytes) {
    var out = [];
    var acc = 0;
    var nbits = 0;
    for (var i = 0; i < bytes.length; i++) {
      var sym = bytes[i];
      var len = HUFF_LEN[sym];
      acc = acc * POW2[len] + HUFF_CODE[sym];
      nbits += len;
      while (nbits >= 8) {
        nbits -= 8;
        out.push(Math.floor(acc / POW2[nbits]));
        acc = acc % POW2[nbits];
      }
    }
    if (nbits > 0) {
      /* Pad with the most significant bits of EOS (all ones). */
      var padBits = 8 - nbits;
      out.push(acc * POW2[padBits] + POW2[padBits] - 1);
    }
    return Buffer.from(out);
  }

  var huffTreeCache = null;
  function huffmanTree() {
    if (huffTreeCache !== null) return huffTreeCache;
    var left = [-1];
    var right = [-1];
    var sym = [-1];
    for (var s = 0; s < HUFF_LEN.length; s++) {
      var node = 0;
      for (var b = HUFF_LEN[s] - 1; b >= 0; b--) {
        var bit = Math.floor(HUFF_CODE[s] / POW2[b]) % 2;
        var child = bit ? right[node] : left[node];
        if (child < 0) {
          child = sym.length;
          left.push(-1);
          right.push(-1);
          sym.push(-1);
          if (bit) right[node] = child;
          else left[node] = child;
        }
        node = child;
      }
      sym[node] = s;
    }
    huffTreeCache = { left: left, right: right, sym: sym };
    return huffTreeCache;
  }

  function huffmanDecode(bytes) {
    var t = huffmanTree();
    var left = t.left;
    var right = t.right;
    var symOf = t.sym;
    var out = Buffer.alloc(Math.floor(bytes.length * 8 / 5) + 1);
    var n = 0;
    var node = 0;
    var pad = 0;
    var padOnes = true;
    for (var i = 0; i < bytes.length; i++) {
      var byte = bytes[i];
      for (var k = 7; k >= 0; k--) {
        var bit = (byte >> k) & 1;
        var next = bit ? right[node] : left[node];
        if (next < 0) throw protoFailure(E.COMPRESSION_ERROR, 'invalid Huffman code');
        node = next;
        pad++;
        if (!bit) padOnes = false;
        var s = symOf[node];
        if (s >= 0) {
          if (s === 256) throw protoFailure(E.COMPRESSION_ERROR, 'EOS inside a Huffman string');
          out[n++] = s;
          node = 0;
          pad = 0;
          padOnes = true;
        }
      }
    }
    /* RFC 7541 5.2: padding longer than 7 bits, or padding that is not the EOS prefix, is a decoding error. */
    if (pad > 7) throw protoFailure(E.COMPRESSION_ERROR, 'Huffman padding longer than 7 bits');
    if (node !== 0 && !padOnes) throw protoFailure(E.COMPRESSION_ERROR, 'Huffman padding is not an EOS prefix');
    return out.subarray(0, n);
  }

  /* huffman: 'auto' codes a string only when strictly shorter (nghttp2's rule); 'always' and 'never' force a choice. */
  function encodeString(out, bytes, huffmanMode) {
    var useHuffman = false;
    if (huffmanMode === 'always') useHuffman = true;
    else if (huffmanMode !== 'never') useHuffman = huffmanLength(bytes) < bytes.length;
    if (useHuffman) {
      var huff = huffmanEncode(bytes);
      encodeInt(out, huff.length, 7, 0x80);
      for (var i = 0; i < huff.length; i++) out.push(huff[i]);
    } else {
      encodeInt(out, bytes.length, 7, 0x00);
      for (var j = 0; j < bytes.length; j++) out.push(bytes[j]);
    }
  }

  function readString(buf, pos) {
    if (pos >= buf.length) throw protoFailure(E.COMPRESSION_ERROR, 'HPACK string truncated');
    var huff = (buf[pos] & 0x80) !== 0;
    var r = readInt(buf, pos, 7);
    /* nghttp2's NGHTTP2_HD_MAX_NV: a name or value longer than 64 KiB is a COMPRESSION_ERROR, as Node reports it. */
    if (r.value > MAX_FIELD_STRING) throw protoFailure(E.COMPRESSION_ERROR, 'HPACK string too long');
    var end = r.pos + r.value;
    if (end > buf.length) throw protoFailure(E.COMPRESSION_ERROR, 'HPACK string truncated');
    var raw = buf.subarray(r.pos, end);
    var bytes = huff ? huffmanDecode(raw) : raw;
    return { str: bytes.toString('latin1'), pos: end };
  }

  /* ---------- HPACK dynamic table (RFC 7541 section 4) ---------- */

  function DynamicTable(maxSize) {
    this.maxSize = maxSize;
    this.size = 0;
    this.entries = [];
  }
  DynamicTable.prototype.evictTo = function (limit) {
    while (this.size > limit && this.entries.length > 0) {
      var old = this.entries.pop();
      this.size -= old[0].length + old[1].length + 32;
    }
  };
  DynamicTable.prototype.add = function (name, value) {
    var entrySize = name.length + value.length + 32;
    if (entrySize > this.maxSize) {
      /* RFC 7541 4.4: an entry larger than the table empties it and is not added. */
      this.entries = [];
      this.size = 0;
      return;
    }
    this.evictTo(this.maxSize - entrySize);
    this.entries.unshift([name, value]);
    this.size += entrySize;
  };
  DynamicTable.prototype.setMaxSize = function (max) {
    this.maxSize = max;
    this.evictTo(max);
  };

  /* Absolute HPACK index: 1..61 static, 62 and up dynamic (newest first). */
  function HpackDecoder(maxSize) {
    this.table = new DynamicTable(maxSize);
    this.maxAllowed = maxSize;
  }
  HpackDecoder.prototype.lookup = function (index) {
    if (index >= 1 && index <= HPACK_STATIC.length) return HPACK_STATIC[index - 1];
    var entry = this.table.entries[index - HPACK_STATIC.length - 1];
    if (entry === undefined) throw protoFailure(E.COMPRESSION_ERROR, 'HPACK index out of range');
    return entry;
  };
  /* Returns [name, value, neverIndexed] triples. Any decoding error is a COMPRESSION_ERROR (RFC 9113 4.3). */
  HpackDecoder.prototype.decode = function (buf) {
    var pos = 0;
    var fields = [];
    var seenField = false;
    while (pos < buf.length) {
      var b = buf[pos];
      var r;
      if ((b & 0x80) !== 0) {
        r = readInt(buf, pos, 7);
        pos = r.pos;
        if (r.value === 0) throw protoFailure(E.COMPRESSION_ERROR, 'HPACK index 0');
        var indexed = this.lookup(r.value);
        fields.push([indexed[0], indexed[1], false]);
        seenField = true;
      } else if ((b & 0x40) !== 0) {
        r = readInt(buf, pos, 6);
        pos = r.pos;
        var nameA;
        if (r.value === 0) {
          var na = readString(buf, pos);
          nameA = na.str;
          pos = na.pos;
        } else {
          nameA = this.lookup(r.value)[0];
        }
        var va = readString(buf, pos);
        pos = va.pos;
        this.table.add(nameA, va.str);
        fields.push([nameA, va.str, false]);
        seenField = true;
      } else if ((b & 0x20) !== 0) {
        /* RFC 7541 4.2: a dynamic table size update is only valid at the start of a field block. */
        if (seenField) throw protoFailure(E.COMPRESSION_ERROR, 'dynamic table size update after a field');
        r = readInt(buf, pos, 5);
        pos = r.pos;
        if (r.value > this.maxAllowed) throw protoFailure(E.COMPRESSION_ERROR, 'dynamic table size update above the limit');
        this.table.setMaxSize(r.value);
      } else {
        var never = (b & 0x10) !== 0;
        r = readInt(buf, pos, 4);
        pos = r.pos;
        var nameB;
        if (r.value === 0) {
          var nb = readString(buf, pos);
          nameB = nb.str;
          pos = nb.pos;
        } else {
          nameB = this.lookup(r.value)[0];
        }
        var vb = readString(buf, pos);
        pos = vb.pos;
        fields.push([nameB, vb.str, never]);
        seenField = true;
      }
    }
    return fields;
  };

  /* Field modes: 'index' (incremental indexing, the default), 'none' (literal without indexing), 'never' (never indexed). */
  function HpackEncoder(maxSize) {
    this.table = new DynamicTable(maxSize);
    this.pendingMin = null;
    this.pendingFinal = null;
    this.huffman = 'auto';
  }
  /* RFC 7541 4.2: after several changes, signal the smallest size reached, then the final size. */
  HpackEncoder.prototype.setMaxTableSize = function (max) {
    if (max === this.table.maxSize && this.pendingFinal === null) return;
    if (this.pendingMin === null || max < this.pendingMin) this.pendingMin = max;
    this.pendingFinal = max;
    this.table.setMaxSize(max);
  };
  HpackEncoder.prototype.findFull = function (name, value) {
    for (var i = 0; i < HPACK_STATIC.length; i++) {
      if (HPACK_STATIC[i][0] === name && HPACK_STATIC[i][1] === value) return i + 1;
    }
    var entries = this.table.entries;
    for (var j = 0; j < entries.length; j++) {
      if (entries[j][0] === name && entries[j][1] === value) return HPACK_STATIC.length + 1 + j;
    }
    return 0;
  };
  HpackEncoder.prototype.findName = function (name) {
    for (var i = 0; i < HPACK_STATIC.length; i++) {
      if (HPACK_STATIC[i][0] === name) return i + 1;
    }
    var entries = this.table.entries;
    for (var j = 0; j < entries.length; j++) {
      if (entries[j][0] === name) return HPACK_STATIC.length + 1 + j;
    }
    return 0;
  };
  HpackEncoder.prototype.encode = function (fields) {
    var out = [];
    if (this.pendingFinal !== null) {
      if (this.pendingMin < this.pendingFinal) encodeInt(out, this.pendingMin, 5, 0x20);
      encodeInt(out, this.pendingFinal, 5, 0x20);
      this.pendingMin = null;
      this.pendingFinal = null;
    }
    for (var i = 0; i < fields.length; i++) {
      var name = fields[i][0];
      var value = fields[i][1];
      var mode = fields[i][2] || 'index';
      if (mode === 'index') {
        var full = this.findFull(name, value);
        if (full > 0) {
          encodeInt(out, full, 7, 0x80);
          continue;
        }
      }
      var nameIndex = this.findName(name);
      var nameBytes = Buffer.from(name, 'latin1');
      var valueBytes = Buffer.from(value, 'latin1');
      var entrySize = nameBytes.length + valueBytes.length + 32;
      if (mode === 'index' && entrySize <= this.table.maxSize) {
        encodeInt(out, nameIndex, 6, 0x40);
        if (nameIndex === 0) encodeString(out, nameBytes, this.huffman);
        encodeString(out, valueBytes, this.huffman);
        this.table.add(name, value);
      } else if (mode === 'never') {
        encodeInt(out, nameIndex, 4, 0x10);
        if (nameIndex === 0) encodeString(out, nameBytes, this.huffman);
        encodeString(out, valueBytes, this.huffman);
      } else {
        encodeInt(out, nameIndex, 4, 0x00);
        if (nameIndex === 0) encodeString(out, nameBytes, this.huffman);
        encodeString(out, valueBytes, this.huffman);
      }
    }
    return Buffer.from(out);
  };

  /* ---------- Frame reading ---------- */

  function FrameReader() {
    this.buf = EMPTY;
  }
  FrameReader.prototype.push = function (chunk) {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
  };
  FrameReader.prototype.drop = function (n) {
    this.buf = this.buf.subarray(n);
  };
  FrameReader.prototype.next = function (maxFrameSize) {
    var buf = this.buf;
    if (buf.length < 9) return null;
    var length = (buf[0] << 16) | (buf[1] << 8) | buf[2];
    if (length > maxFrameSize) return { tooLarge: true, length: length, type: buf[3] };
    if (buf.length < 9 + length) return null;
    var frame = {
      type: buf[3],
      flags: buf[4],
      stream: (buf[5] & 0x7f) * 16777216 + (buf[6] << 16) + (buf[7] << 8) + buf[8],
      length: length,
      payload: buf.subarray(9, 9 + length)
    };
    this.buf = buf.subarray(9 + length);
    return frame;
  };

  /* ---------- Settings ---------- */

  var SETTING_ORDER = [
    { key: 'headerTableSize', id: C.NGHTTP2_SETTINGS_HEADER_TABLE_SIZE },
    { key: 'enablePush', id: C.NGHTTP2_SETTINGS_ENABLE_PUSH },
    { key: 'maxConcurrentStreams', id: C.NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS },
    { key: 'initialWindowSize', id: C.NGHTTP2_SETTINGS_INITIAL_WINDOW_SIZE },
    { key: 'maxFrameSize', id: C.NGHTTP2_SETTINGS_MAX_FRAME_SIZE },
    { key: 'maxHeaderListSize', id: C.NGHTTP2_SETTINGS_MAX_HEADER_LIST_SIZE },
    { key: 'enableConnectProtocol', id: C.NGHTTP2_SETTINGS_ENABLE_CONNECT_PROTOCOL }
  ];
  var BOOLEAN_SETTINGS = { enablePush: true, enableConnectProtocol: true };

  function settingValueOf(settings, entry) {
    var v = settings[entry.key];
    if (v === undefined && entry.key === 'maxHeaderListSize') v = settings.maxHeaderSize;
    return v;
  }

  function invalidSetting(name, value) {
    return h2Error(RangeError, 'ERR_HTTP2_INVALID_SETTING_VALUE', 'Invalid value for setting "' + name + '": ' + value);
  }

  /* Validates the user-facing settings object the way Node does before anything is sent. */
  function validateSettings(settings) {
    for (var i = 0; i < SETTING_ORDER.length; i++) {
      var entry = SETTING_ORDER[i];
      var v = settingValueOf(settings, entry);
      if (v === undefined || v === null) continue;
      if (BOOLEAN_SETTINGS[entry.key] === true) {
        if (typeof v !== 'boolean') throw h2Error(TypeError, 'ERR_HTTP2_INVALID_SETTING_VALUE', 'Invalid value for setting "' + entry.key + '": ' + v);
        continue;
      }
      if (typeof v !== 'number' || v !== Math.floor(v) || v < 0 || v > 4294967295) throw invalidSetting(entry.key, v);
      if (entry.key === 'initialWindowSize' && v > MAX_WINDOW) throw invalidSetting(entry.key, v);
      if (entry.key === 'maxFrameSize' && (v < DEFAULT_FRAME || v > 16777215)) throw invalidSetting(entry.key, v);
    }
  }

  function packSettings(settings) {
    var parts = [];
    for (var i = 0; i < SETTING_ORDER.length; i++) {
      var entry = SETTING_ORDER[i];
      var v = settingValueOf(settings, entry);
      if (v === undefined || v === null) continue;
      if (BOOLEAN_SETTINGS[entry.key] === true) v = v ? 1 : 0;
      var pair = Buffer.alloc(6);
      pair[0] = (entry.id >>> 8) & 0xff;
      pair[1] = entry.id & 0xff;
      pair.set(u32Bytes(Number(v) >>> 0), 2);
      parts.push(pair);
    }
    return parts.length === 0 ? EMPTY : Buffer.concat(parts);
  }

  function copySettings(source) {
    var out = {};
    for (var i = 0; i < SETTING_ORDER.length; i++) {
      var entry = SETTING_ORDER[i];
      var v = settingValueOf(source, entry);
      if (v !== undefined && v !== null) out[entry.key] = v;
    }
    return out;
  }

  /* RFC 9113 6.5.2 initial values. */
  function protocolDefaults() {
    return {
      headerTableSize: 4096,
      enablePush: true,
      initialWindowSize: DEFAULT_WINDOW,
      maxFrameSize: DEFAULT_FRAME,
      maxConcurrentStreams: 4294967295,
      maxHeaderListSize: 4294967295,
      enableConnectProtocol: false
    };
  }

  /* The public view, keyed as Node reports it: maxHeaderSize is the alias of maxHeaderListSize. */
  function publicSettings(s) {
    return {
      headerTableSize: s.headerTableSize,
      enablePush: s.enablePush,
      initialWindowSize: s.initialWindowSize,
      maxFrameSize: s.maxFrameSize,
      maxConcurrentStreams: s.maxConcurrentStreams,
      maxHeaderListSize: s.maxHeaderListSize,
      maxHeaderSize: s.maxHeaderListSize,
      enableConnectProtocol: s.enableConnectProtocol
    };
  }

  /* ---------- Header lists ---------- */

  function nullSet(names) {
    var set = Object.create(null);
    for (var i = 0; i < names.length; i++) set[names[i]] = true;
    return set;
  }

  /* RFC 9113 8.2.2 (received) and Node's isIllegalConnectionSpecificHeader (sent). */
  var CONNECTION_SPECIFIC = nullSet(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade']);
  var CONNECTION_SPECIFIC_SEND = nullSet(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'http2-settings']);
  /* Node's kSingleValueFields: a second value is refused when sent (strictSingleValueFields) and dropped when received. */
  var SINGLE_VALUE = nullSet([':status', ':method', ':authority', ':scheme', ':path', ':protocol', 'access-control-allow-credentials',
    'access-control-max-age', 'access-control-request-method', 'age', 'authorization', 'content-encoding', 'content-language',
    'content-length', 'content-location', 'content-md5', 'content-range', 'content-type', 'date', 'dnt', 'etag', 'expires', 'from',
    'host', 'if-match', 'if-modified-since', 'if-none-match', 'if-range', 'if-unmodified-since', 'last-modified', 'location',
    'max-forwards', 'proxy-authorization', 'range', 'referer', 'retry-after', 'tk', 'upgrade-insecure-requests', 'user-agent',
    'x-content-type-options']);
  /* Node's kValidPseudoHeaders: the pseudo-headers request() accepts (the peer still applies RFC 9113 8.3). */
  var VALID_PSEUDO = nullSet([':status', ':method', ':authority', ':scheme', ':path', ':protocol']);
  /* Node's kNoPayloadMethods: request() ends the writable side by default for these. */
  var NO_PAYLOAD_METHODS = nullSet(['DELETE', 'GET', 'HEAD']);
  var TOKEN_RE = /^[!#$%&'*+\-.\^_\x60|~0-9a-z]+$/;
  var BAD_VALUE_RE = /[\0\r\n]/;

  function utcDate() {
    return new Date().toUTCString();
  }

  /* RFC 9113 8.2.1: lower-case token names; values without NUL, CR or LF and without leading or trailing whitespace. */
  function fieldValueValid(value) {
    if (BAD_VALUE_RE.test(value)) return false;
    if (value.length === 0) return true;
    var first = value.charCodeAt(0);
    var last = value.charCodeAt(value.length - 1);
    return first !== 0x20 && first !== 0x09 && last !== 0x20 && last !== 0x09;
  }

  function invalidPseudo(name) {
    return h2Error(TypeError, 'ERR_HTTP2_INVALID_PSEUDOHEADER', '"' + name + '" is an invalid pseudoheader or is used incorrectly');
  }

  function singleValueError(name) {
    return h2Error(TypeError, 'ERR_HTTP2_HEADER_SINGLE_VALUE', 'Header field "' + name + '" must only have a single value');
  }

  function invalidToken(name) {
    return h2Error(TypeError, 'ERR_INVALID_HTTP_TOKEN', 'Header name must be a valid HTTP token ["' + name + '"]');
  }

  /*
   * Node's buildNgHeaderString: a header object or a flat [name, value, ...] array to [name, value, mode] fields, pseudo-headers
   * first, each group in the caller's order. Names are lower-cased, an undefined value or an empty name is skipped, an empty array
   * sends nothing and a one-element array is a single value. kind is 'request' (Node's kValidPseudoHeaders), 'response' (:status
   * only) or 'trailers' (no pseudo-header). One deliberate difference: a value with NUL, CR or LF throws ERR_INVALID_CHAR, as
   * RFC 9113 8.2.1 forbids it on the wire (Node hands it to nghttp2 and the peer resets the stream).
   */
  function buildFields(arrayOrMap, kind, strict) {
    var pseudo = [];
    var regular = [];
    var singles = Object.create(null);
    var listed = arrayOrMap[sensitiveHeaders] || [];
    var neverIndex = [];
    for (var s = 0; s < listed.length; s++) neverIndex.push(String(listed[s]).toLowerCase());
    function fieldOf(name, text) {
      if (BAD_VALUE_RE.test(text)) throw h2Error(TypeError, 'ERR_INVALID_CHAR', 'Invalid character in header content ["' + name + '"]');
      /* Never-indexed (RFC 7541 6.2.3): the listed names, plus credentials and short cookies as nghttp2 does. */
      var never = neverIndex.indexOf(name) >= 0 || name === 'authorization' || name === 'proxy-authorization' ||
        (name === 'cookie' && text.length < 20);
      return [name, text, never ? 'never' : 'index'];
    }
    function processHeader(key, value) {
      key = key.toLowerCase();
      var strictSingle = strict && SINGLE_VALUE[key] === true;
      var isArray = Array.isArray(value);
      if (isArray) {
        if (value.length === 0) return;
        if (value.length === 1) {
          value = String(value[0]);
          isArray = false;
        } else if (strictSingle) {
          throw singleValueError(key);
        }
      } else {
        value = String(value);
      }
      if (strictSingle) {
        if (singles[key] === true) throw singleValueError(key);
        singles[key] = true;
      }
      if (key.charAt(0) === ':') {
        if (kind === 'trailers' || (kind === 'response' && key !== ':status') || (kind === 'request' && VALID_PSEUDO[key] !== true)) {
          throw invalidPseudo(key);
        }
        pseudo.push(fieldOf(key, value));
        return;
      }
      if (!TOKEN_RE.test(key)) throw invalidToken(key);
      if (CONNECTION_SPECIFIC_SEND[key] === true || (key === 'te' && value !== 'trailers')) {
        throw h2Error(TypeError, 'ERR_HTTP2_INVALID_CONNECTION_HEADERS', 'HTTP/1 Connection specific headers are forbidden: "' + key + '"');
      }
      if (isArray) {
        for (var j = 0; j < value.length; j++) regular.push(fieldOf(key, String(value[j])));
        return;
      }
      regular.push(fieldOf(key, value));
    }
    var i;
    if (Array.isArray(arrayOrMap)) {
      for (i = 0; i < arrayOrMap.length; i += 2) {
        if (arrayOrMap[i + 1] === undefined || arrayOrMap[i] === '') continue;
        processHeader(arrayOrMap[i], arrayOrMap[i + 1]);
      }
    } else {
      var keys = Object.keys(arrayOrMap);
      for (i = 0; i < keys.length; i++) {
        if (arrayOrMap[keys[i]] === undefined || keys[i] === '') continue;
        processHeader(keys[i], arrayOrMap[keys[i]]);
      }
    }
    return pseudo.concat(regular);
  }

  /*
   * Node's toHeaderObject: received fields to a null-prototype object. :status is a number; a repeated single-value field keeps
   * its first value; cookie values join with '; ', set-cookie is an array, anything else joins with ', '.
   */
  function fieldsToHeaders(fields) {
    var out = Object.create(null);
    var sensitive = [];
    for (var i = 0; i < fields.length; i++) {
      var name = fields[i][0];
      var value = fields[i][1];
      if (fields[i][2]) sensitive.push(name);
      if (name === ':status') value = value | 0;
      var existing = out[name];
      if (existing === undefined) {
        out[name] = name === 'set-cookie' ? [value] : value;
      } else if (SINGLE_VALUE[name] !== true) {
        if (name === 'cookie') out[name] = existing + '; ' + value;
        else if (name === 'set-cookie') existing.push(value);
        else out[name] = existing + ', ' + value;
      }
    }
    out[sensitiveHeaders] = sensitive;
    return out;
  }

  function rawHeadersOf(fields) {
    var out = [];
    for (var i = 0; i < fields.length; i++) out.push(fields[i][0], fields[i][1]);
    return out;
  }

  /* Checks common to every received field section: RFC 9113 8.2 and 8.2.2. */
  function regularFieldError(name, value) {
    if (!TOKEN_RE.test(name)) return E.PROTOCOL_ERROR;
    if (CONNECTION_SPECIFIC[name] === true) return E.PROTOCOL_ERROR;
    if (name === 'te' && value !== 'trailers') return E.PROTOCOL_ERROR;
    if (!fieldValueValid(value)) return E.PROTOCOL_ERROR;
    return 0;
  }

  /* RFC 9113 8.3.1: request pseudo-headers come first, exactly once, and no response pseudo-header. */
  function requestFieldsError(fields) {
    var sawRegular = false;
    var seen = {};
    var method = null;
    var hasScheme = false;
    var hasPath = false;
    var hasAuthority = false;
    for (var i = 0; i < fields.length; i++) {
      var name = fields[i][0];
      var value = fields[i][1];
      if (name.charAt(0) === ':') {
        if (sawRegular || seen[name] === true) return E.PROTOCOL_ERROR;
        seen[name] = true;
        if (name === ':method') method = value;
        else if (name === ':scheme') hasScheme = true;
        else if (name === ':path') {
          if (value === '') return E.PROTOCOL_ERROR;
          hasPath = true;
        } else if (name === ':authority') hasAuthority = true;
        else return E.PROTOCOL_ERROR;
        if (!fieldValueValid(value)) return E.PROTOCOL_ERROR;
        continue;
      }
      sawRegular = true;
      var err = regularFieldError(name, value);
      if (err !== 0) return err;
    }
    if (method === null) return E.PROTOCOL_ERROR;
    if (method === 'CONNECT') return hasAuthority && !hasScheme && !hasPath ? 0 : E.PROTOCOL_ERROR;
    return hasScheme && hasPath ? 0 : E.PROTOCOL_ERROR;
  }

  /* RFC 9113 8.3.2: exactly one :status, first, three digits; no request pseudo-header. */
  function responseFieldsError(fields) {
    var sawRegular = false;
    var status = null;
    for (var i = 0; i < fields.length; i++) {
      var name = fields[i][0];
      if (name.charAt(0) === ':') {
        if (sawRegular || name !== ':status' || status !== null) return E.PROTOCOL_ERROR;
        status = fields[i][1];
        if (!/^[0-9]{3}$/.test(status)) return E.PROTOCOL_ERROR;
        continue;
      }
      sawRegular = true;
      var err = regularFieldError(name, fields[i][1]);
      if (err !== 0) return err;
    }
    return status === null ? E.PROTOCOL_ERROR : 0;
  }

  /* Trailers: no pseudo-headers (RFC 9113 8.1). */
  function trailerFieldsError(fields) {
    for (var i = 0; i < fields.length; i++) {
      var name = fields[i][0];
      if (name.charAt(0) === ':') return E.PROTOCOL_ERROR;
      var err = regularFieldError(name, fields[i][1]);
      if (err !== 0) return err;
    }
    return 0;
  }

  function contentLengthOf(fields) {
    for (var i = 0; i < fields.length; i++) {
      if (fields[i][0] === 'content-length') {
        if (!/^[0-9]+$/.test(fields[i][1])) return -2;
        return Number(fields[i][1]);
      }
    }
    return -1;
  }

  function randomBytes8() {
    var out = Buffer.alloc(8);
    for (var i = 0; i < 8; i++) out[i] = Math.floor(Math.random() * 256);
    return out;
  }

  /* Node's getAuthority: :authority, else host. */
  function getAuthority(headers) {
    if (headers[':authority'] !== undefined) return headers[':authority'];
    if (headers.host !== undefined) return headers.host;
    return undefined;
  }

  function checkConnect(authority, scheme, path) {
    if (authority === undefined) throw h2Error(TypeError, 'ERR_HTTP2_CONNECT_AUTHORITY', ':authority header is required for CONNECT requests');
    if (scheme !== undefined) throw h2Error(TypeError, 'ERR_HTTP2_CONNECT_SCHEME', 'The :scheme header is forbidden for CONNECT requests');
    if (path !== undefined) throw h2Error(TypeError, 'ERR_HTTP2_CONNECT_PATH', 'The :path header is forbidden for CONNECT requests');
  }

  /*
   * Node's prepareRequestHeadersObject / prepareRequestHeadersArray: :method defaults to GET; outside CONNECT (or with :protocol)
   * :authority (unless host is given), :scheme and :path get the session's defaults; a plain CONNECT needs :authority and refuses
   * :scheme and :path.
   */
  function prepareRequest(session, headersParam) {
    var strict = session._strictSingle;
    var schemeDefault = session._protocol.slice(0, -1);
    if (Array.isArray(headersParam)) {
      var method;
      var scheme;
      var authority;
      var path;
      var protocol;
      for (var i = 0; i < headersParam.length; i += 2) {
        if (headersParam[i][0] !== ':') continue;
        var header = headersParam[i].toLowerCase();
        var value = headersParam[i + 1];
        if (header === ':method') method = value;
        else if (header === ':scheme') scheme = value;
        else if (header === ':authority') authority = value;
        else if (header === ':path') path = value;
        else if (header === ':protocol') protocol = value;
      }
      var extra = [];
      if (method === undefined) {
        method = 'GET';
        extra.push(':method', method);
      }
      if (method !== 'CONNECT' || protocol !== undefined) {
        if (authority === undefined && headersParam.host === undefined) {
          authority = session._authority;
          extra.push(':authority', authority);
        }
        if (scheme === undefined) {
          scheme = schemeDefault;
          extra.push(':scheme', scheme);
        }
        if (path === undefined) extra.push(':path', '/');
      } else {
        checkConnect(authority, scheme, path);
      }
      var rawHeaders = extra.length > 0 ? extra.concat(headersParam) : headersParam;
      if (headersParam[sensitiveHeaders] !== undefined) rawHeaders[sensitiveHeaders] = headersParam[sensitiveHeaders];
      return { fields: buildFields(rawHeaders, 'request', strict), rawHeaders: rawHeaders, headersObject: undefined, method: method };
    }
    var obj = Object.assign(Object.create(null), headersParam);
    if (obj[':method'] === undefined) obj[':method'] = 'GET';
    if (obj[':method'] !== 'CONNECT' || obj[':protocol'] !== undefined) {
      if (getAuthority(obj) === undefined) obj[':authority'] = session._authority;
      if (obj[':scheme'] === undefined) obj[':scheme'] = schemeDefault;
      if (obj[':path'] === undefined) obj[':path'] = '/';
    } else {
      checkConnect(obj[':authority'], obj[':scheme'], obj[':path']);
    }
    return { fields: buildFields(obj, 'request', strict), rawHeaders: undefined, headersObject: obj, method: obj[':method'] };
  }

  function validatePreparedResponse(headers, statusCode) {
    if (statusCode < 200 || statusCode > 599) throw h2Error(RangeError, 'ERR_HTTP2_STATUS_INVALID', 'Invalid status code: ' + statusCode);
    var neverIndex = headers[sensitiveHeaders];
    if (neverIndex !== undefined && !Array.isArray(neverIndex)) throw argValueError('headers[http2.neverIndex]', neverIndex);
  }

  /* Node's prepareResponseHeaders: :status defaults to 200 and date is added unless sendDate is false. */
  function prepareResponse(stream, headersParam, options) {
    var statusCode;
    var headers;
    var withDate = options.sendDate === undefined || options.sendDate === null || !!options.sendDate;
    if (Array.isArray(headersParam)) {
      var isDateSet = false;
      for (var i = 0; i < headersParam.length; i += 2) {
        var header = headersParam[i].toLowerCase();
        if (header === ':status') statusCode = headersParam[i + 1] | 0;
        else if (header === 'date') isDateSet = true;
      }
      if (!statusCode) {
        statusCode = 200;
        headersParam.unshift(':status', statusCode);
      }
      if (!isDateSet && withDate) headersParam.push('date', utcDate());
      validatePreparedResponse(headersParam, statusCode);
      headers = headersParam;
      stream._rawSentHeaders = headers;
    } else {
      assertIsObject(headersParam, 'headers', 'of type object or an instance of Array');
      headers = Object.create(null);
      if (headersParam !== null && headersParam !== undefined) {
        var keys = Object.keys(headersParam);
        for (var k = 0; k < keys.length; k++) headers[keys[k]] = headersParam[keys[k]];
        headers[sensitiveHeaders] = headersParam[sensitiveHeaders];
      }
      statusCode = headers[':status'] = (headers[':status'] | 0) || 200;
      if (withDate && (headers.date === undefined || headers.date === null)) headers.date = utcDate();
      validatePreparedResponse(headers, statusCode);
      stream._sentHeaders = headers;
    }
    return { fields: buildFields(headers, 'response', stream._session._strictSingle), statusCode: statusCode };
  }

  var STATE_NUMBER = {
    idle: C.NGHTTP2_STREAM_STATE_IDLE,
    open: C.NGHTTP2_STREAM_STATE_OPEN,
    'reserved-local': C.NGHTTP2_STREAM_STATE_RESERVED_LOCAL,
    'reserved-remote': C.NGHTTP2_STREAM_STATE_RESERVED_REMOTE,
    'half-closed-local': C.NGHTTP2_STREAM_STATE_HALF_CLOSED_LOCAL,
    'half-closed-remote': C.NGHTTP2_STREAM_STATE_HALF_CLOSED_REMOTE,
    closed: C.NGHTTP2_STREAM_STATE_CLOSED
  };

  /* ---------- Streams ---------- */

  /* Fields the compat layer keeps on a stream, as Node's kRequest, kResponse and kProxySocket. */
  var kRequest = Symbol('request');
  var kResponse = Symbol('response');
  var kProxySocket = Symbol('proxySocket');
  /* Node's closeStream() modes: no RST_STREAM, RST_STREAM once the writable side allows it, RST_STREAM now. */
  var RST_NONE = 0;
  var RST_SUBMIT = 1;
  var RST_FORCE = 2;

  function invalidStreamError() {
    return h2Error(Error, 'ERR_HTTP2_INVALID_STREAM', 'The stream has been destroyed');
  }

  function headersSentError() {
    return h2Error(Error, 'ERR_HTTP2_HEADERS_SENT', 'Response has already been initiated.');
  }

  function emitWantTrailers(stream) {
    if (stream.destroyed || stream._closedFlag) return;
    /* Node's onStreamTrailers: without a 'wantTrailers' listener the stream ends with empty trailers. */
    if (!stream.emit('wantTrailers')) stream.sendTrailers({});
  }

  /*
   * The protocol state (windows, stream states, frames on the wire) changes as frames arrive. What the application observes is
   * delivered as Node delivers it: every nghttp2 callback runs to completion and its ticks and microtasks drain before the next
   * one. Header events go out on the next tick and hold the stream's later callbacks (DATA, end, reset, close) until a macrotask,
   * so code that awaits 'response' still sees the 'end' and 'close' that arrived in the same read.
   */
  class Http2Stream extends Duplex {
    constructor(session, id) {
      /* Like Node's Http2Stream: no autoDestroy; the stream is destroyed when the protocol closes it (_onStreamClose). */
      super({ allowHalfOpen: true, autoDestroy: false });
      this._session = session;
      /* undefined while a client stream waits for its session to connect (stream.pending, as Node). */
      this.id = id;
      this._state = id === undefined ? 'idle' : 'open';
      this._sendWindow = session._remoteSettings.initialWindowSize;
      this._recvWindow = session._localSettings.initialWindowSize;
      this._outQueue = [];
      this._queuedBytes = 0;
      this._pushedBytes = 0;
      this._ackedBytes = 0;
      this._gotHeaders = false;
      this._headersSent = false;
      this._trailersReady = false;
      this._sentHeaders = undefined;
      this._rawSentHeaders = undefined;
      this._sentInfoHeaders = undefined;
      this._sentTrailers = undefined;
      this._localEnd = false;
      this._remoteEnd = false;
      this._expectedLength = -1;
      this._receivedLength = 0;
      this._isRemote = false;
      this._wireOpen = false;
      this._requestMethod = undefined;
      /* Node's stream state: closed flag, rstCode (0 until closed), aborted, waitForTrailers, HEAD request, endAfterHeaders. */
      this._closedFlag = false;
      this._rstCode = E.NO_ERROR;
      this._aborted = false;
      this._hasTrailers = false;
      this._headRequest = false;
      this._endAfterHeaders = false;
      this._didRead = false;
      this._shutdown = false;
      this._sessionGone = false;
      this._inbox = [];
      this._held = false;
      this._drainScheduled = false;
      this[kRequest] = null;
      this[kProxySocket] = null;
      /* As Node does: maybeReadMore stays off until a consumer first calls _read, so _didRead means a real read. */
      if (this._readableState) this._readableState.readingMore = true;
      var self = this;
      this.on('end', function () { self._maybeDestroy(); });
      this.on('finish', function () { self._maybeDestroy(); });
      session._liveStreams.add(this);
    }
    get session() {
      return this._sessionGone ? undefined : this._session;
    }
    get rstCode() {
      return this._rstCode;
    }
    get headersSent() {
      return this._headersSent;
    }
    get sentHeaders() {
      if (this._sentHeaders !== undefined || this._rawSentHeaders === undefined) return this._sentHeaders;
      /* Node builds the object from a raw header array on first use: names as given, repeated names as arrays. */
      var raw = this._rawSentHeaders;
      var obj = Object.create(null);
      for (var i = 0; i < raw.length; i += 2) {
        var existing = obj[raw[i]];
        if (existing === undefined) obj[raw[i]] = raw[i + 1];
        else if (Array.isArray(existing)) existing.push(raw[i + 1]);
        else obj[raw[i]] = [existing, raw[i + 1]];
      }
      if (raw[sensitiveHeaders] !== undefined) obj[sensitiveHeaders] = raw[sensitiveHeaders];
      this._sentHeaders = obj;
      return obj;
    }
    get sentInfoHeaders() {
      return this._sentInfoHeaders;
    }
    get sentTrailers() {
      return this._sentTrailers;
    }
    get aborted() {
      return this._aborted;
    }
    get closed() {
      return this._closedFlag;
    }
    get pending() {
      return this.id === undefined;
    }
    get headRequest() {
      return this._headRequest;
    }
    get bufferSize() {
      return this._queuedBytes + this.writableLength;
    }
    get endAfterHeaders() {
      return this._endAfterHeaders;
    }
    get state() {
      if (this.destroyed || this.id === undefined) return {};
      return {
        localWindowSize: this._recvWindow,
        state: STATE_NUMBER[this._state],
        localClose: this._localEnd ? 1 : 0,
        remoteClose: this._remoteEnd ? 1 : 0,
        sumDependencyWeight: 0,
        weight: C.NGHTTP2_DEFAULT_WEIGHT
      };
    }
    /* RFC 9113 deprecates the RFC 7540 priority scheme; priority signals are accepted and ignored. */
    priority() {
      if (this.destroyed) throw invalidStreamError();
    }
    setTimeout(ms, callback) {
      if (typeof callback === 'function') this.once('timeout', callback);
      return this;
    }
    read(n) {
      var chunk = super.read(n);
      this._noteConsumed();
      return chunk;
    }

    /* ----- callback delivery ----- */

    /*
     * One nghttp2 callback's worth of observable work: now, unless earlier callbacks of this stream still wait. A barrier callback
     * (header event, end of data, reset) also waits when DATA was delivered to this stream in the same turn, since Node drains
     * ticks and microtasks between the DATA callback and the next one.
     */
    _run(fn, barrier) {
      var turn = this._session._turn;
      /* A hold ends once a macrotask has passed (the host drained ticks and microtasks in between). */
      if (this._held && this._holdTurn !== turn && this._inbox.length === 0) this._held = false;
      if (this._held || this._inbox.length > 0 || (barrier === true && this._dataTurn === turn)) {
        this._inbox.push({ fn: fn, later: false, barrier: barrier === true });
        this._scheduleDrain();
        return;
      }
      fn();
    }
    /* A callback Node makes only after the current one has drained (the stream close). */
    _runLater(fn) {
      this._inbox.push({ fn: fn, later: true, barrier: false });
      this._scheduleDrain();
    }
    /* A header event (or the end of data) went out on the next tick: later callbacks in this turn wait for a macrotask. */
    _hold() {
      this._held = true;
      this._holdTurn = this._session._turn;
      this._session._eventTurn = this._session._turn;
    }
    _scheduleDrain() {
      if (this._drainScheduled) return;
      this._drainScheduled = true;
      this._session._queueDrain(this);
    }
    _drainInbox() {
      this._drainScheduled = false;
      this._held = false;
      var ran = false;
      while (this._inbox.length > 0) {
        var head = this._inbox[0];
        if (ran && (head.later || this._held || (head.barrier && this._dataTurn === this._session._turn))) {
          this._scheduleDrain();
          return;
        }
        this._inbox.shift();
        ran = true;
        head.fn();
      }
      this._session._deferred.delete(this);
    }
    _dropInbox() {
      this._inbox = [];
      this._held = false;
      if (!this._drainScheduled) this._session._deferred.delete(this);
    }

    /* ----- protocol state (RFC 9113 5.1) ----- */

    /* The stream window reopens as the application consumes buffered data (RFC 9113 5.2.2). */
    _noteConsumed() {
      if (this._state === 'closed' || this._remoteEnd || this._session._destroyed) return;
      var consumed = this._pushedBytes - this.readableLength;
      var delta = consumed - this._ackedBytes;
      if (delta <= 0) return;
      if (delta < 16384 && this.readableLength > 0) return;
      this._ackedBytes = consumed;
      this._session._grantStreamWindow(this, delta);
    }
    _canSend() {
      return this._wireOpen && this._headersSent && !this._localEnd &&
        (this._state === 'open' || this._state === 'half-closed-remote' || this._state === 'reserved-local');
    }
    _markLocalEnd() {
      if (this._localEnd) return;
      this._localEnd = true;
      if (this._state === 'open') this._state = 'half-closed-local';
      else if (this._state === 'half-closed-remote' || this._state === 'reserved-local') this._finishState();
    }
    _onRemoteEnd() {
      if (this._remoteEnd) return;
      this._remoteEnd = true;
      if (this._state === 'open' || this._state === 'reserved-remote') this._state = 'half-closed-remote';
      else if (this._state === 'half-closed-local') this._finishState();
    }
    /* Both directions are done: the stream is closed and forgotten; Node's onStreamClose(NO_ERROR) follows as its own callback. */
    _finishState() {
      this._state = 'closed';
      this._session._forgetStream(this, 'closed');
      var self = this;
      this._runLater(function () { self._onStreamClose(E.NO_ERROR); });
    }
    /* Queued data that will never be sent: the writes complete, as nghttp2 drops a reset stream's data. */
    _dropQueuedWrites() {
      var queued = this._outQueue;
      this._outQueue = [];
      this._queuedBytes = 0;
      queued.forEach(function (item) {
        if ((item.kind === 'data' || item.kind === 'end') && typeof item.cb === 'function') queueMicrotask(function () { item.cb(); });
      });
    }
    _onDataChunk(bytes) {
      this._dataTurn = this._session._turn;
      this._pushedBytes += bytes.length;
      this.push(bytes);
      /* Chunks a flowing reader took synchronously never pass through read(): account for them here. */
      this._noteConsumed();
    }

    /* ----- Node's stream lifecycle (lib/internal/http2/core.js) ----- */

    /*
     * closeStream(): closed flag and rstCode; 'aborted' and the end of the writable side if it was open (as with nghttp2, that
     * END_STREAM goes out before the reset); RST_STREAM now, or once the writable side finished when it was ending with NO_ERROR.
     */
    _closeStream(code, rst) {
      this._closedFlag = true;
      this._rstCode = code;
      var ws = this._writableState;
      var ending = ws ? ws.ending === true : true;
      if (!ending) {
        if (!this._aborted) {
          this._aborted = true;
          this.emit('aborted');
        }
        this.end();
      }
      if (rst === RST_NONE) return;
      if (!ending || this.writableFinished || code !== E.NO_ERROR || rst === RST_FORCE) {
        this._submitRst(code);
      } else {
        var self = this;
        this.once('finish', function () { self._submitRst(code); });
      }
    }
    /* submitRstStream(): a pending stream resets once it has an id; Node's onStreamClose(code) follows as its own callback. */
    _submitRst(code) {
      if (this.id === undefined) {
        var waiting = this;
        this.push(null);
        this.once('ready', function () { waiting._submitRst(code); });
        return;
      }
      if (this._state === 'closed') return;
      /*
       * Node submits RST_STREAM at once, and nghttp2 then ignores what was already read for the stream; a CANCEL issued while frames
       * are being delivered is deferred (Http2Stream::SubmitRstStream), so what was already read is still delivered.
       */
      if (code !== E.CANCEL) this._inbox = this._inbox.filter(function (item) { return item.later; });
      this._session._protocolReset(this, code);
      var self = this;
      this._runLater(function () { self._onStreamClose(code); });
    }
    /* onStreamClose(): the protocol closed the stream. Destroy now, or once the readable side has ended. */
    _onStreamClose(code) {
      if (this.destroyed) return;
      if (!this._closedFlag) this._closeStream(code, RST_NONE);
      if (!this.readable || code !== E.NO_ERROR) {
        this.destroy();
        return;
      }
      this.push(null);
      /* As Node does: an unconsumed server stream is drained so that it can end and close. */
      if (this._session._isServer && !this._didRead && this.readableFlowing === null) this.resume();
      else this.read(0);
    }
    /*
     * kMaybeDestroy: once the writable side finished, destroy when the stream closed and the readable side ended; or, for a server
     * that answered without reading the request and owes no trailers, close with NO_ERROR so the client stops sending (RFC 9113 8.1).
     */
    _maybeDestroy(code) {
      if (this.destroyed) return;
      if (code !== undefined && code !== E.NO_ERROR) {
        this.destroy();
        return;
      }
      if (!this.writableFinished) return;
      if (!this.readable && this._closedFlag) {
        this.destroy();
        return;
      }
      if (this._headersSent && this._session._isServer && !this._hasTrailers && !this._didRead && this.readableFlowing === null) {
        var self = this;
        setImmediate(function () { self.close(); });
      }
    }
    _destroy(err, callback) {
      var session = this._session;
      var sessionCode = session._goawayCode || session._destroyCode;
      var code = this._closedFlag ? this._rstCode : sessionCode;
      if (err !== null && err !== undefined) {
        if (sessionCode) code = sessionCode;
        else if (err.name === 'AbortError') code = E.CANCEL;
        else code = E.INTERNAL_ERROR;
      }
      if (!this._closedFlag) this._closeStream(code, this.id !== undefined ? RST_FORCE : RST_NONE);
      this.push(null);
      this._dropInbox();
      if (this._state !== 'closed') {
        this._state = 'closed';
        this._dropQueuedWrites();
        session._forgetStream(this, 'reset-local');
      }
      session._removePending(this);
      session._liveStreams.delete(this);
      /* RST code 8 is not an error: clients use it to abort, as Node documents. */
      if ((err === null || err === undefined) && code !== E.NO_ERROR && code !== E.CANCEL) err = streamError(code);
      this._sessionGone = true;
      setImmediate(function () { session._maybeDestroySession(); });
      callback(err);
    }

    /* ----- public API ----- */

    close(code, callback) {
      if (code === undefined) code = E.NO_ERROR;
      validateInteger(code, 'code', 0, 4294967295);
      if (callback !== undefined) validateFunction(callback, 'callback');
      if (this._closedFlag) return;
      if (callback !== undefined) this.once('close', callback);
      this._closeStream(code, RST_SUBMIT);
    }
    sendTrailers(headers) {
      if (this.destroyed || this._closedFlag) throw invalidStreamError();
      if (this._sentTrailers) throw h2Error(Error, 'ERR_HTTP2_TRAILERS_ALREADY_SENT', 'Trailing headers have already been sent');
      if (!this._trailersReady) throw h2Error(Error, 'ERR_HTTP2_TRAILERS_NOT_READY', 'Trailing headers cannot be sent until after the wantTrailers event is emitted');
      assertIsObject(headers, 'headers');
      var copy = Object.assign(Object.create(null), headers);
      var fields = buildFields(copy, 'trailers', this._session._strictSingle);
      this._sentTrailers = copy;
      this._outQueue.push({ kind: 'trailers', fields: fields });
      this._session._flushStream(this);
    }
    _read() {
      if (this.destroyed) {
        this.push(null);
        return;
      }
      if (!this._didRead) {
        this._didRead = true;
        if (this._readableState) this._readableState.readingMore = false;
      }
    }
    /* Node's kProceed: a server stream written to before respond() responds 200 implicitly. */
    _proceed() {}
    _write(chunk, encoding, callback) {
      if (this.id === undefined) {
        var self = this;
        this.once('ready', function () { self._write(chunk, encoding, callback); });
        return;
      }
      if (this.destroyed) return;
      if (!this._headersSent) this._proceed();
      if (this._state === 'closed' || this._localEnd || this._session._destroyed) {
        /* The stream closed under the write: the data is dropped, as nghttp2 drops it. */
        callback();
        return;
      }
      this._queuedBytes += chunk.length;
      this._outQueue.push({ kind: 'data', buf: chunk, off: 0, cb: callback });
      this._session._flushStream(this);
    }
    _final(callback) {
      if (this.id === undefined) {
        var self = this;
        this.once('ready', function () { self._final(callback); });
        return;
      }
      this._shutdownWritable(callback);
    }
    /* Node's shutdownWritable(): END_STREAM follows the queued data, or rides on the response HEADERS when none were sent yet. */
    _shutdownWritable(callback) {
      if (this._shutdown) {
        callback();
        return;
      }
      this._shutdown = true;
      if (this._localEnd || this._state === 'closed' || this._session._destroyed || !this._headersSent) {
        callback();
        return;
      }
      this._outQueue.push({ kind: 'end', cb: callback });
      this._session._flushStream(this);
    }
  }

  /* Node's ServerHttp2Stream: respond(), additionalHeaders() and push. */
  class ServerHttp2Stream extends Http2Stream {
    constructor(session, id, headers) {
      super(session, id);
      this._isRemote = true;
      this._wireOpen = true;
      this._protocolName = headers[':scheme'];
      this._authorityName = getAuthority(headers);
    }
    get pushAllowed() {
      return !this.destroyed && !this._closedFlag && !this._session._closing && !this._session._destroyed &&
        this._session._remoteSettings.enablePush === true;
    }
    pushStream(headers, options, callback) {
      if (typeof options === 'function') callback = options;
      var error = this._session._remotePushEnabled() ? h2Error(Error, 'ERR_HTTP2_PUSH_UNSUPPORTED', 'Server push is not implemented by this runtime') : h2Error(Error, 'ERR_HTTP2_PUSH_DISABLED', 'HTTP/2 client has disabled push streams');
      if (typeof callback === 'function') queueMicrotask(function () { callback(error); });
    }
    respond(headersParam, options) {
      if (this.destroyed || this._closedFlag) throw invalidStreamError();
      if (this._headersSent) throw headersSentError();
      assertIsObject(options, 'options');
      var opts = Object.assign({}, options);
      var endStream = !!opts.endStream;
      if (opts.waitForTrailers) this._hasTrailers = true;
      var prepared = prepareResponse(this, headersParam, opts);
      var status = prepared.statusCode;
      this._headersSent = true;
      /*
       * Like Node: 204, 205, 304 and HEAD carry no content, and a writable side that is already shut makes the HEADERS frame end the
       * stream (nghttp2's EMPTY_PAYLOAD); then no trailers are asked for.
       */
      var noPayload = endStream || status === 204 || status === 205 || status === 304 || this._headRequest === true;
      var shut = noPayload || this._shutdown;
      /* A stream the peer already reset (its close is still to be delivered) sends nothing more, as nghttp2 drops it. */
      if (this._state !== 'closed') this._session._writeHeaders(this, prepared.fields, shut);
      if (shut) {
        this._shutdown = true;
        this._markLocalEnd();
      }
      if (noPayload) this.end();
      if (!shut) this._session._flushStream(this);
    }
    /* A 1xx informational response before the final one (RFC 9113 8.1). */
    additionalHeaders(headers) {
      if (this.destroyed || this._closedFlag) throw invalidStreamError();
      if (this._headersSent) throw h2Error(Error, 'ERR_HTTP2_HEADERS_AFTER_RESPOND', 'Cannot specify additional headers after response initiated');
      assertIsObject(headers, 'headers');
      var h = Object.assign(Object.create(null), headers);
      if (h[':status'] !== undefined && h[':status'] !== null) {
        var statusCode = h[':status'] |= 0;
        if (statusCode === 101) throw h2Error(Error, 'ERR_HTTP2_STATUS_101', 'HTTP status code 101 (Switching Protocols) is forbidden in HTTP/2');
        if (statusCode < 100 || statusCode >= 200) throw h2Error(RangeError, 'ERR_HTTP2_INVALID_INFO_STATUS', 'Invalid informational status code: ' + h[':status']);
      }
      var fields = buildFields(h, 'response', this._session._strictSingle);
      this._sentInfoHeaders = (this._sentInfoHeaders || []).concat([h]);
      if (this._state !== 'closed') this._session._writeHeaders(this, fields, false);
    }
    _proceed() {
      if (!this._headersSent && this._state !== 'closed') this.respond();
    }
  }

  function handleHeaderContinue(headers) {
    if (headers[':status'] === 100) this.emit('continue');
  }

  /* Node's ClientHttp2Stream: its HEADERS count as sent from the start; a 100 response raises 'continue'. */
  class ClientHttp2Stream extends Http2Stream {
    constructor(session, id) {
      super(session, id);
      this._headersSent = true;
      this.on('headers', handleHeaderContinue);
    }
  }

  /* ---------- Sessions ---------- */

  function invalidSessionError() {
    return h2Error(Error, 'ERR_HTTP2_INVALID_SESSION', 'The session has been destroyed');
  }

  function noSocketManipulation() {
    return h2Error(Error, 'ERR_HTTP2_NO_SOCKET_MANIPULATION', 'HTTP/2 sockets should not be directly manipulated (e.g. read and written)');
  }

  function socketUnbound() {
    return h2Error(Error, 'ERR_HTTP2_SOCKET_UNBOUND', 'The socket has been disconnected from the Http2Session');
  }

  /* Node's session.socket: a proxy to the socket that refuses direct I/O and disappears with the session. */
  var sessionSocketHandler = {
    get: function (session, prop) {
      switch (prop) {
        case 'setTimeout':
        case 'ref':
        case 'unref':
          return session[prop].bind(session);
        case 'destroy':
        case 'emit':
        case 'end':
        case 'pause':
        case 'read':
        case 'resume':
        case 'write':
        case 'setEncoding':
        case 'setKeepAlive':
        case 'setNoDelay':
          throw noSocketManipulation();
        default: {
          if (!session._socketBound) throw socketUnbound();
          var socket = session._socket;
          var value = socket[prop];
          return typeof value === 'function' ? value.bind(socket) : value;
        }
      }
    },
    getPrototypeOf: function (session) {
      if (!session._socketBound) throw socketUnbound();
      return Object.getPrototypeOf(session._socket);
    },
    set: function (session, prop, value) {
      switch (prop) {
        case 'setTimeout':
        case 'ref':
        case 'unref':
          session[prop] = value;
          return true;
        case 'destroy':
        case 'emit':
        case 'end':
        case 'pause':
        case 'read':
        case 'resume':
        case 'write':
        case 'setEncoding':
        case 'setKeepAlive':
        case 'setNoDelay':
          throw noSocketManipulation();
        default: {
          if (!session._socketBound) throw socketUnbound();
          session._socket[prop] = value;
          return true;
        }
      }
    }
  };

  class Http2Session extends EventEmitter {
    constructor(socket, isServer, options, server, alpn, secure) {
      super();
      var opts = options || {};
      this._socket = socket;
      this._socketBound = true;
      this._proxySocket = null;
      this._isServer = isServer;
      this._server = server || null;
      this._alpn = alpn;
      this._encrypted = !!secure;
      this._frames = new FrameReader();
      this._prefaceLeft = isServer ? PREFACE.length : 0;
      this._expectSettings = true;
      this._localSettings = protocolDefaults();
      this._remoteSettings = protocolDefaults();
      this._encoder = new HpackEncoder(Math.min(this._remoteSettings.headerTableSize, ENCODER_TABLE_LIMIT));
      this._decoder = new HpackDecoder(this._localSettings.headerTableSize);
      this._streams = Object.create(null);
      this._liveStreams = new Set();
      this._pendingStreams = [];
      this._pendingRequests = null;
      /* Streams with callbacks waiting for delivery, and the turn counter that separates nghttp2-style callbacks. */
      this._deferred = new Set();
      this._drainQueue = [];
      this._drainTimer = false;
      this._turn = 0;
      this._eventTurn = -1;
      this._frozen = false;
      this._thawQueue = [];
      this._connErrorPending = false;
      this._destroyAfterFlush = false;
      this._closedIds = new Map();
      this._nextLocalId = isServer ? 2 : 1;
      this._lastLocalId = 0;
      this._lastRemoteId = 0;
      this._lastPromisedId = 0;
      this._goawayLastId = null;
      this._activeLocal = 0;
      this._activeRemote = 0;
      this._announcedMaxConcurrent = 4294967295;
      this._queuedStreams = [];
      this._sendConnWindow = DEFAULT_WINDOW;
      this._recvConnWindow = DEFAULT_WINDOW;
      this._recvConnUnacked = 0;
      this._continuation = null;
      this._out = [];
      this._afterFlush = [];
      this._outScheduled = false;
      this._ready = !!isServer;
      this._settingsAcks = [];
      this._pings = Object.create(null);
      this._goawaySent = false;
      this._goawayReceived = false;
      /* Node's goawayCode (null until a GOAWAY arrives) and destroyCode. */
      this._goawayCode = null;
      this._goawayLastStreamId = 0;
      this._destroyCode = E.NO_ERROR;
      this._terminated = false;
      this._sentFinal = false;
      this._closing = false;
      this._destroyed = false;
      this._closeEmitted = false;
      this._connectSeen = false;
      this._connecting = !isServer;
      this._socketClosed = false;
      this._strictSingle = opts.strictSingleValueFields !== false;
      var pairs = opts.maxHeaderListPairs;
      this._maxHeaderPairs = typeof pairs === 'number' && pairs >= 0 ? Math.max(4, pairs) : DEFAULT_MAX_HEADER_PAIRS;
      validateSettings(opts.settings || {});
      this._announced = copySettings(opts.settings || {});
      var self = this;
      socket.on('data', function (chunk) { self._onData(chunk); });
      socket.on('end', function () { self._onSocketEnd(); });
      socket.on('close', function () { self._onSocketClose(); });
      socket.on('error', function (error) { self._onSocketError(error); });
      if (isServer) {
        this._sendSettings(this._announced, null);
        /* Node's setupHandle: 'connect' on the next tick, for server sessions as well. */
        process.nextTick(function () { self.emit('connect', self, socket); });
      } else {
        this._send(PREFACE);
        this._sendSettings(this._announced, null);
        var connectEvent = secure ? 'secureConnect' : 'connect';
        if (socket.connecting === false && socket.pending === false && !secure) this._onConnected();
        else socket.once(connectEvent, function () { self._onConnected(); });
      }
    }

    get alpnProtocol() {
      return this._alpn;
    }
    get encrypted() {
      return this._encrypted;
    }
    get closed() {
      return this._closing;
    }
    get destroyed() {
      return this._destroyed;
    }
    get connecting() {
      return this._connecting;
    }
    get socket() {
      if (this._proxySocket === null) this._proxySocket = new Proxy(this, sessionSocketHandler);
      return this._proxySocket;
    }
    get type() {
      return this._isServer ? C.NGHTTP2_SESSION_SERVER : C.NGHTTP2_SESSION_CLIENT;
    }
    get goawayCode() {
      return this._goawayCode || E.NO_ERROR;
    }
    get goawayLastStreamID() {
      return this._goawayLastStreamId || 0;
    }
    get localSettings() {
      return publicSettings(this._localSettings);
    }
    get remoteSettings() {
      return publicSettings(this._remoteSettings);
    }
    get pendingSettingsAck() {
      return this._settingsAcks.length > 0;
    }
    get originSet() {
      return undefined;
    }
    get state() {
      if (this._connecting || this._destroyed) return {};
      return {
        effectiveLocalWindowSize: this._recvConnWindow,
        effectiveRecvDataLength: this._recvConnUnacked,
        nextStreamID: this._nextLocalId,
        localWindowSize: this._recvConnWindow,
        lastProcStreamID: this._lastRemoteId,
        remoteWindowSize: this._sendConnWindow,
        outboundQueueSize: this._out.length,
        deflateDynamicTableSize: this._encoder.table.size,
        inflateDynamicTableSize: this._decoder.table.size
      };
    }
    _remotePushEnabled() {
      return this._remoteSettings.enablePush === true;
    }
    /* One macrotask delivers the waiting callbacks of every stream of this session; each such macrotask is a new turn. */
    _queueDrain(stream) {
      this._deferred.add(stream);
      this._drainQueue.push(stream);
      if (this._drainTimer) return;
      this._drainTimer = true;
      var self = this;
      setImmediate(function () {
        self._drainTimer = false;
        self._turn++;
        var list = self._drainQueue;
        self._drainQueue = [];
        for (var i = 0; i < list.length; i++) list[i]._drainInbox();
      });
    }

    /* ----- output: frames written in one turn of the event loop leave in one socket write ----- */

    _send(buf) {
      /* Frames queued while the session is being destroyed (resets, the final GOAWAY) still leave; nothing after that. */
      if (this._sentFinal) return;
      this._out.push(buf);
      if (!this._ready || this._outScheduled) return;
      this._outScheduled = true;
      var self = this;
      queueMicrotask(function () { self._flushOut(); });
    }
    _flushOut() {
      this._outScheduled = false;
      if (!this._ready) return;
      var parts = this._out;
      this._out = [];
      if (parts.length > 0 && !this._socketClosed) {
        try {
          this._socket.write(parts.length === 1 ? parts[0] : Buffer.concat(parts));
        } catch (failure) {
          // The socket is gone; its 'close' tears the session down.
        }
      }
      /* Write callbacks run once their bytes are in the socket, so a caller may reuse its buffer afterwards. */
      var callbacks = this._afterFlush;
      this._afterFlush = [];
      for (var i = 0; i < callbacks.length; i++) callbacks[i]();
    }
    _afterSend(callback) {
      this._afterFlush.push(callback);
      if (this._ready && !this._outScheduled) {
        this._outScheduled = true;
        var self = this;
        queueMicrotask(function () { self._flushOut(); });
      }
    }
    _sendFrame(type, flags, streamId, payload) {
      if (payload && payload.length > 1024) {
        /* Large payloads are not copied into a frame buffer: header and payload leave in the same socket write. */
        var head = frameBuffer(type, flags, streamId, null);
        var len = payload.length;
        head[0] = (len >>> 16) & 0xff;
        head[1] = (len >>> 8) & 0xff;
        head[2] = len & 0xff;
        this._send(head);
        this._send(payload);
        return;
      }
      this._send(frameBuffer(type, flags, streamId, payload));
    }
    _sendSettings(settings, callback) {
      if (settings.maxConcurrentStreams !== undefined) this._announcedMaxConcurrent = settings.maxConcurrentStreams;
      var payload = packSettings(settings);
      this._settingsAcks.push({ callback: callback, settings: copySettings(settings), start: Date.now() });
      this._sendFrame(T.SETTINGS, 0, 0, payload.length > 0 ? payload : null);
    }
    _sendGoaway(code, lastStreamId, debug) {
      this._goawaySent = true;
      var last = lastStreamId & 0x7fffffff;
      this._goawayLastId = this._goawayLastId === null ? last : Math.min(this._goawayLastId, last);
      var parts = [u32Bytes(last), u32Bytes(code)];
      if (debug && debug.length > 0) parts.push(debug);
      this._sendFrame(T.GOAWAY, 0, 0, Buffer.concat(parts));
    }
    /* A field block: HEADERS then CONTINUATION frames, never interleaved with other frames (RFC 9113 6.10). */
    _writeHeaders(stream, fields, endStream) {
      var block = this._encoder.encode(fields);
      var max = this._remoteSettings.maxFrameSize;
      var off = 0;
      var first = true;
      do {
        var n = Math.min(max, block.length - off);
        var last = off + n >= block.length;
        var flags = last ? F.END_HEADERS : 0;
        if (first && endStream) flags |= F.END_STREAM;
        this._sendFrame(first ? T.HEADERS : T.CONTINUATION, flags, stream.id, block.subarray(off, off + n));
        off += n;
        first = false;
      } while (off < block.length);
    }
    _flushStream(stream) {
      if (this._destroyed) return;
      var q = stream._outQueue;
      while (q.length > 0) {
        var item = q[0];
        if (item.kind === 'data') {
          var remaining = item.buf.length - item.off;
          if (remaining === 0) {
            q.shift();
            this._afterSend(item.cb);
            continue;
          }
          if (!stream._canSend()) return;
          var allowed = Math.min(remaining, this._sendConnWindow, stream._sendWindow, this._remoteSettings.maxFrameSize);
          if (allowed <= 0) return;
          var part = item.buf.subarray(item.off, item.off + allowed);
          item.off += allowed;
          stream._queuedBytes -= allowed;
          this._sendConnWindow -= allowed;
          stream._sendWindow -= allowed;
          this._sendFrame(T.DATA, 0, stream.id, part);
        } else if (item.kind === 'end') {
          if (!stream._wireOpen || !stream._headersSent) return;
          q.shift();
          if (!stream._localEnd && stream._hasTrailers && stream._state !== 'closed') {
            /*
             * waitForTrailers: the stream stays open until sendTrailers() or close(). As in Node, trailers are asked for when the
             * session next writes (a macrotask later), and the writable side finishes after 'wantTrailers'.
             */
            var finalCallback = item.cb;
            setImmediate(function () {
              if (!stream.destroyed && !stream._closedFlag) stream._trailersReady = true;
              emitWantTrailers(stream);
              finalCallback();
            });
            continue;
          } else if (stream._canSend()) {
            this._sendFrame(T.DATA, F.END_STREAM, stream.id, null);
            stream._markLocalEnd();
          }
          item.cb();
        } else if (item.kind === 'trailers') {
          if (!stream._canSend()) return;
          q.shift();
          /* Node sends empty trailers as an empty DATA frame with END_STREAM. */
          if (item.fields.length === 0) this._sendFrame(T.DATA, F.END_STREAM, stream.id, null);
          else this._writeHeaders(stream, item.fields, true);
          stream._hasTrailers = false;
          stream._markLocalEnd();
          stream._maybeDestroy();
        } else {
          q.shift();
        }
      }
    }
    _flushAll() {
      var ids = Object.keys(this._streams);
      for (var i = 0; i < ids.length; i++) {
        var s = this._streams[ids[i]];
        if (s !== undefined) this._flushStream(s);
      }
    }
    _grantStreamWindow(stream, n) {
      if (this._destroyed || n <= 0) return;
      stream._recvWindow += n;
      this._sendFrame(T.WINDOW_UPDATE, 0, stream.id, u32Bytes(n));
    }
    _grantConnectionWindow(n) {
      this._recvConnWindow += n;
      this._sendFrame(T.WINDOW_UPDATE, 0, 0, u32Bytes(n));
    }
    /* The protocol side of a reset this side sends: the stream closes now and RST_STREAM goes out if the peer knows the stream. */
    _protocolReset(stream, code) {
      if (stream._state === 'closed') return;
      var onWire = stream._wireOpen;
      stream._state = 'closed';
      stream._dropQueuedWrites();
      this._forgetStream(stream, 'reset-local');
      if (!this._destroyed && onWire) this._sendFrame(T.RST_STREAM, 0, stream.id, u32Bytes(code));
    }
    /* A stream error found in what the peer sent (RFC 9113 5.4.2): RST_STREAM, then Node's onStreamClose(code). */
    _resetStream(stream, code) {
      if (stream._state === 'closed') return;
      this._protocolReset(stream, code);
      stream._runLater(function () { stream._onStreamClose(code); });
    }
    /* RST_STREAM for a stream id: the stream object if it exists, else just the frame. */
    _rstRemoteStream(id, code) {
      var stream = this._streams[id];
      if (stream !== undefined) {
        this._resetStream(stream, code);
      } else if (!this._destroyed) {
        this._rememberClosed(id, 'reset-local');
        this._sendFrame(T.RST_STREAM, 0, id, u32Bytes(code));
      }
    }
    _rememberClosed(id, how) {
      this._closedIds.set(id, how);
      if (this._closedIds.size > CLOSED_MEMORY) {
        var oldest = this._closedIds.keys().next().value;
        this._closedIds.delete(oldest);
      }
    }
    _isLocalId(id) {
      return this._isServer ? id % 2 === 0 : id % 2 === 1;
    }
    _forgetStream(stream, how) {
      if (stream.id !== undefined && this._streams[stream.id] === stream) {
        delete this._streams[stream.id];
        if (stream._counted === true) {
          stream._counted = false;
          if (this._isLocalId(stream.id)) this._activeLocal--;
          else this._activeRemote--;
        }
        this._rememberClosed(stream.id, how);
      }
      var queuedAt = this._queuedStreams.indexOf(stream);
      if (queuedAt >= 0) this._queuedStreams.splice(queuedAt, 1);
      this._startQueuedStreams();
    }
    _removePending(stream) {
      var at = this._pendingStreams.indexOf(stream);
      if (at >= 0) this._pendingStreams.splice(at, 1);
    }
    /* Highest stream id the peer opened (a client's pushed streams are opened by its server), for GOAWAY. */
    _lastPeerId() {
      return this._isServer ? this._lastRemoteId : this._lastPromisedId;
    }
    /* RFC 9113 5.1.1: an id never opened by its initiator is idle. */
    _isIdle(id) {
      if (this._isLocalId(id)) return id >= this._nextLocalId;
      if (this._isServer) return id > this._lastRemoteId;
      return id > this._lastPromisedId;
    }

    /* ----- connection errors and teardown ----- */

    /*
     * A connection error found in what the peer sent (RFC 9113 5.4.1): GOAWAY with the code, then the session closes. Open streams
     * receive the session error only if they listen for 'error' (unchanged from the first version of this module).
     */
    _connError(code, debugText, lastId, error) {
      if (this._destroyed || this._connErrorPending) return;
      if (this._deferAfterEvents()) {
        /* A header event of this read is still to be delivered: its handlers run (and may answer) before the connection ends. */
        this._connErrorPending = true;
        var self = this;
        this._afterEvents(function () {
          self._connErrorPending = false;
          self._connError(code, debugText, lastId, error);
        }, false);
        return;
      }
      var debug = debugText ? Buffer.from(debugText, 'latin1') : EMPTY;
      var last = lastId === undefined ? this._lastPeerId() : lastId;
      this._sendGoaway(code, last, debug);
      this._terminated = true;
      this._closeSession(code, error || sessionError(code), false, true);
    }
    /* Socket events wait while frames already read are held back (_afterEvents), so those frames are processed first. */
    _whenThawed(fn) {
      if (this._frozen) this._thawQueue.push(fn);
      else fn();
    }
    _onSocketEnd() {
      /* The peer will send nothing more: finish this side as well (an HTTP/2 connection is never half-open). */
      var self = this;
      this._whenThawed(function () {
        self._turn++;
        self._onPeerGone();
      });
    }
    _onSocketClose() {
      this._socketClosed = true;
      var self = this;
      this._whenThawed(function () {
        self._turn++;
        self._onPeerGone();
        self._emitClose();
      });
    }
    /* Node's socketOnClose: every stream closes with CANCEL, then the session closes and is destroyed. */
    _onPeerGone() {
      if (this._destroyed) return;
      var err = this._connecting ? h2Error(Error, 'ERR_SOCKET_CLOSED', 'Socket is closed') : undefined;
      Array.from(this._liveStreams).forEach(function (s) {
        s._run(function () {
          if (!s.destroyed && !s._closedFlag) s._closeStream(E.CANCEL, RST_NONE);
        }, true);
      });
      this._closing = true;
      this._closeSession(E.NO_ERROR, err, false, false);
    }
    /* Node's socketOnError: ECONNRESET after a GOAWAY is ordinary; any other socket error destroys the session with it. */
    _onSocketError(error) {
      var self = this;
      this._whenThawed(function () {
        if (self._destroyed) return;
        self._turn++;
        if (error && error.code === 'ECONNRESET' && self._goawayCode !== null) self._closeSession(E.NO_ERROR, undefined, false, false);
        else self._closeSession(E.INTERNAL_ERROR, error, false, false);
      });
    }
    /*
     * Node's closeSession(): pending client streams end with ERR_HTTP2_STREAM_CANCEL and open streams with the session's error;
     * a GOAWAY ends the connection unless one already did (nghttp2_session_terminate_session); then the socket ends. immediate:
     * the application asked for it, so streams drop what is still waiting for delivery; otherwise that is delivered first.
     */
    _closeSession(code, error, immediate, lenientStreams) {
      if (this._destroyed) return;
      this._destroyed = true;
      this._destroyCode = code;
      this._pendingError = error;
      var pending = this._pendingStreams.slice();
      var live = [];
      this._liveStreams.forEach(function (s) { if (s.id !== undefined) live.push(s); });
      if (pending.length > 0 || live.length > 0) {
        var cancel = h2Error(Error, 'ERR_HTTP2_STREAM_CANCEL', error && error.message ? 'The pending stream has been canceled (caused by: ' + error.message + ')' : 'The pending stream has been canceled');
        pending.forEach(function (s) { s.destroy(cancel); });
        live.forEach(function (s) {
          var destroyIt = function () {
            if (s.destroyed) return;
            if (lenientStreams && s.listeners('error').length === 0) {
              /* As when Node's socket closes under a terminated session: the stream ends with CANCEL, which is not an error. */
              if (!s._closedFlag) s._closeStream(E.CANCEL, RST_NONE);
              s.destroy();
              return;
            }
            s.destroy(error);
          };
          if (immediate) {
            s._dropInbox();
            destroyIt();
          } else {
            s._run(destroyIt, true);
          }
        });
      }
      this._queuedStreams = [];
      var pings = this._pings;
      this._pings = Object.create(null);
      Object.keys(pings).forEach(function (key) {
        var waiting = pings[key];
        queueMicrotask(function () { waiting.callback(false, 0, waiting.payload); });
      });
      if (!this._terminated && this._ready && !this._socketClosed && !this._socket.destroyed) {
        this._terminated = true;
        this._sendGoaway(code, this._lastPeerId(), EMPTY);
      }
      if (this._ready) this._flushOut();
      this._sentFinal = true;
      if (this._isServer && this._server !== null && this._server._sessions) this._server._sessions.delete(this);
      this._socketBound = false;
      var socket = this._socket;
      var self = this;
      if (this._socketClosed || socket.destroyed) {
        setImmediate(function () { self._emitClose(); });
        return;
      }
      try {
        socket.end();
      } catch (failure) {
        // already gone
      }
      if (this._closing) {
        /* Graceful: as Node does, the peer's close is awaited; a peer that never closes is cut off after a bounded wait. */
        var timer = setTimeout(function () { if (!socket.destroyed) socket.destroy(); }, 1000);
        if (timer && typeof timer.unref === 'function') timer.unref();
      } else {
        setImmediate(function () { if (!socket.destroyed) socket.destroy(); });
      }
    }
    /* Node's emitClose(): 'error' (when destroyed with one) then 'close', after the streams' own callbacks. */
    _emitClose() {
      if (this._closeEmitted || !this._destroyed) return;
      if (this._deferred.size > 0) {
        var self = this;
        setImmediate(function () { self._emitClose(); });
        return;
      }
      this._closeEmitted = true;
      var error = this._pendingError;
      if (error !== undefined && error !== null) this.emit('error', error);
      this.emit('close');
    }
    /*
     * Node's kMaybeDestroy: a closed session with no open or pending streams is destroyed, once what it queued (its GOAWAY) has
     * been written (Node's hasPendingData and graceful-close completion); frames already read are still processed meanwhile.
     */
    _maybeDestroySession() {
      if (this._destroyed || !this._closing) return;
      if (this._liveStreams.size > 0 || this._pendingStreams.length > 0 || this._queuedStreams.length > 0) return;
      if (this._ready && !this._socketClosed && (this._out.length > 0 || this._outScheduled)) {
        if (!this._destroyAfterFlush) {
          this._destroyAfterFlush = true;
          var self = this;
          this._afterSend(function () {
            self._destroyAfterFlush = false;
            self._maybeDestroySession();
          });
        }
        return;
      }
      this._closeSession(E.NO_ERROR, undefined, true, false);
    }
    _onConnected() {
      if (this._connectSeen || this._destroyed) return;
      this._connectSeen = true;
      this._connecting = false;
      this._ready = true;
      if (this._encrypted) this._alpn = this._socket.alpnProtocol;
      this._flushOut();
      /* Node's setupHandle: 'connect' on the next tick. */
      var self = this;
      process.nextTick(function () { self.emit('connect', self, self._socket); });
    }

    /* ----- input ----- */

    /* True while a header event queued in this turn is undelivered: Node would drain it before its next callback. */
    _deferAfterEvents() {
      return this._eventTurn === this._turn;
    }
    /* Stops reading frames until fn has run in a later macrotask; with resume, what was read meanwhile is processed after it. */
    _afterEvents(fn, resume) {
      this._frozen = true;
      var self = this;
      setImmediate(function () {
        self._turn++;
        self._frozen = false;
        fn();
        if (resume) self._processFrames();
        if (self._frozen) return;
        var queued = self._thawQueue;
        self._thawQueue = [];
        for (var i = 0; i < queued.length; i++) queued[i]();
      });
    }
    _onData(chunk) {
      if (this._destroyed) return;
      this._turn++;
      this._frames.push(chunk);
      this._processFrames();
    }
    _processFrames() {
      if (this._destroyed || this._frozen) return;
      if (this._prefaceLeft > 0) {
        var have = this._frames.buf.length;
        var compare = Math.min(have, PREFACE.length);
        for (var i = 0; i < compare; i++) {
          if (this._frames.buf[i] !== PREFACE[i]) {
            this._connError(E.PROTOCOL_ERROR, 'invalid connection preface');
            return;
          }
        }
        if (have < PREFACE.length) return;
        this._frames.drop(PREFACE.length);
        this._prefaceLeft = 0;
      }
      for (;;) {
        if (this._destroyed || this._frozen) return;
        var f = this._frames.next(this._localSettings.maxFrameSize);
        if (f === null) return;
        if (f.tooLarge === true) {
          this._connError(E.FRAME_SIZE_ERROR, 'too large frame size');
          return;
        }
        this._onFrame(f);
      }
    }
    _onFrame(f) {
      if (this._expectSettings) {
        /* RFC 9113 3.4: the peer's preface ends with a SETTINGS frame that is not an acknowledgement. */
        if (f.type !== T.SETTINGS || (f.flags & F.ACK) !== 0) {
          this._connError(E.PROTOCOL_ERROR, 'invalid connection preface');
          return;
        }
        this._expectSettings = false;
      }
      if (this._continuation !== null && (f.type !== T.CONTINUATION || f.stream !== this._continuation.stream)) {
        this._connError(E.PROTOCOL_ERROR, 'CONTINUATION expected');
        return;
      }
      switch (f.type) {
        case T.DATA: this._onDataFrame(f); break;
        case T.HEADERS: this._onHeadersFrame(f); break;
        case T.PRIORITY: this._onPriorityFrame(f); break;
        case T.RST_STREAM: this._onRstFrame(f); break;
        case T.SETTINGS: this._onSettingsFrame(f); break;
        case T.PUSH_PROMISE: this._onPushPromiseFrame(f); break;
        case T.PING: this._onPingFrame(f); break;
        case T.GOAWAY: this._onGoawayFrame(f); break;
        case T.WINDOW_UPDATE: this._onWindowUpdateFrame(f); break;
        case T.CONTINUATION: this._onContinuationFrame(f); break;
        default: break; /* RFC 9113 5.5: unknown frame types are ignored. */
      }
    }
    /* Returns the payload span without padding, or an error code (RFC 9113 6.1 and 6.2). */
    _stripPadding(f) {
      var start = 0;
      var end = f.payload.length;
      if ((f.flags & F.PADDED) !== 0) {
        if (end < 1) return { error: E.FRAME_SIZE_ERROR };
        var pad = f.payload[0];
        start = 1;
        if (pad >= end) return { error: E.PROTOCOL_ERROR };
        end -= pad;
      }
      return { start: start, end: end };
    }
    _onDataFrame(f) {
      if (f.stream === 0) return this._connError(E.PROTOCOL_ERROR, 'DATA: stream 0');
      var span = this._stripPadding(f);
      if (span.error !== undefined) return this._connError(span.error, 'DATA: invalid padding');
      /* The whole payload, padding included, counts against the connection window (RFC 9113 6.9.1). */
      this._recvConnWindow -= f.length;
      if (this._recvConnWindow < 0) return this._connError(E.FLOW_CONTROL_ERROR, 'DATA: connection window exceeded');
      this._recvConnUnacked += f.length;
      if (this._recvConnUnacked >= 16384) {
        var grant = this._recvConnUnacked;
        this._recvConnUnacked = 0;
        this._grantConnectionWindow(grant);
      }
      var stream = this._streams[f.stream];
      if (stream === undefined) {
        if (this._isIdle(f.stream)) return this._connError(E.PROTOCOL_ERROR, 'DATA: stream in idle');
        return this._onFrameForClosedStream(f.stream, 'DATA');
      }
      if (stream._remoteEnd) return this._rstRemoteStream(f.stream, E.STREAM_CLOSED);
      if (!stream._gotHeaders) return this._rstRemoteStream(f.stream, E.PROTOCOL_ERROR);
      stream._recvWindow -= f.length;
      if (stream._recvWindow < 0) return this._rstRemoteStream(f.stream, E.FLOW_CONTROL_ERROR);
      var dataLen = span.end - span.start;
      var padding = f.length - dataLen;
      if (padding > 0) this._grantStreamWindow(stream, padding);
      /* RFC 9113 8.1.1: DATA beyond content-length makes the message malformed. */
      stream._receivedLength += dataLen;
      if (stream._expectedLength >= 0 && stream._receivedLength > stream._expectedLength) return this._rstRemoteStream(f.stream, E.PROTOCOL_ERROR);
      var endStream = (f.flags & F.END_STREAM) !== 0;
      if (endStream && stream._expectedLength >= 0 && stream._receivedLength !== stream._expectedLength) return this._rstRemoteStream(f.stream, E.PROTOCOL_ERROR);
      if (dataLen > 0) {
        var chunk = f.payload.subarray(span.start, span.end);
        stream._run(function () { if (!stream.destroyed) stream._onDataChunk(chunk); });
      }
      if (endStream) {
        /* Node's onStreamRead(UV_EOF): the end of the readable side; 'end' comes on a tick, before any later callback. */
        stream._run(function () {
          if (stream.destroyed) return;
          stream.push(null);
          stream.read(0);
          stream._hold();
        }, true);
        stream._onRemoteEnd();
      }
      return undefined;
    }
    /*
     * A frame for a stream that no longer exists (RFC 9113 5.1, "closed"): ignored after this side reset it,
     * a stream error after the peer reset it, a connection error after the peer ended it.
     */
    _onFrameForClosedStream(id, what) {
      var how = this._closedIds.get(id);
      if (how === 'reset-remote') {
        if (!this._destroyed) this._sendFrame(T.RST_STREAM, 0, id, u32Bytes(E.STREAM_CLOSED));
        return undefined;
      }
      if (how === 'closed') return this._connError(E.STREAM_CLOSED, what + ': stream closed');
      return undefined;
    }
    _onHeadersFrame(f) {
      if (f.stream === 0) return this._connError(E.PROTOCOL_ERROR, 'HEADERS: stream 0');
      var span = this._stripPadding(f);
      if (span.error !== undefined) return this._connError(span.error, 'HEADERS: invalid padding');
      var start = span.start;
      if ((f.flags & F.PRIORITY) !== 0) {
        /* RFC 9113 5.3.2: the RFC 7540 priority fields are deprecated; they are skipped and ignored. */
        if (span.end - start < 5) return this._connError(E.FRAME_SIZE_ERROR, 'HEADERS: priority fields truncated');
        start += 5;
      }
      var block = f.payload.subarray(start, span.end);
      /* The flags Node reports with the header event: the HEADERS frame's own, with END_HEADERS once the block is complete. */
      var pending = { kind: 'headers', stream: f.stream, endStream: (f.flags & F.END_STREAM) !== 0, flags: f.flags | F.END_HEADERS, continuations: 0 };
      if ((f.flags & F.END_HEADERS) !== 0) return this._finishBlock(pending, block);
      pending.parts = [Buffer.from(block)];
      pending.size = block.length;
      this._continuation = pending;
      return undefined;
    }
    _onContinuationFrame(f) {
      var c = this._continuation;
      if (c === null || f.stream !== c.stream) return this._connError(E.PROTOCOL_ERROR, 'CONTINUATION: unexpected');
      var newStream = this._isServer && c.kind === 'headers' && c.stream % 2 === 1 && c.stream > this._lastRemoteId;
      var lastId = newStream ? c.stream : undefined;
      /* nghttp2 (as Node uses it) allows 8 CONTINUATION frames per field block; more ends the connection with INTERNAL_ERROR. */
      c.continuations++;
      if (c.continuations > MAX_CONTINUATIONS) {
        /* The session error Node reports: an NghttpError for NGHTTP2_ERR_TOO_MANY_CONTINUATIONS. */
        var flood = h2Error(Error, 'ERR_HTTP2_ERROR', 'Too many CONTINUATION frames following a HEADER frame');
        flood.errno = -905;
        return this._connError(E.INTERNAL_ERROR, '', lastId, flood);
      }
      c.parts.push(Buffer.from(f.payload));
      c.size += f.length;
      if (c.size > MAX_HEADER_BLOCK) return this._connError(E.ENHANCE_YOUR_CALM, 'CONTINUATION: header block too large', lastId);
      if ((f.flags & F.END_HEADERS) !== 0) {
        this._continuation = null;
        return this._finishBlock(c, Buffer.concat(c.parts));
      }
      return undefined;
    }
    /* Every field block is decoded, even for a stream about to be refused, so HPACK state stays in step. */
    _finishBlock(pending, block) {
      var fields;
      var newStream = this._isServer && pending.kind === 'headers' && pending.stream % 2 === 1 && pending.stream > this._lastRemoteId;
      try {
        fields = this._decoder.decode(block);
      } catch (failure) {
        if (failure.h2Code !== undefined) {
          return this._connError(failure.h2Code, failure.message, newStream ? pending.stream : this._lastRemoteId);
        }
        throw failure;
      }
      /* Node's maxHeaderListPairs: a block with more fields is refused with RST_STREAM ENHANCE_YOUR_CALM. */
      if (fields.length > this._maxHeaderPairs) {
        var target = pending.kind === 'push' ? pending.promised : pending.stream;
        if (newStream) this._lastRemoteId = pending.stream;
        return this._rstRemoteStream(target, E.ENHANCE_YOUR_CALM);
      }
      if (pending.kind === 'push') return this._onPushedFields(pending, fields);
      return this._onHeaderFields(pending, fields);
    }
    _onHeaderFields(pending, fields) {
      var id = pending.stream;
      var stream = this._streams[id];
      if (stream === undefined) {
        if (this._isServer && id % 2 === 1 && id > this._lastRemoteId) return this._openRemoteStream(id, fields, pending);
        if (this._isIdle(id)) return this._connError(E.PROTOCOL_ERROR, 'HEADERS: invalid stream identifier');
        if (this._isServer && !this._closedIds.has(id)) return this._connError(E.PROTOCOL_ERROR, 'HEADERS: invalid stream identifier');
        return this._onFrameForClosedStream(id, 'HEADERS');
      }
      if (stream._remoteEnd) return this._rstRemoteStream(id, E.STREAM_CLOSED);
      if (!stream._gotHeaders) {
        /* Client side: a response, possibly preceded by 1xx informational responses (RFC 9113 8.1). */
        var respError = responseFieldsError(fields);
        if (respError !== 0) return this._rstRemoteStream(id, respError);
        var headers = fieldsToHeaders(fields);
        var status = headers[':status'];
        if (status >= 100 && status < 200) {
          if (status === 101 || pending.endStream) return this._rstRemoteStream(id, E.PROTOCOL_ERROR);
          this._deliverHeaders(stream, 'headers', headers, pending.flags, rawHeadersOf(fields), false);
          return undefined;
        }
        stream._gotHeaders = true;
        /* A pushed stream's response raises 'push' on that stream, as in Node; any other raises 'response'. */
        var pushed = stream._state === 'reserved-remote';
        if (pushed) stream._state = 'half-closed-local';
        if (stream._requestMethod !== 'HEAD' && status !== 204 && status !== 304) {
          var cl = contentLengthOf(fields);
          if (cl === -2) return this._rstRemoteStream(id, E.PROTOCOL_ERROR);
          stream._expectedLength = cl;
          if (pending.endStream && cl > 0) return this._rstRemoteStream(id, E.PROTOCOL_ERROR);
        }
        this._deliverHeaders(stream, pushed ? 'push' : 'response', headers, pending.flags, rawHeadersOf(fields), pending.endStream);
        if (pending.endStream) stream._onRemoteEnd();
        return undefined;
      }
      /* A second field block is a trailer section and must end the stream (RFC 9113 8.1). */
      if (!pending.endStream) return this._rstRemoteStream(id, E.PROTOCOL_ERROR);
      var trailerError = trailerFieldsError(fields);
      if (trailerError !== 0) return this._rstRemoteStream(id, trailerError);
      if (stream._expectedLength >= 0 && stream._receivedLength !== stream._expectedLength) return this._rstRemoteStream(id, E.PROTOCOL_ERROR);
      stream._gotTrailers = true;
      this._deliverHeaders(stream, 'trailers', fieldsToHeaders(fields), pending.flags, rawHeadersOf(fields), true);
      stream._onRemoteEnd();
      return undefined;
    }
    /* Node's onSessionHeaders for an existing stream: the event on the next tick, the end of the readable side now. */
    _deliverHeaders(stream, event, headers, flags, raw, endStream) {
      stream._run(function () {
        process.nextTick(function () { stream.emit(event, headers, flags, raw); });
        if (endStream) stream.push(null);
        stream._hold();
      }, true);
    }
    _openRemoteStream(id, fields, pending) {
      this._lastRemoteId = id;
      /* RFC 9113 6.8: streams above the last id announced in a GOAWAY are ignored. */
      if (this._goawayLastId !== null && id > this._goawayLastId) {
        this._rememberClosed(id, 'reset-local');
        return undefined;
      }
      var reqError = requestFieldsError(fields);
      if (reqError !== 0) return this._rstRemoteStream(id, reqError);
      /* As nghttp2 does, the announced limit refuses streams (REFUSED_STREAM) even before the peer acknowledged it. */
      if (this._activeRemote >= Math.min(this._localSettings.maxConcurrentStreams, this._announcedMaxConcurrent)) return this._rstRemoteStream(id, E.REFUSED_STREAM);
      var cl = contentLengthOf(fields);
      if (cl === -2 || (pending.endStream && cl > 0)) return this._rstRemoteStream(id, E.PROTOCOL_ERROR);
      var headers = fieldsToHeaders(fields);
      var stream = new ServerHttp2Stream(this, id, headers);
      stream._state = 'open';
      stream._gotHeaders = true;
      stream._counted = true;
      stream._expectedLength = cl;
      this._activeRemote++;
      this._streams[id] = stream;
      stream._requestMethod = headers[':method'];
      var flags = pending.flags;
      var raw = rawHeadersOf(fields);
      /* Node's onSessionHeaders for a new stream: end of the readable side, HEAD shuts the writable side, 'stream' next tick. */
      if (pending.endStream) stream.push(null);
      if (headers[':method'] === 'HEAD') {
        stream.end();
        stream._headRequest = true;
      }
      if (pending.endStream) stream._endAfterHeaders = true;
      var session = this;
      process.nextTick(function () { session.emit('stream', stream, headers, flags, raw); });
      stream._hold();
      if (pending.endStream) stream._onRemoteEnd();
      return undefined;
    }
    _onPushPromiseFrame(f) {
      if (this._isServer) return this._connError(E.PROTOCOL_ERROR, 'PUSH_PROMISE: from client');
      if (this._localSettings.enablePush !== true) return this._connError(E.PROTOCOL_ERROR, 'PUSH_PROMISE: push disabled');
      if (f.stream === 0) return this._connError(E.PROTOCOL_ERROR, 'PUSH_PROMISE: stream 0');
      var span = this._stripPadding(f);
      if (span.error !== undefined) return this._connError(span.error, 'PUSH_PROMISE: invalid padding');
      if (span.end - span.start < 4) return this._connError(E.FRAME_SIZE_ERROR, 'PUSH_PROMISE: truncated');
      var promised = readU32(f.payload, span.start) & 0x7fffffff;
      var block = f.payload.subarray(span.start + 4, span.end);
      if (promised === 0 || promised % 2 === 1 || promised <= this._lastPromisedId) return this._connError(E.PROTOCOL_ERROR, 'PUSH_PROMISE: invalid promised stream');
      this._lastPromisedId = promised;
      var pending = { kind: 'push', stream: f.stream, promised: promised, endStream: false, flags: f.flags | F.END_HEADERS, continuations: 0 };
      if ((f.flags & F.END_HEADERS) !== 0) return this._finishBlock(pending, block);
      pending.parts = [Buffer.from(block)];
      pending.size = block.length;
      this._continuation = pending;
      return undefined;
    }
    _onPushedFields(pending, fields) {
      var parent = this._streams[pending.stream];
      var reqError = requestFieldsError(fields);
      if (reqError !== 0 || parent === undefined) {
        this._rememberClosed(pending.promised, 'reset-local');
        this._sendFrame(T.RST_STREAM, 0, pending.promised, u32Bytes(reqError !== 0 ? reqError : E.CANCEL));
        return undefined;
      }
      var stream = new ClientHttp2Stream(this, pending.promised);
      stream._wireOpen = true;
      stream._state = 'reserved-remote';
      /* The client never sends on a pushed stream: its writable side is closed from the start, as Node does. */
      stream._localEnd = true;
      this._streams[pending.promised] = stream;
      stream.end();
      if (this.listeners('stream').length === 0) {
        /* Nobody takes pushed streams: refuse it as Node does. */
        this._resetStream(stream, E.CANCEL);
        return undefined;
      }
      var requestHeaders = fieldsToHeaders(fields);
      var flags = pending.flags;
      var raw = rawHeadersOf(fields);
      var session = this;
      process.nextTick(function () { session.emit('stream', stream, requestHeaders, flags, raw); });
      stream._hold();
      return undefined;
    }
    _onRstFrame(f) {
      if (f.stream === 0) return this._connError(E.PROTOCOL_ERROR, 'RST_STREAM: stream 0');
      if (f.length !== 4) return this._connError(E.FRAME_SIZE_ERROR, 'RST_STREAM: bad length');
      var code = readU32(f.payload, 0);
      var stream = this._streams[f.stream];
      if (stream === undefined) {
        if (this._isIdle(f.stream)) return this._connError(E.PROTOCOL_ERROR, 'RST_STREAM: stream in idle');
        return undefined;
      }
      /* The peer reset the stream: it closes now; Node's onStreamClose(code) is the callback the application sees. */
      stream._state = 'closed';
      stream._dropQueuedWrites();
      this._forgetStream(stream, 'reset-remote');
      stream._run(function () { stream._onStreamClose(code); }, true);
      return undefined;
    }
    /* PRIORITY (RFC 9113 6.3, deprecated by 5.3.2) is accepted and ignored in any stream state; only its framing is checked. */
    _onPriorityFrame(f) {
      if (f.stream === 0) return this._connError(E.PROTOCOL_ERROR, 'PRIORITY: stream 0');
      if (f.length !== 5) return this._rstRemoteStream(f.stream, E.FRAME_SIZE_ERROR);
      return undefined;
    }
    _onSettingsFrame(f) {
      if (f.stream !== 0) return this._connError(E.PROTOCOL_ERROR, 'SETTINGS: stream not 0');
      if ((f.flags & F.ACK) !== 0) {
        if (f.length !== 0) return this._connError(E.FRAME_SIZE_ERROR, 'SETTINGS: ACK with payload');
        var pending = this._settingsAcks.shift();
        if (pending !== undefined) {
          this._applyLocalSettings(pending.settings);
          var ackView = publicSettings(this._localSettings);
          /* Node's settingsCallback: the callback, then 'localSettings'. */
          if (typeof pending.callback === 'function') pending.callback(null, ackView, Date.now() - pending.start);
          this.emit('localSettings', ackView);
        }
        return undefined;
      }
      if (f.length % 6 !== 0) return this._connError(E.FRAME_SIZE_ERROR, 'SETTINGS: bad length');
      var fresh = {};
      var p = f.payload;
      for (var i = 0; i < f.length; i += 6) {
        var id = (p[i] << 8) | p[i + 1];
        var v = readU32(p, i + 2);
        var entry = null;
        for (var k = 0; k < SETTING_ORDER.length; k++) if (SETTING_ORDER[k].id === id) entry = SETTING_ORDER[k];
        if (entry === null) continue; /* RFC 9113 6.5.2: unknown settings are ignored. */
        if (entry.key === 'enablePush' || entry.key === 'enableConnectProtocol') {
          if (v !== 0 && v !== 1) return this._connError(E.PROTOCOL_ERROR, 'SETTINGS: invalid boolean');
          if (entry.key === 'enablePush' && v === 1 && !this._isServer) return this._connError(E.PROTOCOL_ERROR, 'SETTINGS: server enabled push');
          fresh[entry.key] = v === 1;
        } else if (entry.key === 'initialWindowSize') {
          if (v > MAX_WINDOW) return this._connError(E.FLOW_CONTROL_ERROR, 'SETTINGS: invalid initial window size');
          fresh[entry.key] = v;
        } else if (entry.key === 'maxFrameSize') {
          if (v < DEFAULT_FRAME || v > 16777215) return this._connError(E.PROTOCOL_ERROR, 'SETTINGS: invalid max frame size');
          fresh[entry.key] = v;
        } else {
          fresh[entry.key] = v;
        }
      }
      if (this._applyRemoteSettings(fresh) === false) return undefined;
      this._sendFrame(T.SETTINGS, F.ACK, 0, null);
      this.emit('remoteSettings', publicSettings(this._remoteSettings));
      this._flushAll();
      this._startQueuedStreams();
      return undefined;
    }
    _applyRemoteSettings(fresh) {
      var keys = Object.keys(fresh);
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (key === 'headerTableSize') {
          /* The encoder may use less than the peer allows; like nghttp2 it stays at 4096 at most. */
          this._encoder.setMaxTableSize(Math.min(fresh[key], ENCODER_TABLE_LIMIT));
        } else if (key === 'initialWindowSize') {
          /* RFC 9113 6.9.2: the change applies to every open stream; overflowing one is a connection error. */
          var delta = fresh[key] - this._remoteSettings.initialWindowSize;
          var ids = Object.keys(this._streams);
          for (var s = 0; s < ids.length; s++) {
            var st = this._streams[ids[s]];
            st._sendWindow += delta;
            if (st._sendWindow > MAX_WINDOW) {
              this._connError(E.FLOW_CONTROL_ERROR, 'SETTINGS: window overflow');
              return false;
            }
          }
        }
        this._remoteSettings[key] = fresh[key];
      }
      return true;
    }
    _applyLocalSettings(settings) {
      var keys = Object.keys(settings);
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var value = BOOLEAN_SETTINGS[key] === true ? !!settings[key] : Number(settings[key]);
        if (key === 'headerTableSize') {
          this._decoder.maxAllowed = value;
          this._decoder.table.setMaxSize(Math.min(this._decoder.table.maxSize, value));
        } else if (key === 'initialWindowSize') {
          var delta = value - this._localSettings.initialWindowSize;
          var ids = Object.keys(this._streams);
          for (var s = 0; s < ids.length; s++) this._streams[ids[s]]._recvWindow += delta;
        }
        this._localSettings[key] = value;
      }
    }
    _onPingFrame(f) {
      if (f.stream !== 0) return this._connError(E.PROTOCOL_ERROR, 'PING: stream not 0');
      if (f.length !== 8) return this._connError(E.FRAME_SIZE_ERROR, 'PING: bad length');
      var payload = Buffer.from(f.payload);
      if ((f.flags & F.ACK) !== 0) {
        var key = payload.toString('hex');
        var waiting = this._pings[key];
        if (waiting !== undefined) {
          delete this._pings[key];
          waiting.callback(true, Date.now() - waiting.start, payload);
        }
        return undefined;
      }
      this._sendFrame(T.PING, F.ACK, 0, payload);
      this.emit('ping', payload);
      return undefined;
    }
    _onGoawayFrame(f) {
      if (f.stream !== 0) return this._connError(E.PROTOCOL_ERROR, 'GOAWAY: stream not 0');
      if (f.length < 8) return this._connError(E.FRAME_SIZE_ERROR, 'GOAWAY: bad length');
      var lastId = readU32(f.payload, 0) & 0x7fffffff;
      var code = readU32(f.payload, 4);
      var debug = f.length > 8 ? Buffer.from(f.payload.subarray(8)) : undefined;
      if (this._deferAfterEvents()) {
        /* The header events of this read are delivered (and answered) before the GOAWAY takes effect, as Node orders them. */
        var self = this;
        this._afterEvents(function () { if (!self._destroyed) self._applyGoaway(lastId, code, debug); }, true);
        return undefined;
      }
      return this._applyGoaway(lastId, code, debug);
    }
    _applyGoaway(lastId, code, debug) {
      this._goawayReceived = true;
      this._goawayCode = code;
      this._goawayLastStreamId = lastId;
      this.emit('goaway', code, lastId, debug);
      if (this._destroyed) return undefined;
      if (code !== E.NO_ERROR) {
        /* As Node does: the session is destroyed with ERR_HTTP2_SESSION_ERROR (GOAWAY NO_ERROR in reply), which its streams receive. */
        this._closeSession(E.NO_ERROR, sessionError(code), false, false);
        return undefined;
      }
      this.close();
      /* Then, as nghttp2 does, streams this side opened above lastId were never processed: they close with REFUSED_STREAM (RFC 9113 6.8). */
      var ids = Object.keys(this._streams);
      for (var i = 0; i < ids.length; i++) {
        var id = Number(ids[i]);
        var s = this._streams[ids[i]];
        if (s !== undefined && id > lastId && this._isLocalId(id)) {
          s._state = 'closed';
          s._dropQueuedWrites();
          this._forgetStream(s, 'reset-remote');
          (function (refused) {
            refused._run(function () { refused._onStreamClose(E.REFUSED_STREAM); }, true);
          })(s);
        }
      }
      return undefined;
    }
    _onWindowUpdateFrame(f) {
      if (f.length !== 4) return this._connError(E.FRAME_SIZE_ERROR, 'WINDOW_UPDATE: bad length');
      var inc = readU32(f.payload, 0) & 0x7fffffff;
      if (f.stream === 0) {
        if (inc === 0) return this._connError(E.PROTOCOL_ERROR, 'WINDOW_UPDATE: increment 0');
        this._sendConnWindow += inc;
        if (this._sendConnWindow > MAX_WINDOW) return this._connError(E.FLOW_CONTROL_ERROR, 'WINDOW_UPDATE: window overflow');
        this._flushAll();
        return undefined;
      }
      var stream = this._streams[f.stream];
      if (stream === undefined) {
        if (this._isIdle(f.stream)) return this._connError(E.PROTOCOL_ERROR, 'WINDOW_UPDATE: stream in idle');
        return undefined;
      }
      if (inc === 0) return this._rstRemoteStream(f.stream, E.PROTOCOL_ERROR);
      stream._sendWindow += inc;
      if (stream._sendWindow > MAX_WINDOW) return this._rstRemoteStream(f.stream, E.FLOW_CONTROL_ERROR);
      this._flushStream(stream);
      return undefined;
    }

    /* ----- client streams and the peer's concurrency limit ----- */

    _startQueuedStreams() {
      while (this._queuedStreams.length > 0 && !this._destroyed && this._activeLocal < this._remoteSettings.maxConcurrentStreams) {
        var stream = this._queuedStreams.shift();
        if (stream.destroyed || stream._state === 'closed') continue;
        this._startStream(stream);
      }
    }
    /* The HEADERS frame goes out; it ends the stream only when request() said so (endStream, as nghttp2's EMPTY_PAYLOAD). */
    _startStream(stream) {
      stream._counted = true;
      this._activeLocal++;
      stream._wireOpen = true;
      var endStream = stream._endWithHeaders === true;
      this._writeHeaders(stream, stream._pendingFields, endStream);
      stream._pendingFields = null;
      if (endStream) stream._markLocalEnd();
      this._flushStream(stream);
    }

    /* ----- public API ----- */

    /* If ping is called while connecting or after close(), the callback gets ERR_HTTP2_PING_CANCEL (Node). */
    ping(payload, callback) {
      if (this._destroyed) throw invalidSessionError();
      if (typeof payload === 'function') {
        callback = payload;
        payload = undefined;
      }
      if (payload) {
        validateBuffer(payload, 'payload');
        if (payload.byteLength !== 8) throw h2Error(RangeError, 'ERR_HTTP2_PING_LENGTH', 'HTTP2 ping payload must be 8 bytes');
      }
      validateFunction(callback, 'callback');
      var cb = function (ack, duration, data) {
        if (ack) callback(null, duration, data);
        else callback(h2Error(Error, 'ERR_HTTP2_PING_CANCEL', 'HTTP2 ping cancelled'));
      };
      if (this._connecting || this._closing) {
        process.nextTick(cb, false, 0.0, payload);
        return undefined;
      }
      var data = payload ? Buffer.from(bytesOf(payload)) : randomBytes8();
      this._pings[data.toString('hex')] = { callback: cb, start: Date.now(), payload: data };
      this._sendFrame(T.PING, 0, 0, data);
      return true;
    }
    settings(settings, callback) {
      if (this._destroyed) throw invalidSessionError();
      assertIsObject(settings, 'settings');
      validateSettings(settings || {});
      if (callback) validateFunction(callback, 'callback');
      this._sendSettings(copySettings(settings || {}), typeof callback === 'function' ? callback : null);
    }
    goaway(code, lastStreamId, opaqueData) {
      if (this._destroyed) throw invalidSessionError();
      if (code === undefined) code = E.NO_ERROR;
      if (lastStreamId === undefined) lastStreamId = 0;
      if (opaqueData !== undefined) validateBuffer(opaqueData, 'opaqueData');
      validateNumber(code, 'code');
      validateNumber(lastStreamId, 'lastStreamID');
      var last = lastStreamId <= 0 ? this._lastPeerId() : lastStreamId;
      this._sendGoaway(code, last, opaqueData === undefined ? EMPTY : Buffer.from(bytesOf(opaqueData)));
    }
    /* Node's close(): GOAWAY, no new streams, and the session is destroyed once its last stream is. */
    close(callback) {
      if (this._closing || this._destroyed) return;
      this._closing = true;
      if (typeof callback === 'function') this.once('close', callback);
      this._sendGoaway(E.NO_ERROR, this._lastPeerId(), EMPTY);
      this._maybeDestroySession();
    }
    destroy(error, code) {
      if (this._destroyed) return;
      if (error === undefined) error = E.NO_ERROR;
      if (typeof error === 'number') {
        code = error;
        error = code !== E.NO_ERROR ? sessionError(code) : undefined;
      }
      if (code === undefined && error !== null && error !== undefined) code = E.INTERNAL_ERROR;
      this._closeSession(code === undefined ? E.NO_ERROR : code, error === null ? undefined : error, true, false);
    }
    setTimeout(ms, callback) {
      if (typeof callback === 'function') this.once('timeout', callback);
      return this;
    }
    setLocalWindowSize(windowSize) {
      if (this._destroyed) throw invalidSessionError();
      validateInteger(windowSize, 'windowSize', 0, MAX_WINDOW);
      var delta = windowSize - this._recvConnWindow;
      if (delta > 0) this._grantConnectionWindow(delta);
    }
    ref() {
      if (this._socket && typeof this._socket.ref === 'function') this._socket.ref();
      return this;
    }
    unref() {
      if (this._socket && typeof this._socket.unref === 'function') this._socket.unref();
      return this;
    }
  }

  class ServerHttp2Session extends Http2Session {
    constructor(socket, options, server, alpn, secure) {
      super(socket, true, options, server, alpn, secure);
    }
    get server() {
      return this._server === null ? undefined : this._server;
    }
  }

  function goawaySessionError() {
    return h2Error(Error, 'ERR_HTTP2_GOAWAY_SESSION', 'New streams cannot be created after receiving a GOAWAY');
  }

  class ClientHttp2Session extends Http2Session {
    constructor(socket, options, alpn, secure) {
      super(socket, false, options, null, alpn, secure);
    }
    /* Node's request(): headers are prepared and checked now; the stream gets its id at once, or when the session connects. */
    request(headersParam, options) {
      if (this._destroyed) throw invalidSessionError();
      if (this._closing) throw goawaySessionError();
      var prepared;
      if (Array.isArray(headersParam)) prepared = prepareRequest(this, headersParam);
      else if (!!headersParam && typeof headersParam === 'object') prepared = prepareRequest(this, headersParam);
      else if (headersParam === undefined) prepared = prepareRequest(this, {});
      else throw argTypeError('headers', 'of type object or an instance of Array', headersParam);
      assertIsObject(options, 'options');
      var opts = Object.assign({}, options);
      if (opts.parent !== undefined) validateNumber(opts.parent, 'options.parent');
      if (opts.exclusive !== undefined) validateBoolean(opts.exclusive, 'options.exclusive');
      if (opts.silent !== undefined) validateBoolean(opts.silent, 'options.silent');
      /* Node's isPayloadMeaningless: GET, HEAD and DELETE end the writable side unless the caller says otherwise. */
      if (opts.endStream === undefined) opts.endStream = NO_PAYLOAD_METHODS[prepared.method] === true;
      else validateBoolean(opts.endStream, 'options.endStream');
      var stream = new ClientHttp2Stream(this, undefined);
      stream._sentHeaders = prepared.headersObject;
      stream._rawSentHeaders = prepared.rawHeaders;
      stream._requestMethod = prepared.method;
      this._pendingStreams.push(stream);
      if (opts.endStream) stream.end();
      if (opts.waitForTrailers) stream._hasTrailers = true;
      var signal = opts.signal;
      if (signal) {
        if (typeof signal !== 'object' || !('aborted' in signal)) throw argTypeError('options.signal', 'an instance of AbortSignal', signal);
        var aborter = function () {
          var abortError = h2Error(Error, 'ABORT_ERR', 'The operation was aborted');
          abortError.name = 'AbortError';
          abortError.cause = signal.reason;
          stream.destroy(abortError);
        };
        if (signal.aborted) {
          aborter();
        } else if (typeof signal.addEventListener === 'function') {
          signal.addEventListener('abort', aborter, { once: true });
          stream.once('close', function () { signal.removeEventListener('abort', aborter); });
        }
      }
      var self = this;
      var onConnect = function () { self._requestOnConnect(stream, prepared.fields, opts); };
      if (this._connecting) {
        if (this._pendingRequests !== null) {
          this._pendingRequests.push(onConnect);
        } else {
          this._pendingRequests = [onConnect];
          this.once('connect', function () {
            var calls = self._pendingRequests;
            self._pendingRequests = null;
            calls.forEach(function (f) { f(); });
          });
        }
      } else {
        onConnect();
      }
      return stream;
    }
    /* Node's requestOnConnect and kInit: the id is assigned, the HEADERS frame queued, then 'ready'. */
    _requestOnConnect(stream, fields, options) {
      if (this._destroyed || stream.destroyed) return;
      if (this._closing) {
        stream.destroy(goawaySessionError());
        return;
      }
      var id = this._nextLocalId;
      if (id > 2147483647) {
        stream.destroy(h2Error(Error, 'ERR_HTTP2_OUT_OF_STREAMS', 'No stream ID is available because maximum stream ID has been reached'));
        return;
      }
      this._nextLocalId += 2;
      this._lastLocalId = id;
      this._removePending(stream);
      stream.id = id;
      stream._state = 'open';
      stream._pendingFields = fields;
      stream._endWithHeaders = !!options.endStream;
      this._streams[id] = stream;
      this._queuedStreams.push(stream);
      this._startQueuedStreams();
      stream.emit('ready');
    }
  }

  /* ---------- Compat request and response (Node's lib/internal/http2/compat.js) ---------- */

  var LegacyStream = typeof streams === 'function' ? streams : (streams.Stream || EventEmitter);
  var kCState = Symbol('state');
  var kCStream = Symbol('stream');
  var kCHeaders = Symbol('headers');
  var kCRawHeaders = Symbol('rawHeaders');
  var kCTrailers = Symbol('trailers');
  var kCRawTrailers = Symbol('rawTrailers');
  var kCAborted = Symbol('aborted');
  var kSetHeader = Symbol('setHeader');
  var kAppendHeader = Symbol('appendHeader');
  var kBeginSend = Symbol('begin-send');
  var statusMessageWarned = false;
  var connectionHeaderWarned = false;
  var traceWarningHelperShown = false;

  /* process.emitWarning(message, 'UnsupportedWarning') as Node prints it: on the next tick, to stderr, with the trace hint once. */
  function unsupportedWarning(message) {
    var proc = globalThis.process;
    if (!proc || typeof proc.nextTick !== 'function') return;
    var warning = new Error(message);
    warning.name = 'UnsupportedWarning';
    proc.nextTick(function () {
      if (typeof proc.emit === 'function') proc.emit('warning', warning);
      if (proc.stderr && typeof proc.stderr.write === 'function') {
        var text = '(node:' + proc.pid + ') UnsupportedWarning: ' + message + '\n';
        if (!traceWarningHelperShown) {
          traceWarningHelperShown = true;
          text += '(Use \x60node --trace-warnings ...\x60 to show where the warning was created)\n';
        }
        proc.stderr.write(text);
      }
    });
  }

  function isPseudoHeader(name) {
    return name === ':status' || name === ':method' || name === ':path' || name === ':authority' || name === ':scheme';
  }

  function isConnectionHeaderAllowed(name, value) {
    return name !== 'connection' || value === 'trailers';
  }

  function statusMessageWarn() {
    if (!statusMessageWarned) {
      unsupportedWarning('Status message is not supported by HTTP/2 (RFC7540 8.1.2.4)');
      statusMessageWarned = true;
    }
  }

  function connectionHeaderMessageWarn() {
    if (!connectionHeaderWarned) {
      unsupportedWarning('The provided connection header is not valid, the value will be dropped from the header and will never be in use.');
      connectionHeaderWarned = true;
    }
  }

  function assertValidHeader(name, value) {
    if (name === '' || typeof name !== 'string' || name.indexOf(' ') >= 0) throw invalidToken(name);
    if (isPseudoHeader(name)) throw h2Error(TypeError, 'ERR_HTTP2_PSEUDOHEADER_NOT_ALLOWED', 'Cannot set HTTP/2 pseudo-headers');
    if (value === undefined || value === null) throw h2Error(TypeError, 'ERR_HTTP2_INVALID_HEADER_VALUE', 'Invalid value "' + value + '" for header "' + name + '"');
    if (!isConnectionHeaderAllowed(name, value)) connectionHeaderMessageWarn();
  }

  function onStreamData(chunk) {
    var request = this[kRequest];
    if (request !== undefined && !request.push(chunk)) this.pause();
  }

  function onStreamTrailers(trailers, flags, rawTrailers) {
    var request = this[kRequest];
    if (request !== undefined) {
      Object.assign(request[kCTrailers], trailers);
      Array.prototype.push.apply(request[kCRawTrailers], rawTrailers);
    }
  }

  function onStreamEnd() {
    var request = this[kRequest];
    if (request !== undefined) this[kRequest].push(null);
  }

  function onStreamError() {
    // Errors in compatibility mode are not forwarded to the request and response objects (Node).
  }

  function onRequestPause() {
    this[kCStream].pause();
  }

  function onRequestResume() {
    this[kCStream].resume();
  }

  function onStreamDrain() {
    var response = this[kResponse];
    if (response !== undefined) response.emit('drain');
  }

  function onStreamAbortedRequest() {
    var request = this[kRequest];
    if (request !== undefined && request[kCState].closed === false) {
      request[kCAborted] = true;
      request.emit('aborted');
    }
  }

  function onStreamAbortedResponse() {
    // Nothing to do (Node).
  }

  function resumeStream(stream) {
    stream.resume();
  }

  function compatSocketRef(stream) {
    return stream.session !== undefined ? stream.session._socket : stream;
  }

  /* Node's proxySocketHandler for req.socket and res.socket: the session's socket, without direct I/O. */
  var compatSocketHandler = {
    has: function (stream, prop) {
      return (prop in stream) || (prop in compatSocketRef(stream));
    },
    get: function (stream, prop) {
      switch (prop) {
        case 'on':
        case 'once':
        case 'end':
        case 'emit':
        case 'destroy':
          return stream[prop].bind(stream);
        case 'writable':
        case 'destroyed':
          return stream[prop];
        case 'readable': {
          if (stream.destroyed) return false;
          var request = stream[kRequest];
          return request ? request.readable : stream.readable;
        }
        case 'setTimeout': {
          var session = stream.session;
          if (session !== undefined) return session.setTimeout.bind(session);
          return stream.setTimeout.bind(stream);
        }
        case 'write':
        case 'read':
        case 'pause':
        case 'resume':
          throw noSocketManipulation();
        default: {
          var ref = compatSocketRef(stream);
          var value = ref[prop];
          return typeof value === 'function' ? value.bind(ref) : value;
        }
      }
    },
    getPrototypeOf: function (stream) {
      return Object.getPrototypeOf(compatSocketRef(stream));
    },
    set: function (stream, prop, value) {
      switch (prop) {
        case 'writable':
        case 'readable':
        case 'destroyed':
        case 'on':
        case 'once':
        case 'end':
        case 'emit':
        case 'destroy':
          stream[prop] = value;
          return true;
        case 'setTimeout': {
          var session = stream.session;
          if (session !== undefined) session.setTimeout = value;
          else stream.setTimeout = value;
          return true;
        }
        case 'write':
        case 'read':
        case 'pause':
        case 'resume':
          throw noSocketManipulation();
        default:
          compatSocketRef(stream)[prop] = value;
          return true;
      }
    }
  };

  function compatSocket(stream) {
    var proxySocket = stream[kProxySocket];
    if (proxySocket === null) {
      proxySocket = new Proxy(stream, compatSocketHandler);
      stream[kProxySocket] = proxySocket;
    }
    return proxySocket;
  }

  function onStreamCloseRequest() {
    var req = this[kRequest];
    if (req === undefined) return;
    var state = req[kCState];
    state.closed = true;
    req.push(null);
    /* An unread request is dumped, as HTTP/1 does. */
    if (!state.didRead && !req._readableState.resumeScheduled) req.resume();
    this[kProxySocket] = null;
    this[kRequest] = undefined;
    req.emit('close');
  }

  function onStreamTimeout(kind) {
    return function () {
      var obj = this[kind];
      if (obj) obj.emit('timeout');
    };
  }

  class Http2ServerRequest extends Readable {
    constructor(stream, headers, options, rawHeaders) {
      super(Object.assign({ autoDestroy: false }, options));
      this[kCState] = { closed: false, didRead: false };
      this[kCHeaders] = headers;
      this[kCRawHeaders] = rawHeaders;
      this[kCTrailers] = {};
      this[kCRawTrailers] = [];
      this[kCStream] = stream;
      this[kCAborted] = false;
      stream[kProxySocket] = null;
      stream[kRequest] = this;
      stream.on('trailers', onStreamTrailers);
      stream.on('end', onStreamEnd);
      stream.on('error', onStreamError);
      stream.on('aborted', onStreamAbortedRequest);
      stream.on('close', onStreamCloseRequest);
      stream.on('timeout', onStreamTimeout(kRequest));
      this.on('pause', onRequestPause);
      this.on('resume', onRequestResume);
    }
    get aborted() {
      return this[kCAborted];
    }
    get complete() {
      return this[kCAborted] || this.readableEnded || this[kCState].closed || this[kCStream].destroyed;
    }
    get stream() {
      return this[kCStream];
    }
    get headers() {
      return this[kCHeaders];
    }
    get rawHeaders() {
      return this[kCRawHeaders];
    }
    get trailers() {
      return this[kCTrailers];
    }
    get rawTrailers() {
      return this[kCRawTrailers];
    }
    get httpVersionMajor() {
      return 2;
    }
    get httpVersionMinor() {
      return 0;
    }
    get httpVersion() {
      return '2.0';
    }
    get socket() {
      return compatSocket(this[kCStream]);
    }
    get connection() {
      return this.socket;
    }
    /* The stream is only read once the request itself is read, so an unread body stays unread. */
    _read() {
      var state = this[kCState];
      if (!state.didRead) {
        state.didRead = true;
        this[kCStream].on('data', onStreamData);
      } else {
        process.nextTick(resumeStream, this[kCStream]);
      }
    }
    get method() {
      return this[kCHeaders][':method'];
    }
    set method(method) {
      validateString(method, 'method');
      if (method.trim() === '') throw argValueError('method', method);
      this[kCHeaders][':method'] = method;
    }
    get authority() {
      return getAuthority(this[kCHeaders]);
    }
    get scheme() {
      return this[kCHeaders][':scheme'];
    }
    get url() {
      return this[kCHeaders][':path'];
    }
    set url(url) {
      this[kCHeaders][':path'] = url;
    }
    setTimeout(msecs, callback) {
      if (!this[kCState].closed) this[kCStream].setTimeout(msecs, callback);
      return this;
    }
  }

  function onStreamTrailersReady() {
    this.sendTrailers(this[kResponse][kCTrailers]);
  }

  function onStreamCloseResponse() {
    var res = this[kResponse];
    if (res === undefined) return;
    var state = res[kCState];
    if (this.headRequest !== state.headRequest) return;
    state.closed = true;
    this[kProxySocket] = null;
    this.removeListener('wantTrailers', onStreamTrailersReady);
    this[kResponse] = undefined;
    res.emit('finish');
    res.emit('close');
  }

  /* Node's validateLinkHeaderValue for writeEarlyHints(). */
  var LINK_VALUE_RE = /^(?:<[^>]*>)(?:\s*;\s*[^;"\s]+(?:=(")?[^;"\s]*\1)?)*$/;
  function validateLinkHeaderFormat(value, name) {
    if (typeof value === 'undefined' || !LINK_VALUE_RE.test(value)) {
      throw argValueError(name, value, 'must be an array or string of format "</styles.css>; rel=preload; as=style"');
    }
  }
  function validateLinkHeaderValue(hints) {
    if (typeof hints === 'string') {
      validateLinkHeaderFormat(hints, 'hints');
      return hints;
    }
    if (Array.isArray(hints)) {
      var result = '';
      for (var i = 0; i < hints.length; i++) {
        validateLinkHeaderFormat(hints[i], 'hints');
        result += hints[i];
        if (i !== hints.length - 1) result += ', ';
      }
      return result;
    }
    throw argValueError('hints', hints, 'must be an array or string of format "</styles.css>; rel=preload; as=style"');
  }

  class Http2ServerResponse extends LegacyStream {
    constructor(stream, options) {
      super(options);
      this[kCState] = { closed: false, ending: false, destroyed: false, headRequest: false, sendDate: true, statusCode: 200 };
      this[kCHeaders] = Object.create(null);
      this[kCTrailers] = Object.create(null);
      this[kCStream] = stream;
      stream[kProxySocket] = null;
      stream[kResponse] = this;
      this.writable = true;
      this.req = stream[kRequest];
      stream.on('drain', onStreamDrain);
      stream.on('aborted', onStreamAbortedResponse);
      stream.on('close', onStreamCloseResponse);
      stream.on('wantTrailers', onStreamTrailersReady);
      stream.on('timeout', onStreamTimeout(kResponse));
    }
    get _header() {
      return this.headersSent;
    }
    get writableEnded() {
      return this[kCState].ending;
    }
    get finished() {
      return this[kCState].ending;
    }
    get socket() {
      /* As HTTP/1: the response drops its socket once closed. */
      if (this[kCState].closed) return undefined;
      return compatSocket(this[kCStream]);
    }
    get connection() {
      return this.socket;
    }
    get stream() {
      return this[kCStream];
    }
    get headersSent() {
      return this[kCStream].headersSent;
    }
    get sendDate() {
      return this[kCState].sendDate;
    }
    set sendDate(bool) {
      this[kCState].sendDate = Boolean(bool);
    }
    get statusCode() {
      return this[kCState].statusCode;
    }
    set statusCode(code) {
      code |= 0;
      if (code >= 100 && code < 200) throw h2Error(RangeError, 'ERR_HTTP2_INFO_STATUS_NOT_ALLOWED', 'Informational status codes cannot be used');
      if (code < 100 || code > 599) throw h2Error(RangeError, 'ERR_HTTP2_STATUS_INVALID', 'Invalid status code: ' + code);
      this[kCState].statusCode = code;
    }
    get writableCorked() {
      return this[kCStream].writableCorked;
    }
    get writableHighWaterMark() {
      return this[kCStream].writableHighWaterMark;
    }
    get writableFinished() {
      return this[kCStream].writableFinished;
    }
    get writableLength() {
      return this[kCStream].writableLength;
    }
    setTrailer(name, value) {
      validateString(name, 'name');
      name = name.trim().toLowerCase();
      assertValidHeader(name, value);
      this[kCTrailers][name] = value;
    }
    addTrailers(headers) {
      var keys = Object.keys(headers);
      for (var i = 0; i < keys.length; i++) this.setTrailer(keys[i], headers[keys[i]]);
    }
    getHeader(name) {
      validateString(name, 'name');
      name = name.trim().toLowerCase();
      return this[kCHeaders][name];
    }
    getHeaderNames() {
      return Object.keys(this[kCHeaders]);
    }
    getHeaders() {
      return Object.assign(Object.create(null), this[kCHeaders]);
    }
    hasHeader(name) {
      validateString(name, 'name');
      name = name.trim().toLowerCase();
      return Object.prototype.hasOwnProperty.call(this[kCHeaders], name);
    }
    removeHeader(name) {
      validateString(name, 'name');
      if (this[kCStream].headersSent) throw headersSentError();
      name = name.trim().toLowerCase();
      if (name === 'date') {
        this[kCState].sendDate = false;
        return;
      }
      delete this[kCHeaders][name];
    }
    setHeader(name, value) {
      validateString(name, 'name');
      if (this[kCStream].headersSent) throw headersSentError();
      this[kSetHeader](name, value);
    }
    /* A connection header (other than "connection: trailers") is dropped with a one-time UnsupportedWarning, as Node does. */
    [kSetHeader](name, value) {
      name = name.trim().toLowerCase();
      assertValidHeader(name, value);
      if (!isConnectionHeaderAllowed(name, value)) return;
      if (name.charAt(0) === ':') {
        if (VALID_PSEUDO[name] !== true) throw invalidPseudo(name);
      } else if (!TOKEN_RE.test(name)) {
        this.destroy(invalidToken(name));
      }
      this[kCHeaders][name] = value;
    }
    appendHeader(name, value) {
      validateString(name, 'name');
      if (this[kCStream].headersSent) throw headersSentError();
      this[kAppendHeader](name, value);
    }
    [kAppendHeader](name, value) {
      name = name.trim().toLowerCase();
      assertValidHeader(name, value);
      if (!isConnectionHeaderAllowed(name, value)) return;
      if (name.charAt(0) === ':') {
        if (VALID_PSEUDO[name] !== true) throw invalidPseudo(name);
      } else if (!TOKEN_RE.test(name)) {
        this.destroy(invalidToken(name));
      }
      var headers = this[kCHeaders];
      if (headers === null || !headers[name]) return this.setHeader(name, value);
      if (!Array.isArray(headers[name])) headers[name] = [headers[name]];
      var existingValues = headers[name];
      if (Array.isArray(value)) {
        for (var i = 0; i < value.length; i++) existingValues.push(value[i]);
      } else {
        existingValues.push(value);
      }
      return undefined;
    }
    get statusMessage() {
      statusMessageWarn();
      return '';
    }
    set statusMessage(msg) {
      statusMessageWarn();
    }
    flushHeaders() {
      var state = this[kCState];
      if (!state.closed && !this[kCStream].headersSent) this.writeHead(state.statusCode);
    }
    /* Headers as an object, as [[name, value], ...] or as a flat [name, value, ...] list; arrays replace, then append. */
    writeHead(statusCode, statusMessage, headers) {
      var state = this[kCState];
      if (state.closed || this.stream.destroyed || this.stream.closed) return this;
      if (this[kCStream].headersSent) throw headersSentError();
      if (typeof statusMessage === 'string') statusMessageWarn();
      if (headers === undefined && typeof statusMessage === 'object') headers = statusMessage;
      var i;
      if (Array.isArray(headers)) {
        if (this[kCHeaders]) {
          if (headers.length && Array.isArray(headers[0])) {
            for (i = 0; i < headers.length; i += 1) this.removeHeader(headers[i][0]);
          } else {
            for (i = 0; i < headers.length; i += 2) this.removeHeader(headers[i]);
          }
        }
        if (headers.length && Array.isArray(headers[0])) {
          for (i = 0; i < headers.length; i++) this[kAppendHeader](headers[i][0], headers[i][1]);
        } else {
          if (headers.length % 2 !== 0) throw argValueError('headers', headers);
          for (i = 0; i < headers.length; i += 2) this[kAppendHeader](headers[i], headers[i + 1]);
        }
      } else if (typeof headers === 'object') {
        var keys = Object.keys(headers);
        for (i = 0; i < keys.length; i++) this[kSetHeader](keys[i], headers[keys[i]]);
      }
      state.statusCode = statusCode;
      this[kBeginSend]();
      return this;
    }
    cork() {
      this[kCStream].cork();
    }
    uncork() {
      this[kCStream].uncork();
    }
    write(chunk, encoding, cb) {
      var state = this[kCState];
      if (typeof encoding === 'function') {
        cb = encoding;
        encoding = 'utf8';
      }
      var err;
      if (state.ending) err = h2Error(Error, 'ERR_STREAM_WRITE_AFTER_END', 'write after end');
      else if (state.closed) err = invalidStreamError();
      else if (state.destroyed) return false;
      if (err) {
        if (typeof cb === 'function') process.nextTick(cb, err);
        this.destroy(err);
        return false;
      }
      var stream = this[kCStream];
      if (!stream.headersSent) this.writeHead(state.statusCode);
      return stream.write(chunk, encoding, cb);
    }
    end(chunk, encoding, cb) {
      var stream = this[kCStream];
      var state = this[kCState];
      if (typeof chunk === 'function') {
        cb = chunk;
        chunk = null;
      } else if (typeof encoding === 'function') {
        cb = encoding;
        encoding = 'utf8';
      }
      if ((state.closed || state.ending) && state.headRequest === stream.headRequest) {
        if (typeof cb === 'function') process.nextTick(cb);
        return this;
      }
      if (chunk !== null && chunk !== undefined) this.write(chunk, encoding);
      state.headRequest = stream.headRequest;
      state.ending = true;
      if (typeof cb === 'function') {
        if (stream.writableEnded) this.once('finish', cb);
        else stream.once('finish', cb);
      }
      if (!stream.headersSent) this.writeHead(this[kCState].statusCode);
      if (this[kCState].closed || stream.destroyed) onStreamCloseResponse.call(stream);
      else stream.end();
      return this;
    }
    destroy(err) {
      if (this[kCState].destroyed) return;
      this[kCState].destroyed = true;
      this[kCStream].destroy(err);
    }
    setTimeout(msecs, callback) {
      if (this[kCState].closed) return;
      this[kCStream].setTimeout(msecs, callback);
    }
    createPushResponse(headers, callback) {
      validateFunction(callback, 'callback');
      if (this[kCState].closed) {
        process.nextTick(callback, invalidStreamError());
        return;
      }
      this[kCStream].pushStream(headers, {}, function (err, stream) {
        if (err) {
          callback(err);
          return;
        }
        callback(null, new Http2ServerResponse(stream));
      });
    }
    [kBeginSend]() {
      var state = this[kCState];
      var headers = this[kCHeaders];
      headers[':status'] = state.statusCode;
      this[kCStream].respond(headers, { endStream: state.ending, waitForTrailers: true, sendDate: state.sendDate });
    }
    writeContinue() {
      var stream = this[kCStream];
      if (stream.headersSent || this[kCState].closed) return false;
      stream.additionalHeaders({ ':status': 100 });
      return true;
    }
    writeEarlyHints(hints) {
      if (hints === null || typeof hints !== 'object' || Array.isArray(hints)) throw argTypeError('hints', 'of type object', hints);
      var headers = Object.create(null);
      var linkHeaderValue = validateLinkHeaderValue(hints.link);
      var keys = Object.keys(hints);
      for (var i = 0; i < keys.length; i++) if (keys[i] !== 'link') headers[keys[i]] = hints[keys[i]];
      if (linkHeaderValue.length === 0) return false;
      var stream = this[kCStream];
      if (stream.headersSent || this[kCState].closed) return false;
      var info = Object.assign({}, headers);
      info[':status'] = 103;
      info.Link = linkHeaderValue;
      stream.additionalHeaders(info);
      return true;
    }
  }

  /* Node's onServerStream: compat objects, CONNECT, Expect handling, then 'request'. */
  function onServerStream(ServerRequest, ServerResponse, stream, headers, flags, rawHeaders) {
    var server = this;
    var request = new ServerRequest(stream, headers, undefined, rawHeaders);
    var response = new ServerResponse(stream);
    if (headers[':method'] === 'CONNECT') {
      if (!server.emit('connect', request, response)) {
        response.statusCode = 405;
        response.end();
      }
      return;
    }
    if (headers.expect !== undefined) {
      if (headers.expect === '100-continue') {
        if (server.listeners('checkContinue').length > 0) {
          server.emit('checkContinue', request, response);
        } else {
          response.writeContinue();
          server.emit('request', request, response);
        }
      } else if (server.listeners('checkExpectation').length > 0) {
        server.emit('checkExpectation', request, response);
      } else {
        response.statusCode = 417;
        response.end();
      }
      return;
    }
    server.emit('request', request, response);
  }

  /* ---------- Servers and clients ---------- */

  /* Node's setupCompat: the first 'request' listener installs the compat 'stream' listener. */
  function setupCompat(ev) {
    if (ev !== 'request') return;
    this.removeListener('newListener', setupCompat);
    var server = this;
    var opts = server._h2Options || {};
    var RequestCls = opts.Http2ServerRequest || Http2ServerRequest;
    var ResponseCls = opts.Http2ServerResponse || Http2ServerResponse;
    this.on('stream', function (stream, headers, flags, rawHeaders) {
      onServerStream.call(server, RequestCls, ResponseCls, stream, headers, flags, rawHeaders);
    });
  }

  function sessionOnStream(stream, headers, flags, rawHeaders) {
    if (this._server !== null) this._server.emit('stream', stream, headers, flags, rawHeaders);
  }

  function sessionOnError(error) {
    if (this._server !== null) this._server.emit('sessionError', error, this);
  }

  /* Node's connectionListener (after ALPN): the session, its forwarding listeners, then 'session'. */
  function startServerSession(server, socket, alpn, secure) {
    var session = new ServerHttp2Session(socket, server._h2Options, server, alpn, secure);
    server._sessions.add(session);
    session.on('stream', sessionOnStream);
    session.on('error', sessionOnError);
    server.emit('session', session);
    return session;
  }

  function closeServerSessions(server) {
    server._sessions.forEach(function (session) {
      if (!session.destroyed) session.close();
    });
  }

  /* Node's initializeOptions: options are copied, settings validated, strictSingleValueFields a boolean (default true). */
  function initializeOptions(options) {
    assertIsObject(options, 'options');
    var opts = Object.assign({}, options);
    assertIsObject(opts.settings, 'options.settings');
    opts.settings = Object.assign({}, opts.settings);
    validateSettings(opts.settings);
    if (opts.strictSingleValueFields !== undefined) validateBoolean(opts.strictSingleValueFields, 'options.strictSingleValueFields');
    else opts.strictSingleValueFields = true;
    if (opts.unknownProtocolTimeout === undefined) opts.unknownProtocolTimeout = 10000;
    return opts;
  }

  class Http2Server extends net.Server {
    constructor(options, onRequest) {
      var opts = initializeOptions(options);
      super({ allowHalfOpen: false });
      this._h2Options = opts;
      this._sessions = new Set();
      this.timeout = 0;
      var self = this;
      this.on('newListener', setupCompat);
      if (typeof onRequest === 'function') this.on('request', onRequest);
      this.on('connection', function (socket) { startServerSession(self, socket, 'h2c', false); });
    }
    close(callback) {
      var result = super.close(callback);
      closeServerSessions(this);
      return result;
    }
    setTimeout(ms, callback) {
      this.timeout = ms;
      if (callback !== undefined) {
        validateFunction(callback, 'callback');
        this.on('timeout', callback);
      }
      return this;
    }
    updateSettings(settings) {
      assertIsObject(settings, 'settings');
      validateSettings(settings || {});
      this._h2Options.settings = Object.assign({}, this._h2Options.settings || {}, settings);
    }
  }

  function createServer(options, onRequest) {
    if (typeof options === 'function') {
      onRequest = options;
      options = undefined;
    }
    return new Http2Server(options, onRequest);
  }

  /* h2 over TLS: the session starts once the handshake has selected ALPN "h2" (RFC 9113 3.2). */
  function createSecureServer(options, onRequest) {
    if (typeof options === 'function') {
      onRequest = options;
      options = undefined;
    }
    var opts = initializeOptions(options);
    var tls = requireBuiltin('tls');
    var tlsOptions = Object.assign({}, opts);
    tlsOptions.ALPNProtocols = ['h2'];
    var server = tls.createServer(tlsOptions, function (socket) {
      /*
       * Node's rule: a TLS connection that did not select "h2" (ALPN false or http/1.1) is not HTTP/2; it goes to
       * 'unknownProtocol', or gets a 403 and is closed. allowHTTP1 is not supported here.
       */
      if (socket.alpnProtocol !== 'h2') {
        if (!server.emit('unknownProtocol', socket)) {
          var timer = setTimeout(function () { if (!socket.destroyed) socket.destroy(); }, opts.unknownProtocolTimeout);
          if (timer && typeof timer.unref === 'function') timer.unref();
          socket.once('close', function () { clearTimeout(timer); });
          socket.end('HTTP/1.0 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nMissing ALPN Protocol, expected \x60h2\x60 to be available.\nIf this is a HTTP request: The server was not configured with the \x60allowHTTP1\x60 option or a listener for the \x60unknownProtocol\x60 event.\n');
        }
        return;
      }
      startServerSession(server, socket, 'h2', true);
    });
    server._h2Options = opts;
    server._sessions = new Set();
    server.timeout = 0;
    var baseClose = server.close;
    server.close = function (callback) {
      var result = baseClose.call(server, callback);
      closeServerSessions(server);
      return result;
    };
    server.on('newListener', setupCompat);
    if (typeof onRequest === 'function') server.on('request', onRequest);
    return server;
  }

  function parseAuthority(input) {
    var text = typeof input === 'string' ? input : (input && input.href) ? String(input.href) : String(input);
    var m = /^([a-z][a-z0-9+.\-]*):\/\/([^\/:?#\[\]]+|\[[^\]]+\])(?::(\d*))?/i.exec(text);
    if (m === null) throw h2Error(TypeError, 'ERR_INVALID_URL', 'Invalid URL');
    var protocol = m[1].toLowerCase();
    if (protocol !== 'http' && protocol !== 'https') throw h2Error(TypeError, 'ERR_HTTP2_UNSUPPORTED_PROTOCOL', 'protocol "' + protocol + ':" is unsupported.');
    var secure = protocol === 'https';
    var host = m[2].charAt(0) === '[' ? m[2].slice(1, -1) : m[2];
    var port = m[3] !== undefined && m[3] !== '' ? Number(m[3]) : (secure ? 443 : 80);
    return { secure: secure, host: host, port: port, protocol: protocol + ':' };
  }

  function connect(authority, options, listener) {
    if (typeof options === 'function') {
      listener = options;
      options = undefined;
    }
    assertIsObject(options, 'options');
    var opts = Object.assign({}, options);
    if (opts.strictSingleValueFields !== undefined) validateBoolean(opts.strictSingleValueFields, 'options.strictSingleValueFields');
    else opts.strictSingleValueFields = true;
    var target = parseAuthority(authority);
    validateSettings(opts.settings || {});
    var socket;
    if (typeof opts.createConnection === 'function') {
      socket = opts.createConnection(authority, opts);
    } else if (target.secure) {
      var tlsOptions = Object.assign({}, opts);
      tlsOptions.host = target.host;
      tlsOptions.port = target.port;
      if (tlsOptions.servername === undefined && !/^[0-9.]+$/.test(target.host) && target.host.indexOf(':') < 0) tlsOptions.servername = target.host;
      tlsOptions.ALPNProtocols = ['h2'];
      socket = requireBuiltin('tls').connect(tlsOptions);
    } else {
      socket = net.connect({ host: target.host, port: target.port });
    }
    var secure = target.secure && socket.encrypted !== false;
    var session = new ClientHttp2Session(socket, opts, secure ? 'h2' : 'h2c', secure);
    /* Node's kAuthority and kProtocol: the default :authority always names the port. */
    session._authority = (opts.servername || target.host) + ':' + target.port;
    session._protocol = target.protocol;
    if (typeof listener === 'function') session.once('connect', listener);
    return session;
  }

  function getDefaultSettings() {
    var out = {};
    var keys = Object.keys(H2_DEFAULT_SETTINGS);
    for (var i = 0; i < keys.length; i++) out[keys[i]] = H2_DEFAULT_SETTINGS[keys[i]];
    return out;
  }

  function getPackedSettings(settings) {
    validateSettings(settings || {});
    return packSettings(settings || {});
  }

  function getUnpackedSettings(buf) {
    if (buf.length % 6 !== 0) throw h2Error(RangeError, 'ERR_HTTP2_INVALID_PACKED_SETTINGS_LENGTH', 'Packed settings length must be a multiple of six');
    var out = {};
    for (var i = 0; i + 6 <= buf.length; i += 6) {
      var id = (buf[i] << 8) | buf[i + 1];
      var v = readU32(buf, i + 2);
      if (id === C.NGHTTP2_SETTINGS_HEADER_TABLE_SIZE) out.headerTableSize = v;
      else if (id === C.NGHTTP2_SETTINGS_ENABLE_PUSH) out.enablePush = v !== 0;
      else if (id === C.NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS) out.maxConcurrentStreams = v;
      else if (id === C.NGHTTP2_SETTINGS_INITIAL_WINDOW_SIZE) out.initialWindowSize = v;
      else if (id === C.NGHTTP2_SETTINGS_MAX_FRAME_SIZE) out.maxFrameSize = v;
      else if (id === C.NGHTTP2_SETTINGS_MAX_HEADER_LIST_SIZE) {
        out.maxHeaderSize = v;
        out.maxHeaderListSize = v;
      } else if (id === C.NGHTTP2_SETTINGS_ENABLE_CONNECT_PROTOCOL) out.enableConnectProtocol = v !== 0;
    }
    return out;
  }

  function performServerHandshake(socket, options) {
    return new ServerHttp2Session(socket, initializeOptions(options || {}), null, 'h2c', false);
  }

  var api = {
    connect: connect,
    constants: Object.assign({}, C),
    createServer: createServer,
    createSecureServer: createSecureServer,
    getDefaultSettings: getDefaultSettings,
    getPackedSettings: getPackedSettings,
    getUnpackedSettings: getUnpackedSettings,
    performServerHandshake: performServerHandshake,
    sensitiveHeaders: sensitiveHeaders,
    Http2ServerRequest: Http2ServerRequest,
    Http2ServerResponse: Http2ServerResponse
  };
  /* Internals for the wire-level checks; not part of Node's surface and not enumerable. */
  Object.defineProperty(api, '__owcInternals', {
    value: {
      HpackEncoder: HpackEncoder,
      HpackDecoder: HpackDecoder,
      huffmanEncode: huffmanEncode,
      huffmanDecode: huffmanDecode,
      frameBuffer: frameBuffer,
      FrameReader: FrameReader,
      buildFields: buildFields,
      headersToFields: function (obj, kind) { return buildFields(obj, kind, true); },
      fieldsToHeaders: fieldsToHeaders,
      PREFACE: PREFACE
    },
    enumerable: false
  });
  return api;
};
})();
`;
