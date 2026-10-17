/*
 * The primitives the shim builds on, all from @noble (already a dependency of packages/core), so the
 * guest never needs a single line of crypto of its own: XSalsa20-Poly1305, X25519, HSalsa20, Ed25519,
 * BLAKE2b, SHA-2, HMAC and ChaCha20.
 *
 * Every construction here was derived by matching candidate constructions against the real add-on and
 * against fetched libsodium test vectors, not read off the C source:
 *
 *   crypto_secretbox_easy  the NaCl construction: the XSalsa20 keystream under (k, n) is taken from
 *                          offset 0, its first 32 bytes are the Poly1305 key and the message is XORed
 *                          with the keystream from offset 32 on. (The libsodium-detached variant that
 *                          starts the message at block 1 was measured and does NOT match.)
 *   crypto_box_easy        crypto_secretbox_easy under k = HSalsa20(sigma, X25519(sk, pk), 16 zero
 *                          bytes): crypto_box_beforenm.
 *   crypto_box_seed_keypair  sk = SHA-512(seed)[0..32), pk = X25519(sk, base). sk is not the seed.
 *   crypto_sign_seed_keypair sk = seed || pk, pk = Ed25519 public key of seed.
 *   randombytes_buf_deterministic  ChaCha20 (IETF variant) under key = seed and nonce "LibsodiumDRG".
 *   crypto_auth            HMAC-SHA-512 truncated to 32 bytes: crypto_auth_PRIMITIVE hmacsha512256.
 *   crypto_generichash     BLAKE2b with dkLen = out.length and the optional key.
 */

import { hsalsa, xsalsa20 } from '@noble/ciphers/salsa';
import { poly1305 } from '@noble/ciphers/_poly1305';
import { chacha20, chacha20poly1305, xchacha20poly1305 } from '@noble/ciphers/chacha';
import { blake2b } from '@noble/hashes/blake2b';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { hmac } from '@noble/hashes/hmac';
import { ed25519, edwardsToMontgomeryPriv, edwardsToMontgomeryPub, x25519 } from '@noble/curves/ed25519';

export { blake2b, chacha20, ed25519, hmac, sha256, sha512, x25519 };

/**
 * The Salsa20 constant "expand 32-byte k" as the four little-endian words HSalsa20 loads into its
 * state. Spelled out rather than derived from a string so the bundle carries no encoder.
 */
const SIGMA = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);

/** Little-endian words of a byte string, whatever the host's own endianness is. */
function toWords(bytes: Uint8Array): Uint32Array {
    const words = new Uint32Array(bytes.length >>> 2);
    for (let i = 0; i < words.length; i++) {
        words[i] =
            (bytes[i * 4] | (bytes[i * 4 + 1] << 8) | (bytes[i * 4 + 2] << 16) | (bytes[i * 4 + 3] << 24)) >>> 0;
    }
    return words;
}

/** The bytes of little-endian words. */
function fromWords(words: Uint32Array): Uint8Array {
    const bytes = new Uint8Array(words.length * 4);
    for (let i = 0; i < words.length; i++) {
        bytes[i * 4] = words[i];
        bytes[i * 4 + 1] = words[i] >>> 8;
        bytes[i * 4 + 2] = words[i] >>> 16;
        bytes[i * 4 + 3] = words[i] >>> 24;
    }
    return bytes;
}

/** crypto_core_hsalsa20: HSalsa20(key, in), the 20-round core without the final feed-forward add. */
export function coreHsalsa(key: Uint8Array, input: Uint8Array): Uint8Array {
    const out = new Uint32Array(8);
    hsalsa(SIGMA, toWords(key), toWords(input), out);
    return fromWords(out);
}

/** crypto_box_beforenm: the shared secret of a box key pair, ready for crypto_secretbox_easy. */
export function beforenm(publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array {
    return coreHsalsa(x25519.scalarMult(secretKey, publicKey), new Uint8Array(16));
}

/**
 * crypto_secretbox_detached: the ciphertext and its Poly1305 tag. The keystream is generated once over
 * 32 + m.length bytes, so a message of any length needs exactly one XSalsa20 pass.
 */
export function secretboxSeal(message: Uint8Array, nonce: Uint8Array, key: Uint8Array): { ct: Uint8Array; mac: Uint8Array } {
    const stream = xsalsa20(key, nonce, new Uint8Array(message.length + 32));
    const ct = new Uint8Array(message.length);
    for (let i = 0; i < message.length; i++) ct[i] = message[i] ^ stream[32 + i];
    const mac = poly1305(ct, stream.subarray(0, 32));
    return { ct, mac };
}

/** The XSalsa20 keystream bytes the message was XORed with, for opening a box. */
function secretboxStream(length: number, nonce: Uint8Array, key: Uint8Array): Uint8Array {
    return xsalsa20(key, nonce, new Uint8Array(length + 32)).subarray(32);
}

/** crypto_secretbox_open_detached: writes the plaintext into `message` and reports whether the tag held. */
export function secretboxOpen(
    message: Uint8Array,
    ct: Uint8Array,
    mac: Uint8Array,
    nonce: Uint8Array,
    key: Uint8Array
): boolean {
    const expected = poly1305(ct, xsalsa20(key, nonce, new Uint8Array(ct.length + 32)).subarray(0, 32));
    if (!constantTimeEqual(expected, mac.subarray(0, 16))) return false;
    const stream = secretboxStream(ct.length, nonce, key);
    for (let i = 0; i < ct.length; i++) message[i] = ct[i] ^ stream[i];
    return true;
}

/** sodium_memcmp over two equal-length byte strings: no early exit on the first difference. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

/** The guest's CSPRNG. packages/core installs globalThis.crypto = webcrypto in the guest realm. */
export function randomValues(length: number): Uint8Array {
    const out = new Uint8Array(length);
    const webcrypto = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
    if (!webcrypto || typeof webcrypto.getRandomValues !== 'function') {
        const error = new Error(
            'sodium-native: no CSPRNG in the guest: globalThis.crypto.getRandomValues is absent [ERR_OWC_NAPI_SODIUM_NO_CSPRNG]'
        );
        (error as { code?: string }).code = 'ERR_OWC_NAPI_SODIUM_NO_CSPRNG';
        throw error;
    }
    // getRandomValues is specified for at most 65536 bytes at a time.
    for (let at = 0; at < length; at += 65536) {
        webcrypto.getRandomValues(out.subarray(at, Math.min(at + 65536, length)));
    }
    return out;
}

/** randombytes_random: one 32-bit draw. */
export function randomUint32(): number {
    const bytes = randomValues(4);
    return ((bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0);
}

/** randombytes_uniform: libsodium's rejection sampling, which returns 0 below an upper bound of 2. */
export function uniform(upperBound: number): number {
    if (upperBound < 2) return 0;
    const min = (0x100000000 - upperBound) % upperBound;
    let r = randomUint32();
    while (r < min) r = randomUint32();
    return r % upperBound;
}

/** crypto_generichash: BLAKE2b at the caller's output length, keyed when a key is given. */
export function generichash(input: Uint8Array, key: Uint8Array, outLength: number): Uint8Array {
    return blake2b(input, { dkLen: outLength, key: key.length ? key : undefined });
}

/** crypto_auth: HMAC-SHA-512 truncated to crypto_auth_BYTES, which is hmacsha512256. */
export function auth(input: Uint8Array, key: Uint8Array): Uint8Array {
    return hmac(sha512, key, input).subarray(0, 32);
}

/** crypto_onetimeauth: Poly1305 under a one-time key, which noble reads as a 32-byte key. */
export function onetimeauth(input: Uint8Array, key: Uint8Array): Uint8Array {
    return poly1305(input, key);
}

/** The AEAD family the shim computes, both of which noble hands back as ciphertext || 16-byte tag. */
export type AeadKind = 'chacha20poly1305' | 'xchacha20poly1305';

function aeadCipher(kind: AeadKind, key: Uint8Array, npub: Uint8Array, ad: Uint8Array) {
    return kind === 'chacha20poly1305'
        ? chacha20poly1305(key, npub, ad)
        : xchacha20poly1305(key, npub, ad);
}

/** crypto_aead_*_encrypt: ciphertext with its 16-byte tag appended, as RFC 7539 lays it out. */
export function aeadSeal(
    kind: AeadKind,
    message: Uint8Array,
    ad: Uint8Array,
    npub: Uint8Array,
    key: Uint8Array
): Uint8Array {
    return aeadCipher(kind, key, npub, ad).encrypt(message);
}

/** crypto_aead_*_decrypt: throws when the tag does not hold, which the binding reports in its own words. */
export function aeadOpen(
    kind: AeadKind,
    ct: Uint8Array,
    ad: Uint8Array,
    npub: Uint8Array,
    key: Uint8Array
): Uint8Array {
    return aeadCipher(kind, key, npub, ad).decrypt(ct);
}

/**
 * crypto_kdf_derive_from_key: BLAKE2b over an empty message, keyed, with the subkey id as the salt and
 * the context as the personalization - both 16 bytes, exactly the PERSONALBYTES/SALTBYTES libsodium
 * pads into (crypto_kdf/blake2b/kdf_blake2b.c).
 */
export function kdfDerive(
    subkeyLength: number,
    subkeyId: number | bigint,
    ctx: Uint8Array,
    key: Uint8Array
): Uint8Array {
    const personalization = new Uint8Array(16);
    personalization.set(ctx.subarray(0, 8), 0);
    const salt = new Uint8Array(16);
    let id = BigInt(subkeyId);
    for (let i = 0; i < 8; i++) {
        salt[i] = Number(id & BigInt(0xff));
        id >>= BigInt(8);
    }
    return blake2b(new Uint8Array(0), { dkLen: subkeyLength, key, salt, personalization });
}

/**
 * crypto_kx_*_session_keys: unkeyed BLAKE2b-64 over q || client_pk || server_pk, where q is the
 * X25519 shared secret (crypto_kx/crypto_kx.c). The client receives the first half and transmits the
 * second; the server does the opposite.
 */
export function kxSessionKeys(q: Uint8Array, clientPk: Uint8Array, serverPk: Uint8Array): Uint8Array {
    const input = new Uint8Array(96);
    input.set(q.subarray(0, 32), 0);
    input.set(clientPk.subarray(0, 32), 32);
    input.set(serverPk.subarray(0, 32), 64);
    return blake2b(input, { dkLen: 64 });
}

/** crypto_kx_seed_keypair: the secret key is unkeyed BLAKE2b-256 of the seed, not SHA-512. */
export function kxSeedKeypair(pk: Uint8Array, sk: Uint8Array, seed: Uint8Array): void {
    sk.set(blake2b(seed, { dkLen: 32 }));
    pk.set(x25519.scalarMultBase(sk));
}

/** The Ed25519 public key of a 32-byte seed, as crypto_sign_seed_keypair writes it. */
export function ed25519PublicKey(seed: Uint8Array): Uint8Array {
    return ed25519.getPublicKey(seed);
}

export { edwardsToMontgomeryPriv, edwardsToMontgomeryPub };
