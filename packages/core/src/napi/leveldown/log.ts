/**
 * The on-disk format of a database: one write-ahead log per location, always byte-identical to what
 * compacting the live map would produce, so opening a database is a straight replay.
 *
 *   file     := MAGIC record*
 *   MAGIC    := "OWCLDB01"                      8 bytes, ASCII
 *   record   := type klen vlen key value crc    9 + klen + vlen + 4 bytes
 *   type     := 0x01 put | 0x02 del              1 byte
 *   klen     := key length, uint32 big-endian    4 bytes
 *   vlen     := value length, uint32 big-endian  4 bytes (0 for a del)
 *   key      := klen bytes
 *   value    := vlen bytes
 *   crc      := CRC-32 (IEEE 802.3, zlib polynomial 0xEDB88320, reflected) of every preceding byte
 *               of the record -- type, klen, vlen, key, value -- uint32 big-endian, 4 bytes
 *
 * Keys and values are raw bytes; neither is escaped, so a key may contain any byte sequence the
 * magic cannot be confused with (the magic is only ever read at offset 0).
 *
 * Compaction rewrites the file as MAGIC followed by one put record per live entry in ascending key
 * order, through a temporary file and rename(), so a crash during compaction leaves the previous
 * file intact. The record format is the same, which is why replay needs no mode: the log is a
 * compacted image plus whatever has been appended since.
 *
 * A torn tail is what the CRC is for. Replay stops at the first record that is short or whose CRC
 * does not verify, and the bytes from there to the end of the file are dropped; the length is then
 * corrected, so the next append starts where the good records ended. A record is durable only once
 * its last byte and its CRC are on disk, so a torn record describes a write that never happened.
 */
import type { ByteString } from './bytes';

export const MAGIC = 'OWCLDB01';
export const MAGIC_LENGTH = 8;
/** type + klen + vlen + crc */
export const RECORD_OVERHEAD = 13;

export const RECORD_PUT = 1;
export const RECORD_DEL = 2;
/** A whole batch or clear in one record, so a torn write cannot apply half of it. */
export const RECORD_MULTI = 3;

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[i] = c >>> 0;
    }
    return table;
})();

/** CRC-32 as zlib computes it: init 0xFFFFFFFF, reflected, final XOR 0xFFFFFFFF. */
export function crc32(bytes: Uint8Array, from: number, to: number): number {
    let c = 0xffffffff;
    for (let i = from; i < to; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

/** One record, ready to append. */
export function encodeRecord(type: number, key: ByteString, value: ByteString): Uint8Array {
    const klen = key.length;
    const vlen = value.length;
    const out = new Uint8Array(9 + klen + vlen + 4);
    out[0] = type;
    out[1] = (klen >>> 24) & 0xff;
    out[2] = (klen >>> 16) & 0xff;
    out[3] = (klen >>> 8) & 0xff;
    out[4] = klen & 0xff;
    out[5] = (vlen >>> 24) & 0xff;
    out[6] = (vlen >>> 16) & 0xff;
    out[7] = (vlen >>> 8) & 0xff;
    out[8] = vlen & 0xff;
    for (let i = 0; i < klen; i++) out[9 + i] = key.charCodeAt(i);
    for (let i = 0; i < vlen; i++) out[9 + klen + i] = value.charCodeAt(i);
    const crc = crc32(out, 0, 9 + klen + vlen);
    const at = 9 + klen + vlen;
    out[at] = (crc >>> 24) & 0xff;
    out[at + 1] = (crc >>> 16) & 0xff;
    out[at + 2] = (crc >>> 8) & 0xff;
    out[at + 3] = crc & 0xff;
    return out;
}

export interface LogEntry {
    type: number;
    key: ByteString;
    value: ByteString;
}

export interface ParsedLog {
    /** Every record that parsed, in file order. */
    entries: LogEntry[];
    /** True when bytes after the last good record were dropped. */
    torn: boolean;
    /** File length after dropping a torn tail; the offset the next append starts at. */
    length: number;
    /** True when the file did not begin with the magic, or was shorter than it. */
    badMagic: boolean;
}

function byteString(bytes: Uint8Array, from: number, to: number): ByteString {
    let out = '';
    for (let i = from; i < to; i++) out += String.fromCharCode(bytes[i]);
    return out;
}

/**
 * Replays a log file. Stops at the first record that is incomplete or whose CRC fails, and reports
 * the length of the file as it then stands; everything past that point is not part of the database.
 */
export function parseLog(bytes: Uint8Array): ParsedLog {
    const entries: LogEntry[] = [];
    if (bytes.length < MAGIC_LENGTH) return { entries, torn: bytes.length > 0, length: 0, badMagic: true };
    for (let i = 0; i < MAGIC_LENGTH; i++) {
        if (bytes[i] !== MAGIC.charCodeAt(i)) return { entries, torn: true, length: 0, badMagic: true };
    }
    let at = MAGIC_LENGTH;
    while (at < bytes.length) {
        const remaining = bytes.length - at;
        if (remaining < RECORD_OVERHEAD) break;
        const type = bytes[at];
        const klen = ((bytes[at + 1] << 24) | (bytes[at + 2] << 16) | (bytes[at + 3] << 8) | bytes[at + 4]) >>> 0;
        const vlen = ((bytes[at + 5] << 24) | (bytes[at + 6] << 16) | (bytes[at + 7] << 8) | bytes[at + 8]) >>> 0;
        const size = 9 + klen + vlen + 4;
        if (type !== RECORD_PUT && type !== RECORD_DEL && type !== RECORD_MULTI) break;
        if (remaining < size) break;
        const crcAt = at + 9 + klen + vlen;
        const want = ((bytes[crcAt] << 24) | (bytes[crcAt + 1] << 16) | (bytes[crcAt + 2] << 8) | bytes[crcAt + 3]) >>> 0;
        if (crc32(bytes, at, crcAt) !== want) break;
        entries.push({ type, key: byteString(bytes, at + 9, at + 9 + klen), value: byteString(bytes, at + 9 + klen, crcAt) });
        at += size;
    }
    return { entries, torn: at < bytes.length, length: at, badMagic: false };
}
