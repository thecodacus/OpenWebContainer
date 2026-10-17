/**
 * TLS 1.3 engine (RFC 8446) for the OWC guest, as a guest-side JavaScript snippet.
 *
 * Evaluating the snippet defines one bootstrap-scope object, OWC_TLS13. It needs nothing from
 * the guest except the capability function each engine is given (callCap in the guest). All
 * cryptography is host-side (capabilities/tls-crypto.ts and capabilities/crypto.ts):
 *   tls.random, tls.x25519.keypair/shared, tls.p256.keypair/shared, tls.ecdsa.sign/verify,
 *   tls.rsa.sign/verify, tls.aead.seal/open, crypto.digest, crypto.hmac.
 *
 * Contents: bytes, base64, HKDF and HKDF-Expand-Label, a DER reader, PEM, X.509, PKCS#1/PKCS#8/
 * SEC1 private keys, certificate chain verification that reproduces OpenSSL 3 as Node uses it
 * (every check runs and the last error found is the one reported), Node's checkServerIdentity,
 * the Node-shaped peer certificate object, the TLS 1.3 record layer and the client and server
 * handshake state machines with the key schedule.
 *
 * Transport modes:
 *   - TLS mode (quic false): receive(bytes) takes TCP bytes; takeOutput() returns TLS records.
 *   - QUIC mode (quic true, RFC 9001): feedCrypto(level, bytes) takes CRYPTO-frame bytes per
 *     encryption level ('initial', 'handshake', '1-rtt'); takeCrypto(level) returns the handshake
 *     bytes to send at that level. No record layer, no change_cipher_spec, no EndOfEarlyData, no
 *     KeyUpdate; quic_transport_parameters (57) is carried both ways and is mandatory; ALPN is
 *     mandatory (no_application_protocol otherwise). 'secrets' events give per-level traffic secrets.
 *
 * Scope: TLS 1.3 only; TLS_AES_128_GCM_SHA256, TLS_AES_256_GCM_SHA384, TLS_CHACHA20_POLY1305_SHA256;
 * X25519 and secp256r1 key shares; CertificateVerify with ECDSA P-256/P-384, RSA-PSS (rsae and pss);
 * certificate signatures RSA PKCS#1 v1.5, RSA-PSS and ECDSA. No PSK, resumption or 0-RTT.
 *
 * Plain ES2015-style JavaScript (var, functions, typed arrays, no BigInt) for QuickJS. ASCII only.
 */
export const TLS_ENGINE_SRC = String.raw`
var OWC_TLS13 = (function () {
'use strict';

/* ---------- bytes ---------- */

function cat() {
  var total = 0;
  var i;
  for (i = 0; i < arguments.length; i++) {
    if (arguments[i] && arguments[i].length) total += arguments[i].length;
  }
  var out = new Uint8Array(total);
  var off = 0;
  for (i = 0; i < arguments.length; i++) {
    var p = arguments[i];
    if (p && p.length) {
      out.set(p, off);
      off += p.length;
    }
  }
  return out;
}

function catList(list) {
  var total = 0;
  var i;
  for (i = 0; i < list.length; i++) total += list[i].length;
  var out = new Uint8Array(total);
  var off = 0;
  for (i = 0; i < list.length; i++) {
    out.set(list[i], off);
    off += list[i].length;
  }
  return out;
}

function eqBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function u16(v) {
  return [(v >>> 8) & 255, v & 255];
}

function u24(v) {
  return [(v >>> 16) & 255, (v >>> 8) & 255, v & 255];
}

function u32(v) {
  return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
}

function latin1Bytes(s) {
  var o = new Uint8Array(s.length);
  for (var i = 0; i < s.length; i++) o[i] = s.charCodeAt(i) & 255;
  return o;
}

function latin1Of(u, s, e) {
  var start = s === undefined ? 0 : s;
  var end = e === undefined ? u.length : e;
  var parts = [];
  for (var i = start; i < end; i += 4096) {
    parts.push(String.fromCharCode.apply(null, Array.prototype.slice.call(u, i, Math.min(end, i + 4096))));
  }
  return parts.join('');
}

function utf8Of(u, s, e) {
  var out = [];
  var i = s;
  while (i < e) {
    var c = u[i++];
    if (c < 128) {
      out.push(c);
    } else if (c >= 194 && c < 224 && i < e) {
      out.push(((c & 31) << 6) | (u[i++] & 63));
    } else if (c >= 224 && c < 240 && i + 1 < e) {
      out.push(((c & 15) << 12) | ((u[i] & 63) << 6) | (u[i + 1] & 63));
      i += 2;
    } else if (c >= 240 && c < 245 && i + 2 < e) {
      var cp = (((c & 7) << 18) | ((u[i] & 63) << 12) | ((u[i + 1] & 63) << 6) | (u[i + 2] & 63)) - 65536;
      out.push(55296 + (cp >> 10), 56320 + (cp & 1023));
      i += 3;
    } else {
      out.push(65533);
    }
  }
  var parts = [];
  for (var k = 0; k < out.length; k += 4096) parts.push(String.fromCharCode.apply(null, out.slice(k, k + 4096)));
  return parts.join('');
}

var HEX = '0123456789ABCDEF';

function hexUpper(u) {
  var s = [];
  for (var i = 0; i < u.length; i++) s.push(HEX.charAt(u[i] >> 4) + HEX.charAt(u[i] & 15));
  return s.join('');
}

function hexLower(u) {
  return hexUpper(u).toLowerCase();
}

function hexColon(u) {
  var s = [];
  for (var i = 0; i < u.length; i++) s.push(HEX.charAt(u[i] >> 4) + HEX.charAt(u[i] & 15));
  return s.join(':');
}

/* ---------- errors ---------- */

function errWithCode(code, message) {
  var e = new Error(message);
  e.code = code;
  return e;
}

/* Node's code for an OpenSSL reason: upper case, spaces to underscores, nothing else changed */
function reasonCode(reason) {
  return 'ERR_SSL_' + reason.toUpperCase().replace(/ /g, '_');
}

/* An OpenSSL-style SSL error: code ERR_SSL_<REASON>, the alert to send (or null) */
function sslErr(alert, reason, library) {
  var e = errWithCode(reasonCode(reason), reason);
  e.library = library || 'SSL routines';
  e.reason = reason;
  e.alert = alert;
  return e;
}

function decodeErr() {
  return sslErr(50, 'length mismatch');
}

/* An error thrown by a caller's callback: reported as it is, and the connection closes without an alert */
function foreignErr(original) {
  var e = errWithCode(original && typeof original.code === 'string' ? original.code : 'ERR_TLS_CALLBACK', original && original.message ? original.message : String(original));
  e.alert = null;
  e.original = original;
  return e;
}

/* Alert descriptions and the OpenSSL 3 reason a peer reports when it receives them */
var ALERTS = {
  0: ['close_notify', 'sslv3 alert close notify'],
  10: ['unexpected_message', 'ssl/tls alert unexpected message'],
  20: ['bad_record_mac', 'ssl/tls alert bad record mac'],
  21: ['decryption_failed', 'tlsv1 alert decryption failed'],
  22: ['record_overflow', 'tlsv1 alert record overflow'],
  30: ['decompression_failure', 'ssl/tls alert decompression failure'],
  40: ['handshake_failure', 'ssl/tls alert handshake failure'],
  41: ['no_certificate', 'ssl/tls alert no certificate'],
  42: ['bad_certificate', 'ssl/tls alert bad certificate'],
  43: ['unsupported_certificate', 'ssl/tls alert unsupported certificate'],
  44: ['certificate_revoked', 'ssl/tls alert certificate revoked'],
  45: ['certificate_expired', 'ssl/tls alert certificate expired'],
  46: ['certificate_unknown', 'ssl/tls alert certificate unknown'],
  47: ['illegal_parameter', 'ssl/tls alert illegal parameter'],
  48: ['unknown_ca', 'tlsv1 alert unknown ca'],
  49: ['access_denied', 'tlsv1 alert access denied'],
  50: ['decode_error', 'tlsv1 alert decode error'],
  51: ['decrypt_error', 'tlsv1 alert decrypt error'],
  60: ['export_restriction', 'tlsv1 alert export restriction'],
  70: ['protocol_version', 'tlsv1 alert protocol version'],
  71: ['insufficient_security', 'tlsv1 alert insufficient security'],
  80: ['internal_error', 'tlsv1 alert internal error'],
  86: ['inappropriate_fallback', 'tlsv1 alert inappropriate fallback'],
  90: ['user_canceled', 'tlsv1 alert user cancelled'],
  100: ['no_renegotiation', 'tlsv1 alert no renegotiation'],
  109: ['missing_extension', 'tlsv13 alert missing extension'],
  110: ['unsupported_extension', 'tlsv1 unsupported extension'],
  111: ['certificate_unobtainable', 'tlsv1 certificate unobtainable'],
  112: ['unrecognized_name', 'tlsv1 unrecognized name'],
  113: ['bad_certificate_status_response', 'tlsv1 bad certificate status response'],
  114: ['bad_certificate_hash_value', 'tlsv1 bad certificate hash value'],
  115: ['unknown_psk_identity', 'tlsv1 alert unknown psk identity'],
  116: ['certificate_required', 'tlsv13 alert certificate required'],
  120: ['no_application_protocol', 'tlsv1 alert no application protocol']
};

/* ---------- base64 (the capability boundary carries canonical base64) ---------- */

var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
var B64_PAIRS = null;
var B64_DEC = (function () {
  var t = new Int16Array(128);
  var i;
  for (i = 0; i < 128; i++) t[i] = -1;
  for (i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i;
  t[45] = 62;
  t[95] = 63;
  return t;
})();

function b64enc(u) {
  if (B64_PAIRS === null) {
    B64_PAIRS = new Array(4096);
    for (var k = 0; k < 4096; k++) B64_PAIRS[k] = B64.charAt(k >> 6) + B64.charAt(k & 63);
  }
  var T = B64_PAIRS;
  var n = u.length;
  var out = [];
  var i = 0;
  var v;
  for (; i + 2 < n; i += 3) {
    v = (u[i] << 16) | (u[i + 1] << 8) | u[i + 2];
    out.push(T[v >> 12], T[v & 4095]);
  }
  if (n - i === 1) {
    out.push(T[u[i] << 4], '==');
  } else if (n - i === 2) {
    v = (u[i] << 16) | (u[i + 1] << 8);
    out.push(T[v >> 12], B64.charAt((v >> 6) & 63), '=');
  }
  return out.join('');
}

/* Decodes base64 or base64url in one pass; input with characters outside the alphabet (PEM line
   breaks, whitespace) is cleaned first. Trailing padding is ignored. */
function b64dec(s) {
  var D = B64_DEC;
  var len = s.length;
  while (len > 0 && s.charCodeAt(len - 1) === 61) len--;
  var out = new Uint8Array((len * 3) >> 2);
  var o = 0;
  var i = 0;
  var c0, c1, c2, c3, a, b, c, d;
  for (; i + 3 < len; i += 4) {
    c0 = s.charCodeAt(i);
    c1 = s.charCodeAt(i + 1);
    c2 = s.charCodeAt(i + 2);
    c3 = s.charCodeAt(i + 3);
    a = D[c0 & 127];
    b = D[c1 & 127];
    c = D[c2 & 127];
    d = D[c3 & 127];
    if ((c0 | c1 | c2 | c3) > 127 || (a | b | c | d) < 0) return b64dec(s.replace(/[^A-Za-z0-9+\/_-]/g, ''));
    a = (a << 18) | (b << 12) | (c << 6) | d;
    out[o++] = (a >> 16) & 255;
    out[o++] = (a >> 8) & 255;
    out[o++] = a & 255;
  }
  var rest = len - i;
  if (rest > 0) {
    c0 = s.charCodeAt(i);
    c1 = rest > 1 ? s.charCodeAt(i + 1) : 65;
    c2 = rest > 2 ? s.charCodeAt(i + 2) : 65;
    a = D[c0 & 127];
    b = D[c1 & 127];
    c = D[c2 & 127];
    if ((c0 | c1 | c2) > 127 || (a | b | c) < 0) return b64dec(s.replace(/[^A-Za-z0-9+\/_-]/g, ''));
    a = (a << 18) | (b << 12) | (c << 6);
    if (rest >= 2) out[o++] = (a >> 16) & 255;
    if (rest === 3) out[o++] = (a >> 8) & 255;
  }
  return o === out.length ? out : out.slice(0, o);
}

/* ---------- capabilities: every primitive comes from the host ---------- */

var CURVE_BYTES = { p256: 32, p384: 48 };

/* ECDSA uses the leftmost bits of a digest longer than the group order and the plain value of a
   shorter one; for P-256 and P-384 that is truncation or left zero-padding to the order size. */
function fitDigest(digest, size) {
  if (digest.length === size) return digest;
  if (digest.length > size) return digest.slice(0, size);
  var out = new Uint8Array(size);
  out.set(digest, size - digest.length);
  return out;
}

function makeCrypto(cap) {
  var keyErr = function () {
    return sslErr(47, 'bad key share');
  };
  return {
    cap: cap,
    random: function (n) {
      return b64dec(cap('tls.random', { bytes: n }).data);
    },
    x25519Pair: function () {
      var r = cap('tls.x25519.keypair', {});
      return { priv: b64dec(r.priv), pub: b64dec(r.pub) };
    },
    x25519Shared: function (priv, pub) {
      if (pub.length !== 32) throw keyErr();
      try {
        return b64dec(cap('tls.x25519.shared', { priv: b64enc(priv), pub: b64enc(pub) }).secret);
      } catch (failure) {
        throw keyErr();
      }
    },
    p256Pair: function () {
      var r = cap('tls.p256.keypair', {});
      return { priv: b64dec(r.priv), pub: b64dec(r.pub) };
    },
    p256Shared: function (priv, pub) {
      if (pub.length !== 65 || pub[0] !== 4) throw keyErr();
      try {
        return b64dec(cap('tls.p256.shared', { priv: b64enc(priv), pub: b64enc(pub) }).secret);
      } catch (failure) {
        throw keyErr();
      }
    },
    digest: function (alg, data) {
      return b64dec(cap('crypto.digest', { algorithm: alg, data: b64enc(data) }));
    },
    hmac: function (alg, key, data) {
      return b64dec(cap('crypto.hmac', { algorithm: alg, key: b64enc(key), data: b64enc(data) }));
    },
    aeadSeal: function (alg, key, nonce, aad, plain) {
      return b64dec(cap('tls.aead.seal', {
        alg: alg, key: b64enc(key), nonce: b64enc(nonce), aad: b64enc(aad), plaintext: b64enc(plain)
      }).ciphertext);
    },
    aeadOpen: function (alg, key, nonce, aad, ct) {
      return b64dec(cap('tls.aead.open', {
        alg: alg, key: b64enc(key), nonce: b64enc(nonce), aad: b64enc(aad), ciphertext: b64enc(ct)
      }).plaintext);
    },
    ecdsaSign: function (curve, priv, digest) {
      return b64dec(cap('tls.ecdsa.sign', {
        curve: curve, priv: b64enc(priv), digest: b64enc(fitDigest(digest, CURVE_BYTES[curve]))
      }).sig);
    },
    ecdsaVerify: function (curve, pub, digest, sig) {
      if (!CURVE_BYTES[curve]) return false;
      try {
        return cap('tls.ecdsa.verify', {
          curve: curve, pub: b64enc(pub), digest: b64enc(fitDigest(digest, CURVE_BYTES[curve])), sig: b64enc(sig)
        }).ok === true;
      } catch (failure) {
        return false;
      }
    },
    rsaSign: function (scheme, key, message) {
      return b64dec(cap('tls.rsa.sign', {
        scheme: scheme,
        key: {
          n: b64enc(key.n), e: b64enc(key.e), d: b64enc(key.d), p: b64enc(key.p), q: b64enc(key.q),
          dp: b64enc(key.dp), dq: b64enc(key.dq), qi: b64enc(key.qi)
        },
        message: b64enc(message)
      }).sig);
    },
    rsaVerify: function (scheme, key, message, sig) {
      try {
        return cap('tls.rsa.verify', {
          scheme: scheme, key: { n: b64enc(key.n), e: b64enc(key.e) }, message: b64enc(message), sig: b64enc(sig)
        }).ok === true;
      } catch (failure) {
        return false;
      }
    }
  };
}

/* ---------- HKDF (RFC 5869) and HKDF-Expand-Label (RFC 8446 section 7.1) ---------- */

var HASH_LEN = { sha256: 32, sha384: 48, sha512: 64 };

function hkdfExtract(c, alg, salt, ikm) {
  return c.hmac(alg, salt && salt.length ? salt : new Uint8Array(HASH_LEN[alg]), ikm);
}

function hkdfExpand(c, alg, prk, info, len) {
  var blocks = [];
  var t = new Uint8Array(0);
  var total = 0;
  var i = 1;
  while (total < len) {
    t = c.hmac(alg, prk, cat(t, info, [i]));
    blocks.push(t);
    total += t.length;
    i++;
  }
  return catList(blocks).slice(0, len);
}

function hkdfLabel(len, label, context) {
  var full = latin1Bytes('tls13 ' + label);
  return cat([len >> 8, len & 255, full.length], full, [context.length], context);
}

function expandLabel(c, alg, secret, label, context, len) {
  return hkdfExpand(c, alg, secret, hkdfLabel(len, label, context), len);
}

function deriveSecret(c, alg, secret, label, transcriptHash) {
  return expandLabel(c, alg, secret, label, transcriptHash, HASH_LEN[alg]);
}

/* ---------- DER reader ---------- */

function derErr(message) {
  return errWithCode('ERR_OSSL_ASN1_ERROR', message);
}

function derTlv(u, off, lim) {
  if (off + 2 > lim) throw derErr('truncated DER');
  var tag = u[off];
  if ((tag & 31) === 31) throw derErr('multi-byte DER tags are not supported');
  var p = off + 1;
  var len = u[p++];
  if (len & 128) {
    var nb = len & 127;
    if (nb === 0 || nb > 4 || p + nb > lim) throw derErr('bad DER length');
    len = 0;
    for (var i = 0; i < nb; i++) len = len * 256 + u[p++];
  }
  if (p + len > lim) throw derErr('DER length overflows its container');
  return { tag: tag, start: off, vStart: p, vEnd: p + len, end: p + len };
}

function derKids(u, s, e) {
  var out = [];
  var off = s;
  while (off < e) {
    var t = derTlv(u, off, e);
    out.push(t);
    off = t.end;
  }
  return out;
}

function derOne(u, expectTag) {
  var t = derTlv(u, 0, u.length);
  if (expectTag !== undefined && t.tag !== expectTag) throw derErr('unexpected DER tag');
  return t;
}

function derOid(u, t) {
  if (t.tag !== 6) throw derErr('expected an OBJECT IDENTIFIER');
  var parts = [];
  var v = 0;
  var first = true;
  for (var i = t.vStart; i < t.vEnd; i++) {
    v = v * 128 + (u[i] & 127);
    if (!(u[i] & 128)) {
      if (first) {
        var a = v < 80 ? Math.floor(v / 40) : 2;
        parts.push(a, v - a * 40);
        first = false;
      } else {
        parts.push(v);
      }
      v = 0;
    }
  }
  return parts.join('.');
}

/* INTEGER value bytes without the sign octet */
function derInt(u, t) {
  var s = t.vStart;
  var e = t.vEnd;
  while (e - s > 1 && u[s] === 0) s++;
  return u.slice(s, e);
}

function derSmall(u, t) {
  var v = 0;
  for (var i = t.vStart; i < t.vEnd; i++) v = v * 256 + u[i];
  return v;
}

function derBits(u, t) {
  if (t.tag !== 3) throw derErr('expected a BIT STRING');
  return u.slice(t.vStart + 1, t.vEnd);
}

function derString(u, t) {
  if (t.tag === 30) {
    var codes = [];
    for (var i = t.vStart; i + 1 < t.vEnd; i += 2) codes.push((u[i] << 8) | u[i + 1]);
    return String.fromCharCode.apply(null, codes);
  }
  if (t.tag === 20 || t.tag === 19 || t.tag === 22 || t.tag === 26) return latin1Of(u, t.vStart, t.vEnd);
  return utf8Of(u, t.vStart, t.vEnd);
}

function derTime(u, t) {
  var s = latin1Of(u, t.vStart, t.vEnd);
  var m = t.tag === 23 ? /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?Z$/.exec(s) : /^(\d\d\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?(\.\d+)?Z$/.exec(s);
  if (!m) throw derErr('bad certificate time');
  var year = parseInt(m[1], 10);
  if (t.tag === 23) year = year < 50 ? 2000 + year : 1900 + year;
  return Date.UTC(year, parseInt(m[2], 10) - 1, parseInt(m[3], 10), parseInt(m[4], 10), parseInt(m[5], 10), m[6] ? parseInt(m[6], 10) : 0);
}

/* ---------- X.509 ---------- */

var ATTR_SN = {
  '2.5.4.3': 'CN', '2.5.4.4': 'SN', '2.5.4.5': 'serialNumber', '2.5.4.6': 'C', '2.5.4.7': 'L',
  '2.5.4.8': 'ST', '2.5.4.9': 'street', '2.5.4.10': 'O', '2.5.4.11': 'OU', '2.5.4.12': 'title',
  '2.5.4.13': 'description', '2.5.4.15': 'businessCategory', '2.5.4.17': 'postalCode', '2.5.4.41': 'name',
  '2.5.4.42': 'GN', '2.5.4.43': 'initials', '2.5.4.44': 'generationQualifier', '2.5.4.46': 'dnQualifier',
  '2.5.4.65': 'pseudonym', '2.5.4.97': 'organizationIdentifier', '1.2.840.113549.1.9.1': 'emailAddress',
  '0.9.2342.19200300.100.1.1': 'UID', '0.9.2342.19200300.100.1.25': 'DC',
  '1.3.6.1.4.1.311.60.2.1.1': 'jurisdictionL', '1.3.6.1.4.1.311.60.2.1.2': 'jurisdictionST',
  '1.3.6.1.4.1.311.60.2.1.3': 'jurisdictionC'
};

/* Node-shaped name object (null prototype) plus the canonical form used to compare names */
function parseName(u, t) {
  var obj = Object.create(null);
  var canon = [];
  var rdns = derKids(u, t.vStart, t.vEnd);
  for (var r = 0; r < rdns.length; r++) {
    var attrs = derKids(u, rdns[r].vStart, rdns[r].vEnd);
    var set = [];
    for (var a = 0; a < attrs.length; a++) {
      var pair = derKids(u, attrs[a].vStart, attrs[a].vEnd);
      var oid = derOid(u, pair[0]);
      var value = derString(u, pair[1]);
      var key = ATTR_SN[oid] || oid;
      if (obj[key] === undefined) obj[key] = value;
      else if (Array.isArray(obj[key])) obj[key].push(value);
      else obj[key] = [obj[key], value];
      set.push(oid + '=' + value.replace(/[A-Z]/g, function (ch) { return ch.toLowerCase(); }).replace(/\s+/g, ' ').trim());
    }
    canon.push(set.sort().join('+'));
  }
  return { obj: obj, canon: canon.join(','), rdns: canon };
}

var CURVE_OIDS = { '1.2.840.10045.3.1.7': 'p256', '1.3.132.0.34': 'p384', '1.3.132.0.35': 'p521' };
var CURVE_INFO = {
  p256: { asn1: 'prime256v1', nist: 'P-256', bits: 256 },
  p384: { asn1: 'secp384r1', nist: 'P-384', bits: 384 },
  p521: { asn1: 'secp521r1', nist: 'P-521', bits: 521 }
};
var RSA_OID = '1.2.840.113549.1.1.1';
var RSA_PSS_OID = '1.2.840.113549.1.1.10';
var EC_OID = '1.2.840.10045.2.1';
var HASH_OIDS = { '2.16.840.1.101.3.4.2.1': 'sha256', '2.16.840.1.101.3.4.2.2': 'sha384', '2.16.840.1.101.3.4.2.3': 'sha512', '1.3.14.3.2.26': 'sha1' };

function bitLength(bytes) {
  if (bytes.length === 0) return 0;
  var top = bytes[0];
  var bits = 0;
  while (top) {
    bits++;
    top >>= 1;
  }
  return (bytes.length - 1) * 8 + bits;
}

/* RSASSA-PSS-params: {hash, salt}; absent fields take the RFC 4055 defaults (sha1, 20) */
function parsePssParams(u, t) {
  var out = { hash: 'sha1', salt: 20 };
  if (!t || t.tag !== 48) return out;
  var kids = derKids(u, t.vStart, t.vEnd);
  for (var i = 0; i < kids.length; i++) {
    if (kids[i].tag === 160) {
      var hashSeq = derKids(u, kids[i].vStart, kids[i].vEnd)[0];
      out.hash = HASH_OIDS[derOid(u, derKids(u, hashSeq.vStart, hashSeq.vEnd)[0])] || 'unknown';
    } else if (kids[i].tag === 162) {
      out.salt = derSmall(u, derKids(u, kids[i].vStart, kids[i].vEnd)[0]);
    }
  }
  return out;
}

function parseSpki(u, t) {
  var kids = derKids(u, t.vStart, t.vEnd);
  var algKids = derKids(u, kids[0].vStart, kids[0].vEnd);
  var oid = derOid(u, algKids[0]);
  var bits = derBits(u, kids[1]);
  var der = u.slice(t.start, t.end);
  if (oid === RSA_OID || oid === RSA_PSS_OID) {
    var seq = derOne(bits, 48);
    var nums = derKids(bits, seq.vStart, seq.vEnd);
    var n = derInt(bits, nums[0]);
    var pss = oid === RSA_PSS_OID ? parsePssParams(u, algKids[1]) : null;
    return { oid: oid, type: oid === RSA_OID ? 'rsa' : 'rsa-pss', pss: pss, key: { n: n, e: derInt(bits, nums[1]) }, bits: bitLength(n), der: der };
  }
  if (oid === EC_OID && algKids.length > 1 && algKids[1].tag === 6) {
    var curve = CURVE_OIDS[derOid(u, algKids[1])] || null;
    var usable = curve === 'p256' || curve === 'p384';
    return { oid: oid, type: usable ? 'ec' : 'unsupported', curve: curve, point: bits, bits: curve ? CURVE_INFO[curve].bits : 0, der: der };
  }
  return { oid: oid, type: 'unsupported', der: der, bits: 0 };
}

function formatIpAddress(bytes) {
  if (bytes.length === 4) return bytes[0] + '.' + bytes[1] + '.' + bytes[2] + '.' + bytes[3];
  if (bytes.length === 16) {
    var groups = [];
    for (var i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16).toUpperCase());
    return groups.join(':');
  }
  return '<invalid>';
}

/* Node's subjectaltname text: entries in certificate order, quoted when they hold a comma or quote */
function sanEntryText(prefix, value) {
  if (/[,"\\]/.test(value) || /[^\x20-\x7e]/.test(value)) return prefix + JSON.stringify(value);
  return prefix + value;
}

/* One GeneralName: {type, value} with raw bytes for IP addresses and the RDN list for directory names */
function generalName(u, t) {
  var tagNo = t.tag & 31;
  if (t.tag === 130) return { type: 'DNS', value: latin1Of(u, t.vStart, t.vEnd) };
  if (t.tag === 135) return { type: 'IP', value: formatIpAddress(u.slice(t.vStart, t.vEnd)), raw: u.slice(t.vStart, t.vEnd) };
  if (t.tag === 129) return { type: 'email', value: latin1Of(u, t.vStart, t.vEnd) };
  if (t.tag === 134) return { type: 'URI', value: latin1Of(u, t.vStart, t.vEnd) };
  if (tagNo === 4 && (t.tag & 32)) {
    var inner = derKids(u, t.vStart, t.vEnd)[0];
    return { type: 'DirName', value: '<directory name>', rdns: inner ? parseName(u, inner).rdns : [] };
  }
  if (tagNo === 8) return { type: 'Registered ID', value: '<registered id>' };
  if (tagNo === 0) return { type: 'othername', value: '<unsupported>' };
  return { type: 'other', value: '' };
}

var KNOWN_EXTENSIONS = {
  '2.5.29.14': true, '2.5.29.15': true, '2.5.29.17': true, '2.5.29.18': true, '2.5.29.19': true,
  '2.5.29.30': true, '2.5.29.31': true, '2.5.29.32': true, '2.5.29.33': true, '2.5.29.35': true,
  '2.5.29.36': true, '2.5.29.37': true, '2.5.29.46': true, '2.5.29.54': true, '1.3.6.1.5.5.7.1.1': true,
  '1.3.6.1.5.5.7.1.24': true, '1.3.6.1.4.1.11129.2.4.2': true
};

var EKU_SERVER = '1.3.6.1.5.5.7.3.1';
var EKU_CLIENT = '1.3.6.1.5.5.7.3.2';
var EKU_SGC = { '2.16.840.1.113730.4.1': true, '1.3.6.1.4.1.311.10.3.3': true };

function parseExtensions(u, a3, cert) {
  var seq = derKids(u, a3.vStart, a3.vEnd)[0];
  var exts = derKids(u, seq.vStart, seq.vEnd);
  for (var i = 0; i < exts.length; i++) {
    var kids = derKids(u, exts[i].vStart, exts[i].vEnd);
    var oid = derOid(u, kids[0]);
    var critical = kids.length > 2 && kids[1].tag === 1 && u[kids[1].vStart] !== 0;
    var valT = kids[kids.length - 1];
    var value = u.slice(valT.vStart, valT.vEnd);
    if (critical && !KNOWN_EXTENSIONS[oid]) cert.unhandledCritical = true;
    if (oid === '2.5.29.17') {
      var gn = derOne(value, 48);
      var names = derKids(value, gn.vStart, gn.vEnd);
      for (var n = 0; n < names.length; n++) {
        var gname = generalName(value, names[n]);
        if (gname.type !== 'other') cert.san.push(gname);
      }
    } else if (oid === '2.5.29.19') {
      var bc = derOne(value, 48);
      var bcKids = derKids(value, bc.vStart, bc.vEnd);
      cert.bc = { ca: false, pathLen: -1 };
      for (var b = 0; b < bcKids.length; b++) {
        if (bcKids[b].tag === 1) cert.bc.ca = value[bcKids[b].vStart] !== 0;
        else if (bcKids[b].tag === 2) cert.bc.pathLen = derSmall(value, bcKids[b]);
      }
    } else if (oid === '2.5.29.15') {
      var bitsT = derOne(value, 3);
      var b0 = bitsT.vEnd > bitsT.vStart + 1 ? value[bitsT.vStart + 1] : 0;
      var b1 = bitsT.vEnd > bitsT.vStart + 2 ? value[bitsT.vStart + 2] : 0;
      cert.ku = {
        digitalSignature: (b0 & 128) !== 0, nonRepudiation: (b0 & 64) !== 0, keyEncipherment: (b0 & 32) !== 0,
        dataEncipherment: (b0 & 16) !== 0, keyAgreement: (b0 & 8) !== 0, keyCertSign: (b0 & 4) !== 0,
        cRLSign: (b0 & 2) !== 0, encipherOnly: (b0 & 1) !== 0, decipherOnly: (b1 & 128) !== 0
      };
    } else if (oid === '2.5.29.37') {
      var ekuSeq = derOne(value, 48);
      cert.eku = derKids(value, ekuSeq.vStart, ekuSeq.vEnd).map(function (k) { return derOid(value, k); });
    } else if (oid === '2.5.29.14') {
      var skiT = derOne(value, 4);
      cert.ski = value.slice(skiT.vStart, skiT.vEnd);
    } else if (oid === '2.5.29.35') {
      var akiSeq = derOne(value, 48);
      var akiKids = derKids(value, akiSeq.vStart, akiSeq.vEnd);
      cert.aki = { keyId: null, serial: null };
      for (var k = 0; k < akiKids.length; k++) {
        if (akiKids[k].tag === 128) cert.aki.keyId = value.slice(akiKids[k].vStart, akiKids[k].vEnd);
        else if (akiKids[k].tag === 130) cert.aki.serial = derInt(value, akiKids[k]);
      }
    } else if (oid === '2.5.29.30') {
      var ncSeq = derOne(value, 48);
      var ncParts = derKids(value, ncSeq.vStart, ncSeq.vEnd);
      cert.nc = { permitted: [], excluded: [] };
      for (var q = 0; q < ncParts.length; q++) {
        var ncList = ncParts[q].tag === 160 ? cert.nc.permitted : ncParts[q].tag === 161 ? cert.nc.excluded : null;
        if (!ncList) continue;
        var subtrees = derKids(value, ncParts[q].vStart, ncParts[q].vEnd);
        for (var stI = 0; stI < subtrees.length; stI++) ncList.push(generalName(value, derKids(value, subtrees[stI].vStart, subtrees[stI].vEnd)[0]));
      }
    } else if (oid === '1.3.6.1.5.5.7.1.1') {
      var aiaSeq = derOne(value, 48);
      var ads = derKids(value, aiaSeq.vStart, aiaSeq.vEnd);
      cert.aia = [];
      for (var d = 0; d < ads.length; d++) {
        var ad = derKids(value, ads[d].vStart, ads[d].vEnd);
        var method = derOid(value, ad[0]);
        var label = method === '1.3.6.1.5.5.7.48.1' ? 'OCSP - URI' : method === '1.3.6.1.5.5.7.48.2' ? 'CA Issuers - URI' : method;
        if (ad[1] && ad[1].tag === 134) cert.aia.push({ label: label, uri: latin1Of(value, ad[1].vStart, ad[1].vEnd) });
      }
    }
  }
}

/* One DER certificate: the fields the handshake, chain check, identity check and getPeerCertificate need */
function parseCertificate(der) {
  der = Uint8Array.from(der);
  var top = derOne(der, 48);
  if (top.end !== der.length) throw derErr('trailing data after certificate');
  var parts = derKids(der, top.vStart, top.vEnd);
  if (parts.length !== 3) throw derErr('certificate needs three fields');
  var tbsT = parts[0];
  var tbs = derKids(der, tbsT.vStart, tbsT.vEnd);
  var idx = 0;
  var version = 1;
  if (tbs[0].tag === 160) {
    version = derSmall(der, derKids(der, tbs[0].vStart, tbs[0].vEnd)[0]) + 1;
    idx = 1;
  }
  if (tbs.length < idx + 6) throw derErr('truncated TBSCertificate');
  var serialT = tbs[idx++];
  idx++;
  var issuerT = tbs[idx++];
  var validityT = tbs[idx++];
  var subjectT = tbs[idx++];
  var spkiT = tbs[idx++];
  var extT = null;
  for (var k = idx; k < tbs.length; k++) {
    if (tbs[k].tag === 163) extT = tbs[k];
  }
  var validity = derKids(der, validityT.vStart, validityT.vEnd);
  var sigAlgKids = derKids(der, parts[1].vStart, parts[1].vEnd);
  var issuer = parseName(der, issuerT);
  var subject = parseName(der, subjectT);
  var cert = {
    der: der,
    tbs: der.slice(tbsT.start, tbsT.end),
    version: version,
    serial: derInt(der, serialT),
    serialNumber: hexUpper(derInt(der, serialT)),
    sigOid: derOid(der, sigAlgKids[0]),
    sigParamsT: sigAlgKids.length > 1 ? sigAlgKids[1] : null,
    sig: derBits(der, parts[2]),
    issuer: issuer.obj,
    subject: subject.obj,
    issuerCanon: issuer.canon,
    subjectCanon: subject.canon,
    subjectRdns: subject.rdns,
    notBefore: derTime(der, validity[0]),
    notAfter: derTime(der, validity[1]),
    spki: parseSpki(der, spkiT),
    san: [],
    bc: null,
    ku: null,
    eku: null,
    ski: null,
    aki: null,
    aia: null,
    nc: null,
    unhandledCritical: false
  };
  if (extT) parseExtensions(der, extT, cert);
  cert.selfIssued = cert.subjectCanon === cert.issuerCanon;
  cert.sigScheme = certSigScheme(cert);
  cert.selfSigned = cert.selfIssued && akidMatches(cert, cert) && sigAlgMatches(cert, cert);
  return cert;
}

/* ---------- PEM and private keys ---------- */

function pemText(input) {
  if (typeof input === 'string') return input;
  return latin1Of(input, 0, input.length);
}

function parsePem(input) {
  var text = pemText(input);
  var out = [];
  var re = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g;
  var m;
  while ((m = re.exec(text)) !== null) {
    if (m[2].indexOf('Proc-Type') !== -1 || m[1] === 'ENCRYPTED PRIVATE KEY') {
      throw errWithCode('ERR_OSSL_UNSUPPORTED', 'encrypted private keys are not supported');
    }
    out.push({ label: m[1], der: b64dec(m[2]) });
  }
  return out;
}

function parseRsaPrivate(der, type) {
  var seq = derOne(der, 48);
  var k = derKids(der, seq.vStart, seq.vEnd);
  if (k.length < 9) throw errWithCode('ERR_OSSL_UNSUPPORTED', 'RSA private key is incomplete');
  return {
    type: type || 'rsa',
    n: derInt(der, k[1]), e: derInt(der, k[2]), d: derInt(der, k[3]),
    p: derInt(der, k[4]), q: derInt(der, k[5]), dp: derInt(der, k[6]), dq: derInt(der, k[7]), qi: derInt(der, k[8])
  };
}

function parseEcPrivate(der, curveHint) {
  var seq = derOne(der, 48);
  var k = derKids(der, seq.vStart, seq.vEnd);
  var curve = curveHint;
  for (var i = 2; i < k.length; i++) {
    if (k[i].tag === 160) {
      var named = derKids(der, k[i].vStart, k[i].vEnd)[0];
      curve = CURVE_OIDS[derOid(der, named)] || curve;
    }
  }
  if (curve !== 'p256' && curve !== 'p384') throw errWithCode('ERR_OSSL_UNSUPPORTED', 'EC curve not supported');
  var size = CURVE_BYTES[curve];
  var raw = der.slice(k[1].vStart, k[1].vEnd);
  var priv = new Uint8Array(size);
  if (raw.length > size) priv.set(raw.slice(raw.length - size));
  else priv.set(raw, size - raw.length);
  return { type: 'ec', curve: curve, priv: priv };
}

/* PKCS#8 (PRIVATE KEY), PKCS#1 (RSA PRIVATE KEY) or SEC1 (EC PRIVATE KEY) */
function parsePrivateKey(label, der) {
  if (label === 'RSA PRIVATE KEY') return parseRsaPrivate(der);
  if (label === 'EC PRIVATE KEY') return parseEcPrivate(der, null);
  if (label !== 'PRIVATE KEY') throw errWithCode('ERR_OSSL_UNSUPPORTED', 'unsupported key label ' + label);
  var seq = derOne(der, 48);
  var k = derKids(der, seq.vStart, seq.vEnd);
  var algKids = derKids(der, k[1].vStart, k[1].vEnd);
  var oid = derOid(der, algKids[0]);
  var inner = der.slice(k[2].vStart, k[2].vEnd);
  if (oid === RSA_OID) return parseRsaPrivate(inner, 'rsa');
  if (oid === RSA_PSS_OID) {
    var key = parseRsaPrivate(inner, 'rsa-pss');
    key.pss = parsePssParams(der, algKids[1]);
    return key;
  }
  if (oid === EC_OID) return parseEcPrivate(inner, algKids[1] && algKids[1].tag === 6 ? (CURVE_OIDS[derOid(der, algKids[1])] || null) : null);
  throw errWithCode('ERR_OSSL_UNSUPPORTED', 'private key algorithm not supported');
}

/* Certificates and the private key in PEM text: {certs: [der], key} */
function loadPem(input) {
  var blocks = parsePem(input);
  var certs = [];
  var key = null;
  for (var i = 0; i < blocks.length; i++) {
    if (blocks[i].label === 'CERTIFICATE' || blocks[i].label === 'TRUSTED CERTIFICATE' || blocks[i].label === 'X509 CERTIFICATE') {
      certs.push(blocks[i].der);
    } else if (/PRIVATE KEY$/.test(blocks[i].label)) {
      key = parsePrivateKey(blocks[i].label, blocks[i].der);
    }
  }
  return { certs: certs, key: key };
}

/* ---------- certificate signatures ---------- */

/* The scheme of a certificate's signature algorithm, or null when unsupported */
function certSigScheme(cert) {
  var oid = cert.sigOid;
  if (oid === '1.2.840.113549.1.1.11') return { kind: 'rsa', scheme: 'pkcs1-sha256', hash: 'sha256' };
  if (oid === '1.2.840.113549.1.1.12') return { kind: 'rsa', scheme: 'pkcs1-sha384', hash: 'sha384' };
  if (oid === '1.2.840.113549.1.1.13') return { kind: 'rsa', scheme: 'pkcs1-sha512', hash: 'sha512' };
  if (oid === '1.2.840.10045.4.3.2') return { kind: 'ecdsa', hash: 'sha256' };
  if (oid === '1.2.840.10045.4.3.3') return { kind: 'ecdsa', hash: 'sha384' };
  if (oid === '1.2.840.10045.4.3.4') return { kind: 'ecdsa', hash: 'sha512' };
  if (oid === RSA_PSS_OID) {
    var p = parsePssParams(cert.der, cert.sigParamsT);
    if (p.salt === HASH_LEN[p.hash]) return { kind: 'pss', scheme: 'pss-' + p.hash, hash: p.hash };
    return { kind: 'pss', scheme: null, hash: p.hash };
  }
  return { kind: 'other', scheme: null, hash: null };
}

/* OpenSSL check_sig_alg_match: the issuer's key type can make the subject's signature */
function sigAlgMatches(issuer, subject) {
  var s = subject.sigScheme;
  var t = issuer.spki.type;
  if (!s || s.kind === 'other') return true;
  if (s.kind === 'ecdsa') return t === 'ec' || issuer.spki.oid === EC_OID;
  if (s.kind === 'rsa') return t === 'rsa';
  if (s.kind === 'pss') return t === 'rsa' || t === 'rsa-pss';
  return true;
}

function certSigOk(c, issuer, cert) {
  var s = cert.sigScheme;
  var k = issuer.spki;
  if (!s || !s.hash) return false;
  if (s.kind === 'ecdsa') {
    if (k.type !== 'ec') return false;
    return c.ecdsaVerify(k.curve, k.point, c.digest(s.hash, cert.tbs), cert.sig);
  }
  if ((s.kind === 'rsa' && k.type === 'rsa') || (s.kind === 'pss' && (k.type === 'rsa' || k.type === 'rsa-pss'))) {
    if (!s.scheme) return false;
    return c.rsaVerify(s.scheme, k.key, cert.tbs, cert.sig);
  }
  return false;
}

/* ---------- chain verification (OpenSSL 3 build_chain, check_chain_extensions, internal_verify) ---------- */

var VERIFY_MESSAGES = {
  UNABLE_TO_GET_ISSUER_CERT: 'unable to get issuer certificate',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'unable to get local issuer certificate',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'unable to verify the first certificate',
  UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY: 'unable to decode issuer public key',
  CERT_SIGNATURE_FAILURE: 'certificate signature failure',
  CERT_NOT_YET_VALID: 'certificate is not yet valid',
  CERT_HAS_EXPIRED: 'certificate has expired',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'self-signed certificate',
  SELF_SIGNED_CERT_IN_CHAIN: 'self-signed certificate in certificate chain',
  CERT_CHAIN_TOO_LONG: 'certificate chain too long',
  INVALID_CA: 'invalid CA certificate',
  PATH_LENGTH_EXCEEDED: 'path length constraint exceeded',
  INVALID_PURPOSE: 'unsuitable certificate purpose',
  UNHANDLED_CRITICAL_EXTENSION: 'unhandled critical extension',
  KEYUSAGE_NO_CERTSIGN: 'key usage does not include certificate signing',
  UNSPECIFIED: 'unspecified certificate verification error',
  PERMITTED_VIOLATION: 'permitted subtree violation',
  EXCLUDED_VIOLATION: 'excluded subtree violation'
};

/* Node knows a fixed set of X509 codes; the others, such as the name constraint ones, it reports as UNSPECIFIED */
var NODE_UNKNOWN_CODES = { PERMITTED_VIOLATION: true, EXCLUDED_VIOLATION: true };

/* Node 24 appends this hint to three verification failures when it does not use the system CA store, which never
   exists here (src/crypto/crypto_common.cc; calibrated: not for _LOCALLY, SELF_SIGNED_CERT_IN_CHAIN or expiry) */
var SYSTEM_CA_HINT = '; if the root CA is installed locally, try running Node.js with --use-system-ca';
var SYSTEM_CA_HINT_CODES = { UNABLE_TO_GET_ISSUER_CERT: true, UNABLE_TO_VERIFY_LEAF_SIGNATURE: true, DEPTH_ZERO_SELF_SIGNED_CERT: true };

function verifyError(code) {
  var message = VERIFY_MESSAGES[code] || code;
  if (SYSTEM_CA_HINT_CODES[code]) message += SYSTEM_CA_HINT;
  return errWithCode(NODE_UNKNOWN_CODES[code] ? 'UNSPECIFIED' : code, message);
}

/* ---------- name constraints (OpenSSL v3_ncons.c) ---------- */

function ncDns(dns, base) {
  if (base.length === 0) return true;
  var d = dns.toLowerCase();
  var b = base.toLowerCase();
  if (d.length < b.length) return false;
  if (d.length > b.length && b.charAt(0) !== '.' && d.charAt(d.length - b.length - 1) !== '.') return false;
  return d.slice(d.length - b.length) === b;
}

function ncIp(ip, base) {
  if (!ip || !base || base.length !== ip.length * 2) return false;
  for (var i = 0; i < ip.length; i++) {
    var mask = base[ip.length + i];
    if ((ip[i] & mask) !== (base[i] & mask)) return false;
  }
  return true;
}

function ncEmail(email, base) {
  var at = email.lastIndexOf('@');
  if (at < 0) return false;
  var domain = email.slice(at + 1).toLowerCase();
  if (base.indexOf('@') >= 0) {
    var bat = base.lastIndexOf('@');
    return email.slice(0, at) === base.slice(0, bat) && domain === base.slice(bat + 1).toLowerCase();
  }
  var b = base.toLowerCase();
  if (b.charAt(0) === '.') return domain.length > b.length && domain.slice(domain.length - b.length) === b;
  return domain === b;
}

function ncUri(uri, base) {
  var m = /^[^:]*:\/\/([^\/:?#]*)/.exec(uri);
  if (!m || m[1] === '') return false;
  var host = m[1].toLowerCase();
  var b = base.toLowerCase();
  if (b.charAt(0) === '.') return host.length > b.length && host.slice(host.length - b.length) === b;
  return host === b;
}

function ncDirName(rdns, base) {
  if (!base || base.length > rdns.length) return false;
  for (var i = 0; i < base.length; i++) {
    if (base[i] !== rdns[i]) return false;
  }
  return true;
}

function ncMatches(name, sub) {
  if (name.type !== sub.type) return false;
  if (name.type === 'DNS') return ncDns(name.value, sub.value);
  if (name.type === 'IP') return ncIp(name.raw, sub.raw);
  if (name.type === 'email') return ncEmail(name.value, sub.value);
  if (name.type === 'URI') return ncUri(name.value, sub.value);
  if (name.type === 'DirName') return ncDirName(name.rdns, sub.rdns);
  return false;
}

/* nc_match: a name of a constrained type must sit in a permitted subtree and in no excluded one */
function ncMatch(name, nc) {
  var sameType = false;
  var permitted = false;
  for (var i = 0; i < nc.permitted.length; i++) {
    if (nc.permitted[i].type !== name.type) continue;
    sameType = true;
    if (ncMatches(name, nc.permitted[i])) permitted = true;
  }
  if (sameType && !permitted) return 'PERMITTED_VIOLATION';
  for (var j = 0; j < nc.excluded.length; j++) {
    if (ncMatches(name, nc.excluded[j])) return 'EXCLUDED_VIOLATION';
  }
  return null;
}

/* NAME_CONSTRAINTS_check: the subject name, its emailAddress attributes, then every subjectAltName */
function ncCheck(x, nc) {
  var rv = null;
  if (x.subjectRdns.length > 0) rv = ncMatch({ type: 'DirName', rdns: x.subjectRdns }, nc);
  var emails = x.subject.emailAddress === undefined ? [] : [].concat(x.subject.emailAddress);
  for (var e = 0; e < emails.length && !rv; e++) rv = ncMatch({ type: 'email', value: emails[e] }, nc);
  for (var i = 0; i < x.san.length && !rv; i++) rv = ncMatch(x.san[i], nc);
  return rv;
}

/* cn2dnsid: a commonName that looks like a host name (two or more labels, no wildcard) */
function cnLooksLikeDns(cn) {
  var dns = false;
  for (var i = 0; i < cn.length; i++) {
    var ch = cn.charAt(i);
    if (/[A-Za-z0-9]/.test(ch)) continue;
    if (i > 0 && i < cn.length - 1) {
      if (ch === '-') continue;
      if (ch === '.' && cn.charAt(i + 1) !== '.' && cn.charAt(i - 1) !== '-' && cn.charAt(i + 1) !== '-') {
        dns = true;
        continue;
      }
    }
    return false;
  }
  return dns;
}

/* NAME_CONSTRAINTS_check_CN: host-name-like commonNames against the DNS subtrees */
function ncCheckCn(x, nc) {
  var cns = x.subject.CN === undefined ? [] : [].concat(x.subject.CN);
  for (var i = 0; i < cns.length; i++) {
    if (!cnLooksLikeDns(cns[i])) continue;
    var rv = ncMatch({ type: 'DNS', value: cns[i] }, nc);
    if (rv) return rv;
  }
  return null;
}

/* X509_check_akid: an authority key identifier, when present, agrees with the issuer */
function akidMatches(issuer, subject) {
  var aki = subject.aki;
  if (!aki) return true;
  if (aki.keyId && issuer.ski && !eqBytes(aki.keyId, issuer.ski)) return false;
  if (aki.serial && !eqBytes(aki.serial, issuer.serial)) return false;
  return true;
}

/* ossl_x509_likely_issued: names chain, the AKID agrees, the key type can make the signature */
function likelyIssued(issuer, subject) {
  return issuer.subjectCanon === subject.issuerCanon && akidMatches(issuer, subject) && sigAlgMatches(issuer, subject);
}

/* X509_check_ca: 0 not a CA, 1 basicConstraints CA, 3 v1 root, 4 keyCertSign without basicConstraints */
function checkCa(x) {
  if (x.ku && !x.ku.keyCertSign) return 0;
  if (x.bc) return x.bc.ca ? 1 : 0;
  if (x.version === 1 && x.selfSigned) return 3;
  if (x.ku) return 4;
  return 0;
}

function ekuAllows(x, purpose) {
  if (!x.eku) return true;
  for (var i = 0; i < x.eku.length; i++) {
    if (purpose === 'server' && (x.eku[i] === EKU_SERVER || EKU_SGC[x.eku[i]])) return true;
    if (purpose === 'client' && x.eku[i] === EKU_CLIENT) return true;
  }
  return false;
}

/* X509_check_purpose for the SSL server and SSL client purposes */
function purposeOk(x, purpose, asCa) {
  if (!ekuAllows(x, purpose)) return false;
  if (asCa) return checkCa(x) !== 0;
  if (x.ku) {
    if (purpose === 'server' && !(x.ku.digitalSignature || x.ku.keyEncipherment || x.ku.keyAgreement)) return false;
    if (purpose === 'client' && !(x.ku.digitalSignature || x.ku.keyAgreement)) return false;
  }
  return true;
}

/*
 * Verifies a peer chain (parsed certificates, leaf first) against parsed trust anchors.
 * Every check runs and the last failure wins, which is what Node reports: its OpenSSL verify
 * callback accepts every error and Node reads the final verify result after the handshake.
 * opts: {now, purpose: 'server' | 'client', partial: allowPartialTrustChain}. Returns null or an Error.
 */
function verifyChain(c, peer, anchors, opts) {
  var now = opts.now;
  var last = null;
  var fail = function (code) {
    last = code;
  };
  var chain = [peer[0]];
  var used = [true];
  var numUntrusted = 1;
  var trusted = false;
  for (;;) {
    var cur = chain[chain.length - 1];
    if (chain.length > 100) {
      fail('CERT_CHAIN_TOO_LONG');
      break;
    }
    var anchor = null;
    for (var a = 0; a < anchors.length && !anchor; a++) {
      if (likelyIssued(anchors[a], cur)) anchor = anchors[a];
    }
    if (anchor) {
      if (eqBytes(anchor.der, cur.der)) {
        if (cur.selfSigned || opts.partial) {
          if (chain.length === numUntrusted) numUntrusted--;
          trusted = true;
        }
        break;
      }
      chain.push(anchor);
      if (anchor.selfSigned || opts.partial) {
        trusted = true;
        break;
      }
      continue;
    }
    if (cur.selfSigned) break;
    var next = -1;
    for (var i = 1; i < peer.length && next < 0; i++) {
      if (!used[i] && likelyIssued(peer[i], cur)) next = i;
    }
    if (next < 0) break;
    used[next] = true;
    chain.push(peer[next]);
    if (chain.length - 1 === numUntrusted) numUntrusted++;
  }
  var num = chain.length;
  var top = chain[num - 1];
  if (!trusted) {
    if (top.selfSigned) fail(num === 1 ? 'DEPTH_ZERO_SELF_SIGNED_CERT' : 'SELF_SIGNED_CERT_IN_CHAIN');
    else fail(numUntrusted < num ? 'UNABLE_TO_GET_ISSUER_CERT' : 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY');
  }
  /* check_chain_extensions, leaf to top */
  var mustBeCa = -1;
  var plen = 0;
  for (var j = 0; j < num; j++) {
    var x = chain[j];
    if (x.unhandledCritical) fail('UNHANDLED_CRITICAL_EXTENSION');
    var ret = checkCa(x);
    if (mustBeCa > 0 && (ret === 0 || (j + 1 < num && ret !== 1))) fail('INVALID_CA');
    if (!purposeOk(x, opts.purpose, mustBeCa > 0)) fail('INVALID_PURPOSE');
    if (j > 1 && x.bc && x.bc.pathLen >= 0 && plen > x.bc.pathLen) fail('PATH_LENGTH_EXCEEDED');
    if (j > 0 && !x.selfIssued) plen++;
    mustBeCa = 1;
  }
  /* internal_verify, top to leaf: issuer key usage, signatures, validity periods */
  var n = num - 1;
  var xi = chain[n];
  var xs = xi;
  if (!likelyIssued(xi, xi) && !opts.partial) {
    if (n > 0) {
      n--;
      xs = chain[n];
    } else {
      fail('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    }
  }
  while (n >= 0) {
    if (xs !== xi) {
      if (xi.ku && !xi.ku.keyCertSign) fail('KEYUSAGE_NO_CERTSIGN');
      if (xi.spki.type === 'unsupported') fail('UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY');
      else if (!certSigOk(c, xi, xs)) fail('CERT_SIGNATURE_FAILURE');
    }
    if (now < xs.notBefore) fail('CERT_NOT_YET_VALID');
    if (now > xs.notAfter) fail('CERT_HAS_EXPIRED');
    if (--n >= 0) {
      xi = xs;
      xs = chain[n];
    }
  }
  /* check_name_constraints: every certificate below a constraining CA; the leaf's commonName too when it has no DNS name */
  for (var ii = num - 1; ii >= 0; ii--) {
    var xx = chain[ii];
    if (ii > 0 && xx.selfIssued) continue;
    for (var jj = num - 1; jj > ii; jj--) {
      var ncon = chain[jj].nc;
      if (!ncon) continue;
      var rv = ncCheck(xx, ncon);
      if (!rv && ii === 0 && !xx.san.some(function (sn) { return sn.type === 'DNS'; })) rv = ncCheckCn(xx, ncon);
      if (rv) fail(rv);
    }
  }
  return last === null ? null : verifyError(last);
}

/* ---------- Node's tls.checkServerIdentity ---------- */

function isIPv4(s) {
  return typeof s === 'string' && /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(s);
}

function ipv6Groups(s) {
  if (typeof s !== 'string' || s.indexOf(':') === -1) return null;
  var text = s;
  var lastColon = text.lastIndexOf(':');
  var tail4 = text.slice(lastColon + 1);
  if (tail4.indexOf('.') !== -1) {
    if (!isIPv4(tail4)) return null;
    var p4 = tail4.split('.');
    text = text.slice(0, lastColon + 1) + ((+p4[0] << 8) | +p4[1]).toString(16) + ':' + ((+p4[2] << 8) | +p4[3]).toString(16);
  }
  var halves = text.split('::');
  if (halves.length > 2) return null;
  var head = halves[0] === '' ? [] : halves[0].split(':');
  var tail = halves.length === 2 && halves[1] !== '' ? halves[1].split(':') : [];
  var all = head.concat(tail);
  for (var i = 0; i < all.length; i++) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(all[i])) return null;
  }
  if (halves.length === 1 && head.length !== 8) return null;
  if (halves.length === 2 && head.length + tail.length > 7) return null;
  var groups = [];
  for (i = 0; i < head.length; i++) groups.push(parseInt(head[i], 16));
  if (halves.length === 2) for (i = 0; i < 8 - head.length - tail.length; i++) groups.push(0);
  for (i = 0; i < tail.length; i++) groups.push(parseInt(tail[i], 16));
  return groups;
}

function isIP(s) {
  if (isIPv4(s)) return 4;
  return ipv6Groups(s) ? 6 : 0;
}

/* inet_pton then inet_ntop: the canonical text Node compares IP identities with */
function canonicalizeIP(s) {
  if (isIPv4(s)) return s.split('.').map(Number).join('.');
  var g = ipv6Groups(s);
  if (!g) return s;
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 65535) {
    return '::ffff:' + (g[6] >> 8) + '.' + (g[6] & 255) + '.' + (g[7] >> 8) + '.' + (g[7] & 255);
  }
  var bestStart = -1;
  var bestLen = 0;
  for (var i = 0; i < 8;) {
    if (g[i] !== 0) {
      i++;
      continue;
    }
    var j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  var hex = g.map(function (v) { return v.toString(16); });
  if (bestStart < 0) return hex.join(':');
  return hex.slice(0, bestStart).join(':') + '::' + hex.slice(bestStart + bestLen).join(':');
}

function unfqdn(host) {
  return host.replace(/[.]$/, '');
}

function splitHost(host) {
  return unfqdn(host).replace(/[A-Z]/g, function (ch) { return String.fromCharCode(32 + ch.charCodeAt(0)); }).split('.');
}

function checkHostPattern(hostParts, pattern, wildcards) {
  if (!pattern) return false;
  var patternParts = splitHost(pattern);
  if (hostParts.length !== patternParts.length) return false;
  if (patternParts.indexOf('') !== -1) return false;
  for (var b = 0; b < patternParts.length; b++) {
    if (/[^\u0021-\u007F]/.test(patternParts[b])) return false;
  }
  for (var i = hostParts.length - 1; i > 0; i -= 1) {
    if (hostParts[i] !== patternParts[i]) return false;
  }
  var hostSubdomain = hostParts[0];
  var patternSubdomain = patternParts[0];
  var patternSubdomainParts = patternSubdomain.split('*');
  if (patternSubdomainParts.length === 1 || patternSubdomain.indexOf('xn--') !== -1) return hostSubdomain === patternSubdomain;
  if (!wildcards) return false;
  if (patternSubdomainParts.length > 2) return false;
  if (patternParts.length <= 2) return false;
  var prefix = patternSubdomainParts[0];
  var suffix = patternSubdomainParts[1];
  if (prefix.length + suffix.length > hostSubdomain.length) return false;
  if (hostSubdomain.indexOf(prefix) !== 0) return false;
  if (hostSubdomain.slice(hostSubdomain.length - suffix.length) !== suffix) return false;
  return true;
}

function splitEscapedAltNames(altNames) {
  var result = [];
  var currentToken = '';
  var offset = 0;
  while (offset !== altNames.length) {
    var nextSep = altNames.indexOf(',', offset);
    var nextQuote = altNames.indexOf('"', offset);
    if (nextQuote !== -1 && (nextSep === -1 || nextQuote < nextSep)) {
      currentToken += altNames.slice(offset, nextQuote);
      var match = /^"((?:[^"\\]|\\.)*)"/.exec(altNames.slice(nextQuote));
      if (!match) throw errWithCode('ERR_TLS_CERT_ALTNAME_FORMAT', 'Invalid subject alternative name string');
      currentToken += JSON.parse(match[0]);
      offset = nextQuote + match[0].length;
    } else if (nextSep !== -1) {
      currentToken += altNames.slice(offset, nextSep);
      result.push(currentToken);
      currentToken = '';
      offset = nextSep + 2;
    } else {
      currentToken += altNames.slice(offset);
      offset = altNames.length;
    }
  }
  result.push(currentToken);
  return result;
}

/* A port of Node's tls.checkServerIdentity(hostname, cert): undefined, or the Error to report */
function checkServerIdentity(hostname, cert) {
  var subject = cert && cert.subject;
  var altNames = cert && cert.subjectaltname;
  var dnsNames = [];
  var ips = [];
  var host = '' + hostname;
  if (altNames) {
    var splitAltNames = altNames.indexOf('"') !== -1 ? splitEscapedAltNames(altNames) : altNames.split(', ');
    for (var i = 0; i < splitAltNames.length; i++) {
      var name = splitAltNames[i];
      if (name.indexOf('DNS:') === 0) dnsNames.push(name.slice(4));
      else if (name.indexOf('IP Address:') === 0) ips.push(canonicalizeIP(name.slice(11)));
    }
  }
  var valid = false;
  var reason = 'Unknown reason';
  host = unfqdn(host);
  if (isIP(host)) {
    valid = ips.indexOf(canonicalizeIP(host)) !== -1;
    if (!valid) reason = 'IP: ' + host + " is not in the cert's list: " + ips.join(', ');
  } else if (dnsNames.length > 0 || (subject && subject.CN)) {
    var hostParts = splitHost(host);
    var wildcard = function (pattern) {
      return checkHostPattern(hostParts, pattern, true);
    };
    if (dnsNames.length > 0) {
      valid = dnsNames.some(wildcard);
      if (!valid) reason = 'Host: ' + host + ". is not in the cert's altnames: " + altNames;
    } else {
      var cn = subject.CN;
      if (Array.isArray(cn)) valid = cn.some(wildcard);
      else if (cn) valid = wildcard(cn);
      if (!valid) reason = 'Host: ' + host + ". is not cert's CN: " + cn;
    }
  } else {
    reason = 'Cert does not contain a DNS name';
  }
  if (!valid) {
    var err = errWithCode('ERR_TLS_CERT_ALTNAME_INVALID', "Hostname/IP does not match certificate's altnames: " + reason);
    err.reason = reason;
    err.host = host;
    err.cert = cert;
    return err;
  }
  return undefined;
}

/* ---------- the Node-shaped certificate object of getPeerCertificate() ---------- */

var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatCertTime(ms) {
  var d = new Date(ms);
  var pad = function (v) { return (v < 10 ? '0' : '') + v; };
  var day = d.getUTCDate();
  return MONTHS[d.getUTCMonth()] + ' ' + (day < 10 ? ' ' + day : String(day)) + ' ' + pad(d.getUTCHours()) + ':' +
    pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + ' ' + d.getUTCFullYear() + ' GMT';
}

function sanText(parsed) {
  if (parsed.san.length === 0) return undefined;
  var parts = [];
  for (var i = 0; i < parsed.san.length; i++) {
    var entry = parsed.san[i];
    var prefix = entry.type === 'IP' ? 'IP Address:' : entry.type + ':';
    parts.push(entry.type === 'IP' ? prefix + entry.value : sanEntryText(prefix, entry.value));
  }
  return parts.join(', ');
}

function infoAccessOf(parsed) {
  if (!parsed.aia || parsed.aia.length === 0) return undefined;
  var out = Object.create(null);
  for (var i = 0; i < parsed.aia.length; i++) {
    var e = parsed.aia[i];
    if (!out[e.label]) out[e.label] = [];
    out[e.label].push(e.uri);
  }
  return out;
}

/* X509_check_issued: likely issued, and the issuer's key usage allows certificate signing */
function checkIssued(issuer, subject) {
  return likelyIssued(issuer, subject) && !(issuer.ku && !issuer.ku.keyCertSign);
}

/*
 * The object Node's getPeerCertificate() returns for parsed[0]. With detailed, issuerCertificate
 * follows Node's GetPeerCert: issuers found among the peer's other certificates (X509_check_issued),
 * then issuers from the trust store until a certificate that issued itself, and only such a last
 * certificate is linked to itself. A trusted self-signed leaf whose key usage lacks keyCertSign gets
 * a separate copy as issuer; an untrusted one gets none. toBuffer turns bytes into Buffers.
 */
function certificateObject(c, parsed, extra, detailed, toBuffer) {
  var anchors = extra || [];
  var build = function (x) {
    var k = x.spki;
    var o = {};
    o.subject = x.subject;
    o.issuer = x.issuer;
    o.subjectaltname = sanText(x);
    o.infoAccess = infoAccessOf(x);
    o.ca = !!(x.bc && x.bc.ca);
    o.modulus = k.type === 'rsa' || k.type === 'rsa-pss' ? hexUpper(k.key.n) : undefined;
    o.exponent = k.type === 'rsa' || k.type === 'rsa-pss' ? '0x' + hexLower(k.key.e).replace(/^0+(?=.)/, '') : undefined;
    o.pubkey = k.type === 'ec' ? toBuffer(k.point) : k.type === 'rsa' || k.type === 'rsa-pss' ? toBuffer(k.der) : undefined;
    o.bits = k.bits || undefined;
    o.valid_from = formatCertTime(x.notBefore);
    o.valid_to = formatCertTime(x.notAfter);
    o.fingerprint = hexColon(c.digest('sha1', x.der));
    o.fingerprint256 = hexColon(c.digest('sha256', x.der));
    o.fingerprint512 = hexColon(c.digest('sha512', x.der));
    o.ext_key_usage = x.eku ? x.eku.slice() : undefined;
    o.serialNumber = x.serialNumber;
    o.raw = toBuffer(x.der);
    o.asn1Curve = k.type === 'ec' ? CURVE_INFO[k.curve].asn1 : undefined;
    o.nistCurve = k.type === 'ec' ? CURVE_INFO[k.curve].nist : undefined;
    return o;
  };
  var result = build(parsed[0]);
  if (!detailed) return result;
  var remaining = parsed.slice(1);
  var cur = parsed[0];
  var obj = result;
  for (;;) {
    var idx = -1;
    for (var i = 0; i < remaining.length && idx < 0; i++) {
      if (checkIssued(remaining[i], cur)) idx = i;
    }
    if (idx < 0) break;
    var next = remaining.splice(idx, 1)[0];
    var nextObj = build(next);
    obj.issuerCertificate = nextObj;
    obj = nextObj;
    cur = next;
  }
  while (!checkIssued(cur, cur)) {
    var ca = null;
    for (var a = 0; a < anchors.length && !ca; a++) {
      if (likelyIssued(anchors[a], cur)) ca = anchors[a];
    }
    if (!ca) break;
    var caObj = build(ca);
    obj.issuerCertificate = caObj;
    obj = caObj;
    if (ca === cur) break;
    cur = ca;
  }
  if (checkIssued(cur, cur)) obj.issuerCertificate = obj;
  return result;
}

/* OpenSSL's certificate slot of a key or a certificate's public key: rsa, rsa-pss, ec (any curve) */
function keySlot(type, oid) {
  if (type === 'rsa' || type === 'rsa-pss') return type;
  if (type === 'ec' || oid === EC_OID) return 'ec';
  return 'other:' + (oid || type);
}

/* X509_check_private_key: the private key belongs to the certificate's public key (EC by a signature round trip) */
function keyMatchesCertificate(cap, key, leaf) {
  var k = leaf.spki;
  if (key.type === 'rsa' || key.type === 'rsa-pss') {
    return (k.type === 'rsa' || k.type === 'rsa-pss') && eqBytes(k.key.n, key.n) && eqBytes(k.key.e, key.e);
  }
  if (key.type === 'ec') {
    if (k.type !== 'ec' || k.curve !== key.curve) return false;
    var c = makeCrypto(cap);
    var digest = c.digest(key.curve === 'p384' ? 'sha384' : 'sha256', latin1Bytes('owc private key and certificate pair check'));
    try {
      return c.ecdsaVerify(key.curve, k.point, digest, c.ecdsaSign(key.curve, key.priv, digest));
    } catch (failure) {
      return false;
    }
  }
  return false;
}

/* ---------- TLS 1.3 constants ---------- */

var CT_CCS = 20;
var CT_ALERT = 21;
var CT_HANDSHAKE = 22;
var CT_APPDATA = 23;
var MAX_PLAIN = 16384;

var HT = {
  client_hello: 1, server_hello: 2, new_session_ticket: 4, end_of_early_data: 5, encrypted_extensions: 8,
  certificate: 11, certificate_request: 13, certificate_verify: 15, finished: 20, key_update: 24, message_hash: 254
};

var EXT = {
  server_name: 0, supported_groups: 10, signature_algorithms: 13, alpn: 16, record_size_limit: 28,
  pre_shared_key: 41, early_data: 42, supported_versions: 43, cookie: 44, psk_key_exchange_modes: 45,
  certificate_authorities: 47, signature_algorithms_cert: 50, key_share: 51, quic_transport_parameters: 57
};

var GROUP_P256 = 23;
var GROUP_X25519 = 29;
var GROUP_NAMES = { 23: 'prime256v1', 29: 'X25519' };
var GROUP_BITS = { 23: 256, 29: 253 };

var SUITES = {
  4865: { id: 4865, name: 'TLS_AES_128_GCM_SHA256', alg: 'sha256', keyLen: 16, aead: 'aes-128-gcm' },
  4866: { id: 4866, name: 'TLS_AES_256_GCM_SHA384', alg: 'sha384', keyLen: 32, aead: 'aes-256-gcm' },
  4867: { id: 4867, name: 'TLS_CHACHA20_POLY1305_SHA256', alg: 'sha256', keyLen: 32, aead: 'chacha20-poly1305' }
};
/* OpenSSL's default TLS 1.3 ciphersuites order */
var DEFAULT_SUITES = [4866, 4867, 4865];
var DEFAULT_GROUPS = [GROUP_X25519, GROUP_P256];

/* Every signature scheme this engine can check, in the order it offers them */
var SIG_SCHEMES = {
  0x0403: { kind: 'ecdsa', curve: 'p256', hash: 'sha256', cv: true },
  0x0503: { kind: 'ecdsa', curve: 'p384', hash: 'sha384', cv: true },
  0x0804: { kind: 'rsa', key: 'rsa', scheme: 'pss-sha256', hash: 'sha256', cv: true },
  0x0805: { kind: 'rsa', key: 'rsa', scheme: 'pss-sha384', hash: 'sha384', cv: true },
  0x0806: { kind: 'rsa', key: 'rsa', scheme: 'pss-sha512', hash: 'sha512', cv: true },
  0x0809: { kind: 'rsa', key: 'rsa-pss', scheme: 'pss-sha256', hash: 'sha256', cv: true },
  0x080a: { kind: 'rsa', key: 'rsa-pss', scheme: 'pss-sha384', hash: 'sha384', cv: true },
  0x080b: { kind: 'rsa', key: 'rsa-pss', scheme: 'pss-sha512', hash: 'sha512', cv: true },
  0x0401: { kind: 'rsa', key: 'rsa', scheme: 'pkcs1-sha256', hash: 'sha256', cv: false },
  0x0501: { kind: 'rsa', key: 'rsa', scheme: 'pkcs1-sha384', hash: 'sha384', cv: false },
  0x0601: { kind: 'rsa', key: 'rsa', scheme: 'pkcs1-sha512', hash: 'sha512', cv: false }
};
/* OpenSSL's default order, without the schemes this engine cannot check */
var DEFAULT_SIGALGS = [0x0403, 0x0503, 0x0809, 0x080a, 0x080b, 0x0804, 0x0805, 0x0806, 0x0401, 0x0501, 0x0601];

var QUIC_LEVELS = { initial: true, handshake: true, '1-rtt': true };

/* RFC 9001 section 4.1.3: the encryption level a TLS message travels at in QUIC */
function quicLevelOf(type) {
  if (type === HT.client_hello || type === HT.server_hello) return 'initial';
  if (type === HT.new_session_ticket || type === HT.key_update) return '1-rtt';
  return 'handshake';
}

function ext(type, body) {
  return cat(u16(type), u16(body.length), body);
}

function extBlock(list) {
  var body = catList(list);
  return cat(u16(body.length), body);
}

function orderExts(list, order) {
  var rank = function (entry) {
    var i = order.indexOf(entry.t);
    return i < 0 ? order.length : i;
  };
  return list.map(function (entry, index) { return { e: entry, i: index }; })
    .sort(function (a, b) { return (rank(a.e) - rank(b.e)) || (a.i - b.i); })
    .map(function (x) { return x.e.b; });
}

/* ---------- bounds-checked message reader ---------- */

function Reader(u, start, end) {
  this.u = u;
  this.p = start || 0;
  this.e = end === undefined ? u.length : end;
}

Reader.prototype.need = function (n) {
  if (this.p + n > this.e) throw decodeErr();
};
Reader.prototype.u8 = function () {
  this.need(1);
  return this.u[this.p++];
};
Reader.prototype.u16 = function () {
  this.need(2);
  var v = (this.u[this.p] << 8) | this.u[this.p + 1];
  this.p += 2;
  return v;
};
Reader.prototype.u24 = function () {
  this.need(3);
  var v = (this.u[this.p] << 16) | (this.u[this.p + 1] << 8) | this.u[this.p + 2];
  this.p += 3;
  return v;
};
Reader.prototype.bytes = function (n) {
  this.need(n);
  var b = this.u.slice(this.p, this.p + n);
  this.p += n;
  return b;
};
Reader.prototype.vec8 = function () {
  return this.bytes(this.u8());
};
Reader.prototype.vec16 = function () {
  return this.bytes(this.u16());
};
Reader.prototype.vec24 = function () {
  return this.bytes(this.u24());
};
Reader.prototype.atEnd = function () {
  return this.p >= this.e;
};
Reader.prototype.finish = function () {
  if (this.p !== this.e) throw decodeErr();
};

/* An extension block (u16 length first) as {map: type -> body, order: [types]}; duplicates are illegal */
function readExtensions(r) {
  var block = r.vec16();
  var x = new Reader(block);
  var map = {};
  var order = [];
  while (!x.atEnd()) {
    var t = x.u16();
    var body = x.vec16();
    if (map[t] !== undefined) throw sslErr(47, 'bad extension');
    map[t] = body;
    order.push(t);
  }
  return { map: map, order: order };
}

function u16List(body, lengthBytes) {
  var r = new Reader(body);
  var inner = lengthBytes === 1 ? r.vec8() : r.vec16();
  r.finish();
  if (inner.length % 2 !== 0) throw decodeErr();
  var out = [];
  for (var i = 0; i < inner.length; i += 2) out.push((inner[i] << 8) | inner[i + 1]);
  return out;
}

function parseAlpnList(body) {
  var r = new Reader(body);
  var list = new Reader(r.vec16());
  r.finish();
  var names = [];
  while (!list.atEnd()) {
    var name = list.vec8();
    if (name.length === 0) throw decodeErr();
    names.push(latin1Of(name, 0, name.length));
  }
  return names;
}

function nonceOf(iv, hi, lo) {
  var n = new Uint8Array(12);
  n.set(iv);
  n[4] ^= (hi >>> 24) & 255;
  n[5] ^= (hi >>> 16) & 255;
  n[6] ^= (hi >>> 8) & 255;
  n[7] ^= hi & 255;
  n[8] ^= (lo >>> 24) & 255;
  n[9] ^= (lo >>> 16) & 255;
  n[10] ^= (lo >>> 8) & 255;
  n[11] ^= lo & 255;
  return n;
}

function bumpSeq(state) {
  state.lo = (state.lo + 1) >>> 0;
  if (state.lo === 0) state.hi = (state.hi + 1) >>> 0;
}

function cvContent(context, transcriptHash) {
  var pad = new Uint8Array(64);
  pad.fill(32);
  return cat(pad, latin1Bytes(context), [0], transcriptHash);
}

/* The CertificateVerify schemes a key can sign, in preference order */
function schemesForKey(key) {
  if (!key) return [];
  if (key.type === 'ec') return key.curve === 'p256' ? [0x0403] : key.curve === 'p384' ? [0x0503] : [];
  if (key.type === 'rsa') return [0x0804, 0x0805, 0x0806];
  if (key.type === 'rsa-pss') {
    var h = key.pss && key.pss.hash;
    if (h === 'sha384') return [0x080a];
    if (h === 'sha512') return [0x080b];
    if (h === 'sha256') return [0x0809];
    return [0x0809, 0x080a, 0x080b];
  }
  return [];
}

/* OpenSSL's shared sigalgs: the peer's order filtered by ours, or, under server preference, ours (the configured list or
   OpenSSL's default order) filtered by the peer's */
function sharedSigAlgs(peer, mine, ourOrder) {
  var conf = mine || (ourOrder ? DEFAULT_SIGALGS : null);
  if (!conf) return peer;
  var pref = ourOrder ? conf : peer;
  var allow = ourOrder ? peer : conf;
  return pref.filter(function (v) { return allow.indexOf(v) >= 0; });
}

/* ---------- the engine ---------- */

function Engine(o) {
  if (typeof o.cap !== 'function') throw errWithCode('ERR_INVALID_ARG_TYPE', 'a capability function is required');
  this.role = o.role === 'server' ? 'server' : 'client';
  this.quic = o.quic === true;
  this.c = makeCrypto(o.cap);
  this.rng = typeof o.random === 'function' ? o.random : null;
  this.hooks = o.testHooks || {};
  this.keyPairSource = o.keyPairs || null;
  this.nowFn = function () { return typeof o.now === 'number' ? o.now : Date.now(); };
  this.serverName = typeof o.serverName === 'string' && o.serverName !== '' ? o.serverName : null;
  this.alpnList = Array.isArray(o.ALPNProtocols) ? o.ALPNProtocols.slice() : [];
  this.alpnCallback = typeof o.alpnCallback === 'function' ? o.alpnCallback : null;
  this.quicParams = o.quicTransportParameters ? Uint8Array.from(o.quicTransportParameters) : null;
  this.suites = Array.isArray(o.suites) && o.suites.length ? o.suites.slice() : DEFAULT_SUITES.slice();
  this.groups = Array.isArray(o.groups) && o.groups.length ? o.groups.slice() : DEFAULT_GROUPS.slice();
  this.keyShareGroups = Array.isArray(o.keyShareGroups) && o.keyShareGroups.length ? o.keyShareGroups.slice() : this.groups.slice();
  this.honorCipherOrder = o.honorCipherOrder === true;
  /* the sigalgs option: the schemes offered and accepted, in preference order (null: DEFAULT_SIGALGS) */
  this.sigalgs = Array.isArray(o.sigalgs) && o.sigalgs.length ? o.sigalgs.filter(function (v) { return !!SIG_SCHEMES[v]; }) : null;
  if (this.sigalgs && this.sigalgs.length === 0) this.sigalgs = null;
  this.anchors = (o.anchors || []).map(function (a) { return a && a.der && a.subjectCanon !== undefined ? a : parseCertificate(a); });
  this.partialChain = o.allowPartialTrustChain === true;
  this.hostname = o.hostname !== undefined && o.hostname !== null && o.hostname !== '' ? String(o.hostname) : null;
  this.identityCheck = typeof o.identityCheck === 'function' ? o.identityCheck : null;
  this.onSecrets = typeof o.onSecrets === 'function' ? o.onSecrets : null;
  this.contexts = [];
  if (Array.isArray(o.contexts)) {
    for (var i = 0; i < o.contexts.length; i++) this.contexts.push(normalizeContext(o.contexts[i]));
  } else if (o.certificates && o.privateKey) {
    this.contexts.push(normalizeContext({ certificates: o.certificates, privateKey: o.privateKey }));
  }
  this.requestCert = o.requestCert === true;
  this.requireCert = o.requestCert === true && o.rejectUnauthorized === true;
  this.deferContext = o.deferContext === true;
  if (this.role === 'server' && this.contexts.length === 0 && !this.deferContext) {
    throw errWithCode('ERR_TLS_NO_CERTIFICATE', 'a server needs a certificate chain and a private key');
  }
  this.hrrRandom = this.c.digest('sha256', latin1Bytes('HelloRetryRequest'));
  this.state = this.role === 'client' ? 'C_START' : 'S_START';
  this.suite = null;
  this.tx = [];
  this.hsIn = new Uint8Array(0);
  this.qin = { initial: new Uint8Array(0), handshake: new Uint8Array(0), '1-rtt': new Uint8Array(0) };
  this.qout = { initial: [], handshake: [], '1-rtt': [] };
  this.recvBuf = new Uint8Array(0);
  this.firstRecord = true;
  this.rd = null;
  this.wr = null;
  this.rdSecret = null;
  this.wrSecret = null;
  this.outList = [];
  this.events = [];
  this.secrets = {};
  this.kx = {};
  this.group = null;
  this.offeredExts = {};
  this.clientRandom = null;
  this.clientSessionId = null;
  this.serverRandom = null;
  this.hrrSeen = false;
  this.hrrSent = false;
  this.hrrGroup = null;
  this.hrrSuite = null;
  this.cookie = null;
  this.certRequested = false;
  this.certRequestContext = new Uint8Array(0);
  this.peerSigAlgs = null;
  this.peerCertDers = null;
  this.peerCerts = null;
  this.peerQuicTransportParameters = null;
  this.alpn = null;
  this.peerServerName = null;
  this.selected = null;
  this.verifyData = null;
  this.peerVerifyData = null;
  this.dead = false;
  this.connected = false;
  this.peerClosed = false;
  this.closeSent = false;
  this.cipherName = null;
  this.pendingHello = null;
}

function normalizeContext(ctx) {
  var certs = (ctx.certificates || []).map(function (d) { return Uint8Array.from(d); });
  if (certs.length === 0 || !ctx.privateKey) throw errWithCode('ERR_TLS_NO_CERTIFICATE', 'a certificate chain and a private key are required');
  return { certificates: certs, privateKey: ctx.privateKey, leaf: ctx.leaf || parseCertificate(certs[0]) };
}

function createEngine(options) {
  return new Engine(options || {});
}

Engine.prototype._drain = function () {
  var out = this.events;
  this.events = [];
  return out;
};

Engine.prototype._random = function (n) {
  return this.rng ? Uint8Array.from(this.rng(n)) : this.c.random(n);
};

Engine.prototype._keyPair = function (group) {
  var name = group === GROUP_X25519 ? 'x25519' : 'p256';
  var queue = this.keyPairSource && this.keyPairSource[name];
  if (queue && queue.length > 0) {
    var injected = queue.shift();
    return { priv: Uint8Array.from(injected.priv), pub: Uint8Array.from(injected.pub) };
  }
  return group === GROUP_X25519 ? this.c.x25519Pair() : this.c.p256Pair();
};

Engine.prototype._sharedSecret = function (group, priv, peerKey) {
  if (group === GROUP_X25519) return this.c.x25519Shared(priv, peerKey);
  if (group === GROUP_P256) return this.c.p256Shared(priv, peerKey);
  throw sslErr(47, 'bad key share');
};

Engine.prototype._buildMsg = function (type, body) {
  return cat([type], u24(body.length), body);
};

Engine.prototype._transcriptHash = function () {
  return this.c.digest(this.suite.alg, catList(this.tx));
};

Engine.prototype._keyState = function (secret) {
  var alg = this.suite.alg;
  return {
    alg: this.suite.aead,
    key: expandLabel(this.c, alg, secret, 'key', new Uint8Array(0), this.suite.keyLen),
    iv: expandLabel(this.c, alg, secret, 'iv', new Uint8Array(0), 12),
    hi: 0,
    lo: 0
  };
};

Engine.prototype._emitSecrets = function (level, client, server) {
  this.secrets[level] = { client: client, server: server };
  var suite = { name: this.suite.name, hash: this.suite.alg, aead: this.suite.aead, keyLen: this.suite.keyLen };
  this.events.push({ type: 'secrets', level: level, client: client, server: server, suite: suite });
  if (this.onSecrets) this.onSecrets(level, { client: client, server: server, suite: suite });
};

Engine.prototype._deriveHandshake = function (ecdhe) {
  var c = this.c;
  var alg = this.suite.alg;
  var zeros = new Uint8Array(HASH_LEN[alg]);
  var early = hkdfExtract(c, alg, zeros, zeros);
  var derived = deriveSecret(c, alg, early, 'derived', c.digest(alg, new Uint8Array(0)));
  this.earlySecret = early;
  this.hsSecret = hkdfExtract(c, alg, derived, ecdhe);
  var th = this._transcriptHash();
  this.chsSecret = deriveSecret(c, alg, this.hsSecret, 'c hs traffic', th);
  this.shsSecret = deriveSecret(c, alg, this.hsSecret, 's hs traffic', th);
  this._emitSecrets('handshake', this.chsSecret, this.shsSecret);
};

/* Application traffic secrets from the transcript through the server Finished */
Engine.prototype._deriveApp = function () {
  var c = this.c;
  var alg = this.suite.alg;
  var zeros = new Uint8Array(HASH_LEN[alg]);
  var derived = deriveSecret(c, alg, this.hsSecret, 'derived', c.digest(alg, new Uint8Array(0)));
  this.masterSecret = hkdfExtract(c, alg, derived, zeros);
  var th = this._transcriptHash();
  this.capSecret = deriveSecret(c, alg, this.masterSecret, 'c ap traffic', th);
  this.sapSecret = deriveSecret(c, alg, this.masterSecret, 's ap traffic', th);
  this.expMasterSecret = deriveSecret(c, alg, this.masterSecret, 'exp master', th);
  this._emitSecrets('1-rtt', this.capSecret, this.sapSecret);
};

Engine.prototype.expandLabel = function (secret, label, context, len) {
  return expandLabel(this.c, this.suite.alg, secret, label, context, len);
};

/* RFC 8446 section 7.5 exporter (Node's exportKeyingMaterial) */
Engine.prototype.exportKeyingMaterial = function (label, context, length) {
  if (!this.connected) throw errWithCode('ERR_TLS_NOT_CONNECTED', 'handshake is not complete');
  var alg = this.suite.alg;
  var c = this.c;
  var labelBytes = typeof label === 'string' ? latin1Bytes(label) : Uint8Array.from(label);
  var secret = expandLabel(c, alg, this.expMasterSecret, latin1Of(labelBytes), c.digest(alg, new Uint8Array(0)), HASH_LEN[alg]);
  return expandLabel(c, alg, secret, 'exporter', c.digest(alg, context ? Uint8Array.from(context) : new Uint8Array(0)), length);
};

/* ---------- records (TLS mode) ---------- */

Engine.prototype._writeRecord = function (type, body, legacyVersion) {
  if (!this.wr) {
    this.outList.push(cat([type, legacyVersion >> 8, legacyVersion & 255], u16(body.length), body));
    return;
  }
  var inner = cat(body, [type]);
  var len = inner.length + 16;
  var header = [CT_APPDATA, 3, 3, len >> 8, len & 255];
  var ct = this.c.aeadSeal(this.wr.alg, this.wr.key, nonceOf(this.wr.iv, this.wr.hi, this.wr.lo), header, inner);
  bumpSeq(this.wr);
  this.outList.push(cat(header, ct));
};

Engine.prototype._writeChunked = function (type, body, legacyVersion) {
  for (var off = 0; off < body.length; off += MAX_PLAIN) {
    this._writeRecord(type, body.subarray(off, Math.min(off + MAX_PLAIN, body.length)), legacyVersion);
  }
  if (body.length === 0 && type !== CT_HANDSHAKE) this._writeRecord(type, body, legacyVersion);
};

Engine.prototype.takeOutput = function () {
  var out = catList(this.outList);
  this.outList = [];
  return out;
};

Engine.prototype.takeCrypto = function (level) {
  if (!this.quic) throw errWithCode('ERR_TLS_TLS_MODE', 'takeCrypto is for QUIC mode');
  if (!QUIC_LEVELS[level]) throw errWithCode('ERR_INVALID_ARG_VALUE', 'unknown encryption level');
  var parts = this.qout[level];
  this.qout[level] = [];
  return catList(parts);
};

/* Adds a handshake message to the transcript and queues it at a level (QUIC) or in a record (TLS) */
Engine.prototype._send = function (type, body, level, legacyVersion) {
  var msg = this._buildMsg(type, body);
  this.tx.push(msg);
  if (this.quic) this.qout[level].push(msg);
  else this._writeChunked(CT_HANDSHAKE, msg, legacyVersion || 0x0303);
  return msg;
};

/* Handshake messages already in the transcript, coalesced into records (TLS) or queued at one level (QUIC) */
Engine.prototype._writeFlight = function (msgs, level) {
  if (this.quic) {
    for (var j = 0; j < msgs.length; j++) this.qout[level].push(msgs[j]);
  } else {
    this._writeChunked(CT_HANDSHAKE, catList(msgs), 0x0303);
  }
};

Engine.prototype._fail = function (alert, code, message, extra) {
  if (this.dead) return;
  if (!this.quic && alert !== undefined && alert !== null) {
    try {
      this._writeRecord(CT_ALERT, [2, alert], 0x0303);
    } catch (failure) {
      // The alert is best effort; the local failure is reported regardless.
    }
  }
  this.dead = true;
  var ev = { type: 'error', code: code, message: message || code, alert: alert === undefined ? null : alert };
  if (extra) for (var k in extra) ev[k] = extra[k];
  this.events.push(ev);
};

Engine.prototype._failWith = function (err) {
  var alert = err && err.alert !== undefined ? err.alert : 80;
  var code = err && typeof err.code === 'string' ? err.code : 'ERR_SSL_INTERNAL_ERROR';
  var extra = null;
  if (err && err.original) extra = { original: err.original };
  else if (err && err.reason) extra = { reason: err.reason, library: err.library };
  this._fail(alert, code, err && err.message ? err.message : code, extra);
};

/* TLS mode input: TCP bytes; returns the events they produced */
Engine.prototype.receive = function (bytes) {
  if (this.quic) throw errWithCode('ERR_TLS_QUIC_MODE', 'receive is for TLS mode; use feedCrypto in QUIC mode');
  if (this.dead) return this._drain();
  this.inputDeferred = false;
  this.recvBuf = this.recvBuf.length ? cat(this.recvBuf, bytes) : Uint8Array.from(bytes);
  try {
    while (!this.dead && this.recvBuf.length >= 5) {
      var snap = this._readSnapshot();
      try {
        if (!this._receiveRecord()) break;
      } catch (recordFailure) {
        if (this._deferFailure(snap)) break;
        throw recordFailure;
      }
      /* a fatal alert received after such data waits the same way */
      if (this.dead && this._deferFailure(snap)) break;
    }
  } catch (failure) {
    this._failWith(failure);
  }
  return this._drain();
};

/*
 * OpenSSL hands Node one record per SSL_read, and Node runs the 'data' listeners before it reads the next record, so
 * what a listener writes goes out before the alert for a bad record that followed in the same segment. This engine
 * reads every buffered record at once; when a record fails (or carries a fatal alert) while application data is still
 * on its way to the listeners (data from earlier records of this call, or data the caller says is undelivered), the
 * record is put back unprocessed and inputDeferred is set: the caller delivers the data and calls receive() again,
 * and the record then fails. Only a record that left keys and output untouched is put back.
 */
Engine.prototype._readSnapshot = function () {
  return {
    buf: this.recvBuf, rd: this.rd, hi: this.rd ? this.rd.hi : 0, lo: this.rd ? this.rd.lo : 0, wr: this.wr,
    out: this.outList.length, hsIn: this.hsIn, events: this.events.length, dead: this.dead, firstRecord: this.firstRecord
  };
};

Engine.prototype._deferFailure = function (snap) {
  if (!this.deferFailures || !this.connected || snap.dead) return false;
  var pending = this.undeliveredData === true;
  for (var i = 0; i < snap.events && !pending; i++) pending = this.events[i].type === 'data';
  if (!pending || this.rd !== snap.rd || this.wr !== snap.wr || this.outList.length !== snap.out) return false;
  this.recvBuf = snap.buf;
  if (this.rd) {
    this.rd.hi = snap.hi;
    this.rd.lo = snap.lo;
  }
  this.hsIn = snap.hsIn;
  this.dead = false;
  this.events.length = snap.events;
  this.firstRecord = snap.firstRecord;
  this.inputDeferred = true;
  return true;
};

/* One record from recvBuf: false when it is not complete yet */
Engine.prototype._receiveRecord = function () {
  var b = this.recvBuf;
  if (this.firstRecord && this.role === 'server' && b.length >= 4) {
    var head4 = latin1Of(b, 0, 4);
    if (head4 === 'GET ' || head4 === 'POST' || head4 === 'HEAD' || head4 === 'PUT ') throw sslErr(null, 'http request');
    if (head4 === 'CONN') throw sslErr(null, 'https proxy request');
  }
  var len = (b[3] << 8) | b[4];
  /* OpenSSL's read buffer holds 2^14 + 320 bytes; past that a record is "packet length too long" */
  if (len > MAX_PLAIN + 320) throw sslErr(22, 'packet length too long');
  if (this.rd) {
    /* OpenSSL's tls13_validate_record_header once the peer's keys are in use: only application_data, a CCS while
       the read keys date from the first handshake, and plaintext alerts during the handshake; version 0x0303 */
    var ccsAllowed = b[0] === CT_CCS && (this.role === 'client' ? !this.rdUpdated : !this.connected);
    var plainAlertAllowed = b[0] === CT_ALERT && !this.connected;
    if (b[0] !== CT_APPDATA && !ccsAllowed && !plainAlertAllowed) throw sslErr(10, 'bad record type');
    if (b[1] !== 3 || b[2] !== 3) throw sslErr(50, 'wrong version number');
    if (b[0] === CT_APPDATA && len > MAX_PLAIN + 256) throw sslErr(22, 'encrypted length too long');
  } else if (b[1] !== 3) {
    throw sslErr(70, 'wrong version number');
  }
  if (b.length < 5 + len) return false;
  var type = b[0];
  var header = b.slice(0, 5);
  var body = b.slice(5, 5 + len);
  this.recvBuf = b.slice(5 + len);
  this.firstRecord = false;
  this._record(type, header, body);
  return true;
};

Engine.prototype._record = function (type, header, body) {
  if (this.peerClosed) return;
  if (type === CT_CCS) {
    /* OpenSSL drops a TLS 1.3 CCS while the read keys date from the first handshake. A client installs its application
       read keys before its handshake ends and a server after, so once connected a server rejects a CCS (bad record
       type) while a client ignores it until a KeyUpdate replaces those keys. */
    if (this.connected && (this.role === 'server' || this.rdUpdated)) throw sslErr(10, 'bad record type');
    if (body.length !== 1 || body[0] !== 1) throw sslErr(10, 'unexpected message');
    return;
  }
  if (!this.rd || (type === CT_ALERT && body.length === 2)) {
    if (type !== CT_HANDSHAKE && type !== CT_ALERT) throw sslErr(10, 'unexpected record');
    if (type === CT_HANDSHAKE && this.rd) throw sslErr(10, 'unexpected message');
    if (body.length > MAX_PLAIN) throw sslErr(22, 'data length too long');
    if (type === CT_HANDSHAKE && body.length === 0) throw sslErr(10, 'unexpected message');
    this._content(type, body);
    return;
  }
  if (type !== CT_APPDATA) throw sslErr(10, 'unexpected record');
  if (body.length < 17) throw sslErr(20, 'decryption failed or bad record mac');
  var inner;
  try {
    inner = this.c.aeadOpen(this.rd.alg, this.rd.key, nonceOf(this.rd.iv, this.rd.hi, this.rd.lo), header, body);
  } catch (failure) {
    throw sslErr(20, 'decryption failed or bad record mac');
  }
  bumpSeq(this.rd);
  var j = inner.length - 1;
  while (j >= 0 && inner[j] === 0) j--;
  if (j < 0) throw sslErr(10, 'unexpected message');
  if (j > MAX_PLAIN) throw sslErr(22, 'data length too long');
  var innerType = inner[j];
  var content = inner.slice(0, j);
  if (innerType !== CT_HANDSHAKE && innerType !== CT_ALERT && innerType !== CT_APPDATA) throw sslErr(10, 'bad record type');
  if (innerType === CT_HANDSHAKE && content.length === 0) throw sslErr(10, 'unexpected message');
  this._content(innerType, content);
};

Engine.prototype._content = function (type, content) {
  if (type === CT_ALERT) {
    if (content.length !== 2) throw sslErr(50, 'bad alert');
    var desc = content[1];
    if (desc === 0) {
      this.peerClosed = true;
      this.events.push({ type: 'close_notify' });
      return;
    }
    if (desc === 90) return;
    var info = ALERTS[desc] || ['unknown_' + desc, 'tlsv1 alert unknown alert ' + desc];
    this.dead = true;
    var e = sslErr(null, info[1]);
    this.events.push({ type: 'error', code: e.code, message: info[1], reason: info[1], library: 'SSL routines', alert: desc, received: true });
    return;
  }
  if (type === CT_HANDSHAKE) {
    this.hsIn = this.hsIn.length ? cat(this.hsIn, content) : content;
    this._drainHandshake();
    return;
  }
  if (type === CT_APPDATA) {
    if (!this.connected) throw sslErr(10, 'unexpected message');
    if (content.length > 0) this.events.push({ type: 'data', bytes: content });
    return;
  }
  throw sslErr(10, 'unexpected record');
};

Engine.prototype._drainHandshake = function () {
  while (!this.dead && this.hsIn.length >= 4) {
    var len = (this.hsIn[1] << 16) | (this.hsIn[2] << 8) | this.hsIn[3];
    if (this.hsIn.length < 4 + len) break;
    var raw = this.hsIn.slice(0, 4 + len);
    this.hsIn = this.hsIn.slice(4 + len);
    var keysBefore = this.rd;
    this._onMessage(raw[0], raw.slice(4), raw, null);
    if (!this.dead && this.rd !== keysBefore && this.hsIn.length > 0) throw sslErr(10, 'not on record boundary');
  }
};

/* ---------- QUIC mode input: CRYPTO-frame bytes per encryption level ---------- */

Engine.prototype.feedCrypto = function (level, bytes) {
  if (!this.quic) throw errWithCode('ERR_TLS_TLS_MODE', 'feedCrypto is for QUIC mode');
  if (!QUIC_LEVELS[level]) throw errWithCode('ERR_INVALID_ARG_VALUE', 'unknown encryption level');
  if (this.dead) return this._drain();
  this.qin[level] = cat(this.qin[level], bytes);
  try {
    while (!this.dead && this.qin[level].length >= 4) {
      var q = this.qin[level];
      var len = (q[1] << 16) | (q[2] << 8) | q[3];
      if (q.length < 4 + len) break;
      var raw = q.slice(0, 4 + len);
      this.qin[level] = q.slice(4 + len);
      this._onMessage(raw[0], raw.slice(4), raw, level);
    }
  } catch (failure) {
    this._failWith(failure);
  }
  return this._drain();
};

/* ---------- handshake dispatch ---------- */

Engine.prototype._onMessage = function (type, body, raw, level) {
  if (this.dead) return;
  if (this.quic && quicLevelOf(type) !== level) throw sslErr(10, 'unexpected message');
  switch (this.state) {
    case 'S_START':
    case 'S_WAIT_CH2':
      if (type === HT.client_hello) return this._sClientHello(body, raw);
      break;
    case 'S_WAIT_CERT':
      if (type === HT.certificate) return this._sCertificate(body, raw);
      break;
    case 'S_WAIT_CV':
      if (type === HT.certificate_verify) return this._sCertVerify(body, raw);
      break;
    case 'S_WAIT_FIN':
      if (type === HT.finished) return this._sFinished(body, raw);
      break;
    case 'C_WAIT_SH':
      if (type === HT.server_hello) return this._cServerHello(body, raw);
      break;
    case 'C_WAIT_EE':
      if (type === HT.encrypted_extensions) return this._cEncryptedExt(body, raw);
      break;
    case 'C_WAIT_CERT_CR':
      if (type === HT.certificate_request) return this._cCertRequest(body, raw);
      if (type === HT.certificate) return this._cCertificate(body, raw);
      break;
    case 'C_WAIT_CERT':
      if (type === HT.certificate) return this._cCertificate(body, raw);
      break;
    case 'C_WAIT_CV':
      if (type === HT.certificate_verify) return this._cCertVerify(body, raw);
      break;
    case 'C_WAIT_FIN':
      if (type === HT.finished) return this._cFinished(body, raw);
      break;
    case 'CONNECTED':
      if (type === HT.new_session_ticket && this.role === 'client') return this._cTicket(body);
      if (type === HT.key_update && !this.quic) return this._onKeyUpdate(body);
      break;
    default:
      break;
  }
  throw sslErr(10, 'unexpected message');
};

/* ---------- client: ClientHello ---------- */

Engine.prototype.start = function () {
  if (this.role !== 'client' || this.state !== 'C_START') {
    throw errWithCode('ERR_TLS_INVALID_STATE', 'start() is for a client that has not started');
  }
  try {
    this._clientHello(false);
    this.state = 'C_WAIT_SH';
  } catch (failure) {
    this._failWith(failure);
  }
  return this.takeOutput();
};

Engine.prototype._clientHello = function (retry) {
  var h = this.hooks.clientHello || {};
  if (!retry) {
    this.clientRandom = h.random ? Uint8Array.from(h.random) : this._random(32);
    if (h.sessionId) this.clientSessionId = Uint8Array.from(h.sessionId);
    else this.clientSessionId = this.quic ? new Uint8Array(0) : this._random(32);
    if (h.groups) this.groups = h.groups.slice();
    if (h.keyShareGroups) this.keyShareGroups = h.keyShareGroups.slice();
    if (h.suites) this.suites = h.suites.slice();
    for (var g0 = 0; g0 < this.keyShareGroups.length; g0++) {
      var grp = this.keyShareGroups[g0];
      if (grp !== GROUP_X25519 && grp !== GROUP_P256) continue;
      this.kx[grp] = this._keyPair(grp);
    }
  }
  var shareEntries = [];
  var shareGroups = retry ? (this.hrrGroup !== null ? [this.hrrGroup] : this.keyShareGroups) : this.keyShareGroups;
  for (var s = 0; s < shareGroups.length; s++) {
    var kp = this.kx[shareGroups[s]];
    if (!kp) continue;
    shareEntries.push(cat(u16(shareGroups[s]), u16(kp.pub.length), kp.pub));
  }
  var suiteBytes = [];
  for (var i = 0; i < this.suites.length; i++) suiteBytes.push((this.suites[i] >> 8) & 255, this.suites[i] & 255);
  var groupBytes = [];
  for (var g = 0; g < this.groups.length; g++) groupBytes.push((this.groups[g] >> 8) & 255, this.groups[g] & 255);
  var sigs = h.sigAlgs || this.sigalgs || DEFAULT_SIGALGS;
  var sigBytes = [];
  for (var k = 0; k < sigs.length; k++) sigBytes.push((sigs[k] >> 8) & 255, sigs[k] & 255);
  this.offeredSigAlgs = sigs.slice();
  var exts = [];
  if (this.serverName && !isIP(this.serverName)) {
    var name = latin1Bytes(this.serverName);
    exts.push({ t: EXT.server_name, b: ext(EXT.server_name, cat(u16(name.length + 3), [0], u16(name.length), name)) });
  }
  exts.push({ t: EXT.supported_groups, b: ext(EXT.supported_groups, cat(u16(groupBytes.length), groupBytes)) });
  exts.push({ t: EXT.signature_algorithms, b: ext(EXT.signature_algorithms, cat(u16(sigBytes.length), sigBytes)) });
  if (this.alpnList.length > 0) {
    var protos = [];
    for (var a = 0; a < this.alpnList.length; a++) {
      var pb = latin1Bytes(this.alpnList[a]);
      protos.push(cat([pb.length], pb));
    }
    var pl = catList(protos);
    exts.push({ t: EXT.alpn, b: ext(EXT.alpn, cat(u16(pl.length), pl)) });
  }
  exts.push({ t: EXT.supported_versions, b: ext(EXT.supported_versions, [2, 3, 4]) });
  exts.push({ t: EXT.psk_key_exchange_modes, b: ext(EXT.psk_key_exchange_modes, [1, 1]) });
  var shares = catList(shareEntries);
  exts.push({ t: EXT.key_share, b: ext(EXT.key_share, cat(u16(shares.length), shares)) });
  if (this.quicParams) exts.push({ t: EXT.quic_transport_parameters, b: ext(EXT.quic_transport_parameters, this.quicParams) });
  if (retry && this.cookie) exts.push({ t: EXT.cookie, b: ext(EXT.cookie, this.cookie) });
  var extra = (h.extra || []).concat(retry && h.retryExtra ? h.retryExtra : []);
  for (var x = 0; x < extra.length; x++) {
    var replaced = false;
    for (var r = 0; r < exts.length; r++) {
      if (exts[r].t === extra[x].type) {
        exts[r] = { t: extra[x].type, b: ext(extra[x].type, extra[x].body) };
        replaced = true;
      }
    }
    if (!replaced) exts.push({ t: extra[x].type, b: ext(extra[x].type, extra[x].body) });
  }
  this.offeredExts = {};
  for (var oe = 0; oe < exts.length; oe++) this.offeredExts[exts[oe].t] = true;
  var ordered = orderExts(exts, h.order || [EXT.server_name, EXT.supported_groups, EXT.signature_algorithms,
    EXT.alpn, EXT.supported_versions, EXT.psk_key_exchange_modes, EXT.key_share, EXT.quic_transport_parameters, EXT.cookie]);
  var extBytes = catList(ordered);
  var body = cat([3, 3], this.clientRandom, [this.clientSessionId.length], this.clientSessionId,
    u16(suiteBytes.length), suiteBytes, [1, 0], u16(extBytes.length), extBytes);
  this._send(HT.client_hello, body, 'initial', retry ? 0x0303 : 0x0301);
};

/* ---------- client: ServerHello, HelloRetryRequest ---------- */

Engine.prototype._cServerHello = function (body, raw) {
  var r = new Reader(body);
  var legacy = r.u16();
  var random = r.bytes(32);
  var sid = r.vec8();
  var suiteId = r.u16();
  var compression = r.u8();
  var exts = r.atEnd() ? { map: {}, order: [] } : readExtensions(r);
  r.finish();
  var sv = exts.map[EXT.supported_versions];
  if (!sv) throw sslErr(70, 'unsupported protocol');
  if (sv.length !== 2 || ((sv[0] << 8) | sv[1]) !== 0x0304) throw sslErr(47, 'bad protocol version number');
  if (legacy !== 0x0303) throw sslErr(70, 'unsupported protocol');
  if (!eqBytes(sid, this.clientSessionId)) throw sslErr(47, 'invalid session id');
  if (compression !== 0) throw sslErr(47, 'invalid compression algorithm');
  var suite = SUITES[suiteId];
  if (!suite || this.suites.indexOf(suiteId) < 0) throw sslErr(47, 'wrong cipher returned');
  if (eqBytes(random, this.hrrRandom)) return this._cHelloRetry(suite, raw, exts);
  for (var i = 0; i < exts.order.length; i++) {
    var t = exts.order[i];
    if (t !== EXT.supported_versions && t !== EXT.key_share) throw sslErr(110, 'unsolicited extension');
  }
  if (this.hrrSeen && suite.id !== this.hrrSuite) throw sslErr(47, 'wrong cipher returned');
  var ks = exts.map[EXT.key_share];
  if (!ks) throw sslErr(109, 'missing key share');
  var kr = new Reader(ks);
  var group = kr.u16();
  var peerKey = kr.vec16();
  kr.finish();
  var kp = this.kx[group];
  if (!kp || this.groups.indexOf(group) < 0 || (this.hrrSeen && group !== this.hrrGroup)) throw sslErr(47, 'bad key share');
  this.suite = suite;
  this.group = group;
  this.serverRandom = random;
  this.tx.push(raw);
  this._deriveHandshake(this._sharedSecret(group, kp.priv, peerKey));
  this.rd = this._keyState(this.shsSecret);
  this.state = 'C_WAIT_EE';
};

Engine.prototype._cHelloRetry = function (suite, raw, exts) {
  if (this.hrrSeen) throw sslErr(10, 'unexpected message');
  var cookie = exts.map[EXT.cookie];
  var ks = exts.map[EXT.key_share];
  for (var i = 0; i < exts.order.length; i++) {
    var t = exts.order[i];
    if (t !== EXT.supported_versions && t !== EXT.key_share && t !== EXT.cookie) throw sslErr(110, 'unsolicited extension');
  }
  var group = null;
  if (ks) {
    if (ks.length !== 2) throw decodeErr();
    group = (ks[0] << 8) | ks[1];
    if (this.groups.indexOf(group) < 0 || this.kx[group] || (group !== GROUP_X25519 && group !== GROUP_P256)) throw sslErr(47, 'bad key share');
  }
  if (group === null && !cookie) throw sslErr(47, 'bad hello retry request');
  if (cookie) {
    var cr = new Reader(cookie);
    var cv = cr.vec16();
    cr.finish();
    if (cv.length === 0) throw decodeErr();
  }
  this.hrrSeen = true;
  this.hrrSuite = suite.id;
  this.hrrGroup = group;
  this.suite = suite;
  this.cookie = cookie ? cookie.slice() : null;
  var ch1 = this.tx[0];
  this.tx = [cat([HT.message_hash, 0, 0, HASH_LEN[suite.alg]], this.c.digest(suite.alg, ch1)), raw];
  if (group !== null) this.kx[group] = this._keyPair(group);
  this._clientHello(true);
};

/* ---------- client: EncryptedExtensions, CertificateRequest, Certificate, CertificateVerify, Finished ---------- */

Engine.prototype._cEncryptedExt = function (body, raw) {
  var r = new Reader(body);
  var exts = readExtensions(r);
  r.finish();
  for (var i = 0; i < exts.order.length; i++) {
    var t = exts.order[i];
    var allowed = t === EXT.supported_groups || ((t === EXT.server_name || t === EXT.alpn || t === EXT.record_size_limit ||
      t === EXT.quic_transport_parameters || t === EXT.early_data) && this.offeredExts[t]);
    if (!allowed && (t === EXT.key_share || t === EXT.supported_versions || t === EXT.pre_shared_key || t === EXT.cookie ||
      t === EXT.signature_algorithms || t === EXT.psk_key_exchange_modes)) {
      throw sslErr(47, 'bad extension');
    }
    if (!allowed && !this.offeredExts[t]) throw sslErr(110, 'unsolicited extension');
  }
  var alpnExt = exts.map[EXT.alpn];
  if (alpnExt) {
    var names = parseAlpnList(alpnExt);
    if (names.length !== 1 || this.alpnList.indexOf(names[0]) < 0) throw sslErr(47, 'bad extension');
    this.alpn = names[0];
  }
  var qp = exts.map[EXT.quic_transport_parameters];
  this.peerQuicTransportParameters = qp ? qp.slice() : null;
  if (this.quic && !qp && !this.hooks.quicRelaxed) throw sslErr(109, 'missing quic transport parameters extension');
  if (this.quic && this.alpnList.length > 0 && this.alpn === null && !this.hooks.quicRelaxed) throw sslErr(120, 'no application protocol');
  this.tx.push(raw);
  this.state = 'C_WAIT_CERT_CR';
};

Engine.prototype._cCertRequest = function (body, raw) {
  var r = new Reader(body);
  var context = r.vec8();
  var exts = readExtensions(r);
  r.finish();
  if (context.length !== 0) throw sslErr(47, 'bad extension');
  var sig = exts.map[EXT.signature_algorithms];
  if (!sig) throw sslErr(109, 'missing signature algorithms extension');
  this.certRequested = true;
  this.certRequestContext = context;
  this.peerSigAlgs = u16List(sig, 2);
  this.tx.push(raw);
  this.state = 'C_WAIT_CERT';
};

/* A Certificate message: {context, ders} */
function parseCertificateMsg(body) {
  var r = new Reader(body);
  var context = r.vec8();
  var list = new Reader(r.vec24());
  r.finish();
  var ders = [];
  while (!list.atEnd()) {
    var der = list.vec24();
    if (der.length === 0) throw decodeErr();
    list.vec16();
    ders.push(der);
  }
  return { context: context, ders: ders };
}

function parseCertList(ders) {
  try {
    return ders.map(parseCertificate);
  } catch (failure) {
    throw sslErr(50, 'certificate parse failure');
  }
}

Engine.prototype._cCertificate = function (body, raw) {
  var msg = parseCertificateMsg(body);
  if (msg.context.length !== 0) throw sslErr(47, 'invalid context');
  if (msg.ders.length === 0) throw sslErr(50, 'length mismatch');
  this.peerCertDers = msg.ders;
  this.peerCerts = parseCertList(msg.ders);
  this.tx.push(raw);
  this.state = 'C_WAIT_CV';
};

/* Checks a peer CertificateVerify: the scheme was offered and fits the key, and the signature holds */
Engine.prototype._checkCv = function (body, offered, leaf, context) {
  var r = new Reader(body);
  var scheme = r.u16();
  var sig = r.vec16();
  r.finish();
  var s = SIG_SCHEMES[scheme];
  var k = leaf.spki;
  if (!s || !s.cv || offered.indexOf(scheme) < 0) throw sslErr(47, 'wrong signature type');
  if (s.kind === 'ecdsa' ? (k.type !== 'ec' || k.curve !== s.curve) : k.type !== s.key) throw sslErr(47, 'wrong signature type');
  var content = cvContent(context, this._transcriptHash());
  var ok = s.kind === 'ecdsa'
    ? this.c.ecdsaVerify(s.curve, k.point, this.c.digest(s.hash, content), sig)
    : this.c.rsaVerify(s.scheme, k.key, content, sig);
  if (!ok) throw sslErr(51, 'provider signature failure', 'digital envelope routines');
};

Engine.prototype._cCertVerify = function (body, raw) {
  this._checkCv(body, this.offeredSigAlgs, this.peerCerts[0], 'TLS 1.3, server CertificateVerify');
  this.tx.push(raw);
  this.state = 'C_WAIT_FIN';
};

Engine.prototype._finishedMac = function (secret) {
  var alg = this.suite.alg;
  return this.c.hmac(alg, expandLabel(this.c, alg, secret, 'finished', new Uint8Array(0), HASH_LEN[alg]), this._transcriptHash());
};

/* Signs a CertificateVerify for our own key with the first of the peer's schemes the key can make */
Engine.prototype._certVerifyBody = function (key, peerSchemes, context) {
  var mine = schemesForKey(key);
  var scheme = null;
  var order = peerSchemes || mine;
  for (var i = 0; i < order.length && scheme === null; i++) {
    if (mine.indexOf(order[i]) >= 0) scheme = order[i];
  }
  if (scheme === null) throw sslErr(40, 'no suitable signature algorithm');
  var s = SIG_SCHEMES[scheme];
  var content = cvContent(context, this._transcriptHash());
  var sig;
  var override = this.hooks.signature;
  if (override) sig = Uint8Array.from(override(scheme, content));
  else if (s.kind === 'ecdsa') sig = this.c.ecdsaSign(key.curve, key.priv, this.c.digest(s.hash, content));
  else sig = this.c.rsaSign(s.scheme, key, content);
  return cat(u16(scheme), u16(sig.length), sig);
};

function certificateBody(context, certs) {
  var entries = [];
  for (var d = 0; d < certs.length; d++) entries.push(cat(u24(certs[d].length), certs[d], [0, 0]));
  var list = catList(entries);
  return cat([context.length], context, u24(list.length), list);
}

Engine.prototype._cFinished = function (body, raw) {
  var expected = this._finishedMac(this.shsSecret);
  if (!eqBytes(expected, body)) throw sslErr(51, 'digest check failed');
  this.peerVerifyData = body.slice();
  this.tx.push(raw);
  this._deriveApp();
  if (!this.quic) this.wr = this._keyState(this.chsSecret);
  var flight = [];
  if (this.certRequested) {
    var mine = this.contexts.length ? this.contexts[0] : null;
    var peerSchemes = sharedSigAlgs(this.peerSigAlgs, this.sigalgs, false);
    var usable = !!mine && schemesForKey(mine.privateKey).some(function (sch) { return peerSchemes.indexOf(sch) >= 0; });
    var certMsg = this._buildMsg(HT.certificate, certificateBody(this.certRequestContext, usable ? mine.certificates : []));
    this.tx.push(certMsg);
    flight.push(certMsg);
    if (usable) {
      var cvMsg = this._buildMsg(HT.certificate_verify, this._certVerifyBody(mine.privateKey, peerSchemes, 'TLS 1.3, client CertificateVerify'));
      this.tx.push(cvMsg);
      flight.push(cvMsg);
    }
  }
  this.verifyData = this._finishedMac(this.chsSecret);
  var finMsg = this._buildMsg(HT.finished, this.verifyData);
  this.tx.push(finMsg);
  flight.push(finMsg);
  this._writeFlight(flight, 'handshake');
  if (!this.quic) {
    this.wr = this._keyState(this.capSecret);
    this.rd = this._keyState(this.sapSecret);
  }
  this.wrSecret = this.capSecret;
  this.rdSecret = this.sapSecret;
  this._finishHandshake(this._peerVerdict('server'));
};

/* The certificate verdict after a handshake: chain against the anchors, then the identity check */
Engine.prototype._peerVerdict = function (purpose) {
  if (!this.peerCerts || this.peerCerts.length === 0) {
    return { authorized: false, authorizationError: 'UNABLE_TO_GET_ISSUER_CERT', error: verifyError('UNABLE_TO_GET_ISSUER_CERT') };
  }
  var chainError = verifyChain(this.c, this.peerCerts, this.anchors, { now: this.nowFn(), purpose: purpose, partial: this.partialChain });
  if (chainError) return { authorized: false, authorizationError: chainError.code, error: chainError };
  if (purpose === 'server' && (this.hostname !== null || this.identityCheck)) {
    var certObj = certificateObject(this.c, this.peerCerts, this.anchors, true, function (b) { return b; });
    var identityError = this.identityCheck ? this.identityCheck(this.hostname, certObj, this.peerCerts) : checkServerIdentity(this.hostname, certObj);
    if (identityError) {
      return { authorized: false, authorizationError: identityError.code || identityError.message, error: identityError };
    }
  }
  return { authorized: true, authorizationError: null, error: null };
};

Engine.prototype._finishHandshake = function (verdict) {
  this.resMaster = deriveSecret(this.c, this.suite.alg, this.masterSecret, 'res master', this._transcriptHash());
  this.connected = true;
  this.cipherName = this.suite.name;
  this.state = 'CONNECTED';
  this.events.push({
    type: 'connected',
    alpnProtocol: this.alpn,
    cipherName: this.suite.name,
    group: this.group,
    peerVerify: verdict,
    peerCertificates: this.peerCertDers || [],
    peerServerName: this.peerServerName,
    peerQuicTransportParameters: this.peerQuicTransportParameters
  });
};

Engine.prototype._cTicket = function (body) {
  var r = new Reader(body);
  r.bytes(8);
  r.vec8();
  var ticket = r.vec16();
  readExtensions(r);
  r.finish();
  if (ticket.length === 0) throw decodeErr();
};

/* ---------- server: ClientHello, HelloRetryRequest, flight ---------- */

Engine.prototype._sClientHello = function (body, raw) {
  var r = new Reader(body);
  var legacy = r.u16();
  var random = r.bytes(32);
  var sid = r.vec8();
  if (sid.length > 32) throw sslErr(47, 'invalid session id');
  var suites = [];
  var suiteBytes = r.vec16();
  if (suiteBytes.length === 0 || suiteBytes.length % 2) throw decodeErr();
  for (var sb = 0; sb < suiteBytes.length; sb += 2) suites.push((suiteBytes[sb] << 8) | suiteBytes[sb + 1]);
  var comp = r.vec8();
  var exts = r.atEnd() ? { map: {}, order: [] } : readExtensions(r);
  r.finish();
  var sv = exts.map[EXT.supported_versions];
  var versions = sv ? u16List(sv, 1) : [];
  if (versions.indexOf(0x0304) < 0 || legacy < 0x0301) throw sslErr(70, 'unsupported protocol');
  if (comp.length !== 1 || comp[0] !== 0) throw sslErr(47, 'required compression algorithm missing');
  var pskIndex = exts.order.indexOf(EXT.pre_shared_key);
  if (pskIndex >= 0 && pskIndex !== exts.order.length - 1) throw sslErr(47, 'bad extension');
  if (this.hrrSent) {
    if (!eqBytes(random, this.clientRandom) || !eqBytes(sid, this.clientSessionId)) throw sslErr(47, 'bad hello retry');
  }
  var suiteId = null;
  var pref = this.honorCipherOrder ? this.suites : suites;
  var other = this.honorCipherOrder ? suites : this.suites;
  for (var s = 0; s < pref.length && suiteId === null; s++) {
    if (other.indexOf(pref[s]) >= 0 && SUITES[pref[s]]) suiteId = pref[s];
  }
  if (suiteId === null) throw sslErr(40, 'no shared cipher');
  if (this.hrrSent && suiteId !== this.suite.id) throw sslErr(47, 'wrong cipher returned');
  var sigExt = exts.map[EXT.signature_algorithms];
  if (!sigExt) throw sslErr(109, 'missing signature algorithms extension');
  var sniExt = exts.map[EXT.server_name];
  var serverName = null;
  if (sniExt) {
    var sr = new Reader(sniExt);
    var listR = new Reader(sr.vec16());
    sr.finish();
    while (!listR.atEnd()) {
      var nameType = listR.u8();
      var hostBytes = listR.vec16();
      if (nameType === 0 && serverName === null) {
        if (hostBytes.length === 0) throw decodeErr();
        serverName = latin1Of(hostBytes, 0, hostBytes.length);
      }
    }
  }
  var shareExt = exts.map[EXT.key_share];
  var groupsExt = exts.map[EXT.supported_groups];
  if (!shareExt || !groupsExt) throw sslErr(109, 'missing extension');
  var offeredGroups = u16List(groupsExt, 2);
  var kr = new Reader(shareExt);
  var shareList = new Reader(kr.vec16());
  kr.finish();
  var shares = [];
  var seen = {};
  while (!shareList.atEnd()) {
    var grp = shareList.u16();
    var key = shareList.vec16();
    if (seen[grp]) throw sslErr(47, 'bad key share');
    seen[grp] = true;
    shares.push({ group: grp, key: key });
  }
  this.tx.push(raw);
  this.clientRandom = random.slice();
  this.clientSessionId = sid.slice();
  this.peerSigAlgs = u16List(sigExt, 2);
  this.peerServerName = serverName;
  var qp = exts.map[EXT.quic_transport_parameters];
  this.peerQuicTransportParameters = qp ? qp.slice() : null;
  if (this.quic && !qp && !this.hooks.quicRelaxed) throw sslErr(109, 'missing quic transport parameters extension');
  this.clientAlpn = exts.map[EXT.alpn] ? parseAlpnList(exts.map[EXT.alpn]) : null;
  this.suite = SUITES[suiteId];
  var chosen = null;
  var serverGroups = this.hooks.serverGroups || this.groups;
  for (var q = 0; q < shares.length && chosen === null; q++) {
    if (serverGroups.indexOf(shares[q].group) >= 0 && offeredGroups.indexOf(shares[q].group) >= 0) chosen = shares[q];
  }
  if (this.hrrSent && (!chosen || chosen.group !== this.hrrGroup)) throw sslErr(47, 'bad key share');
  if (chosen === null) {
    var want = null;
    for (var g3 = 0; g3 < serverGroups.length && want === null; g3++) {
      if (offeredGroups.indexOf(serverGroups[g3]) >= 0) want = serverGroups[g3];
    }
    if (want === null || this.hrrSent) throw sslErr(40, 'no suitable key share');
    this._sendHelloRetry(want);
    return;
  }
  this.pendingHello = { share: chosen };
  if (this.deferContext && !this.contextResolved) {
    this.state = 'S_WAIT_CTX';
    this.events.push({ type: 'clienthello', serverName: serverName, alpn: this.clientAlpn });
    return;
  }
  this._sContinue();
};

/* Supplies the certificate contexts after a 'clienthello' event (SNI selection) and continues */
Engine.prototype.resume = function (contexts) {
  if (this.state !== 'S_WAIT_CTX') throw errWithCode('ERR_TLS_INVALID_STATE', 'resume() follows a clienthello event');
  try {
    if (contexts) {
      this.contexts = [];
      for (var i = 0; i < contexts.length; i++) this.contexts.push(normalizeContext(contexts[i]));
    }
    if (this.contexts.length === 0) throw sslErr(40, 'no suitable signature algorithm');
    this.contextResolved = true;
    this._sContinue();
  } catch (failure) {
    this._failWith(failure);
  }
  return this._drain();
};

Engine.prototype._sContinue = function () {
  var chosen = this.pendingHello.share;
  this.pendingHello = null;
  /* OpenSSL's tls_choose_sigalg: the first of the client's signature schemes that some certificate can make */
  var selected = null;
  this.sharedSigAlgs = sharedSigAlgs(this.peerSigAlgs, this.sigalgs, this.honorCipherOrder);
  for (var p0 = 0; p0 < this.sharedSigAlgs.length && !selected; p0++) {
    for (var c0 = 0; c0 < this.contexts.length; c0++) {
      if (schemesForKey(this.contexts[c0].privateKey).indexOf(this.sharedSigAlgs[p0]) >= 0) {
        selected = this.contexts[c0];
        break;
      }
    }
  }
  if (!selected) throw sslErr(40, 'no suitable signature algorithm');
  this.selected = selected;
  this.alpn = null;
  if (this.alpnCallback && this.clientAlpn) {
    /* Node's ALPNCallback: undefined rejects with no_application_protocol; a name the client did not offer is an error */
    var picked;
    try {
      picked = this.alpnCallback(this.peerServerName, this.clientAlpn.slice());
    } catch (cbFailure) {
      throw foreignErr(cbFailure);
    }
    if (picked === undefined) throw sslErr(120, 'no application protocol');
    if (this.clientAlpn.indexOf(picked) < 0) {
      var invalid = new TypeError('ALPN callback returned a value (' + picked + ") that did not match any of the client's offered protocols (" + this.clientAlpn.join(', ') + ')');
      invalid.code = 'ERR_TLS_ALPN_CALLBACK_INVALID_RESULT';
      throw foreignErr(invalid);
    }
    this.alpn = picked;
  } else if (this.alpnList.length > 0 && this.clientAlpn) {
    for (var a = 0; a < this.alpnList.length && this.alpn === null; a++) {
      if (this.clientAlpn.indexOf(this.alpnList[a]) >= 0) this.alpn = this.alpnList[a];
    }
    if (this.alpn === null) throw sslErr(120, 'no application protocol');
  }
  if (this.quic && this.alpn === null && !this.hooks.quicRelaxed) throw sslErr(120, 'no application protocol');
  var kp = this._keyPair(chosen.group);
  this.kx[chosen.group] = kp;
  this.group = chosen.group;
  var shared = this._sharedSecret(chosen.group, kp.priv, chosen.key);
  var shBody = cat([3, 3], this._serverRandomValue(), [this.clientSessionId.length], this.clientSessionId, u16(this.suite.id), [0],
    extBlock([ext(EXT.key_share, cat(u16(chosen.group), u16(kp.pub.length), kp.pub)), ext(EXT.supported_versions, [3, 4])]));
  this._send(HT.server_hello, shBody, 'initial');
  this._deriveHandshake(shared);
  if (!this.quic) {
    this.rd = this._keyState(this.chsSecret);
    this.wr = this._keyState(this.shsSecret);
  }
  this._serverFlight();
  this.state = this.requestCert ? 'S_WAIT_CERT' : 'S_WAIT_FIN';
};

Engine.prototype._serverRandomValue = function () {
  var h = this.hooks.serverHello;
  this.serverRandom = h && h.random ? Uint8Array.from(h.random) : this._random(32);
  return this.serverRandom;
};

Engine.prototype._sendHelloRetry = function (group) {
  var ch1 = this.tx[0];
  this.tx = [cat([HT.message_hash, 0, 0, HASH_LEN[this.suite.alg]], this.c.digest(this.suite.alg, ch1))];
  var h = this.hooks.helloRetry || {};
  var list = [ext(EXT.key_share, u16(group))];
  if (h.cookie) list.push(ext(EXT.cookie, cat(u16(h.cookie.length), Uint8Array.from(h.cookie))));
  list.push(ext(EXT.supported_versions, [3, 4]));
  var hrrBody = cat([3, 3], this.hrrRandom, [this.clientSessionId.length], this.clientSessionId, u16(this.suite.id), [0], extBlock(list));
  this.hrrSent = true;
  this.hrrGroup = group;
  this._send(HT.server_hello, hrrBody, 'initial');
  this.state = 'S_WAIT_CH2';
};

/* EncryptedExtensions, CertificateRequest, Certificate, CertificateVerify, Finished: one flight */
Engine.prototype._serverFlight = function () {
  var eeList = [];
  var h = this.hooks.encryptedExtensions || {};
  if (h.groups) {
    var gb = [];
    for (var i = 0; i < h.groups.length; i++) gb.push((h.groups[i] >> 8) & 255, h.groups[i] & 255);
    eeList.push({ t: EXT.supported_groups, b: ext(EXT.supported_groups, cat(u16(gb.length), gb)) });
  }
  for (var x = 0; h.extra && x < h.extra.length; x++) eeList.push({ t: h.extra[x].type, b: ext(h.extra[x].type, h.extra[x].body) });
  if (this.peerServerName !== null) eeList.push({ t: EXT.server_name, b: ext(EXT.server_name, []) });
  if (this.alpn !== null) {
    var nb = latin1Bytes(this.alpn);
    eeList.push({ t: EXT.alpn, b: ext(EXT.alpn, cat(u16(nb.length + 1), [nb.length], nb)) });
  }
  if (this.quicParams) eeList.push({ t: EXT.quic_transport_parameters, b: ext(EXT.quic_transport_parameters, this.quicParams) });
  var eeOrder = h.order || [EXT.supported_groups, EXT.record_size_limit, EXT.server_name, EXT.alpn, EXT.quic_transport_parameters];
  var msgs = [this._buildMsg(HT.encrypted_extensions, extBlock(orderExts(eeList, eeOrder)))];
  if (this.requestCert) {
    var crh = this.hooks.certificateRequest || {};
    var sigs = crh.sigAlgs || this.sigalgs || DEFAULT_SIGALGS;
    var sb = [];
    for (var k = 0; k < sigs.length; k++) sb.push((sigs[k] >> 8) & 255, sigs[k] & 255);
    this.crSigAlgs = sigs.filter(function (v) { return SIG_SCHEMES[v] && SIG_SCHEMES[v].cv; });
    var crList = [{ t: EXT.signature_algorithms, b: ext(EXT.signature_algorithms, cat(u16(sb.length), sb)) }];
    for (var y = 0; crh.extra && y < crh.extra.length; y++) crList.push({ t: crh.extra[y].type, b: ext(crh.extra[y].type, crh.extra[y].body) });
    var crOrder = crh.order || [EXT.signature_algorithms];
    msgs.push(this._buildMsg(HT.certificate_request, cat([0], extBlock(orderExts(crList, crOrder)))));
  }
  msgs.push(this._buildMsg(HT.certificate, certificateBody(new Uint8Array(0), this.selected.certificates)));
  for (var m = 0; m < msgs.length; m++) this.tx.push(msgs[m]);
  var cv = this._buildMsg(HT.certificate_verify, this._certVerifyBody(this.selected.privateKey, this.sharedSigAlgs || this.peerSigAlgs, 'TLS 1.3, server CertificateVerify'));
  this.tx.push(cv);
  this.verifyData = this._finishedMac(this.shsSecret);
  var fin = this._buildMsg(HT.finished, this.verifyData);
  this.tx.push(fin);
  msgs.push(cv, fin);
  this._writeFlight(msgs, 'handshake');
  this._deriveApp();
  if (!this.quic) this.wr = this._keyState(this.sapSecret);
  this.wrSecret = this.sapSecret;
};

Engine.prototype._sCertificate = function (body, raw) {
  var msg = parseCertificateMsg(body);
  if (msg.context.length !== 0) throw sslErr(47, 'invalid context');
  this.tx.push(raw);
  if (msg.ders.length === 0) {
    if (this.requireCert) throw sslErr(116, 'peer did not return a certificate');
    this.peerCertDers = null;
    this.peerCerts = null;
    this.state = 'S_WAIT_FIN';
    return;
  }
  this.peerCertDers = msg.ders;
  this.peerCerts = parseCertList(msg.ders);
  this.state = 'S_WAIT_CV';
};

Engine.prototype._sCertVerify = function (body, raw) {
  this._checkCv(body, this.crSigAlgs, this.peerCerts[0], 'TLS 1.3, client CertificateVerify');
  this.tx.push(raw);
  this.state = 'S_WAIT_FIN';
};

Engine.prototype._sFinished = function (body, raw) {
  var expected = this._finishedMac(this.chsSecret);
  if (!eqBytes(expected, body)) throw sslErr(51, 'digest check failed');
  this.peerVerifyData = body.slice();
  this.tx.push(raw);
  if (!this.quic) this.rd = this._keyState(this.capSecret);
  this.rdSecret = this.capSecret;
  var verdict = this.requestCert ? this._peerVerdict('client') : { authorized: false, authorizationError: null, error: null };
  this._finishHandshake(verdict);
  this._sendTicket();
};

/* NewSessionTicket only when a caller injects one (RFC 8448 traces); this engine never resumes */
Engine.prototype._sendTicket = function () {
  var t = this.hooks.newSessionTicket;
  if (!t) return;
  var ticket = Uint8Array.from(t.ticket);
  var body = cat(u32(t.lifetime), u32(t.ageAdd), [t.nonce.length], Uint8Array.from(t.nonce), u16(ticket.length), ticket,
    extBlock([ext(EXT.early_data, u32(t.maxEarlyData))]));
  var msg = this._buildMsg(HT.new_session_ticket, body);
  if (this.quic) this.qout['1-rtt'].push(msg);
  else this._writeRecord(CT_HANDSHAKE, msg, 0x0303);
};

/* ---------- post-handshake ---------- */

Engine.prototype._onKeyUpdate = function (body) {
  if (body.length !== 1 || body[0] > 1) throw sslErr(47, 'bad key update');
  this.rdSecret = expandLabel(this.c, this.suite.alg, this.rdSecret, 'traffic upd', new Uint8Array(0), HASH_LEN[this.suite.alg]);
  this.rd = this._keyState(this.rdSecret);
  this.rdUpdated = true;
  if (body[0] === 1 && !this.closeSent) this._sendKeyUpdate(false);
};

Engine.prototype._sendKeyUpdate = function (requestPeer) {
  this._writeRecord(CT_HANDSHAKE, this._buildMsg(HT.key_update, [requestPeer ? 1 : 0]), 0x0303);
  this.wrSecret = expandLabel(this.c, this.suite.alg, this.wrSecret, 'traffic upd', new Uint8Array(0), HASH_LEN[this.suite.alg]);
  this.wr = this._keyState(this.wrSecret);
};

/* Sends a KeyUpdate (TLS mode); the returned records carry it */
Engine.prototype.keyUpdate = function (requestPeer) {
  if (this.quic) throw errWithCode('ERR_TLS_QUIC_MODE', 'KeyUpdate is not used in QUIC');
  if (!this.connected || this.dead) throw errWithCode('ERR_TLS_NOT_CONNECTED', 'handshake is not complete');
  this._sendKeyUpdate(requestPeer);
  return this.takeOutput();
};

/* Application data out (TLS mode, after the handshake) */
Engine.prototype.write = function (bytes) {
  if (this.quic) throw errWithCode('ERR_TLS_QUIC_MODE', 'write is for TLS mode');
  if (!this.connected || this.dead) throw errWithCode('ERR_TLS_NOT_CONNECTED', 'handshake is not complete');
  if (bytes.length > 0) this._writeChunked(CT_APPDATA, bytes, 0x0303);
  return this.takeOutput();
};

Engine.prototype.closeNotify = function () {
  if (this.quic || this.closeSent || this.dead) return new Uint8Array(0);
  this.closeSent = true;
  this._writeRecord(CT_ALERT, [1, 0], 0x0303);
  return this.takeOutput();
};

/* NSS key log lines for the secrets derived so far (Node's 'keylog' event) */
Engine.prototype.keylogLines = function (level) {
  var cr = hexLower(this.clientRandom || new Uint8Array(32));
  var s = this.secrets[level];
  if (!s) return [];
  if (level === 'handshake') {
    return ['CLIENT_HANDSHAKE_TRAFFIC_SECRET ' + cr + ' ' + hexLower(s.client) + '\n', 'SERVER_HANDSHAKE_TRAFFIC_SECRET ' + cr + ' ' + hexLower(s.server) + '\n'];
  }
  return ['CLIENT_TRAFFIC_SECRET_0 ' + cr + ' ' + hexLower(s.client) + '\n', 'SERVER_TRAFFIC_SECRET_0 ' + cr + ' ' + hexLower(s.server) + '\n',
    'EXPORTER_SECRET ' + cr + ' ' + hexLower(this.expMasterSecret) + '\n'];
};

/* Certificate verdict for arbitrary DER chains (QUIC users and tests) */
function verifyPeer(cap, ders, anchors, opts) {
  var c = makeCrypto(cap);
  var o = opts || {};
  if (!ders || ders.length === 0) return { authorized: false, authorizationError: 'UNABLE_TO_GET_ISSUER_CERT', error: verifyError('UNABLE_TO_GET_ISSUER_CERT') };
  var peer = parseCertList(ders);
  var anchorList = (anchors || []).map(function (a) { return a && a.der && a.subjectCanon !== undefined ? a : parseCertificate(a); });
  var chainError = verifyChain(c, peer, anchorList, { now: typeof o.now === 'number' ? o.now : Date.now(), purpose: o.purpose || 'server', partial: o.allowPartialTrustChain === true });
  if (chainError) return { authorized: false, authorizationError: chainError.code, error: chainError };
  if (o.hostname) {
    var certObj = certificateObject(c, peer, anchorList, true, function (b) { return b; });
    var idErr = checkServerIdentity(o.hostname, certObj);
    if (idErr) return { authorized: false, authorizationError: idErr.code, error: idErr };
  }
  return { authorized: true, authorizationError: null, error: null };
}

return {
  createEngine: createEngine,
  parsePem: parsePem,
  loadPem: loadPem,
  parseCertificate: parseCertificate,
  parsePrivateKey: parsePrivateKey,
  certificateObject: function (cap, ders, extraDers, detailed, toBuffer) {
    var parsed = ders.map(parseCertificate);
    var extra = (extraDers || []).map(function (a) { return a && a.der && a.subjectCanon !== undefined ? a : parseCertificate(a); });
    return certificateObject(makeCrypto(cap), parsed, extra, detailed, toBuffer || function (b) { return b; });
  },
  verifyPeer: verifyPeer,
  keySlot: keySlot,
  keyMatchesCertificate: keyMatchesCertificate,
  sigSchemeSupported: function (code) { return !!SIG_SCHEMES[code]; },
  /* OpenSSL's automatic chain: a lone certificate gains the issuers found among the trust anchors */
  autoChain: function (ders, anchors) {
    var out = ders.slice();
    if (out.length !== 1) return out;
    var cur = parseCertificate(out[0]);
    for (var i = 0; i < 10 && !cur.selfSigned; i++) {
      var next = null;
      for (var a = 0; a < anchors.length && !next; a++) {
        if (!eqBytes(anchors[a].der, cur.der) && likelyIssued(anchors[a], cur)) next = anchors[a];
      }
      if (!next) break;
      out.push(next.der);
      cur = next;
    }
    return out;
  },
  checkServerIdentity: checkServerIdentity,
  isIP: isIP,
  makeCrypto: makeCrypto,
  hkdfExtract: function (cap, hash, salt, ikm) {
    return hkdfExtract(makeCrypto(cap), hash, Uint8Array.from(salt), Uint8Array.from(ikm));
  },
  hkdfExpandLabel: function (cap, hash, secret, label, context, length) {
    return expandLabel(makeCrypto(cap), hash, Uint8Array.from(secret), label, Uint8Array.from(context || []), length);
  },
  SUITES: SUITES,
  GROUPS: { X25519: GROUP_X25519, P256: GROUP_P256 },
  GROUP_NAMES: GROUP_NAMES,
  GROUP_BITS: GROUP_BITS,
  DEFAULT_SUITES: DEFAULT_SUITES.slice(),
  hexColon: hexColon,
  hexUpper: hexUpper,
  b64enc: b64enc,
  b64dec: b64dec
};
})();
`;
