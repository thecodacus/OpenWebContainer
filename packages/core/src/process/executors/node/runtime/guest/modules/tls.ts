/**
 * Guest source for the `tls` module: TLS 1.3 over the in-container virtual network, with the
 * protocol engine of tls-engine.ts (OWC_TLS13, defined by TLS_ENGINE_SRC in the same bootstrap).
 *
 * Plain JavaScript inside a String.raw snippet. It registers BF.tls and uses only bootstrap-scope
 * helpers (BF, requireBuiltin, callCap, Buffer, process, queueMicrotask, setTimeout, OWC_TLS13).
 *
 * Behaviour, stated plainly:
 * - Protocol: TLS 1.3 only (RFC 8446); TLS 1.2 and older are never negotiated. minVersion and
 *   maxVersion accept Node's values; a range that excludes TLSv1.3 fails the handshake with
 *   ERR_SSL_NO_PROTOCOLS_AVAILABLE. Suites TLS_AES_256_GCM_SHA384, TLS_CHACHA20_POLY1305_SHA256,
 *   TLS_AES_128_GCM_SHA256; groups X25519 and P-256; CertificateVerify with ECDSA P-256/P-384 and
 *   RSA-PSS; certificate chains signed with RSA PKCS#1 v1.5, RSA-PSS or ECDSA.
 * - Options are validated as Node does: `ciphers` that select nothing throw ERR_SSL_NO_CIPHER_MATCH
 *   (a list naming only TLS 1.2 ciphers keeps the default TLS 1.3 suites, since Node would negotiate
 *   TLS 1.2 there); an unknown `ecdhCurve` throws ERR_CRYPTO_OPERATION_FAILED; `sigalgs` restricts the
 *   schemes offered and accepted, and unknown names throw as in Node. Valid names this engine lacks
 *   (the CCM suites; P-384, X448, ffdhe and ML-KEM groups; Ed25519, P-521, DSA, SHA-1 schemes) are
 *   dropped from a list, and a list of only those throws ERR_FEATURE_UNAVAILABLE_ON_PLATFORM.
 * - Keys and certificates: PEM; PKCS#8, PKCS#1 RSA, SEC1 EC and RSA-PSS keys, kept per key type as
 *   OpenSSL does (a key that does not match the certificate of its type throws
 *   ERR_OSSL_X509_KEY_VALUES_MISMATCH; an RSA key with only an EC certificate fails at the handshake).
 *   Encrypted keys cannot be decrypted: without a passphrase this is Node's ERR_OSSL_BAD_DECRYPT, with
 *   one a not-supported ERR_OSSL_UNSUPPORTED. pfx is not supported. There are no built-in roots
 *   (rootCertificates is []), so peers verify only against `ca`; the system trust store is not used.
 * - Verification reproduces Node: the chain result is OpenSSL 3's (every check, last error wins),
 *   then checkServerIdentity(servername || host) on the client. rejectUnauthorized decides whether a
 *   failure destroys the socket. Servers verify client certificates with requestCert and `ca`.
 * - Errors follow Node's routing: before the handshake completes a server reports through
 *   'tlsClientError' (once) and a client through 'error'; a peer that ends the stream first gives a
 *   tls.connect client 'end' then ECONNRESET. After it completes, a TLS failure (bad record, fatal
 *   alert) is the socket's 'error' event, once, and the socket then waits for the peer to close
 *   ('end', then close with hadError false).
 * - SNI: the client sends options.servername only (as Node does; https sends the host name). Servers
 *   take SNICallback or addContext() contexts. ALPN: ALPNProtocols on both sides, or a server
 *   ALPNCallback({ servername, protocols }).
 * - Not supported: session resumption, tickets and 0-RTT (getSession() is undefined), renegotiation,
 *   PSK, OCSP stapling, Ed25519 and P-521 keys, unix-socket paths.
 */
export const TLS_SRC = String.raw`
BF['tls'] = function () {
  var net = requireBuiltin('net');
  var ENGINE = OWC_TLS13;
  var PROTOCOL_VERSIONS = { 'TLSv1.3': 4, 'TLSv1.2': 3, 'TLSv1.1': 2, 'TLSv1': 1 };
  var SUITE_IDS = { TLS_AES_128_GCM_SHA256: 4865, TLS_AES_256_GCM_SHA384: 4866, TLS_CHACHA20_POLY1305_SHA256: 4867 };
  /* OpenSSL's TLS 1.3 suite names; the two CCM suites are valid names that this engine does not implement */
  var TLS13_SUITE_NAMES = { TLS_AES_128_GCM_SHA256: true, TLS_AES_256_GCM_SHA384: true, TLS_CHACHA20_POLY1305_SHA256: true, TLS_AES_128_CCM_SHA256: true, TLS_AES_128_CCM_8_SHA256: true };
  /* Group names OpenSSL accepts in ecdhCurve (case-insensitive), and the two this engine implements */
  var GROUP_NAMES = ('x25519 x448 p-256 p-384 p-521 prime256v1 secp256r1 secp384r1 secp521r1 secp224r1 secp256k1 secp192r1 prime192v1 ' +
    'brainpoolp256r1 brainpoolp384r1 brainpoolp512r1 brainpoolp256r1tls13 brainpoolp384r1tls13 brainpoolp512r1tls13 ' +
    'ffdhe2048 ffdhe3072 ffdhe4096 ffdhe6144 ffdhe8192 x25519mlkem768 x448mlkem1024 secp256r1mlkem768 secp384r1mlkem1024 ' +
    'mlkem512 mlkem768 mlkem1024').split(' ');
  var SUPPORTED_GROUPS = { x25519: 29, 'p-256': 23, prime256v1: 23, secp256r1: 23 };
  /* OpenSSL cipher-string words for TLS 1.2 and below that select at least one cipher (names and aliases) */
  var CIPHER_WORDS = {};
  ('ALL COMPLEMENTOFALL COMPLEMENTOFDEFAULT DEFAULT HIGH MEDIUM FIPS kRSA aRSA RSA kEDH kDHE EDH DHE DH kEECDH kECDHE EECDH ECDHE ECDH ' +
    'aECDSA ECDSA aDSS DSS kPSK kRSAPSK kECDHEPSK kDHEPSK aPSK PSK kSRP aSRP SRP SSLv3 TLSv1 TLSv1.0 TLSv1.2 AES AES128 AES256 AESGCM ' +
    'AESCCM AESCCM8 CAMELLIA CAMELLIA128 CAMELLIA256 CHACHA20 ARIA ARIA128 ARIA256 ARIAGCM 3DES IDEA SEED CBC SHA1 SHA SHA256 SHA384 ' +
    'SUITEB128 SUITEB128ONLY SUITEB128C2 SUITEB192 ' +
    'ECDHE-ECDSA-AES256-GCM-SHA384 ECDHE-RSA-AES256-GCM-SHA384 DHE-DSS-AES256-GCM-SHA384 DHE-RSA-AES256-GCM-SHA384 ' +
    'ECDHE-ECDSA-CHACHA20-POLY1305 ECDHE-RSA-CHACHA20-POLY1305 DHE-RSA-CHACHA20-POLY1305 ECDHE-ECDSA-AES256-CCM8 ECDHE-ECDSA-AES256-CCM ' +
    'DHE-RSA-AES256-CCM8 DHE-RSA-AES256-CCM ECDHE-ECDSA-ARIA256-GCM-SHA384 ECDHE-ARIA256-GCM-SHA384 DHE-DSS-ARIA256-GCM-SHA384 ' +
    'DHE-RSA-ARIA256-GCM-SHA384 ECDHE-ECDSA-AES128-GCM-SHA256 ECDHE-RSA-AES128-GCM-SHA256 DHE-DSS-AES128-GCM-SHA256 DHE-RSA-AES128-GCM-SHA256 ' +
    'ECDHE-ECDSA-AES128-CCM8 ECDHE-ECDSA-AES128-CCM DHE-RSA-AES128-CCM8 DHE-RSA-AES128-CCM ECDHE-ECDSA-ARIA128-GCM-SHA256 ' +
    'ECDHE-ARIA128-GCM-SHA256 DHE-DSS-ARIA128-GCM-SHA256 DHE-RSA-ARIA128-GCM-SHA256 ECDHE-ECDSA-AES256-SHA384 ECDHE-RSA-AES256-SHA384 ' +
    'DHE-RSA-AES256-SHA256 DHE-DSS-AES256-SHA256 ECDHE-ECDSA-CAMELLIA256-SHA384 ECDHE-RSA-CAMELLIA256-SHA384 DHE-RSA-CAMELLIA256-SHA256 ' +
    'DHE-DSS-CAMELLIA256-SHA256 ECDHE-ECDSA-AES128-SHA256 ECDHE-RSA-AES128-SHA256 DHE-RSA-AES128-SHA256 DHE-DSS-AES128-SHA256 ' +
    'ECDHE-ECDSA-CAMELLIA128-SHA256 ECDHE-RSA-CAMELLIA128-SHA256 DHE-RSA-CAMELLIA128-SHA256 DHE-DSS-CAMELLIA128-SHA256 ' +
    'ECDHE-ECDSA-AES256-SHA ECDHE-RSA-AES256-SHA DHE-RSA-AES256-SHA DHE-DSS-AES256-SHA DHE-RSA-CAMELLIA256-SHA DHE-DSS-CAMELLIA256-SHA ' +
    'ECDHE-ECDSA-AES128-SHA ECDHE-RSA-AES128-SHA DHE-RSA-AES128-SHA DHE-DSS-AES128-SHA DHE-RSA-SEED-SHA DHE-DSS-SEED-SHA ' +
    'DHE-RSA-CAMELLIA128-SHA DHE-DSS-CAMELLIA128-SHA RSA-PSK-AES256-GCM-SHA384 DHE-PSK-AES256-GCM-SHA384 RSA-PSK-CHACHA20-POLY1305 ' +
    'DHE-PSK-CHACHA20-POLY1305 ECDHE-PSK-CHACHA20-POLY1305 DHE-PSK-AES256-CCM8 DHE-PSK-AES256-CCM RSA-PSK-ARIA256-GCM-SHA384 ' +
    'DHE-PSK-ARIA256-GCM-SHA384 AES256-GCM-SHA384 AES256-CCM8 AES256-CCM ARIA256-GCM-SHA384 PSK-AES256-GCM-SHA384 PSK-CHACHA20-POLY1305 ' +
    'PSK-AES256-CCM8 PSK-AES256-CCM PSK-ARIA256-GCM-SHA384 RSA-PSK-AES128-GCM-SHA256 DHE-PSK-AES128-GCM-SHA256 DHE-PSK-AES128-CCM8 ' +
    'DHE-PSK-AES128-CCM RSA-PSK-ARIA128-GCM-SHA256 DHE-PSK-ARIA128-GCM-SHA256 AES128-GCM-SHA256 AES128-CCM8 AES128-CCM ARIA128-GCM-SHA256 ' +
    'PSK-AES128-GCM-SHA256 PSK-AES128-CCM8 PSK-AES128-CCM PSK-ARIA128-GCM-SHA256 AES256-SHA256 CAMELLIA256-SHA256 AES128-SHA256 ' +
    'CAMELLIA128-SHA256 ECDHE-PSK-AES256-CBC-SHA384 ECDHE-PSK-AES256-CBC-SHA SRP-DSS-AES-256-CBC-SHA SRP-RSA-AES-256-CBC-SHA ' +
    'SRP-AES-256-CBC-SHA RSA-PSK-AES256-CBC-SHA384 DHE-PSK-AES256-CBC-SHA384 RSA-PSK-AES256-CBC-SHA DHE-PSK-AES256-CBC-SHA ' +
    'ECDHE-PSK-CAMELLIA256-SHA384 RSA-PSK-CAMELLIA256-SHA384 DHE-PSK-CAMELLIA256-SHA384 AES256-SHA CAMELLIA256-SHA PSK-AES256-CBC-SHA384 ' +
    'PSK-AES256-CBC-SHA PSK-CAMELLIA256-SHA384 ECDHE-PSK-AES128-CBC-SHA256 ECDHE-PSK-AES128-CBC-SHA SRP-DSS-AES-128-CBC-SHA ' +
    'SRP-RSA-AES-128-CBC-SHA SRP-AES-128-CBC-SHA RSA-PSK-AES128-CBC-SHA256 DHE-PSK-AES128-CBC-SHA256 RSA-PSK-AES128-CBC-SHA ' +
    'DHE-PSK-AES128-CBC-SHA ECDHE-PSK-CAMELLIA128-SHA256 RSA-PSK-CAMELLIA128-SHA256 DHE-PSK-CAMELLIA128-SHA256 AES128-SHA SEED-SHA ' +
    'CAMELLIA128-SHA IDEA-CBC-SHA PSK-AES128-CBC-SHA256 PSK-AES128-CBC-SHA PSK-CAMELLIA128-SHA256 DES-CBC3-SHA ECDHE-RSA-DES-CBC3-SHA ' +
    'ECDHE-ECDSA-DES-CBC3-SHA EDH-RSA-DES-CBC3-SHA DHE-RSA-DES-CBC3-SHA').split(' ').forEach(function (w) { CIPHER_WORDS[w] = true; });
  var DEFAULT_CIPHERS = 'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:ECDHE-RSA-AES128-GCM-SHA256:' +
    'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256:' +
    'ECDHE-RSA-AES128-SHA256:DHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA384:DHE-RSA-AES256-SHA384:ECDHE-RSA-AES256-SHA256:' +
    'DHE-RSA-AES256-SHA256:HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA';

  function tlsErr(code, message, Ctor) {
    var err = new (Ctor || Error)(message);
    err.code = code;
    return err;
  }

  function u8Of(value) {
    if (typeof value === 'string') return new Uint8Array(Buffer.from(value, 'utf8'));
    if (value && value.buffer && typeof value.byteLength === 'number') {
      return new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength);
    }
    return new Uint8Array(value);
  }

  function bufOf(bytes) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  function copyBuf(bytes) {
    return Buffer.from(Uint8Array.from(bytes));
  }

  function isBytes(value) {
    return value !== null && typeof value === 'object' && typeof value.byteLength === 'number' && value.buffer !== undefined;
  }

  function latin1OfBytes(bytes) {
    return Buffer.from(u8Of(bytes)).toString('latin1');
  }

  /* ALPNProtocols: an array of strings or byte arrays, or one byte array in wire format */
  function alpnList(value) {
    if (value === undefined || value === null) return [];
    var list = [];
    if (isBytes(value)) {
      var wire = u8Of(value);
      for (var p = 0; p < wire.length;) {
        var n = wire[p];
        list.push(latin1OfBytes(wire.subarray(p + 1, p + 1 + n)));
        p += 1 + n;
      }
      return list;
    }
    if (!Array.isArray(value)) {
      throw tlsErr('ERR_INVALID_ARG_TYPE', 'The "options.ALPNProtocols" property must be an instance of Array, Buffer, TypedArray, or DataView.', TypeError);
    }
    for (var i = 0; i < value.length; i++) {
      var name = typeof value[i] === 'string' ? Buffer.from(value[i], 'utf8').toString('latin1') : latin1OfBytes(value[i]);
      if (name.length > 255) throw tlsErr('ERR_OUT_OF_RANGE', 'The byte length of the protocol at index ' + i + ' exceeds the maximum length.', RangeError);
      list.push(name);
    }
    return list;
  }

  /* PEM inputs as strings or bytes; a {pem, passphrase} key item records its passphrase in out.passphrases */
  function pemItems(value, field) {
    var out = [];
    out.passphrases = [];
    if (value === undefined || value === null) return out;
    var items = Array.isArray(value) ? value : [value];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      out.passphrases[i] = undefined;
      if (item && typeof item === 'object' && !isBytes(item) && item.pem !== undefined) {
        out.passphrases[i] = item.passphrase;
        item = item.pem;
      }
      if (typeof item !== 'string' && !isBytes(item)) {
        throw tlsErr('ERR_INVALID_ARG_TYPE', 'The "options.' + field + '" property must be of type string or an instance of Buffer, TypedArray, or DataView.', TypeError);
      }
      out.push(typeof item === 'string' ? item : u8Of(item));
    }
    return out;
  }

  function opensslErr(code, message, library, reason) {
    var err = tlsErr(code, message);
    err.library = library;
    err.reason = reason;
    return err;
  }

  function parseVersion(value, which) {
    if (value === undefined) return undefined;
    if (!Object.prototype.hasOwnProperty.call(PROTOCOL_VERSIONS, value)) {
      throw tlsErr('ERR_TLS_INVALID_PROTOCOL_VERSION', String(value) + ' is not a valid ' + which + ' TLS protocol version', TypeError);
    }
    return PROTOCOL_VERSIONS[value];
  }

  /* A value Node accepts that names only features this engine lacks: refused at once, saying so */
  function unavailable(message) {
    return tlsErr('ERR_FEATURE_UNAVAILABLE_ON_PLATFORM', message);
  }

  function noCipherMatch() {
    return opensslErr('ERR_SSL_NO_CIPHER_MATCH', 'error:0A0000B9:SSL routines::no cipher match', 'SSL routines', 'no cipher match');
  }

  /*
   * Node's processCiphers: TLS_ names are TLS 1.3 suites, the rest an OpenSSL cipher list for TLS 1.2 and below.
   * Either part that is present must select something (ERR_SSL_NO_CIPHER_MATCH otherwise). Returns the TLS 1.3
   * suites to offer, or null for the defaults. A list without TLS_ names makes Node negotiate TLS 1.2, which this
   * engine lacks, so it keeps its default TLS 1.3 suites then.
   */
  function ciphersOf(value) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') throw tlsErr('ERR_INVALID_ARG_TYPE', 'The "options.ciphers" property must be of type string.', TypeError);
    var parts = (value === '' ? DEFAULT_CIPHERS : value).split(':');
    var suites = [];
    var list = [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].length === 0) continue;
      if (parts[i].indexOf('TLS_') === 0) suites.push(parts[i]);
      else list.push(parts[i]);
    }
    if (suites.length === 0 && list.length === 0) {
      throw tlsErr('ERR_INVALID_ARG_VALUE', "The property 'options.ciphers' is invalid. Received '" + value + "'", TypeError);
    }
    var ids = [];
    if (suites.length > 0) {
      var named = false;
      for (var j = 0; j < suites.length; j++) {
        if (TLS13_SUITE_NAMES[suites[j]]) named = true;
        if (SUITE_IDS[suites[j]] && ids.indexOf(SUITE_IDS[suites[j]]) < 0) ids.push(SUITE_IDS[suites[j]]);
      }
      if (!named) throw noCipherMatch();
      if (ids.length === 0) {
        throw unavailable('ciphers ' + suites.join(':') + ' is not supported by this runtime ' +
          '(TLS 1.3 suites: TLS_AES_256_GCM_SHA384, TLS_CHACHA20_POLY1305_SHA256, TLS_AES_128_GCM_SHA256)');
      }
    }
    if (list.length > 0) {
      var words = list.join(':').split(/[:, ]+/);
      var selects = false;
      for (var w = 0; w < words.length && !selects; w++) {
        var word = words[w];
        if (!word || '!-+@'.indexOf(word.charAt(0)) >= 0) continue;
        selects = word.split('+').every(function (part) { return CIPHER_WORDS[part] === true; });
      }
      if (!selects) throw noCipherMatch();
    }
    return ids.length ? ids : null;
  }

  function curveFailed() {
    return tlsErr('ERR_CRYPTO_OPERATION_FAILED', 'Failed to set ECDH curve');
  }

  /* ecdhCurve: every name must be an OpenSSL group (else Node's ERR_CRYPTO_OPERATION_FAILED); only X25519 and P-256
     are implemented, so a list with neither is refused with a message saying so instead of falling back */
  function groupsOf(value) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') throw tlsErr('ERR_INVALID_ARG_TYPE', 'The "options.ecdhCurve" property must be of type string.', TypeError);
    if (value === '' || value === 'auto') return null;
    var tokens = value.split(/[:\/]/);
    var ids = [];
    var unsupported = [];
    for (var i = 0; i < tokens.length; i++) {
      var name = tokens[i];
      var optional = false;
      while (name.charAt(0) === '?' || name.charAt(0) === '*') {
        if (name.charAt(0) === '?') optional = true;
        name = name.slice(1);
      }
      var lower = name.toLowerCase();
      if (name === '' || GROUP_NAMES.indexOf(lower) < 0) {
        if (optional && name !== '') continue;
        throw curveFailed();
      }
      if (SUPPORTED_GROUPS[lower]) {
        if (ids.indexOf(SUPPORTED_GROUPS[lower]) < 0) ids.push(SUPPORTED_GROUPS[lower]);
      } else {
        unsupported.push(name);
      }
    }
    if (ids.length === 0) throw unavailable('ecdhCurve ' + unsupported.join(':') + ' is not supported by this runtime (groups: X25519, P-256)');
    return ids;
  }

  /* OpenSSL's signature scheme names (case-insensitive) and SIG+HASH forms; 0 marks a valid scheme this engine lacks */
  var SIGALG_NAMES = {
    ecdsa_secp256r1_sha256: 0x0403, ecdsa_secp384r1_sha384: 0x0503, ecdsa_secp521r1_sha512: 0x0603, ecdsa_sha224: 0x0303,
    ecdsa_sha1: 0x0203, ed25519: 0x0807, ed448: 0x0808, ecdsa_brainpoolp256r1tls13_sha256: 0x081a,
    ecdsa_brainpoolp384r1tls13_sha384: 0x081b, ecdsa_brainpoolp512r1tls13_sha512: 0x081c, ecdsa_brainpoolp256r1_sha256: 0,
    ecdsa_brainpoolp384r1_sha384: 0, ecdsa_brainpoolp512r1_sha512: 0, rsa_pss_rsae_sha256: 0x0804, rsa_pss_rsae_sha384: 0x0805,
    rsa_pss_rsae_sha512: 0x0806, rsa_pss_pss_sha256: 0x0809, rsa_pss_pss_sha384: 0x080a, rsa_pss_pss_sha512: 0x080b,
    rsa_pkcs1_sha256: 0x0401, rsa_pkcs1_sha384: 0x0501, rsa_pkcs1_sha512: 0x0601, rsa_pkcs1_sha224: 0x0301, rsa_pkcs1_sha1: 0x0201,
    dsa_sha256: 0x0402, dsa_sha384: 0x0502, dsa_sha512: 0x0602, dsa_sha224: 0x0302, dsa_sha1: 0x0202,
    mldsa44: 0x0904, mldsa65: 0x0905, mldsa87: 0x0906
  };
  var SIGALG_PAIRS = {
    'rsa+sha1': 0x0201, 'rsa+sha224': 0x0301, 'rsa+sha256': 0x0401, 'rsa+sha384': 0x0501, 'rsa+sha512': 0x0601,
    'rsa-pss+sha256': 0x0804, 'rsa-pss+sha384': 0x0805, 'rsa-pss+sha512': 0x0806,
    'ecdsa+sha1': 0x0203, 'ecdsa+sha224': 0x0303, 'ecdsa+sha256': 0x0403, 'ecdsa+sha384': 0x0503, 'ecdsa+sha512': 0x0603,
    'dsa+sha1': 0x0202, 'dsa+sha224': 0x0302, 'dsa+sha256': 0x0402, 'dsa+sha384': 0x0502, 'dsa+sha512': 0x0602
  };

  /*
   * sigalgs: the signature schemes offered (client) or accepted and used (server), in order. Node rejects a name OpenSSL
   * does not know with a code-less "error:00000000:lib(0)::reason(0)"; valid schemes this engine cannot make or check
   * (Ed25519, Ed448, P-521, brainpool, DSA, SHA-1/SHA-224, ML-DSA) are dropped, and a list of only those is refused.
   */
  function sigalgsOf(value) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') throw tlsErr('ERR_INVALID_ARG_TYPE', 'The "options.sigalgs" property must be of type string. Received ' + (typeof value === 'object' ? 'an instance of ' + ((value.constructor && value.constructor.name) || 'Object') : typeof value === 'function' ? 'function ' + value.name : 'type ' + typeof value + ' (' + (typeof value === 'bigint' ? value + 'n' : Object.is(value, -0) ? '-0' : String(value)) + ')'), TypeError);
    if (value === '') throw tlsErr('ERR_INVALID_ARG_VALUE', "The property 'options.sigalgs' is invalid. Received ''", TypeError);
    var parts = value.split(':');
    var codes = [];
    var dropped = [];
    for (var i = 0; i < parts.length; i++) {
      var name = parts[i].trim();
      var lower = name.toLowerCase();
      var code;
      if (lower.indexOf('+') >= 0) {
        if (lower.indexOf('pss+') === 0) lower = 'rsa-' + lower;
        code = Object.prototype.hasOwnProperty.call(SIGALG_PAIRS, lower) ? SIGALG_PAIRS[lower] : undefined;
      } else {
        code = Object.prototype.hasOwnProperty.call(SIGALG_NAMES, lower) ? SIGALG_NAMES[lower] : undefined;
      }
      if (code === undefined) throw new Error('error:00000000:lib(0)::reason(0)');
      if (code && ENGINE.sigSchemeSupported(code)) {
        if (codes.indexOf(code) < 0) codes.push(code);
      } else {
        dropped.push(name);
      }
    }
    if (codes.length === 0) {
      throw unavailable('sigalgs ' + dropped.join(':') + ' is not supported by this runtime ' +
        '(schemes: ECDSA P-256/P-384 with SHA-256/SHA-384, RSA-PSS and RSA PKCS#1 with SHA-256/384/512)');
    }
    return codes;
  }

  function keyUnsupported() {
    return opensslErr('ERR_OSSL_UNSUPPORTED', 'error:1E08010C:DECODER routines::unsupported', 'DECODER routines', 'unsupported');
  }

  /*
   * One key item: PKCS#8, PKCS#1 or SEC1 PEM; anything else is OpenSSL's DECODER "unsupported", as in Node. Encrypted
   * keys cannot be decrypted here: without a passphrase this is Node's own failure (bad decrypt); with one, a clear
   * not-supported error.
   */
  function keyOf(item, passphrase) {
    var text = typeof item === 'string' ? item : Buffer.from(item).toString('latin1');
    if (/-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(text) || /Proc-Type: *4, *ENCRYPTED/.test(text)) {
      if (passphrase === undefined || passphrase === null) {
        throw opensslErr('ERR_OSSL_BAD_DECRYPT', 'error:1C800064:Provider routines::bad decrypt', 'Provider routines', 'bad decrypt');
      }
      throw tlsErr('ERR_OSSL_UNSUPPORTED', 'encrypted private keys are not supported by this runtime (passphrase-protected PEM)');
    }
    var loaded;
    try {
      loaded = ENGINE.loadPem(item);
    } catch (failure) {
      throw keyUnsupported();
    }
    if (!loaded.key) throw keyUnsupported();
    return loaded.key;
  }

  function certParseError(der) {
    if (!der || der.length === 0 || der[0] !== 0x30) {
      return opensslErr('ERR_OSSL_ASN1_WRONG_TAG', 'error:0680007B:asn1 encoding routines::wrong tag', 'asn1 encoding routines', 'wrong tag');
    }
    return opensslErr('ERR_OSSL_ASN1_HEADER_TOO_LONG', 'error:0680009B:asn1 encoding routines::header too long', 'asn1 encoding routines', 'header too long');
  }

  /* One cert item: the certificates of a PEM text, each parsed (a chain: leaf first) */
  function chainOf(item) {
    var ders = ENGINE.loadPem(item).certs;
    if (ders.length === 0) throw opensslErr('ERR_OSSL_PEM_NO_START_LINE', 'error:0480006C:PEM routines::no start line', 'PEM routines', 'no start line');
    var parsed = [];
    for (var i = 0; i < ders.length; i++) {
      try {
        parsed.push(ENGINE.parseCertificate(ders[i]));
      } catch (failure) {
        throw certParseError(ders[i]);
      }
    }
    return { ders: ders, leaf: parsed[0] };
  }

  /*
   * The parsed state behind a tls.SecureContext. As OpenSSL keeps one certificate and key per key type (RSA, RSA-PSS,
   * EC), certificates go to their slot first and keys after; a key whose slot holds a certificate must belong to it
   * (ERR_OSSL_X509_KEY_VALUES_MISMATCH otherwise), while an RSA key with an EC certificate fills different slots and
   * fails later, at the handshake, as in Node. CA items load their certificates up to the first one that does not
   * parse, which is skipped silently, as Node's PEM_read_bio_X509_AUX loop does.
   */
  function ContextState(options) {
    var opts = options || {};
    if (opts.pfx !== undefined && opts.pfx !== null) throw tlsErr('ERR_TLS_PFX_UNSUPPORTED', 'pfx (PKCS#12) is not supported by this runtime');
    this.suites = ciphersOf(opts.ciphers);
    this.sigalgs = sigalgsOf(opts.sigalgs);
    var groups = groupsOf(opts.ecdhCurve);
    this.groups = groups;
    this.keyShareGroups = groups ? [groups[0]] : null;
    var minV = parseVersion(opts.minVersion, 'minimum');
    var maxV = parseVersion(opts.maxVersion, 'maximum');
    if (opts.secureProtocol !== undefined) {
      var sp = String(opts.secureProtocol);
      if (/^TLSv1_3/.test(sp)) minV = maxV = 4;
      else if (/^(TLSv1_2|TLSv1_1|TLSv1|SSLv3)_/.test(sp)) minV = maxV = 3;
    }
    if (minV !== undefined && maxV !== undefined && minV > maxV) {
      throw tlsErr('ERR_TLS_PROTOCOL_VERSION_CONFLICT', 'TLS protocol version ' + opts.minVersion + ' conflicts with secureProtocol', TypeError);
    }
    this.noProtocols = maxV !== undefined && maxV < 4;
    this.honorCipherOrder = !!opts.honorCipherOrder;
    this.allowPartialTrustChain = opts.allowPartialTrustChain === true;
    this.anchors = [];
    var caItems = pemItems(opts.ca, 'ca');
    for (var a = 0; a < caItems.length; a++) {
      var caDers;
      try {
        caDers = ENGINE.loadPem(caItems[a]).certs;
      } catch (failure) {
        caDers = [];
      }
      for (var x = 0; x < caDers.length; x++) {
        try {
          this.anchors.push(ENGINE.parseCertificate(caDers[x]));
        } catch (failure) {
          break;
        }
      }
    }
    var slots = {};
    var order = [];
    var slotOf = function (name) {
      if (!slots[name]) {
        slots[name] = {};
        order.push(name);
      }
      return slots[name];
    };
    var certItems = pemItems(opts.cert, 'cert');
    for (var c = 0; c < certItems.length; c++) {
      var chain = chainOf(certItems[c]);
      var cslot = slotOf(ENGINE.keySlot(chain.leaf.spki.type, chain.leaf.spki.oid));
      cslot.certificates = chain.ders;
      cslot.leaf = chain.leaf;
    }
    var keyItems = pemItems(opts.key, 'key');
    for (var k = 0; k < keyItems.length; k++) {
      var key = keyOf(keyItems[k], keyItems.passphrases[k] !== undefined ? keyItems.passphrases[k] : opts.passphrase);
      var kslot = slotOf(ENGINE.keySlot(key.type));
      if (kslot.leaf && !ENGINE.keyMatchesCertificate(callCap, key, kslot.leaf)) {
        throw opensslErr('ERR_OSSL_X509_KEY_VALUES_MISMATCH', 'error:05800074:x509 certificate routines::key values mismatch',
          'x509 certificate routines', 'key values mismatch');
      }
      kslot.privateKey = key;
    }
    this.contexts = [];
    for (var o = 0; o < order.length; o++) {
      var slot = slots[order[o]];
      /* as OpenSSL does when cert holds no chain: the issuers found in ca are sent after the leaf */
      if (slot.certificates && slot.privateKey) {
        this.contexts.push({ certificates: ENGINE.autoChain(slot.certificates, this.anchors), privateKey: slot.privateKey, leaf: slot.leaf });
      }
    }
  }

  /* Node's tls.SecureContext: what createSecureContext() returns; .context holds the parsed state */
  function SecureContext(options) {
    if (!(this instanceof SecureContext)) return new SecureContext(options);
    this.context = new ContextState(options);
  }

  function createSecureContext(options) {
    return new SecureContext(options);
  }

  function stateOf(value) {
    if (value instanceof SecureContext) return value.context;
    if (value && value.context instanceof ContextState) return value.context;
    if (value instanceof ContextState) return value;
    return null;
  }

  function contextOf(options) {
    var given = options ? stateOf(options.secureContext) : null;
    return given || new ContextState(options);
  }

  function checkServerIdentity(hostname, cert) {
    return ENGINE.checkServerIdentity(hostname, cert);
  }

  function emitKeylog(socket, level) {
    var server = socket._tlsServer;
    var wantSocket = socket.listenerCount('keylog') > 0;
    var wantServer = server && server.listenerCount('keylog') > 0;
    if (!wantSocket && !wantServer) return;
    var lines = socket._tls.keylogLines(level);
    for (var i = 0; i < lines.length; i++) {
      var line = Buffer.from(lines[i], 'latin1');
      if (wantSocket) socket.emit('keylog', line);
      if (wantServer) server.emit('keylog', line, socket);
    }
  }

  function TLSStreamWrap(stream) {
    this.stream = stream;
  }

  class TLSSocket extends net.Socket {
    constructor(socket, options) {
      var opts = options || {};
      super({ allowHalfOpen: !!opts.allowHalfOpen });
      this.encrypted = true;
      this.authorized = false;
      this.authorizationError = null;
      this.alpnProtocol = false;
      this.servername = false;
      this.secureConnecting = true;
      this._handle = { _parentWrap: { constructor: TLSStreamWrap } };
      this._tls = null;
      this._tlsRole = opts.isServer ? 'server' : 'client';
      this._tlsCfg = null;
      this._tlsServer = opts.server || null;
      this._tlsCtx = stateOf(opts.secureContext);
      this._tlsDone = false;
      /* set once the handshake is done and the peer accepted: later TLS failures are the socket's 'error' event */
      this._tlsSecure = false;
      /* the TLS session failed after it was secure: no more records are read or written */
      this._tlsBroken = false;
      this._tlsHadError = false;
      this._tlsEndQueued = false;
      this._tlsStarted = false;
      this._tlsWaiting = [];
      this._tlsFinal = null;
      this._tlsPeerClosed = false;
      this._tlsClosed = false;
      this._tlsPeerDers = null;
      this._tlsCipher = null;
      this._tlsGroup = null;
      this._tlsTimer = null;
      this._tlsWrapped = null;
      if (socket && typeof socket.on === 'function') {
        this._tlsWrap(socket, opts);
        if (!opts.isServer && !opts._owcConnect) {
          /* a bare client TLSSocket, as in Node: no handshake until _start(); the chain is checked but nothing is
             rejected and no identity check runs */
          this._tlsClientSetup(Object.assign({}, opts, { socket: socket, rejectUnauthorized: false, checkServerIdentity: function () {} }));
        }
      }
    }

    _tlsClientSetup(opts) {
      var ctx = this._tlsCtx || contextOf(opts);
      this._tlsCtx = ctx;
      var servername = typeof opts.servername === 'string' && opts.servername !== '' ? opts.servername : undefined;
      var socketHost = opts.socket && opts.socket._host;
      this._tlsRole = 'client';
      this._tlsCfg = {
        ctx: ctx,
        anchors: ctx.anchors,
        host: opts.host,
        port: opts.port,
        identityHost: servername || opts.host || socketHost || 'localhost',
        checkServerIdentity: typeof opts.checkServerIdentity === 'function' ? opts.checkServerIdentity : checkServerIdentity,
        rejectUnauthorized: opts.rejectUnauthorized !== false,
        noProtocols: ctx.noProtocols
      };
      this._tls = ENGINE.createEngine({
        role: 'client',
        cap: callCap,
        serverName: servername && !ENGINE.isIP(servername) ? servername : null,
        hostname: null,
        anchors: ctx.anchors,
        allowPartialTrustChain: ctx.allowPartialTrustChain,
        ALPNProtocols: alpnList(opts.ALPNProtocols),
        contexts: ctx.contexts,
        suites: ctx.suites,
        groups: ctx.groups,
        keyShareGroups: ctx.keyShareGroups,
        sigalgs: ctx.sigalgs
      });
      if (servername) this.servername = servername;
    }

    /* A caller-supplied socket (or any duplex) carries the TLS bytes: new TLSSocket(socket) and tls.connect({socket}) */
    _tlsWrap(socket, opts) {
      var self = this;
      this._tlsWrapped = socket;
      this.connecting = !!socket.connecting;
      if (socket.connecting) {
        socket.once('connect', function () {
          self.connecting = false;
          if (!self._dead) self.emit('connect');
        });
      }
      socket.on('data', function (chunk) {
        if (!self._dead && self._tls) {
          self.bytesRead += chunk.length;
          self._tlsFeed(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        }
      });
      socket.on('end', function () { self._onRemoteEnd(); });
      socket.on('error', function (err) { if (!self._dead) self._tlsFail(err); });
      /* as for a hub connection: a close waits until the consumer has read the queued data and end */
      socket.on('close', function () {
        if (!self._dead) self._onRemoteClose();
      });
      if (opts.isServer) {
        this._tlsRole = 'server';
        this._tlsServerSetup(Object.assign({}, opts, { alpn: alpnList(opts.ALPNProtocols) }));
      }
    }

    get remoteAddress() {
      return this._tlsWrapped ? this._tlsWrapped.remoteAddress : this._remoteAddress;
    }

    set remoteAddress(value) {
      this._remoteAddress = value;
    }

    get remotePort() {
      return this._tlsWrapped ? this._tlsWrapped.remotePort : this._remotePort;
    }

    set remotePort(value) {
      this._remotePort = value;
    }

    get remoteFamily() {
      return this._tlsWrapped ? this._tlsWrapped.remoteFamily : this._remoteFamily;
    }

    set remoteFamily(value) {
      this._remoteFamily = value;
    }

    get readyState() {
      if (this._tlsWrapped) return this._dead ? 'closed' : this._tlsWrapped.readyState;
      return super.readyState;
    }

    address() {
      if (this._tlsWrapped) return this._tlsWrapped.address();
      return super.address();
    }

    _onConnectEvent() {
      super._onConnectEvent();
      this._tlsStartClient();
    }

    /* Node's internal start of a client handshake, used by callers that build a bare TLSSocket */
    _start() {
      this._tlsStartClient();
    }

    _tlsStartClient() {
      if (this._tlsRole === 'client' && this._tls && !this._tlsStarted && !this._dead) {
        this._tlsStarted = true;
        if (this._tlsCfg.noProtocols) {
          this._tlsFail(Object.assign(tlsErr('ERR_SSL_NO_PROTOCOLS_AVAILABLE', 'no protocols available'), { library: 'SSL routines', reason: 'no protocols available' }));
          return;
        }
        this._tlsSend(this._tls.start());
        this._tlsHandleEvents(this._tls._drain());
      }
    }

    _onChunk(chunk) {
      if (this._dead || !this._tls) return;
      this.bytesRead += chunk.length;
      this._armIdle();
      this._tlsFeed(chunk);
    }

    /*
     * The peer's end of the stream (TCP FIN, or close_notify). Before the handshake completes a server reports
     * 'socket hang up' through tlsClientError; a client emits 'end' as Node does, and tls.connect's end listener
     * (onConnectEnd) turns that into ECONNRESET.
     */
    _onRemoteEnd() {
      if (this._dead || this._tlsEndQueued) return;
      if (!this._tlsDone && this._tlsRole === 'server') {
        this._tlsFail(tlsErr('ECONNRESET', 'socket hang up'));
        return;
      }
      this._tlsEndQueued = true;
      if (this._tlsWrapped) {
        this._readQueue.push({ end: true });
        this._scheduleRead();
        return;
      }
      super._onRemoteEnd();
    }

    _onRemoteClose() {
      if (this._dead) return;
      if (!this._tlsDone) this._onRemoteEnd();
      super._onRemoteClose();
    }

    /* after the queued data reached the listeners, the records the engine held back (a failure behind that data) run */
    _drainReadQueue() {
      super._drainReadQueue();
      if (!this._dead && this._tls && this._tls.inputDeferred) this._tlsFeed(new Uint8Array(0));
    }

    _tlsSend(bytes) {
      if (!bytes || bytes.length === 0) return;
      if (this._tlsWrapped) {
        if (!this._tlsWrapped.destroyed) this._tlsWrapped.write(copyBuf(bytes));
        return;
      }
      this._sendChunk(bufOf(bytes));
    }

    _tlsEndTransport() {
      if (this._tlsWrapped) {
        if (!this._tlsWrapped.destroyed) this._tlsWrapped.end();
        return;
      }
      this._sendEnd();
    }

    _tlsFeed(chunk) {
      if (this._tlsBroken) return;
      /* while the listeners are reading (flowing), a TLS failure waits until the data ahead of it has reached them, so
         what they write in response goes out before the alert, as with Node's record-by-record reads */
      var flowing = this.readableFlowing !== undefined ? this.readableFlowing === true : this._flowing === true;
      this._tls.deferFailures = this._tlsSecure && flowing;
      this._tls.undeliveredData = this._readQueue.some(function (item) { return item.chunk !== undefined; });
      var events = this._tls.receive(u8Of(chunk));
      var out = this._tls.takeOutput();
      var completing = false;
      for (var i = 0; i < events.length && !completing; i++) completing = events[i].type === 'connected';
      /* A client's last flight waits for its certificate verdict: on a rejected chain Node destroys the
         socket before its Finished reaches the server, so the server never completes the handshake. */
      if (completing && this._tlsRole === 'client') this._tlsHeldOut = out;
      else this._tlsSend(out);
      this._tlsHandleEvents(events);
    }

    _tlsHandleEvents(events) {
      var pushed = false;
      for (var i = 0; i < events.length && !this._dead; i++) {
        var ev = events[i];
        if (ev.type === 'data') {
          this._readQueue.push({ chunk: bufOf(ev.bytes) });
          pushed = true;
        } else if (ev.type === 'close_notify') {
          this._tlsPeerClosed = true;
          if (!this._tlsDone && this._tlsRole === 'server') {
            this._tlsFail(tlsErr('ECONNRESET', 'socket hang up'));
          } else if (!this._tlsEndQueued) {
            this._tlsEndQueued = true;
            this._readQueue.push({ end: true });
            pushed = true;
          }
        } else if (ev.type === 'secrets') {
          emitKeylog(this, ev.level);
        } else if (ev.type === 'clienthello') {
          this._tlsSni(ev.serverName);
        } else if (ev.type === 'connected') {
          this._tlsConnected(ev);
        } else if (ev.type === 'error') {
          /* an exception from user code (ALPNCallback) is reported as it was thrown */
          var err = ev.original || tlsErr(ev.code, ev.message);
          if (!ev.original && ev.reason) {
            err.library = ev.library;
            err.reason = ev.reason;
          }
          this._tlsProtocolError(err, ev.received === true);
        }
      }
      if (pushed && !this._dead) this._scheduleRead();
    }

    /* Server: picks the certificate context for the client's server_name, as Node's SNICallback does */
    _tlsSni(serverName) {
      var self = this;
      var server = this._tlsServer;
      this.servername = serverName === null ? false : serverName;
      var done = false;
      var answer = function (err, ctx) {
        if (done || self._dead) return;
        done = true;
        if (err) {
          self._tlsFail(err);
          return;
        }
        /* as Node's loadSNI: a context from the callback replaces the server's; without a certificate for the
           client's signature algorithms the engine fails the handshake as OpenSSL does */
        var use = stateOf(ctx) || self._tlsCtx;
        var events = self._tls.resume(use ? use.contexts : []);
        self._tlsSend(self._tls.takeOutput());
        self._tlsHandleEvents(events);
      };
      if (serverName === null || !server || typeof server._sniCallback !== 'function') {
        answer(null, null);
        return;
      }
      try {
        server._sniCallback.call({ server: server }, serverName, answer);
      } catch (failure) {
        answer(failure);
      }
    }

    _tlsConnected(ev) {
      var self = this;
      this._tlsDone = true;
      this.secureConnecting = false;
      this._tlsCipher = ev.cipherName;
      this._tlsGroup = ev.group;
      this._tlsPeerDers = ev.peerCertificates && ev.peerCertificates.length > 0 ? ev.peerCertificates : null;
      this.alpnProtocol = ev.alpnProtocol || false;
      if (this._tlsTimer) {
        clearTimeout(this._tlsTimer);
        this._tlsTimer = null;
      }
      if (this._tlsRole === 'client') {
        var cfg = this._tlsCfg;
        var verdict = ev.peerVerify;
        var error = verdict.authorized ? null : verdict.error;
        if (!error) {
          try {
            var identity = cfg.checkServerIdentity(cfg.identityHost, this.getPeerCertificate(true));
            if (identity) error = identity;
          } catch (failure) {
            error = failure;
          }
        }
        var held = this._tlsHeldOut;
        this._tlsHeldOut = null;
        if (error) {
          this.authorized = false;
          this.authorizationError = error.code || error.message;
          if (cfg.rejectUnauthorized) {
            this.destroy(error);
            return;
          }
        } else {
          this.authorized = true;
        }
        this._tlsSecure = true;
        if (this._tlsOnConnectEnd) {
          this.removeListener('end', this._tlsOnConnectEnd);
          this._tlsOnConnectEnd = null;
        }
        this._tlsSend(held);
        this._tlsFlushWrites();
        queueMicrotask(function () {
          if (self._dead) return;
          self.emit('secure');
          self.emit('secureConnect');
        });
        return;
      }
      var server = this._tlsServer;
      this.servername = ev.peerServerName === null || ev.peerServerName === undefined ? false : ev.peerServerName;
      if (this._tlsServerOpts && this._tlsServerOpts.requestCert) {
        var v = ev.peerVerify;
        if (v.authorized) {
          this.authorized = true;
        } else {
          this.authorizationError = v.authorizationError;
          if (this._tlsServerOpts.rejectUnauthorized) {
            this._tlsFail(tlsErr('ECONNRESET', 'socket hang up'));
            return;
          }
        }
      }
      this._tlsSecure = true;
      this._tlsFlushWrites();
      queueMicrotask(function () {
        if (self._dead) return;
        self.emit('secure');
        if (server) server.emit('secureConnection', self);
      });
    }

    _tlsFlushWrites() {
      var waiting = this._tlsWaiting;
      this._tlsWaiting = [];
      for (var i = 0; i < waiting.length && !this._dead; i++) this._tlsWrite(waiting[i].chunk, waiting[i].callback);
      if (this._tlsFinal && !this._dead) {
        var finish = this._tlsFinal;
        this._tlsFinal = null;
        finish();
      }
    }

    _tlsWrite(chunk, callback) {
      if (this._tlsBroken) {
        /* after its own fatal alert Node's TLSWrap fails a write with EPROTO, and the stream is destroyed with it; after a
           received fatal alert Node's write never completes, which is not reproduced: the write is dropped */
        if (this._tlsSentAlert) {
          var eproto = new Error('write EPROTO');
          var errno = requireBuiltin('os').constants;
          eproto.errno = -((errno && errno.errno && errno.errno.EPROTO) || 71);
          eproto.code = 'EPROTO';
          eproto.syscall = 'write';
          callback(eproto);
          return;
        }
        callback();
        return;
      }
      this.bytesWritten += chunk.length;
      this._armIdle();
      try {
        this._tlsSend(this._tls.write(u8Of(chunk)));
      } catch (failure) {
        callback(failure);
        return;
      }
      callback();
    }

    _tlsFail(err) {
      if (this._dead) return;
      if (this._tlsTimer) {
        clearTimeout(this._tlsTimer);
        this._tlsTimer = null;
      }
      if (this._tls && !this._tlsBroken) this._tlsSend(this._tls.takeOutput());
      if (this._tlsRole === 'server' && !this._tlsSecure) {
        this.destroy();
        this._tlsClientError(err);
        return;
      }
      this.destroy(err);
    }

    /*
     * A TLS failure from the engine (a bad record, a received fatal alert, ...). Before the connection is secure it
     * fails the handshake. Afterwards, as Node's onerror does once control is released, the alert goes out, the socket
     * emits 'error' once and is not destroyed: 'end' and close(hadError=false) follow when the peer closes.
     */
    _tlsProtocolError(err, received) {
      if (!this._tlsSecure) {
        this._tlsFail(err);
        return;
      }
      if (this._tlsBroken) return;
      this._tlsSend(this._tls.takeOutput());
      this._tlsBroken = true;
      this._tlsSentAlert = !received;
      if (this._tlsHadError) return;
      this._tlsHadError = true;
      var self = this;
      /* after 'secureConnection'/'secureConnect', which are queued the same way */
      queueMicrotask(function () {
        if (!self._dead) self.emit('error', err);
      });
    }

    /* A server socket reports at most one error before the handshake completes, as Node does */
    _tlsClientError(err) {
      if (this._tlsErrorEmitted) return;
      this._tlsErrorEmitted = true;
      if (this._tlsServer) this._tlsServer.emit('tlsClientError', err, this);
    }

    _tlsServerSetup(serverOpts) {
      var server = serverOpts.server;
      var ctx = this._tlsCtx || (server && server._tlsCtx) || contextOf(serverOpts);
      this._tlsCtx = ctx;
      this._tlsServer = server || null;
      this._tlsServerOpts = serverOpts;
      var defer = !!(server && (typeof server._sniCallback === 'function'));
      if (ctx && ctx.noProtocols) {
        var self0 = this;
        queueMicrotask(function () { self0._tlsFail(tlsErr('ERR_SSL_NO_PROTOCOLS_AVAILABLE', 'no protocols available')); });
      }
      var alpnCallback = typeof serverOpts.ALPNCallback === 'function' ? serverOpts.ALPNCallback : null;
      var socket = this;
      this._tls = ENGINE.createEngine({
        role: 'server',
        cap: callCap,
        /* Node calls ALPNCallback({ servername, protocols }) and expects one of the protocols or undefined */
        alpnCallback: alpnCallback ? function (serverName, protocols) {
          return alpnCallback.call(socket, { servername: serverName === null || serverName === undefined ? false : serverName, protocols: protocols });
        } : null,
        contexts: ctx ? ctx.contexts : [],
        deferContext: defer || !ctx || ctx.contexts.length === 0,
        ALPNProtocols: serverOpts.alpn || [],
        requestCert: !!serverOpts.requestCert,
        rejectUnauthorized: serverOpts.rejectUnauthorized !== false,
        anchors: ctx ? ctx.anchors : [],
        allowPartialTrustChain: ctx ? ctx.allowPartialTrustChain : false,
        suites: ctx ? ctx.suites : null,
        groups: ctx ? ctx.groups : null,
        sigalgs: ctx ? ctx.sigalgs : null,
        /* a tls.Server passes its own setting; a bare server TLSSocket has its context's (createSecureContext: off) */
        honorCipherOrder: typeof serverOpts.honorCipherOrder === 'boolean' ? serverOpts.honorCipherOrder : (ctx ? ctx.honorCipherOrder : false)
      });
      var timeout = serverOpts.handshakeTimeout === undefined ? 120000 : Number(serverOpts.handshakeTimeout);
      if (timeout > 0) {
        var self = this;
        /* Node 24 reports the timeout as tlsClientError and leaves the connection open */
        this._tlsTimer = setTimeout(function () {
          self._tlsTimer = null;
          if (!self._tlsDone && !self._dead) self._tlsClientError(tlsErr('ERR_TLS_HANDSHAKE_TIMEOUT', 'TLS handshake timeout'));
        }, timeout);
        if (this._tlsTimer && typeof this._tlsTimer.unref === 'function') this._tlsTimer.unref();
      }
    }

    getPeerCertificate(detailed) {
      if (!this._tlsDone || !this._tlsPeerDers) return {};
      var anchors = this._tlsRole === 'client' ? this._tlsCfg.anchors : (this._tlsCtx ? this._tlsCtx.anchors : []);
      return ENGINE.certificateObject(callCap, this._tlsPeerDers, anchors, !!detailed, copyBuf);
    }

    getCertificate() {
      var ctx = this._tlsRole === 'client' ? this._tlsCfg && this._tlsCfg.ctx : this._tlsCtx;
      var own = this._tls && this._tls.selected ? this._tls.selected : (ctx && ctx.contexts.length ? ctx.contexts[0] : null);
      if (!own) return {};
      return ENGINE.certificateObject(callCap, own.certificates, [], false, copyBuf);
    }

    getPeerX509Certificate() {
      var X509 = requireBuiltin('crypto').X509Certificate;
      if (!this._tlsPeerDers || typeof X509 !== 'function') return undefined;
      return new X509(copyBuf(this._tlsPeerDers[0]));
    }

    getX509Certificate() {
      var X509 = requireBuiltin('crypto').X509Certificate;
      var own = this._tls && this._tls.selected;
      if (!own || typeof X509 !== 'function') return undefined;
      return new X509(copyBuf(own.certificates[0]));
    }

    getProtocol() {
      if (this._tlsDone && !this._dead) return 'TLSv1.3';
      if (this._dead) return null;
      return 'unknown';
    }

    getCipher() {
      if (!this._tlsDone) return null;
      return { name: this._tlsCipher, standardName: this._tlsCipher, version: 'TLSv1.3' };
    }

    getEphemeralKeyInfo() {
      if (this._tlsRole === 'server') return null;
      if (!this._tlsDone || !this._tlsGroup) return {};
      return { type: 'ECDH', name: ENGINE.GROUP_NAMES[this._tlsGroup], size: ENGINE.GROUP_BITS[this._tlsGroup] };
    }

    getFinished() {
      return this._tls && this._tls.verifyData ? copyBuf(this._tls.verifyData) : undefined;
    }

    getPeerFinished() {
      return this._tls && this._tls.peerVerifyData ? copyBuf(this._tls.peerVerifyData) : undefined;
    }

    getSharedSigalgs() {
      return [];
    }

    getSession() {
      return undefined;
    }

    getTLSTicket() {
      return undefined;
    }

    isSessionReused() {
      return false;
    }

    setSession() {}

    exportKeyingMaterial(length, label, context) {
      if (typeof length !== 'number' || !Number.isInteger(length) || length < 0) {
        throw tlsErr('ERR_INVALID_ARG_TYPE', 'The "length" argument must be of type number.', TypeError);
      }
      if (typeof label !== 'string') throw tlsErr('ERR_INVALID_ARG_TYPE', 'The "label" argument must be of type string.', TypeError);
      if (!this._tlsDone) throw tlsErr('ERR_TLS_INVALID_STATE', 'TLS socket connection must be securely established');
      return copyBuf(this._tls.exportKeyingMaterial(label, context === undefined ? undefined : u8Of(context), length));
    }

    setServername(name) {
      if (typeof name !== 'string') throw tlsErr('ERR_INVALID_ARG_TYPE', 'The "name" argument must be of type string.', TypeError);
      if (this._tlsRole === 'server') throw tlsErr('ERR_TLS_SNI_FROM_SERVER', 'Cannot issue SNI from a TLS server-side socket');
      this.servername = name;
      if (this._tls && !this._tlsStarted) this._tls.serverName = name === '' || ENGINE.isIP(name) ? null : name;
    }

    setMaxSendFragment(size) {
      if (typeof size !== 'number') throw tlsErr('ERR_INVALID_ARG_TYPE', 'The "size" argument must be of type number.', TypeError);
      return size >= 512 && size <= 16384;
    }

    renegotiate(options, callback) {
      var cb = typeof options === 'function' ? options : callback;
      var err = tlsErr('ERR_TLS_RENEGOTIATION_DISABLED', 'TLS session renegotiation disabled for this socket');
      if (typeof cb === 'function') process.nextTick(cb, err);
      return false;
    }

    disableRenegotiation() {}

    enableTrace() {}
  }

  TLSSocket.prototype._write = function (chunk, encoding, callback) {
    if (this._dead) {
      callback();
      return;
    }
    if (!this._tlsDone) {
      this._tlsWaiting.push({ chunk: chunk, callback: callback });
      return;
    }
    this._tlsWrite(chunk, callback);
  };

  TLSSocket.prototype._final = function (callback) {
    var self = this;
    var finish = function () {
      if (self._tlsDone && !self._tlsClosed && !self._dead && !self._tlsBroken) {
        self._tlsClosed = true;
        self._tlsSend(self._tls.closeNotify());
      }
      self._wFinished = true;
      self._tlsEndTransport();
      callback();
    };
    if (this._tlsDone || this._dead || !this._tls || this._tlsEndQueued) finish();
    else this._tlsFinal = finish;
  };

  var baseDestroy = TLSSocket.prototype._destroy;
  TLSSocket.prototype._destroy = function (error, callback) {
    if (this._tlsTimer) {
      clearTimeout(this._tlsTimer);
      this._tlsTimer = null;
    }
    if (this._tlsWrapped && !this._tlsWrapped.destroyed) this._tlsWrapped.destroy();
    return baseDestroy.call(this, error, callback);
  };

  class TLSServer extends net.Server {
    constructor(options, listener) {
      var opts = typeof options === 'function' ? {} : (options || {});
      super({ allowHalfOpen: !!opts.allowHalfOpen, pauseOnConnect: !!opts.pauseOnConnect });
      if (typeof options === 'function') listener = options;
      if (opts.ALPNCallback && opts.ALPNProtocols) {
        throw tlsErr('ERR_TLS_ALPN_CALLBACK_WITH_PROTOCOLS', 'The ALPNCallback and ALPNProtocols TLS options are mutually exclusive', TypeError);
      }
      this._tlsOpts = {
        alpn: alpnList(opts.ALPNProtocols),
        /* Node's tls.Server: the server's cipher (and signature scheme) order unless honorCipherOrder is false */
        honorCipherOrder: opts.honorCipherOrder !== undefined ? !!opts.honorCipherOrder : true,
        ALPNCallback: opts.ALPNCallback || null,
        requestCert: opts.requestCert === true,
        rejectUnauthorized: opts.rejectUnauthorized !== false,
        handshakeTimeout: opts.handshakeTimeout
      };
      this._contexts = [];
      this._tlsCtx = contextOf(opts);
      this._sniCallback = typeof opts.SNICallback === 'function' ? opts.SNICallback : null;
      if (opts.SNICallback !== undefined && typeof opts.SNICallback !== 'function') {
        throw tlsErr('ERR_INVALID_ARG_TYPE', 'The "options.SNICallback" property must be of type function.', TypeError);
      }
      if (typeof listener === 'function') this.on('secureConnection', listener);
    }

    _makeSocket() {
      var socket = new TLSSocket(undefined, { allowHalfOpen: this._serverOpts.allowHalfOpen, isServer: true, server: this });
      socket._tlsServerSetup(Object.assign({ server: this }, this._tlsOpts));
      return socket;
    }

    _emitAccepted(socket) {
      this.emit('connection', socket);
    }

    addContext(hostname, context) {
      if (typeof hostname !== 'string') throw tlsErr('ERR_INVALID_ARG_TYPE', 'The "servername" argument must be of type string.', TypeError);
      var re = new RegExp('^' + hostname.replace(/([.^$+?\-\\[\]{}])/g, '\\$1').replace(/\*/g, '[^.]*') + '$');
      var ctx = stateOf(context) ? context : createSecureContext(context);
      this._contexts.push([re, ctx]);
      if (!this._sniCallback) this._sniCallback = defaultSniCallback;
    }

    setSecureContext(options) {
      this._tlsCtx = contextOf(options);
      if (options && options.ALPNProtocols !== undefined) this._tlsOpts.alpn = alpnList(options.ALPNProtocols);
      this._tlsOpts.honorCipherOrder = options && options.honorCipherOrder !== undefined ? !!options.honorCipherOrder : true;
    }

    getTicketKeys() {
      return Buffer.alloc(48);
    }

    setTicketKeys() {}
  }

  function defaultSniCallback(servername, callback) {
    var contexts = this.server._contexts;
    for (var i = contexts.length - 1; i >= 0; --i) {
      if (contexts[i][0].test(servername)) {
        callback(null, contexts[i][1]);
        return;
      }
    }
    callback(null, undefined);
  }

  function normalizeConnectArgs(args) {
    var list = Array.prototype.slice.call(args);
    var cb = typeof list[list.length - 1] === 'function' ? list.pop() : undefined;
    var opts;
    if (list[0] !== null && typeof list[0] === 'object') {
      opts = Object.assign({}, list[0]);
    } else {
      opts = {};
      if (typeof list[0] === 'string' && !/^\d+$/.test(list[0])) opts.path = list[0];
      else {
        opts.port = list[0];
        if (typeof list[1] === 'string') opts.host = list[1];
      }
    }
    if (list[1] !== null && typeof list[1] === 'object') Object.assign(opts, list[1]);
    else if (list[2] !== null && typeof list[2] === 'object') Object.assign(opts, list[2]);
    return { opts: opts, cb: cb };
  }

  function tlsConnect() {
    var args = normalizeConnectArgs(arguments);
    var allowUnauthorized = process && process.env && process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0';
    var opts = Object.assign({ rejectUnauthorized: !allowUnauthorized, checkServerIdentity: checkServerIdentity, minDHSize: 1024 }, args.opts);
    if (typeof opts.checkServerIdentity !== 'function') {
      throw tlsErr('ERR_INVALID_ARG_TYPE', 'The "options.checkServerIdentity" property must be of type function.', TypeError);
    }
    if (opts.path !== undefined && !opts.socket) throw tlsErr('ERR_NOT_SUPPORTED', 'Unix domain sockets are not supported by this runtime');
    var socket = new TLSSocket(opts.socket, { allowHalfOpen: !!opts.allowHalfOpen, secureContext: { context: contextOf(opts) }, _owcConnect: true });
    socket._tlsClientSetup(opts);
    /* Node's onConnectEnd: the peer ending the stream before the handshake completes is ECONNRESET, after 'end' */
    socket._tlsOnConnectEnd = function () {
      if (this._tlsHadError) return;
      this._tlsHadError = true;
      var err = tlsErr('ECONNRESET', 'Client network socket disconnected before secure TLS connection was established');
      err.path = opts.path;
      err.host = opts.host;
      err.port = opts.port;
      err.localAddress = opts.localAddress;
      this.destroy(err);
    };
    socket.prependListener('end', socket._tlsOnConnectEnd);
    if (typeof args.cb === 'function') socket.once('secureConnect', args.cb);
    if (opts.timeout) socket.setTimeout(opts.timeout);
    if (opts.socket) {
      var wrapped = opts.socket;
      if (wrapped.connecting) wrapped.once('connect', function () { socket._tlsStartClient(); });
      else queueMicrotask(function () { socket._tlsStartClient(); });
    } else {
      socket.connect({ port: opts.port, host: opts.host, family: opts.family, lookup: opts.lookup, localPort: opts.localPort });
    }
    return socket;
  }

  function tlsCreateServer(options, listener) {
    return new TLSServer(options, listener);
  }

  return {
    connect: tlsConnect,
    createServer: tlsCreateServer,
    createSecureContext: createSecureContext,
    checkServerIdentity: checkServerIdentity,
    getCiphers: function () {
      return ['tls_aes_128_gcm_sha256', 'tls_aes_256_gcm_sha384', 'tls_chacha20_poly1305_sha256'];
    },
    rootCertificates: Object.freeze([]),
    getCACertificates: function () {
      return [];
    },
    setDefaultCACertificates: function () {},
    convertALPNProtocols: function (protocols, out) {
      var list = alpnList(protocols);
      var parts = [];
      for (var i = 0; i < list.length; i++) parts.push(Buffer.from([list[i].length]), Buffer.from(list[i], 'latin1'));
      out.ALPNProtocols = Buffer.concat(parts);
    },
    DEFAULT_ECDH_CURVE: 'auto',
    DEFAULT_MIN_VERSION: 'TLSv1.2',
    DEFAULT_MAX_VERSION: 'TLSv1.3',
    DEFAULT_CIPHERS: DEFAULT_CIPHERS,
    CLIENT_RENEG_LIMIT: 3,
    CLIENT_RENEG_WINDOW: 600,
    SecureContext: SecureContext,
    Server: TLSServer,
    TLSSocket: TLSSocket
  };
};
`;
