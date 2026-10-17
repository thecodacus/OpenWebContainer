import { HP_KEY_LENGTH, HP_SAMPLE_LENGTH, headerProtectionMask } from '../../../../../network/quic/crypto';
import type { HeaderProtectionAlgorithm } from '../../../../../network/quic/crypto';
import { base64ToBytes, bytesToBase64 } from '../../../../../network/virtual/host-http';
import { CapabilityHandler } from './types';

/*
 * Host side of the guest QUIC stack's header protection (RFC 9001 Section 5.4). It is the one QUIC
 * primitive the existing capabilities cannot build: payload protection uses tls.aead.seal and
 * tls.aead.open, and HKDF uses crypto.hmac. The mask comes from the QUIC codec module itself
 * (network/quic/crypto.ts: AES-ECB of the sample, or ChaCha20 keyed by the sample). One synchronous
 * call per protected or unprotected packet. Byte values are canonical padded base64.
 */

function quicError(message: string): Error {
    return Object.assign(new Error(message), { code: 'ERR_QUIC_INVALID_ARG' });
}

/** Canonical padded base64 of exactly length bytes; anything else is an argument error. */
function bytesArg(value: unknown, field: string, length: number): Uint8Array {
    if (typeof value !== 'string') throw quicError(`${field} must be a base64 string`);
    let bytes: Uint8Array;
    try {
        bytes = base64ToBytes(value);
    } catch {
        throw quicError(`${field} is not base64`);
    }
    if (bytesToBase64(bytes) !== value) throw quicError(`${field} is not canonical padded base64`);
    if (bytes.length !== length) throw quicError(`${field} must be ${length} bytes, got ${bytes.length}`);
    return bytes;
}

export const QUIC_CRYPTO_CAPABILITIES: Record<string, CapabilityHandler> = {
    /** Args {alg: 'aes-128' | 'aes-256' | 'chacha20', key, sample}: the 5-byte header protection mask, {mask}. */
    'quic.hp.mask': (args) => {
        const alg = args?.alg as unknown;
        if (typeof alg !== 'string' || !Object.prototype.hasOwnProperty.call(HP_KEY_LENGTH, alg)) {
            throw quicError(`unknown header protection algorithm ${String(alg)}`);
        }
        const name = alg as HeaderProtectionAlgorithm;
        const key = bytesArg(args?.key, 'key', HP_KEY_LENGTH[name]);
        const sample = bytesArg(args?.sample, 'sample', HP_SAMPLE_LENGTH);
        return { mask: bytesToBase64(headerProtectionMask(name, key, sample)) };
    },
};
