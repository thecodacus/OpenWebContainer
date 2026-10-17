/**
 * Byte strings.
 *
 * The store keeps every key and value as a JavaScript string in which each char code is one byte
 * (0-255). String comparison then orders keys exactly like LevelDB's bytewise comparator (memcmp,
 * then the shorter key first), Map lookups and sorting are native, and ASCII text crosses the
 * binding without any conversion. These helpers convert between byte strings and the values the
 * add-on accepts and returns: strings (UTF-8) and Buffers (any ArrayBufferView, as napi_is_buffer).
 */

export type ByteString = string;

/** The part of the Buffer constructor the shim uses: wrapping an ArrayBuffer without a copy. */
export interface BufferConstructorLike {
    from(data: ArrayBuffer, byteOffset?: number, length?: number): Uint8Array;
}

const ASCII = /^[\x00-\x7f]*$/;
const CHUNK = 8192;

function fromCodes(codes: ArrayLike<number>): string {
    return String.fromCharCode.apply(null, codes as unknown as number[]);
}

/**
 * UTF-8 bytes of a string, as napi_get_value_string_utf8 writes them: an unpaired surrogate
 * becomes U+FFFD (EF BF BD).
 */
export function stringToBytes(s: string): ByteString {
    if (ASCII.test(s)) return s;
    const parts: string[] = [];
    let codes: number[] = [];
    const n = s.length;
    for (let i = 0; i < n; i++) {
        let c = s.charCodeAt(i);
        if (c < 0x80) {
            codes.push(c);
        } else if (c < 0x800) {
            codes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
        } else if (c >= 0xd800 && c <= 0xdfff) {
            const d = i + 1 < n ? s.charCodeAt(i + 1) : 0;
            if (c <= 0xdbff && d >= 0xdc00 && d <= 0xdfff) {
                c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
                i++;
                codes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
            } else {
                codes.push(0xef, 0xbf, 0xbd);
            }
        } else {
            codes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        }
        if (codes.length >= CHUNK) {
            parts.push(fromCodes(codes));
            codes = [];
        }
    }
    parts.push(fromCodes(codes));
    return parts.join('');
}

/**
 * Decodes UTF-8 bytes the way napi_create_string_utf8 does (WHATWG decoding): each maximal
 * invalid subpart becomes one U+FFFD and the byte that ended it is decoded again.
 */
export function bytesToString(b: ByteString): string {
    if (ASCII.test(b)) return b;
    const parts: string[] = [];
    let out: number[] = [];
    const n = b.length;
    let i = 0;
    while (i < n) {
        const c0 = b.charCodeAt(i);
        if (c0 < 0x80) {
            out.push(c0);
            i++;
        } else {
            let need = 0;
            let cp = 0;
            let lower = 0x80;
            let upper = 0xbf;
            if (c0 >= 0xc2 && c0 <= 0xdf) {
                need = 1;
                cp = c0 & 0x1f;
            } else if (c0 >= 0xe0 && c0 <= 0xef) {
                need = 2;
                cp = c0 & 0x0f;
                if (c0 === 0xe0) lower = 0xa0;
                else if (c0 === 0xed) upper = 0x9f;
            } else if (c0 >= 0xf0 && c0 <= 0xf4) {
                need = 3;
                cp = c0 & 0x07;
                if (c0 === 0xf0) lower = 0x90;
                else if (c0 === 0xf4) upper = 0x8f;
            }
            i++;
            let ok = need > 0;
            for (let k = 0; k < need; k++) {
                if (i >= n) {
                    ok = false;
                    break;
                }
                const c = b.charCodeAt(i);
                if (c < lower || c > upper) {
                    ok = false;
                    break;
                }
                lower = 0x80;
                upper = 0xbf;
                cp = (cp << 6) | (c & 0x3f);
                i++;
            }
            if (!ok) {
                out.push(0xfffd);
            } else if (cp >= 0x10000) {
                cp -= 0x10000;
                out.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
            } else {
                out.push(cp);
            }
        }
        if (out.length >= CHUNK) {
            parts.push(fromCodes(out));
            out = [];
        }
    }
    parts.push(fromCodes(out));
    return parts.join('');
}

/** The bytes of any ArrayBufferView (Buffer, Uint8Array, other typed arrays, DataView). */
export function viewToBytes(view: ArrayBufferView): ByteString {
    const u = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    if (u.length <= CHUNK) return fromCodes(u);
    const parts: string[] = [];
    for (let i = 0; i < u.length; i += CHUNK) parts.push(fromCodes(u.subarray(i, i + CHUNK)));
    return parts.join('');
}

export function bytesToView(s: ByteString): Uint8Array {
    const n = s.length;
    const u = new Uint8Array(n);
    for (let i = 0; i < n; i++) u[i] = s.charCodeAt(i);
    return u;
}

/** The add-on's ToSlice(): a string as UTF-8, an ArrayBufferView as its bytes, anything else as no bytes. */
export function toBytes(value: unknown): ByteString {
    if (typeof value === 'string') return stringToBytes(value);
    if (ArrayBuffer.isView(value)) return viewToBytes(value);
    return '';
}

/** True when napi_is_buffer would accept the value. */
export function isView(value: unknown): value is ArrayBufferView {
    return ArrayBuffer.isView(value);
}

/** A fresh Buffer holding the bytes (napi_create_buffer_copy). */
export function bytesToBuffer(B: BufferConstructorLike, s: ByteString): Uint8Array {
    const u = bytesToView(s);
    return B.from(u.buffer, 0, u.length);
}

/** Entry::Convert(): a Buffer copy or a UTF-8 decoded string. */
export function convert(B: BufferConstructorLike, s: ByteString, asBuffer: boolean): Uint8Array | string {
    return asBuffer ? bytesToBuffer(B, s) : bytesToString(s);
}

/** Printable form of a byte string for error and property text: ASCII as is, other bytes as \xNN. */
export function escapeBytes(s: ByteString): string {
    let out = '';
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        out += c >= 0x20 && c < 0x7f ? s.charAt(i) : '\\x' + (c < 16 ? '0' : '') + c.toString(16);
    }
    return out;
}
