/* Byte helpers shared by the QUIC codecs. */

/**
 * A fresh Uint8Array holding src[start..end). Use this instead of src.slice(): a Node Buffer is a
 * Uint8Array whose slice() returns a view of the same memory, so writing to or keeping a "slice" of a
 * caller's Buffer would mutate or alias the caller's bytes.
 */
export function copyBytes(src: Uint8Array, start = 0, end = src.length): Uint8Array {
    const out = new Uint8Array(Math.max(0, end - start));
    out.set(src.subarray(start, end));
    return out;
}

const HEX = '0123456789abcdef';

export function bytesToHex(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0x0f];
    return out;
}

/** Strict hex decode: an even number of hex digits, nothing else. */
export function hexToBytes(hex: string): Uint8Array {
    if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new TypeError('hex string expected');
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
    let length = 0;
    for (const part of parts) length += part.length;
    const out = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

/** ASCII text to bytes; every code unit must be below 0x80. */
export function asciiBytes(text: string): Uint8Array {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code > 0x7f) throw new TypeError('ASCII text expected');
        out[i] = code;
    }
    return out;
}
