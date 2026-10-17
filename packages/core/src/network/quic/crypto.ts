import { ecb, gcm } from '@noble/ciphers/aes';
import { chacha20, chacha20poly1305 } from '@noble/ciphers/chacha';
import { expand, extract } from '@noble/hashes/hkdf';
import { sha256, sha384 } from '@noble/hashes/sha2';
import { asciiBytes, copyBytes } from './bytes';

/*
 * Cryptographic primitives for QUIC packet protection (RFC 9001 Section 5). This is the only module
 * that imports @noble; the rest of the QUIC code reaches the primitives through these functions.
 *
 * One primitive is not taken from @noble as is: @noble/ciphers 1.3.0 chacha20 rejects a block counter
 * of 2^32 - 1 ("arx: counter overflow"), and ChaCha20 header protection takes its counter from the
 * first four sample bytes, so every value 0..2^32-1 occurs. For that single counter value the mask
 * comes from chacha20Block below (RFC 8439 Section 2.3); every other counter goes through @noble.
 */

export type HashAlgorithm = 'sha256' | 'sha384';
export type AeadAlgorithm = 'aes-128-gcm' | 'aes-256-gcm' | 'chacha20-poly1305';
export type HeaderProtectionAlgorithm = 'aes-128' | 'aes-256' | 'chacha20';

const HASHES = { sha256, sha384 } as const;

export const HASH_LENGTH: Readonly<Record<HashAlgorithm, number>> = { sha256: 32, sha384: 48 };
export const AEAD_KEY_LENGTH: Readonly<Record<AeadAlgorithm, number>> = { 'aes-128-gcm': 16, 'aes-256-gcm': 32, 'chacha20-poly1305': 32 };
export const HP_KEY_LENGTH: Readonly<Record<HeaderProtectionAlgorithm, number>> = { 'aes-128': 16, 'aes-256': 32, chacha20: 32 };
export const AEAD_NONCE_LENGTH = 12;
export const AEAD_TAG_LENGTH = 16;
export const HP_SAMPLE_LENGTH = 16;

/** Smallest block counter @noble/ciphers 1.3.0 chacha20 refuses. */
const NOBLE_CHACHA20_COUNTER_LIMIT = 0xffffffff;

function checkLength(bytes: Uint8Array, length: number, what: string): void {
    if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw new RangeError(`${what} must be ${length} bytes`);
}

/** HKDF-Extract(salt, IKM) (RFC 5869 Section 2.2). */
export function hkdfExtract(hash: HashAlgorithm, salt: Uint8Array, ikm: Uint8Array): Uint8Array {
    return extract(HASHES[hash], ikm, salt);
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

/** HKDF-Expand-Label(Secret, Label, Context, Length) (RFC 8446 Section 7.1). */
export function hkdfExpandLabel(hash: HashAlgorithm, secret: Uint8Array, label: string, context: Uint8Array, length: number): Uint8Array {
    return expand(HASHES[hash], secret, hkdfLabel(length, label, context), length);
}

function aeadCipher(alg: AeadAlgorithm, key: Uint8Array, nonce: Uint8Array, aad: Uint8Array) {
    checkLength(key, AEAD_KEY_LENGTH[alg], `${alg} key`);
    checkLength(nonce, AEAD_NONCE_LENGTH, 'AEAD nonce');
    return alg === 'chacha20-poly1305' ? chacha20poly1305(key, nonce, aad) : gcm(key, nonce, aad);
}

/** AEAD encryption: ciphertext followed by the 16-byte tag. */
export function aeadSeal(alg: AeadAlgorithm, key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    return aeadCipher(alg, key, nonce, aad).encrypt(plaintext);
}

/** AEAD decryption of ciphertext || tag; null when the input is shorter than a tag or does not authenticate. */
export function aeadOpen(alg: AeadAlgorithm, key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, sealed: Uint8Array): Uint8Array | null {
    const cipher = aeadCipher(alg, key, nonce, aad);
    if (sealed.length < AEAD_TAG_LENGTH) return null;
    try {
        return cipher.decrypt(sealed);
    } catch {
        return null;
    }
}

function rotl32(v: number, n: number): number {
    return ((v << n) | (v >>> (32 - n))) >>> 0;
}

function readLE32(bytes: Uint8Array, offset: number): number {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

/** One ChaCha20 block (RFC 8439 Section 2.3): 32-byte key, 32-bit counter, 12-byte nonce. */
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
 * The 5-byte header protection mask for a 16-byte sample: AES-ECB of the sample (RFC 9001
 * Section 5.4.3), or ChaCha20 of five zero bytes with the counter taken little-endian from sample
 * bytes 0..3 and the nonce from bytes 4..15 (Section 5.4.4).
 */
export function headerProtectionMask(alg: HeaderProtectionAlgorithm, hpKey: Uint8Array, sample: Uint8Array): Uint8Array {
    checkLength(hpKey, HP_KEY_LENGTH[alg], `${alg} header protection key`);
    checkLength(sample, HP_SAMPLE_LENGTH, 'header protection sample');
    if (alg === 'chacha20') {
        const counter = readLE32(sample, 0);
        const nonce = copyBytes(sample, 4, 16);
        if (counter < NOBLE_CHACHA20_COUNTER_LIMIT) return chacha20(hpKey, nonce, new Uint8Array(5), undefined, counter);
        return chacha20Block(hpKey, counter, nonce).slice(0, 5);
    }
    return ecb(hpKey, { disablePadding: true }).encrypt(sample).slice(0, 5);
}
