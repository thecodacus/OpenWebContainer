import { x25519 } from '@noble/curves/ed25519';
import { p256 } from '@noble/curves/p256';
import { p384 } from '@noble/curves/p384';
import { gcm } from '@noble/ciphers/aes';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { sha256 } from '@noble/hashes/sha256';
import { sha384, sha512 } from '@noble/hashes/sha512';
import { bytesToBase64 } from '../../../../../network/virtual/host-http';
import { CapabilityHandler } from './types';

/*
 * Host side of the guest TLS 1.3 engine's cryptography. Each capability is one synchronous call
 * over JSON whose byte values are canonical padded base64, the encoding crypto.ts uses. Verify
 * capabilities answer { ok } and never throw for a bad signature. Every other rejection throws an
 * Error whose string code (ERR_TLS_*) reaches the guest through errorEnvelope in dispatch.ts.
 * Signatures are peer data and answer false when malformed; keys and names are arguments and throw.
 */

type TlsErrorCode = 'ERR_TLS_INVALID_ARG' | 'ERR_TLS_INVALID_KEY' | 'ERR_TLS_KEY_EXCHANGE' | 'ERR_TLS_BAD_RECORD_MAC';

function tlsError(code: TlsErrorCode, message: string): Error {
    return Object.assign(new Error(message), { code });
}

/** The named argument of a capability call, or undefined when the call carries no object. */
function argOf(args: unknown, name: string): unknown {
    return typeof args === 'object' && args !== null ? (args as Record<string, unknown>)[name] : undefined;
}

/** Looks a named algorithm, curve or scheme up in its own table; an unknown name is an argument error. */
function lookup<T>(table: Readonly<Record<string, T>>, name: unknown, what: string): T {
    if (typeof name === 'string' && Object.prototype.hasOwnProperty.call(table, name)) return table[name];
    throw tlsError('ERR_TLS_INVALID_ARG', `unknown ${what} ${String(name)}`);
}

// Bytes and integers

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_SHAPE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64_VALUE = (() => {
    const table = new Int16Array(128).fill(-1);
    for (let i = 0; i < BASE64_ALPHABET.length; i++) table[BASE64_ALPHABET.charCodeAt(i)] = i;
    return table;
})();

/** Strict decode: canonical padded base64 only. Re-encoding the bytes must reproduce the input. */
function decodeBase64(value: unknown, field: string): Uint8Array {
    if (typeof value !== 'string' || value.length % 4 !== 0 || !BASE64_SHAPE.test(value)) {
        throw tlsError('ERR_TLS_INVALID_ARG', `${field} is not canonical padded base64`);
    }
    const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
    const bytes = new Uint8Array((value.length / 4) * 3 - padding);
    let next = 0;
    for (let i = 0; i < value.length; i += 4) {
        const a = BASE64_VALUE[value.charCodeAt(i)];
        const b = BASE64_VALUE[value.charCodeAt(i + 1)];
        const c = value.charAt(i + 2) === '=' ? 0 : BASE64_VALUE[value.charCodeAt(i + 2)];
        const d = value.charAt(i + 3) === '=' ? 0 : BASE64_VALUE[value.charCodeAt(i + 3)];
        const group = (a << 18) | (b << 12) | (c << 6) | d;
        for (let shift = 16; shift >= 0; shift -= 8) {
            if (next < bytes.length) bytes[next++] = (group >> shift) & 0xff;
        }
    }
    if (bytesToBase64(bytes) !== value) {
        throw tlsError('ERR_TLS_INVALID_ARG', `${field} has non-zero padding bits`);
    }
    return bytes;
}

function decodeOrUndefined(value: unknown): Uint8Array | undefined {
    try {
        return decodeBase64(value, 'sig');
    } catch {
        return undefined;
    }
}

function bytesOfLength(value: unknown, field: string, length: number): Uint8Array {
    const bytes = decodeBase64(value, field);
    if (bytes.length !== length) {
        throw tlsError('ERR_TLS_INVALID_ARG', `${field} must be ${length} bytes, got ${bytes.length}`);
    }
    return bytes;
}

function bigintOfBytes(bytes: Uint8Array): bigint {
    let x = 0n;
    for (const byte of bytes) x = (x << 8n) | BigInt(byte);
    return x;
}

function bytesOfBigint(x: bigint, length: number): Uint8Array {
    const bytes = new Uint8Array(length);
    let rest = x;
    for (let i = length - 1; i >= 0; i--) {
        bytes[i] = Number(rest & 0xffn);
        rest >>= 8n;
    }
    if (rest !== 0n) throw tlsError('ERR_TLS_INVALID_KEY', 'value does not fit its byte length');
    return bytes;
}

/** A positive big-endian integer, such as an RSA key component. */
function integerOf(value: unknown, field: string): bigint {
    const x = bigintOfBytes(decodeBase64(value, field));
    if (x === 0n) throw tlsError('ERR_TLS_INVALID_ARG', `${field} must be a positive integer`);
    return x;
}

function bitLength(x: bigint): number {
    return x.toString(2).length;
}

function byteLength(x: bigint): number {
    return Math.ceil(bitLength(x) / 8);
}

function randomBytes(length: number): Uint8Array {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return bytes;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
    return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
    let hex = '';
    for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
    return hex;
}

// Modular arithmetic for RSA

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
    let result = 1n;
    let square = base % modulus;
    let rest = exponent;
    while (rest > 0n) {
        if (rest & 1n) result = (result * square) % modulus;
        square = (square * square) % modulus;
        rest >>= 1n;
    }
    return result;
}

function modPositive(x: bigint, modulus: bigint): bigint {
    return ((x % modulus) + modulus) % modulus;
}

// Hashes, signature encodings and the AEAD table

type HashName = 'sha256' | 'sha384' | 'sha512';

const HASH_FUNCTIONS: Readonly<Record<HashName, (data: Uint8Array) => Uint8Array>> = { sha256, sha384, sha512 };

const HASH_LENGTHS: Readonly<Record<HashName, number>> = { sha256: 32, sha384: 48, sha512: 64 };

/** DER DigestInfo prefixes of RFC 8017 section 9.2, one per hash. */
const DIGEST_INFO_PREFIX: Readonly<Record<HashName, Uint8Array>> = {
    sha256: hexToBytes('3031300d060960864801650304020105000420'),
    sha384: hexToBytes('3041300d060960864801650304020205000430'),
    sha512: hexToBytes('3051300d060960864801650304020305000440'),
};

function mgf1(hash: HashName, seed: Uint8Array, length: number): Uint8Array {
    const out = new Uint8Array(length);
    let filled = 0;
    for (let counter = 0; filled < length; counter++) {
        const block = HASH_FUNCTIONS[hash](
            concatBytes(seed, Uint8Array.of((counter >>> 24) & 0xff, (counter >>> 16) & 0xff, (counter >>> 8) & 0xff, counter & 0xff))
        );
        const take = Math.min(block.length, length - filled);
        out.set(block.subarray(0, take), filled);
        filled += take;
    }
    return out;
}

/** EMSA-PKCS1-v1_5 encoding (RFC 8017 section 9.2) of a message, as k bytes. */
function emsaPkcs1Encode(hash: HashName, message: Uint8Array, k: number): Uint8Array {
    const info = concatBytes(DIGEST_INFO_PREFIX[hash], HASH_FUNCTIONS[hash](message));
    if (k < info.length + 11) throw tlsError('ERR_TLS_INVALID_KEY', 'RSA modulus is too small for this scheme');
    const em = new Uint8Array(k);
    em[1] = 0x01;
    em.fill(0xff, 2, k - info.length - 1);
    em.set(info, k - info.length);
    return em;
}

/** EMSA-PSS encoding (RFC 8017 section 9.1.1) with salt length equal to the hash length. */
function emsaPssEncode(hash: HashName, message: Uint8Array, modBits: number, salt: Uint8Array): Uint8Array {
    const hashLength = HASH_LENGTHS[hash];
    const emBits = modBits - 1;
    const emLength = Math.ceil(emBits / 8);
    if (emLength < hashLength + salt.length + 2) throw tlsError('ERR_TLS_INVALID_KEY', 'RSA modulus is too small for PSS');
    const digest = HASH_FUNCTIONS[hash](concatBytes(new Uint8Array(8), HASH_FUNCTIONS[hash](message), salt));
    const db = concatBytes(new Uint8Array(emLength - salt.length - hashLength - 2), Uint8Array.of(0x01), salt);
    const mask = mgf1(hash, digest, emLength - hashLength - 1);
    const maskedDb = db.map((byte, i) => byte ^ mask[i]);
    maskedDb[0] &= 0xff >>> (8 * emLength - emBits);
    return concatBytes(maskedDb, digest, Uint8Array.of(0xbc));
}

/** EMSA-PSS verification (RFC 8017 section 9.1.2) of the encoding recovered from a signature. */
function emsaPssVerify(hash: HashName, message: Uint8Array, em: Uint8Array, modBits: number): boolean {
    const hashLength = HASH_LENGTHS[hash];
    const emBits = modBits - 1;
    const emLength = Math.ceil(emBits / 8);
    if (emLength < 2 * hashLength + 2) throw tlsError('ERR_TLS_INVALID_KEY', 'RSA modulus is too small for PSS');
    if (em.length !== emLength || em[emLength - 1] !== 0xbc) return false;
    const dbLength = emLength - hashLength - 1;
    const maskedDb = em.subarray(0, dbLength);
    const digest = em.subarray(dbLength, emLength - 1);
    const topMask = 0xff >>> (8 * emLength - emBits);
    if ((maskedDb[0] & ~topMask) !== 0) return false;
    const mask = mgf1(hash, digest, dbLength);
    const db = maskedDb.map((byte, i) => byte ^ mask[i]);
    db[0] &= topMask;
    const padLength = dbLength - hashLength - 1;
    for (let i = 0; i < padLength; i++) {
        if (db[i] !== 0) return false;
    }
    if (db[padLength] !== 0x01) return false;
    const salt = db.subarray(dbLength - hashLength);
    const expected = HASH_FUNCTIONS[hash](concatBytes(new Uint8Array(8), HASH_FUNCTIONS[hash](message), salt));
    return equalBytes(expected, digest);
}

interface AeadAlgorithm {
    readonly keyBytes: number;
    readonly seal: (key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, data: Uint8Array) => Uint8Array;
    readonly open: (key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, data: Uint8Array) => Uint8Array;
}

const AEAD_ALGORITHMS: Readonly<Record<string, AeadAlgorithm>> = {
    'aes-128-gcm': {
        keyBytes: 16,
        seal: (key, nonce, aad, data) => gcm(key, nonce, aad).encrypt(data),
        open: (key, nonce, aad, data) => gcm(key, nonce, aad).decrypt(data),
    },
    'aes-256-gcm': {
        keyBytes: 32,
        seal: (key, nonce, aad, data) => gcm(key, nonce, aad).encrypt(data),
        open: (key, nonce, aad, data) => gcm(key, nonce, aad).decrypt(data),
    },
    'chacha20-poly1305': {
        keyBytes: 32,
        seal: (key, nonce, aad, data) => chacha20poly1305(key, nonce, aad).encrypt(data),
        open: (key, nonce, aad, data) => chacha20poly1305(key, nonce, aad).decrypt(data),
    },
};

const AEAD_NONCE_BYTES = 12;
const AEAD_TAG_BYTES = 16;

// Elliptic curves

interface EcdsaSignature {
    normalizeS(): EcdsaSignature;
    toDERHex(): string;
}

/** The subset of a noble NIST curve module this file uses. */
interface NistCurve {
    readonly utils: { randomPrivateKey(): Uint8Array; isValidPrivateKey(priv: Uint8Array): boolean };
    readonly ProjectivePoint: { fromHex(hex: Uint8Array): unknown };
    readonly Signature: { fromDER(der: Uint8Array): EcdsaSignature };
    getPublicKey(priv: Uint8Array, isCompressed?: boolean): Uint8Array;
    getSharedSecret(priv: Uint8Array, pub: Uint8Array, isCompressed?: boolean): Uint8Array;
    sign(digest: Uint8Array, priv: Uint8Array): EcdsaSignature;
    verify(signature: EcdsaSignature | Uint8Array, digest: Uint8Array, pub: Uint8Array, opts?: { lowS?: boolean }): boolean;
}

interface CurveEntry {
    readonly curve: NistCurve;
    readonly orderBytes: number;
}

const NIST_CURVES: Readonly<Record<string, CurveEntry>> = {
    p256: { curve: p256, orderBytes: 32 },
    p384: { curve: p384, orderBytes: 48 },
};

/** A peer's uncompressed point, checked to lie on the curve; a malformed key is an argument error. */
function uncompressedPointOf(entry: CurveEntry, value: unknown): Uint8Array {
    const bytes = bytesOfLength(value, 'pub', 2 * entry.orderBytes + 1);
    if (bytes[0] !== 0x04) throw tlsError('ERR_TLS_INVALID_ARG', 'pub is not an uncompressed point');
    try {
        entry.curve.ProjectivePoint.fromHex(bytes);
    } catch {
        throw tlsError('ERR_TLS_INVALID_ARG', 'pub is not a point on the curve');
    }
    return bytes;
}

// RSA

interface RsaPublicKey {
    readonly n: bigint;
    readonly e: bigint;
}

interface RsaPrivateKey extends RsaPublicKey {
    readonly d: bigint;
    readonly p: bigint;
    readonly q: bigint;
    readonly dp: bigint;
    readonly dq: bigint;
    readonly qi: bigint;
}

interface RsaScheme {
    readonly padding: 'pkcs1' | 'pss';
    readonly hash: HashName;
}

const RSA_SCHEMES: Readonly<Record<string, RsaScheme>> = {
    'pkcs1-sha256': { padding: 'pkcs1', hash: 'sha256' },
    'pkcs1-sha384': { padding: 'pkcs1', hash: 'sha384' },
    'pkcs1-sha512': { padding: 'pkcs1', hash: 'sha512' },
    'pss-sha256': { padding: 'pss', hash: 'sha256' },
    'pss-sha384': { padding: 'pss', hash: 'sha384' },
    'pss-sha512': { padding: 'pss', hash: 'sha512' },
};

function rsaPublicKeyOf(key: unknown): RsaPublicKey {
    const n = integerOf(argOf(key, 'n'), 'key.n');
    const e = integerOf(argOf(key, 'e'), 'key.e');
    if (e < 3n) throw tlsError('ERR_TLS_INVALID_ARG', 'key.e must be at least 3');
    return { n, e };
}

function rsaPrivateKeyOf(key: unknown): RsaPrivateKey {
    return {
        ...rsaPublicKeyOf(key),
        d: integerOf(argOf(key, 'd'), 'key.d'),
        p: integerOf(argOf(key, 'p'), 'key.p'),
        q: integerOf(argOf(key, 'q'), 'key.q'),
        dp: integerOf(argOf(key, 'dp'), 'key.dp'),
        dq: integerOf(argOf(key, 'dq'), 'key.dq'),
        qi: integerOf(argOf(key, 'qi'), 'key.qi'),
    };
}

/** The CRT private-key operation, checked by re-encryption so an inconsistent key never yields a signature. */
function rsaPrivateOperation(key: RsaPrivateKey, value: bigint): bigint {
    if (key.p * key.q !== key.n) throw tlsError('ERR_TLS_INVALID_KEY', 'RSA p times q does not equal n');
    const s1 = modPow(value, key.dp, key.p);
    const s2 = modPow(value, key.dq, key.q);
    const h = modPositive(key.qi * (s1 - s2), key.p);
    const s = s2 + h * key.q;
    if (modPow(s, key.e, key.n) !== value) throw tlsError('ERR_TLS_INVALID_KEY', 'RSA CRT components are inconsistent');
    return s;
}

function rsaSignBytes(scheme: RsaScheme, key: RsaPrivateKey, message: Uint8Array): Uint8Array {
    const k = byteLength(key.n);
    const em =
        scheme.padding === 'pkcs1'
            ? emsaPkcs1Encode(scheme.hash, message, k)
            : emsaPssEncode(scheme.hash, message, bitLength(key.n), randomBytes(HASH_LENGTHS[scheme.hash]));
    return bytesOfBigint(rsaPrivateOperation(key, bigintOfBytes(em)), k);
}

function rsaVerifyBytes(scheme: RsaScheme, key: RsaPublicKey, message: Uint8Array, sig: Uint8Array): boolean {
    const k = byteLength(key.n);
    if (sig.length !== k) return false;
    const s = bigintOfBytes(sig);
    if (s >= key.n) return false;
    const recovered = bytesOfBigint(modPow(s, key.e, key.n), k);
    if (scheme.padding === 'pkcs1') return equalBytes(recovered, emsaPkcs1Encode(scheme.hash, message, k));
    const emLength = Math.ceil((bitLength(key.n) - 1) / 8);
    const lead = k - emLength;
    for (let i = 0; i < lead; i++) {
        if (recovered[i] !== 0) return false;
    }
    return emsaPssVerify(scheme.hash, message, recovered.subarray(lead), bitLength(key.n));
}

// The capability table

export const TLS_CRYPTO_CAPABILITIES: Record<string, CapabilityHandler> = {
    /** Args {}: a fresh X25519 key pair, {priv, pub}, base64 of 32 bytes each. */
    'tls.x25519.keypair': () => {
        const priv = randomBytes(32);
        return { priv: bytesToBase64(priv), pub: bytesToBase64(x25519.getPublicKey(priv)) };
    },

    /** Args {priv, pub}: the X25519 shared secret, {secret}. */
    'tls.x25519.shared': (args) => {
        const priv = bytesOfLength(argOf(args, 'priv'), 'priv', 32);
        const pub = bytesOfLength(argOf(args, 'pub'), 'pub', 32);
        let secret: Uint8Array;
        try {
            secret = x25519.getSharedSecret(priv, pub);
        } catch {
            throw tlsError('ERR_TLS_KEY_EXCHANGE', 'x25519 peer key is a low-order point');
        }
        if (secret.every((byte) => byte === 0)) throw tlsError('ERR_TLS_KEY_EXCHANGE', 'x25519 shared secret is all zero');
        return { secret: bytesToBase64(secret) };
    },

    /** Args {}: a fresh P-256 key pair, {priv: 32-byte scalar, pub: 65-byte uncompressed point}. */
    'tls.p256.keypair': () => {
        const { curve } = NIST_CURVES.p256;
        const priv = curve.utils.randomPrivateKey();
        return { priv: bytesToBase64(priv), pub: bytesToBase64(curve.getPublicKey(priv, false)) };
    },

    /** Args {priv, pub}: the P-256 ECDH secret, the 32-byte x coordinate, {secret}. */
    'tls.p256.shared': (args) => {
        const { curve, orderBytes } = NIST_CURVES.p256;
        const priv = bytesOfLength(argOf(args, 'priv'), 'priv', orderBytes);
        const pub = bytesOfLength(argOf(args, 'pub'), 'pub', 2 * orderBytes + 1);
        if (pub[0] !== 0x04) throw tlsError('ERR_TLS_INVALID_ARG', 'pub is not an uncompressed point');
        if (!curve.utils.isValidPrivateKey(priv)) throw tlsError('ERR_TLS_INVALID_ARG', 'priv is not a valid P-256 scalar');
        let point: Uint8Array;
        try {
            point = curve.getSharedSecret(priv, pub, false);
        } catch {
            throw tlsError('ERR_TLS_KEY_EXCHANGE', 'pub is not a point on P-256');
        }
        return { secret: bytesToBase64(point.subarray(1, 1 + orderBytes)) };
    },

    /** Args {curve, priv, digest}: DER ECDSA-Sig-Value over the pre-hashed digest, low-S, {sig}. */
    'tls.ecdsa.sign': (args) => {
        const entry = lookup(NIST_CURVES, argOf(args, 'curve'), 'curve');
        const priv = bytesOfLength(argOf(args, 'priv'), 'priv', entry.orderBytes);
        const digest = bytesOfLength(argOf(args, 'digest'), 'digest', entry.orderBytes);
        if (!entry.curve.utils.isValidPrivateKey(priv)) throw tlsError('ERR_TLS_INVALID_ARG', 'priv is not a valid scalar for the curve');
        const signature = entry.curve.sign(digest, priv).normalizeS();
        return { sig: bytesToBase64(hexToBytes(signature.toDERHex())) };
    },

    /** Args {curve, pub, digest, sig}: {ok}. A malformed or non-canonical DER signature is false, never a throw. */
    'tls.ecdsa.verify': (args) => {
        const entry = lookup(NIST_CURVES, argOf(args, 'curve'), 'curve');
        const pub = uncompressedPointOf(entry, argOf(args, 'pub'));
        const digest = bytesOfLength(argOf(args, 'digest'), 'digest', entry.orderBytes);
        const der = decodeOrUndefined(argOf(args, 'sig'));
        if (der === undefined) return { ok: false };
        try {
            const signature = entry.curve.Signature.fromDER(der);
            if (signature.toDERHex() !== bytesToHex(der)) return { ok: false };
            return { ok: entry.curve.verify(signature, digest, pub, { lowS: false }) };
        } catch {
            return { ok: false };
        }
    },

    /** Args {scheme, key: {n, e, d, p, q, dp, dq, qi}, message}: the RSA signature over the message, {sig}. */
    'tls.rsa.sign': (args) => {
        const scheme = lookup(RSA_SCHEMES, argOf(args, 'scheme'), 'RSA scheme');
        const key = rsaPrivateKeyOf(argOf(args, 'key'));
        const message = decodeBase64(argOf(args, 'message'), 'message');
        return { sig: bytesToBase64(rsaSignBytes(scheme, key, message)) };
    },

    /** Args {scheme, key: {n, e}, message, sig}: {ok}. A malformed or non-verifying signature is false. */
    'tls.rsa.verify': (args) => {
        const scheme = lookup(RSA_SCHEMES, argOf(args, 'scheme'), 'RSA scheme');
        const key = rsaPublicKeyOf(argOf(args, 'key'));
        const message = decodeBase64(argOf(args, 'message'), 'message');
        const sig = decodeOrUndefined(argOf(args, 'sig'));
        return { ok: sig !== undefined && rsaVerifyBytes(scheme, key, message, sig) };
    },

    /** Args {alg, key, nonce, aad, plaintext}: the ciphertext followed by its 16-byte tag, {ciphertext}. */
    'tls.aead.seal': (args) => {
        const algorithm = lookup(AEAD_ALGORITHMS, argOf(args, 'alg'), 'AEAD algorithm');
        const key = bytesOfLength(argOf(args, 'key'), 'key', algorithm.keyBytes);
        const nonce = bytesOfLength(argOf(args, 'nonce'), 'nonce', AEAD_NONCE_BYTES);
        const aad = decodeBase64(argOf(args, 'aad'), 'aad');
        const plaintext = decodeBase64(argOf(args, 'plaintext'), 'plaintext');
        return { ciphertext: bytesToBase64(algorithm.seal(key, nonce, aad, plaintext)) };
    },

    /** Args {alg, key, nonce, aad, ciphertext}: {plaintext}. A failed tag check throws ERR_TLS_BAD_RECORD_MAC. */
    'tls.aead.open': (args) => {
        const algorithm = lookup(AEAD_ALGORITHMS, argOf(args, 'alg'), 'AEAD algorithm');
        const key = bytesOfLength(argOf(args, 'key'), 'key', algorithm.keyBytes);
        const nonce = bytesOfLength(argOf(args, 'nonce'), 'nonce', AEAD_NONCE_BYTES);
        const aad = decodeBase64(argOf(args, 'aad'), 'aad');
        const ciphertext = decodeBase64(argOf(args, 'ciphertext'), 'ciphertext');
        if (ciphertext.length < AEAD_TAG_BYTES) throw tlsError('ERR_TLS_BAD_RECORD_MAC', 'record is shorter than its tag');
        let plaintext: Uint8Array;
        try {
            plaintext = algorithm.open(key, nonce, aad, ciphertext);
        } catch {
            throw tlsError('ERR_TLS_BAD_RECORD_MAC', 'record failed authentication');
        }
        return { plaintext: bytesToBase64(plaintext) };
    },

    /** Args {bytes}: n bytes from the host CSPRNG, {data}; n is an integer in [0, 65536]. */
    'tls.random': (args) => {
        const count = argOf(args, 'bytes');
        if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > 65536) {
            throw tlsError('ERR_TLS_INVALID_ARG', 'bytes must be an integer in [0, 65536]');
        }
        return { data: bytesToBase64(randomBytes(count)) };
    },
};
