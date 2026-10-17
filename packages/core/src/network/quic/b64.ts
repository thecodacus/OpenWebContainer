/*
 * Canonical padded base64 for capability arguments. The guest reaches host cryptography through JSON
 * capability calls (callCap), whose byte values are base64 strings; these two functions are the only
 * conversion the QUIC guest code needs. Table driven, one pass, no regular expressions.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const VALUES: Int16Array = (() => {
    const table = new Int16Array(128).fill(-1);
    for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i;
    return table;
})();

export function bytesToBase64(bytes: Uint8Array): string {
    const parts: string[] = [];
    let chunk = '';
    let i = 0;
    for (; i + 2 < bytes.length; i += 3) {
        const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
        chunk += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
        if (chunk.length >= 8192) {
            parts.push(chunk);
            chunk = '';
        }
    }
    const rest = bytes.length - i;
    if (rest === 1) {
        const n = bytes[i] << 16;
        chunk += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + '==';
    } else if (rest === 2) {
        const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
        chunk += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + '=';
    }
    parts.push(chunk);
    return parts.join('');
}

/** Decodes canonical padded base64; throws TypeError on anything else. */
export function base64ToBytes(text: string): Uint8Array {
    if (typeof text !== 'string' || text.length % 4 !== 0) throw new TypeError('base64 text expected');
    const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
    const out = new Uint8Array((text.length / 4) * 3 - padding);
    let o = 0;
    for (let i = 0; i < text.length; i += 4) {
        const last = i + 4 === text.length;
        const a = VALUES[text.charCodeAt(i)] ?? -1;
        const b = VALUES[text.charCodeAt(i + 1)] ?? -1;
        const c = last && padding === 2 ? 0 : VALUES[text.charCodeAt(i + 2)] ?? -1;
        const d = last && padding >= 1 ? 0 : VALUES[text.charCodeAt(i + 3)] ?? -1;
        if ((a | b | c | d) < 0) throw new TypeError('base64 text expected');
        const n = (a << 18) | (b << 12) | (c << 6) | d;
        out[o++] = n >> 16;
        if (o < out.length) out[o++] = (n >> 8) & 0xff;
        if (o < out.length) out[o++] = n & 0xff;
    }
    return out;
}
