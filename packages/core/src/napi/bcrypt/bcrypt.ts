/*
 * bcrypt salts and hashes as the native code of the bcrypt package (5.1.1) computes and formats them:
 * bcrypt(), bcrypt_gensalt() and bcrypt_get_rounds() of src/bcrypt.cc (OpenBSD bcrypt.c), and ValidateSalt()
 * of src/bcrypt_node.cc, quirks included: the 2a key length wraps at 256 bytes, 2b caps it at 72, a cost of
 * 31 fails validation (1 << 31 overflows int), and numbers parse as atoi() does.
 *
 * Salts and hashes arrive as C strings: UTF-8 bytes read up to the first NUL, with zero bytes after it, so a
 * read past the end sees NUL as the C code does.
 */
import { eksBlowfish } from './eksblowfish';

const BCRYPT_VERSION = 0x32; // '2'
const MAX_SALT = 16;
const MIN_ROUNDS = 16;
const DOLLAR = 0x24;
const MINOR_A = 0x61;
const MINOR_B = 0x62;

const BASE64_CODE = './ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const INDEX_64 = (() => {
    const index = new Uint8Array(128).fill(255);
    for (let i = 0; i < 64; i++) index[BASE64_CODE.charCodeAt(i)] = i;
    return index;
})();

function char64(c: number): number {
    return c > 127 ? 255 : INDEX_64[c];
}

/** Decodes len bytes from the bcrypt base64 at s[p]; stops at the first character outside the alphabet. */
function decodeBase64(out: Uint8Array, len: number, s: Uint8Array, p: number): void {
    let bp = 0;
    while (bp < len) {
        const c1 = char64(s[p]);
        const c2 = char64(s[p + 1]);
        if (c1 === 255 || c2 === 255) break;
        out[bp++] = (c1 << 2) | ((c2 & 0x30) >> 4);
        if (bp >= len) break;
        const c3 = char64(s[p + 2]);
        if (c3 === 255) break;
        out[bp++] = ((c2 & 0x0f) << 4) | ((c3 & 0x3c) >> 2);
        if (bp >= len) break;
        const c4 = char64(s[p + 3]);
        if (c4 === 255) break;
        out[bp++] = ((c3 & 0x03) << 6) | c4;
        p += 4;
    }
}

function encodeBase64(data: Uint8Array, len: number): string {
    let out = '';
    let p = 0;
    while (p < len) {
        let c1 = data[p++];
        out += BASE64_CODE[c1 >> 2];
        c1 = (c1 & 0x03) << 4;
        if (p >= len) {
            out += BASE64_CODE[c1];
            break;
        }
        let c2 = data[p++];
        c1 |= (c2 >> 4) & 0x0f;
        out += BASE64_CODE[c1];
        c1 = (c2 & 0x0f) << 2;
        if (p >= len) {
            out += BASE64_CODE[c1];
            break;
        }
        c2 = data[p++];
        c1 |= (c2 >> 6) & 0x03;
        out += BASE64_CODE[c1];
        out += BASE64_CODE[c2 & 0x3f];
    }
    return out;
}

/** snprintf "%2.2u" */
function twoDigits(n: number): string {
    return (n < 10 ? '0' : '') + n;
}

function strlen(s: Uint8Array, p: number): number {
    let n = 0;
    while (s[p + n] !== 0) n++;
    return n;
}

function isSpace(c: number): boolean {
    return c === 0x20 || (c >= 0x09 && c <= 0x0d);
}

const LONG_MAX = '9223372036854775807';
const LONG_MIN_MAGNITUDE = '9223372036854775808';

/** atoi(): (int)strtol(s, NULL, 10) with a 64-bit long, saturating at LONG_MAX and LONG_MIN before the int cast. */
function atoi(s: Uint8Array, p: number): number {
    while (isSpace(s[p])) p++;
    let negative = false;
    if (s[p] === 0x2b || s[p] === 0x2d) {
        negative = s[p] === 0x2d;
        p++;
    }
    let digits = '';
    while (s[p] >= 0x30 && s[p] <= 0x39) digits += String.fromCharCode(s[p++]);
    digits = digits.replace(/^0+/, '');
    const limit = negative ? LONG_MIN_MAGNITUDE : LONG_MAX;
    if (digits.length > limit.length || (digits.length === limit.length && digits > limit)) {
        // LONG_MIN keeps no bits in its low 32; LONG_MAX keeps all ones
        return negative ? 0 : -1;
    }
    let low = 0;
    for (let i = 0; i < digits.length; i++) low = (low * 10 + digits.charCodeAt(i) - 0x30) % 4294967296;
    if (negative) low = (4294967296 - low) % 4294967296;
    return low | 0;
}

function signedChar(c: number): number {
    return (c << 24) >> 24;
}

/** ValidateSalt() of bcrypt_node.cc: "$", a version up to '2', an optional a or b minor, "NN$" and 22 or more salt characters. */
export function validateSalt(salt: Uint8Array): boolean {
    let p = 0;
    if (salt[p] !== DOLLAR) return false;
    p++;
    if (signedChar(salt[p]) > BCRYPT_VERSION) return false;
    if (salt[p + 1] !== DOLLAR) {
        if (salt[p + 1] !== MINOR_A && salt[p + 1] !== MINOR_B) return false;
        p++;
    }
    p += 2;
    if (salt[p + 2] !== DOLLAR) return false;
    const n = atoi(salt, p);
    if (n > 31 || n < 0) return false;
    // ((uint8_t)1 << (uint8_t)n) is an int: 31 shifts into the sign bit and fails
    if ((1 << n) < MIN_ROUNDS) return false;
    p += 3;
    return Math.floor((strlen(salt, p) * 3) / 4) >= MAX_SALT;
}

/**
 * bcrypt(): hashes key (keyLength bytes, then a NUL) with the salt or hash setting. Returns the hash, or ":"
 * for a setting it cannot parse.
 */
export function bcrypt(key: Uint8Array, keyLength: number, salt: Uint8Array): string {
    let p = 1;
    if (signedChar(salt[p]) > BCRYPT_VERSION) return ':';
    let minor = 0;
    if (salt[p + 1] !== DOLLAR) {
        if (salt[p + 1] !== MINOR_A && salt[p + 1] !== MINOR_B) return ':';
        minor = salt[p + 1];
        p++;
    }
    p += 2;
    if (salt[p + 2] !== DOLLAR) return ':';
    const n = atoi(salt, p);
    if (n > 31 || n < 0) return ':';
    const logRounds = n;
    if (Math.pow(2, logRounds) < MIN_ROUNDS) return ':';
    p += 3;
    if (Math.floor((strlen(salt, p) * 3) / 4) < MAX_SALT) return ':';
    const csalt = new Uint8Array(MAX_SALT);
    decodeBase64(csalt, MAX_SALT, salt, p);
    let keyBytes: number;
    if (minor <= MINOR_A) {
        // the key length is a u_int8_t here: 2a counts the NUL and wraps at 256
        keyBytes = (keyLength + (minor >= MINOR_A ? 1 : 0)) & 0xff;
    } else {
        // 2b caps the length at 72 bytes, then counts the NUL
        keyBytes = (keyLength > 72 ? 72 : keyLength) + 1;
    }
    const ciphertext = eksBlowfish(key, keyBytes, csalt, logRounds);
    return '$2' + (minor ? String.fromCharCode(minor) : '') + '$' + twoDigits(logRounds & 0x1f) + '$'
        + encodeBase64(csalt, MAX_SALT) + encodeBase64(ciphertext, 23);
}

/**
 * bcrypt_gensalt() as the binding returns it, String::New(salt, strlen(salt)): logRounds (a u_int8_t) clamped
 * to 4..31. A NUL minor ends the string after "$2"; a non-ASCII minor byte is an invalid UTF-8 sequence and
 * decodes to U+FFFD.
 */
export function genSalt(minor: number, logRounds: number, seed: Uint8Array): string {
    if (logRounds < 4) logRounds = 4;
    else if (logRounds > 31) logRounds = 31;
    if (minor === 0) return '$2';
    return '$2' + (minor < 0x80 ? String.fromCharCode(minor) : '�') + '$' + twoDigits(logRounds & 0x1f) + '$'
        + encodeBase64(seed, MAX_SALT);
}

/** bcrypt_get_rounds(): atoi() of what follows "$", the version, an optional minor and "$", as an unsigned 32-bit value; 0 when malformed. */
export function getRounds(hash: Uint8Array): number {
    let p = 0;
    if (hash[p++] !== DOLLAR) return 0;
    if (hash[p++] === 0) return 0;
    if (hash[p] !== 0 && hash[p] !== DOLLAR) p++;
    if (hash[p++] !== DOLLAR) return 0;
    return atoi(hash, p) >>> 0;
}
