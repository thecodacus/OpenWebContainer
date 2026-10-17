import { asciiBytes } from './bytes';
import { base64ToBytes, bytesToBase64 } from './b64';
import type * as HostCrypto from './crypto';

/*
 * Guest replacement for crypto.ts, with the same exports and the same contracts. The guest bundle
 * (scripts/build-quic-guest.mjs) resolves every import of './crypto' inside network/quic to this
 * module, so the stage 1 codecs (protection.ts, packet.ts) run unchanged inside QuickJS while the
 * primitives run on the host through synchronous capability calls:
 *   - HKDF-Extract and HKDF-Expand: crypto.hmac
 *   - AEAD seal and open: tls.aead.seal and tls.aead.open
 *   - header protection masks: quic.hp.mask (capabilities/quic-crypto.ts)
 * hkdfLabel and chacha20Block are pure and are computed here, exactly as crypto.ts does.
 *
 * callCap is the guest bootstrap's capability function; it throws an Error carrying the host's
 * error code when the host rejects a call.
 */

declare const callCap: (op: string, args?: unknown) => any;

export type HashAlgorithm = 'sha256' | 'sha384';
export type AeadAlgorithm = 'aes-128-gcm' | 'aes-256-gcm' | 'chacha20-poly1305';
export type HeaderProtectionAlgorithm = 'aes-128' | 'aes-256' | 'chacha20';

export const HASH_LENGTH: Readonly<Record<HashAlgorithm, number>> = { sha256: 32, sha384: 48 };
export const AEAD_KEY_LENGTH: Readonly<Record<AeadAlgorithm, number>> = { 'aes-128-gcm': 16, 'aes-256-gcm': 32, 'chacha20-poly1305': 32 };
export const HP_KEY_LENGTH: Readonly<Record<HeaderProtectionAlgorithm, number>> = { 'aes-128': 16, 'aes-256': 32, chacha20: 32 };
export const AEAD_NONCE_LENGTH = 12;
export const AEAD_TAG_LENGTH = 16;
export const HP_SAMPLE_LENGTH = 16;

function checkLength(bytes: Uint8Array, length: number, what: string): void {
    if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw new RangeError(`${what} must be ${length} bytes`);
}

function hmac(hash: HashAlgorithm, key: Uint8Array, data: Uint8Array): Uint8Array {
    return base64ToBytes(callCap('crypto.hmac', { algorithm: hash, key: bytesToBase64(key), data: bytesToBase64(data) }) as string);
}

/** HKDF-Extract(salt, IKM) (RFC 5869 Section 2.2): HMAC-Hash(salt, IKM). */
export function hkdfExtract(hash: HashAlgorithm, salt: Uint8Array, ikm: Uint8Array): Uint8Array {
    return hmac(hash, salt, ikm);
}

/** HkdfLabel (RFC 8446 Section 7.1): uint16 length, opaque label<7..255> = "tls13 " + label, opaque context<0..255>. */
export function hkdfLabel(length: number, label: string, context: Uint8Array): Uint8Array {
    const fullLabel = asciiBytes('tls13 ' + label);
    if (!Number.isInteger(length) || length < 0 || length > 0xffff) throw new RangeError('HkdfLabel length out of range');
    if (fullLabel.length < 7 || fullLabel.length > 255) throw new RangeError('HkdfLabel label length out of range');
    if (context.length > 255) throw new RangeError('HkdfLabel context longer than 255 bytes');
    const out = new Uint8Array(2 + 1 + fullLabel.length + 1 + context.length);
    out[0] = length >>> 8;
    out[1] = length & 0xff;
    out[2] = fullLabel.length;
    out.set(fullLabel, 3);
    out[3 + fullLabel.length] = context.length;
    out.set(context, 4 + fullLabel.length);
    return out;
}

/** HKDF-Expand-Label(Secret, Label, Context, Length) (RFC 8446 Section 7.1) over HKDF-Expand (RFC 5869 Section 2.3). */
export function hkdfExpandLabel(hash: HashAlgorithm, secret: Uint8Array, label: string, context: Uint8Array, length: number): Uint8Array {
    const info = hkdfLabel(length, label, context);
    const hashLength = HASH_LENGTH[hash];
    if (length > 255 * hashLength) throw new RangeError('HKDF-Expand length too large');
    const out = new Uint8Array(length);
    let previous = new Uint8Array(0);
    for (let filled = 0, counter = 1; filled < length; counter++) {
        const input = new Uint8Array(previous.length + info.length + 1);
        input.set(previous, 0);
        input.set(info, previous.length);
        input[input.length - 1] = counter;
        previous = hmac(hash, secret, input);
        const take = Math.min(previous.length, length - filled);
        out.set(previous.subarray(0, take), filled);
        filled += take;
    }
    return out;
}

function checkAead(alg: AeadAlgorithm, key: Uint8Array, nonce: Uint8Array): void {
    if (AEAD_KEY_LENGTH[alg] === undefined) throw new RangeError(`unknown AEAD algorithm ${String(alg)}`);
    checkLength(key, AEAD_KEY_LENGTH[alg], `${alg} key`);
    checkLength(nonce, AEAD_NONCE_LENGTH, 'AEAD nonce');
}

/** AEAD encryption: ciphertext followed by the 16-byte tag. */
export function aeadSeal(alg: AeadAlgorithm, key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    checkAead(alg, key, nonce);
    const result = callCap('tls.aead.seal', {
        alg,
        key: bytesToBase64(key),
        nonce: bytesToBase64(nonce),
        aad: bytesToBase64(aad),
        plaintext: bytesToBase64(plaintext),
    });
    return base64ToBytes(result.ciphertext as string);
}

/** AEAD decryption of ciphertext || tag; null when the input is shorter than a tag or does not authenticate. */
export function aeadOpen(alg: AeadAlgorithm, key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, sealed: Uint8Array): Uint8Array | null {
    checkAead(alg, key, nonce);
    if (sealed.length < AEAD_TAG_LENGTH) return null;
    let result: { plaintext: string };
    try {
        result = callCap('tls.aead.open', {
            alg,
            key: bytesToBase64(key),
            nonce: bytesToBase64(nonce),
            aad: bytesToBase64(aad),
            ciphertext: bytesToBase64(sealed),
        });
    } catch (error) {
        if ((error as { code?: unknown }).code === 'ERR_TLS_BAD_RECORD_MAC') return null;
        throw error;
    }
    return base64ToBytes(result.plaintext);
}

function rotl32(v: number, n: number): number {
    return ((v << n) | (v >>> (32 - n))) >>> 0;
}

function readLE32(bytes: Uint8Array, offset: number): number {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

/** One ChaCha20 block (RFC 8439 Section 2.3): 32-byte key, 32-bit counter, 12-byte nonce. Same code as crypto.ts. */
export function chacha20Block(key: Uint8Array, counter: number, nonce: Uint8Array): Uint8Array {
    checkLength(key, 32, 'ChaCha20 key');
    checkLength(nonce, 12, 'ChaCha20 nonce');
    if (!Number.isInteger(counter) || counter < 0 || counter > 0xffffffff) throw new RangeError('ChaCha20 counter out of range');
    const state = new Uint32Array(16);
    state[0] = 0x61707865;
    state[1] = 0x3320646e;
    state[2] = 0x79622d32;
    state[3] = 0x6b206574;
    for (let i = 0; i < 8; i++) state[4 + i] = readLE32(key, 4 * i);
    state[12] = counter;
    for (let i = 0; i < 3; i++) state[13 + i] = readLE32(nonce, 4 * i);
    const x = Uint32Array.from(state);
    const quarter = (a: number, b: number, c: number, d: number): void => {
        x[a] += x[b];
        x[d] = rotl32(x[d] ^ x[a], 16);
        x[c] += x[d];
        x[b] = rotl32(x[b] ^ x[c], 12);
        x[a] += x[b];
        x[d] = rotl32(x[d] ^ x[a], 8);
        x[c] += x[d];
        x[b] = rotl32(x[b] ^ x[c], 7);
    };
    for (let round = 0; round < 10; round++) {
        quarter(0, 4, 8, 12);
        quarter(1, 5, 9, 13);
        quarter(2, 6, 10, 14);
        quarter(3, 7, 11, 15);
        quarter(0, 5, 10, 15);
        quarter(1, 6, 11, 12);
        quarter(2, 7, 8, 13);
        quarter(3, 4, 9, 14);
    }
    const out = new Uint8Array(64);
    for (let i = 0; i < 16; i++) {
        const word = (x[i] + state[i]) >>> 0;
        out[4 * i] = word & 0xff;
        out[4 * i + 1] = (word >>> 8) & 0xff;
        out[4 * i + 2] = (word >>> 16) & 0xff;
        out[4 * i + 3] = word >>> 24;
    }
    return out;
}

/**
 * The 5-byte header protection mask for a 16-byte sample (RFC 9001 Sections 5.4.3 and 5.4.4),
 * computed on the host by the quic.hp.mask capability.
 */
export function headerProtectionMask(alg: HeaderProtectionAlgorithm, hpKey: Uint8Array, sample: Uint8Array): Uint8Array {
    if (HP_KEY_LENGTH[alg] === undefined) throw new RangeError(`unknown header protection algorithm ${String(alg)}`);
    checkLength(hpKey, HP_KEY_LENGTH[alg], `${alg} header protection key`);
    checkLength(sample, HP_SAMPLE_LENGTH, 'header protection sample');
    const result = callCap('quic.hp.mask', { alg, key: bytesToBase64(hpKey), sample: bytesToBase64(sample) });
    return base64ToBytes(result.mask as string);
}

/* Compile-time check: this module offers every runtime export of crypto.ts with the same type. */
const SURFACE: { [K in keyof typeof HostCrypto]: (typeof HostCrypto)[K] } = {
    HASH_LENGTH,
    AEAD_KEY_LENGTH,
    HP_KEY_LENGTH,
    AEAD_NONCE_LENGTH,
    AEAD_TAG_LENGTH,
    HP_SAMPLE_LENGTH,
    hkdfExtract,
    hkdfLabel,
    hkdfExpandLabel,
    aeadSeal,
    aeadOpen,
    chacha20Block,
    headerProtectionMask,
};
void SURFACE;
