import { CapabilityHandler } from './types';
import { FlateErrorCode, deflateSync, gzipSync, inflateSync, zlibSync } from 'fflate';

/**
 * Host operations for the zlib family. fflate does the raw DEFLATE work (its `deflateSync` and
 * `inflateSync` are raw streams; `zlibSync` and `unzlibSync` are the zlib framing). The framing Node
 * checks and fflate does not (CRC-32 and size for gzip, Adler-32 for zlib, multi-member gzip, the
 * zero-byte stop rule) is reproduced here, with zlib's error codes and wording. Bytes cross the
 * capability boundary as base64 strings because capability arguments are JSON.
 */

type Bytes = Uint8Array;
type FlateLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

const Z_NEED_DICT = 2;
const Z_DATA_ERROR = -3;
const Z_BUF_ERROR = -5;

function zlibError(code: string, errno: number, message: string): Error {
    return Object.assign(new Error(message), { code, errno });
}

function dataError(message: string): Error {
    return zlibError('Z_DATA_ERROR', Z_DATA_ERROR, message);
}

function eofError(): Error {
    return zlibError('Z_BUF_ERROR', Z_BUF_ERROR, 'unexpected end of file');
}

/** Maps an fflate failure onto the zlib error Node raises for the same stream. */
function mapFlateError(error: unknown): Error {
    const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
    if (code === FlateErrorCode.UnexpectedEOF) return eofError();
    if (code === FlateErrorCode.InvalidHeader) return dataError('incorrect header check');
    if (code === FlateErrorCode.InvalidLengthLiteral) return dataError('invalid literal/length code');
    if (code === FlateErrorCode.InvalidDistance) return dataError('invalid distance too far back');
    return dataError(typeof message === 'string' ? message : String(error));
}

const CRC_TABLE: Uint32Array = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

function crc32Of(bytes: Bytes): number {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function adler32Of(bytes: Bytes): number {
    let a = 1;
    let b = 0;
    let i = 0;
    while (i < bytes.length) {
        const end = Math.min(i + 5552, bytes.length);
        for (; i < end; i++) {
            a += bytes[i];
            b += a;
        }
        a %= 65521;
        b %= 65521;
    }
    return ((b << 16) | a) >>> 0;
}

function u32le(bytes: Bytes, at: number): number {
    return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

function u32be(bytes: Bytes, at: number): number {
    return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

function concatBytes(parts: Bytes[]): Bytes {
    let total = 0;
    for (const part of parts) total += part.length;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const part of parts) {
        out.set(part, pos);
        pos += part.length;
    }
    return out;
}

/** Raw DEFLATE inflate. Empty input is an unexpected end, as zlib reports it. */
function inflateRaw(bytes: Bytes, dictionary?: Bytes): Bytes {
    if (bytes.length === 0) throw eofError();
    try {
        return inflateSync(bytes, dictionary ? { dictionary } : undefined);
    } catch (error) {
        throw mapFlateError(error);
    }
}

function inflatesCleanly(bytes: Bytes, dictionary?: Bytes): boolean {
    try {
        inflateSync(bytes, dictionary ? { dictionary } : undefined);
        return true;
    } catch {
        return false;
    }
}

/**
 * Length of the deflate stream at the start of `bytes`: the shortest prefix that inflates without an
 * unexpected end. fflate ignores bytes after the final block, so this bisection is exact. It runs only
 * on failure paths, where the trailer position cannot be read from the output alone.
 */
function deflateStreamLength(bytes: Bytes, dictionary?: Bytes): number {
    let lo = 1;
    let hi = bytes.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (inflatesCleanly(bytes.subarray(0, mid), dictionary)) hi = mid;
        else lo = mid + 1;
    }
    return lo;
}

function skipZeroTerminated(data: Bytes, pos: number): number {
    let at = pos;
    while (at < data.length && data[at] !== 0) at++;
    if (at >= data.length) throw eofError();
    return at + 1;
}

/** Index of the deflate payload of the gzip member at `start`, validated in zlib's order. */
function gzipPayloadStart(data: Bytes, start: number): number {
    if (data.length - start < 2) throw eofError();
    if (data[start] !== 0x1f || data[start + 1] !== 0x8b) throw dataError('incorrect header check');
    if (data.length - start < 10) throw eofError();
    if (data[start + 2] !== 8) throw dataError('unknown compression method');
    const flags = data[start + 3];
    if (flags & 0xe0) throw dataError('unknown header flags set');
    let pos = start + 10;
    if (flags & 0x04) {
        if (pos + 2 > data.length) throw eofError();
        pos += 2 + (data[pos] | (data[pos + 1] << 8));
    }
    if (flags & 0x08) pos = skipZeroTerminated(data, pos);
    if (flags & 0x10) pos = skipZeroTerminated(data, pos);
    if (flags & 0x02) pos += 2;
    if (pos > data.length) throw eofError();
    return pos;
}

/**
 * One gzip member. fflate ignores bytes after the final block, so the output is the member's alone; the
 * trailer is the first position, at or after the shortest possible deflate stream, whose CRC-32 and size
 * match. That first match is the true trailer even when the next member repeats this one's checksum.
 * When nothing matches, the exact deflate end is found by bisection, which gives zlib's error.
 */
function gunzipMember(data: Bytes, payload: number): { out: Bytes; end: number } {
    const out = inflateRaw(data.subarray(payload));
    const crc = crc32Of(out);
    const size = out.length % 0x100000000;
    for (let at = payload + 2; at + 8 <= data.length; at++) {
        if (u32le(data, at) === crc && u32le(data, at + 4) === size) return { out, end: at + 8 };
    }
    const trailer = payload + deflateStreamLength(data.subarray(payload));
    if (trailer + 8 > data.length) throw eofError();
    if (u32le(data, trailer) !== crc) throw dataError('incorrect data check');
    throw dataError('incorrect length check');
}

/** gunzip: concatenated members are read in order; a zero byte after a member ends the stream, as in zlib. */
function gunzipAll(data: Bytes): Bytes {
    const parts: Bytes[] = [];
    let start = 0;
    for (;;) {
        const member = gunzipMember(data, gzipPayloadStart(data, start));
        parts.push(member.out);
        start = member.end;
        if (start >= data.length || data[start] === 0) break;
    }
    return parts.length === 1 ? parts[0] : concatBytes(parts);
}

/** inflate: zlib framing, Adler-32 trailer, optional preset dictionary. */
function zlibInflate(data: Bytes, dictionary?: Bytes): Bytes {
    if (data.length < 2) throw eofError();
    const cmf = data[0];
    const flg = data[1];
    if (((cmf << 8) | flg) % 31 !== 0) throw dataError('incorrect header check');
    if ((cmf & 0x0f) !== 8) throw dataError('unknown compression method');
    if (cmf >>> 4 > 7) throw dataError('invalid window size');
    let payload = 2;
    if (flg & 0x20) {
        if (data.length < 6) throw eofError();
        if (dictionary === undefined) throw zlibError('Z_NEED_DICT', Z_NEED_DICT, 'Missing dictionary');
        if (adler32Of(dictionary) !== u32be(data, 2)) throw zlibError('Z_NEED_DICT', Z_NEED_DICT, 'Bad dictionary');
        payload = 6;
    }
    const out = inflateRaw(data.subarray(payload), dictionary);
    const sum = adler32Of(out);
    for (let at = payload + 2; at + 4 <= data.length; at++) {
        if (u32be(data, at) === sum) return out;
    }
    const trailer = payload + deflateStreamLength(data.subarray(payload), dictionary);
    if (trailer + 4 > data.length) throw eofError();
    throw dataError('incorrect data check');
}

/** unzip: gzip when the first two bytes are the gzip magic, zlib otherwise (as zlib's auto-detect). */
function unzipAll(data: Bytes, dictionary?: Bytes): Bytes {
    return data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b ? gunzipAll(data) : zlibInflate(data, dictionary);
}

function inflateBytes(format: string, data: Bytes, dictionary?: Bytes): Bytes {
    switch (format) {
        case 'gzip':
            return gunzipAll(data);
        case 'deflate':
            return zlibInflate(data, dictionary);
        case 'deflate-raw':
            return inflateRaw(data, dictionary);
        case 'unzip':
            return unzipAll(data, dictionary);
        default:
            throw new Error(`unknown zlib format: ${format}`);
    }
}

/** Level -1 is zlib's default, which is 6; fflate takes 0-9. */
function deflateBytes(format: string, data: Bytes, level: number, dictionary?: Bytes): Bytes {
    const lvl = (level < 0 ? 6 : Math.min(9, Math.trunc(level))) as FlateLevel;
    const options = dictionary ? { level: lvl, dictionary } : { level: lvl };
    switch (format) {
        case 'gzip':
            return gzipSync(data, { level: lvl, mtime: 0 });
        case 'deflate':
            return zlibSync(data, options);
        case 'deflate-raw':
            return deflateSync(data, options);
        default:
            throw new Error(`unknown zlib format: ${format}`);
    }
}

function base64ToBytes(text: string): Bytes {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}

function bytesToBase64(bytes: Bytes): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
}

const argBytes = (value: unknown): Bytes => base64ToBytes(typeof value === 'string' ? value : '');
const argDictionary = (value: unknown): Bytes | undefined => (typeof value === 'string' ? base64ToBytes(value) : undefined);

/** Zlib host operations: compress and decompress whole buffers. The guest buffers stream input and calls these once. */
export const ZLIB_CAPABILITIES: Record<string, CapabilityHandler> = {
    'zlib.compress': (args) =>
        bytesToBase64(
            deflateBytes(
                String(args.format),
                argBytes(args.data),
                typeof args.level === 'number' ? args.level : -1,
                argDictionary(args.dictionary)
            )
        ),
    'zlib.decompress': (args) =>
        bytesToBase64(inflateBytes(String(args.format), argBytes(args.data), argDictionary(args.dictionary)))
};
