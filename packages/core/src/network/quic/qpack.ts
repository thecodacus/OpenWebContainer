import { QpackErrorCode } from './http3-constants';
import { HuffmanError, huffmanDecode, huffmanEncode, huffmanEncodedLength } from './huffman';
import { QPACK_STATIC_TABLE } from './qpack-static-table';

/*
 * QPACK (RFC 9204) for an endpoint whose decoder advertises SETTINGS_QPACK_MAX_TABLE_CAPACITY 0 and
 * SETTINGS_QPACK_BLOCKED_STREAMS 0, and whose encoder never uses the dynamic table.
 *
 * Encoder: every field section has Required Insert Count 0 and Base 0; a field line is an indexed
 * static entry when the static table holds the name and value, a literal with a static name reference
 * when it holds the name, and a literal with a literal name otherwise. Strings are Huffman-coded when
 * that is strictly shorter (huffman: 'auto'), or always or never.
 *
 * Decoder: every representation a peer may legally send to such an endpoint (static references and
 * literals, Huffman-coded or not, with or without the N bit). A reference to the dynamic table cannot
 * be valid when the table capacity is 0: a non-zero Encoded Required Insert Count exceeds FullRange 0
 * (Section 4.5.1.1), and with Required Insert Count 0 every dynamic or post-Base reference is at or
 * beyond it (Section 2.2.3); both are connection errors of type QPACK_DECOMPRESSION_FAILED.
 *
 * Encoder and decoder streams: the peer's encoder may only send Set Dynamic Table Capacity with a
 * capacity of 0; any insertion or duplication cannot fit a table of capacity 0 (Section 3.2.2) and is
 * a QPACK_ENCODER_STREAM_ERROR. The peer's decoder may send Stream Cancellation; a Section
 * Acknowledgment or an Insert Count Increment cannot refer to anything this encoder sent (Sections
 * 4.4.1, 4.4.3) and is a QPACK_DECODER_STREAM_ERROR.
 *
 * Field names and values are byte strings carried as latin1 JavaScript strings (one character per
 * byte), as the guest http2 module does.
 */

/** A field line: name and value as latin1 strings. */
export type FieldLine = readonly [name: string, value: string];

export type HuffmanMode = 'auto' | 'always' | 'never';

/**
 * A QPACK failure. code is the HTTP/3 error code (QPACK_DECOMPRESSION_FAILED,
 * QPACK_ENCODER_STREAM_ERROR or QPACK_DECODER_STREAM_ERROR); streamError marks a value beyond this
 * decoder's limits on a request stream, which RFC 9204 Section 7.4 makes a stream error.
 */
export class QpackError extends Error {
    readonly code: number;
    readonly streamError: boolean;

    constructor(code: number, message: string, streamError = false) {
        super(message);
        this.name = 'QpackError';
        this.code = code;
        this.streamError = streamError;
    }
}

/** Largest integer accepted on the wire: RFC 9204 Section 4.1.1 requires decoding up to 62 bits. */
const INTEGER_LIMIT = 2 ** 62;

let exactIndex: Map<string, number> | null = null;
let nameIndex: Map<string, number> | null = null;

function staticIndexes(): { exact: Map<string, number>; name: Map<string, number> } {
    if (exactIndex === null || nameIndex === null) {
        exactIndex = new Map();
        nameIndex = new Map();
        for (let i = 0; i < QPACK_STATIC_TABLE.length; i++) {
            const [name, value] = QPACK_STATIC_TABLE[i];
            const key = name + '\u0000' + value;
            if (!exactIndex.has(key)) exactIndex.set(key, i);
            if (!nameIndex.has(name)) nameIndex.set(name, i);
        }
    }
    return { exact: exactIndex, name: nameIndex };
}

/** The bytes of a latin1 string; a character above U+00FF cannot be a field byte. */
export function latin1Bytes(text: string): Uint8Array {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code > 0xff) throw Object.assign(new TypeError(`field contains the character U+${code.toString(16).padStart(4, '0')}, which is not a byte`), { code: 'ERR_INVALID_CHAR' });
        out[i] = code;
    }
    return out;
}

export function latin1String(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i += 4096) out += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 4096)));
    return out;
}

// ------------------------------------------------------------------ primitives (RFC 9204 Section 4.1)

/** Appends an integer with an N-bit prefix (RFC 7541 Section 5.1); flags fill the bits above the prefix. */
function writeInteger(out: number[], value: number, prefixBits: number, flags: number): void {
    const max = 2 ** prefixBits - 1;
    if (value < max) {
        out.push(flags | value);
        return;
    }
    out.push(flags | max);
    let rest = value - max;
    while (rest >= 128) {
        out.push((rest % 128) + 128);
        rest = Math.floor(rest / 128);
    }
    out.push(rest);
}

function writeString(out: number[], bytes: Uint8Array, prefixBits: number, flags: number, huffman: HuffmanMode): void {
    const coded = huffman === 'always' || (huffman === 'auto' && huffmanEncodedLength(bytes) < bytes.length);
    const body = coded ? huffmanEncode(bytes) : bytes;
    // The H bit sits just above the (N-1)-bit length prefix.
    writeInteger(out, body.length, prefixBits - 1, flags | (coded ? 2 ** (prefixBits - 1) : 0));
    for (let i = 0; i < body.length; i++) out.push(body[i]);
}

interface Cursor {
    readonly bytes: Uint8Array;
    pos: number;
}

/** Continuation bytes accepted after the prefix: 9 carry 63 bits, enough for any 62-bit value. */
const MAX_CONTINUATION_BYTES = 9;

/**
 * Reads an integer with an N-bit prefix. Returns null when the input ends inside it (the caller
 * decides whether that is truncation or a partial instruction). A value of 2^62 or more, or an
 * encoding longer than MAX_CONTINUATION_BYTES, is beyond what this decoder accepts.
 */
function readInteger(cursor: Cursor, prefixBits: number, limitError: () => QpackError): number | null {
    const { bytes } = cursor;
    let pos = cursor.pos;
    if (pos >= bytes.length) return null;
    const max = 2 ** prefixBits - 1;
    let value = bytes[pos++] & max;
    if (value === max) {
        let scale = 1;
        for (let count = 1; ; count++) {
            if (pos >= bytes.length) return null;
            if (count > MAX_CONTINUATION_BYTES) throw limitError();
            const b = bytes[pos++];
            value += (b & 0x7f) * scale;
            scale *= 128;
            if (value >= INTEGER_LIMIT) throw limitError();
            if ((b & 0x80) === 0) break;
        }
    }
    cursor.pos = pos;
    return value;
}

function decompressionFailed(message: string): QpackError {
    return new QpackError(QpackErrorCode.QPACK_DECOMPRESSION_FAILED, message);
}

function readFieldInteger(cursor: Cursor, prefixBits: number, what: string): number {
    const value = readInteger(cursor, prefixBits, () => new QpackError(QpackErrorCode.QPACK_DECOMPRESSION_FAILED, `${what} is beyond the 62-bit integer limit`, true));
    if (value === null) throw decompressionFailed(`field section truncated inside ${what}`);
    return value;
}

function readFieldString(cursor: Cursor, prefixBits: number, what: string, maxLength: number): string {
    if (cursor.pos >= cursor.bytes.length) throw decompressionFailed(`field section truncated before ${what}`);
    const coded = (cursor.bytes[cursor.pos] & (2 ** (prefixBits - 1))) !== 0;
    const length = readFieldInteger(cursor, prefixBits - 1, `${what} length`);
    if (length > cursor.bytes.length - cursor.pos) throw decompressionFailed(`${what} runs past the end of the field section`);
    if (length > maxLength) throw new QpackError(QpackErrorCode.QPACK_DECOMPRESSION_FAILED, `${what} longer than ${maxLength} bytes`, true);
    const raw = cursor.bytes.subarray(cursor.pos, cursor.pos + length);
    cursor.pos += length;
    if (!coded) return latin1String(raw);
    try {
        return latin1String(huffmanDecode(raw));
    } catch (error) {
        if (error instanceof HuffmanError) throw decompressionFailed(`${what}: ${error.message}`);
        throw error;
    }
}

function staticEntry(index: number, what: string): readonly [string, string] {
    const entry = QPACK_STATIC_TABLE[index];
    if (entry === undefined) throw decompressionFailed(`${what} refers to static table index ${index}; the table has ${QPACK_STATIC_TABLE.length} entries`);
    return entry;
}

// ------------------------------------------------------------------ field sections (RFC 9204 Section 4.5)

export interface EncodeOptions {
    readonly huffman?: HuffmanMode;
}

/** Encodes a field section with the static table and literals only (Required Insert Count 0, Base 0). */
export function encodeFieldSection(fields: readonly FieldLine[], options: EncodeOptions = {}): Uint8Array {
    const huffman = options.huffman ?? 'auto';
    const { exact, name: byName } = staticIndexes();
    // Encoded Required Insert Count 0, then Sign 0 and Delta Base 0.
    const out: number[] = [0x00, 0x00];
    for (const [name, value] of fields) {
        const full = exact.get(name + '\u0000' + value);
        if (full !== undefined) {
            // Indexed Field Line, T=1: '11' then a 6-bit prefix index.
            writeInteger(out, full, 6, 0xc0);
            continue;
        }
        const valueBytes = latin1Bytes(value);
        const named = byName.get(name);
        if (named !== undefined) {
            // Literal Field Line with Name Reference, N=0, T=1: '0101' then a 4-bit prefix index.
            writeInteger(out, named, 4, 0x50);
            writeString(out, valueBytes, 8, 0x00, huffman);
        } else {
            // Literal Field Line with Literal Name, N=0: '0010' then H and a 3-bit prefix length.
            writeString(out, latin1Bytes(name), 4, 0x20, huffman);
            writeString(out, valueBytes, 8, 0x00, huffman);
        }
    }
    return Uint8Array.from(out);
}

export interface DecodeOptions {
    /** Longest name or value accepted, in bytes (default 65536). */
    readonly maxStringLength?: number;
}

export interface DecodedFieldSection {
    readonly fields: FieldLine[];
    readonly encodedRequiredInsertCount: number;
    readonly base: number;
    /** One entry per field line: 'indexed', 'literal-name-ref' or 'literal-literal', with ':huffman' and ':never' marks. */
    readonly representations: string[];
}

/** Decodes a field section; see decodeFieldSectionDetailed. */
export function decodeFieldSection(bytes: Uint8Array, options: DecodeOptions = {}): FieldLine[] {
    return decodeFieldSectionDetailed(bytes, options).fields;
}

/** Decodes a field section for a decoder whose dynamic table capacity is 0. Throws QpackError. */
export function decodeFieldSectionDetailed(bytes: Uint8Array, options: DecodeOptions = {}): DecodedFieldSection {
    const maxStringLength = options.maxStringLength ?? 65536;
    const cursor: Cursor = { bytes, pos: 0 };
    const encodedRequiredInsertCount = readFieldInteger(cursor, 8, 'Required Insert Count');
    // MaxEntries = floor(0 / 32) = 0, so FullRange = 0 and only an encoded value of 0 is possible.
    if (encodedRequiredInsertCount !== 0) {
        throw decompressionFailed(`Encoded Required Insert Count ${encodedRequiredInsertCount} with a maximum dynamic table capacity of 0 (FullRange 0)`);
    }
    if (cursor.pos >= bytes.length) throw decompressionFailed('field section truncated before Delta Base');
    const sign = (bytes[cursor.pos] & 0x80) !== 0;
    const deltaBase = readFieldInteger(cursor, 7, 'Delta Base');
    // Section 4.5.1.2: a Sign bit of 1 is invalid when Required Insert Count <= Delta Base, always so here.
    if (sign) throw decompressionFailed(`Base sign bit 1 with Required Insert Count 0 and Delta Base ${deltaBase} (negative Base)`);
    const base = deltaBase;
    const fields: FieldLine[] = [];
    const representations: string[] = [];
    while (cursor.pos < bytes.length) {
        const first = bytes[cursor.pos];
        if ((first & 0x80) !== 0) {
            // Indexed Field Line: '1', T, 6-bit index.
            const isStatic = (first & 0x40) !== 0;
            const index = readFieldInteger(cursor, 6, 'field line index');
            if (!isStatic) throw decompressionFailed(`indexed field line refers to dynamic table relative index ${index}, at or beyond Required Insert Count 0`);
            const [name, value] = staticEntry(index, 'indexed field line');
            fields.push([name, value]);
            representations.push(`indexed:${index}`);
        } else if ((first & 0x40) !== 0) {
            // Literal Field Line with Name Reference: '01', N, T, 4-bit name index.
            const never = (first & 0x20) !== 0;
            const isStatic = (first & 0x10) !== 0;
            const index = readFieldInteger(cursor, 4, 'name index');
            if (!isStatic) throw decompressionFailed(`literal field line refers to dynamic table name relative index ${index}, at or beyond Required Insert Count 0`);
            const [name] = staticEntry(index, 'literal field line name reference');
            const huff = (bytes[cursor.pos] & 0x80) !== 0;
            const value = readFieldString(cursor, 8, 'field value', maxStringLength);
            fields.push([name, value]);
            representations.push(`literal-name-ref:${index}${huff ? ':huffman' : ''}${never ? ':never' : ''}`);
        } else if ((first & 0x20) !== 0) {
            // Literal Field Line with Literal Name: '001', N, H, 3-bit name length.
            const never = (first & 0x10) !== 0;
            const nameHuff = (first & 0x08) !== 0;
            const name = readFieldString(cursor, 4, 'field name', maxStringLength);
            const valueHuff = (bytes[cursor.pos] & 0x80) !== 0;
            const value = readFieldString(cursor, 8, 'field value', maxStringLength);
            fields.push([name, value]);
            representations.push(`literal-literal${nameHuff || valueHuff ? ':huffman' : ''}${never ? ':never' : ''}`);
        } else if ((first & 0x10) !== 0) {
            // Indexed Field Line with Post-Base Index: '0001', 4-bit index.
            const index = readFieldInteger(cursor, 4, 'post-Base index');
            throw decompressionFailed(`indexed field line with post-Base index ${index} (absolute index ${base + index}) refers to the dynamic table, at or beyond Required Insert Count 0`);
        } else {
            // Literal Field Line with Post-Base Name Reference: '0000', N, 3-bit index.
            const index = readFieldInteger(cursor, 3, 'post-Base name index');
            throw decompressionFailed(`literal field line with post-Base name index ${index} (absolute index ${base + index}) refers to the dynamic table, at or beyond Required Insert Count 0`);
        }
    }
    return { fields, encodedRequiredInsertCount, base, representations };
}

// ------------------------------------------------------------------ encoder and decoder streams (RFC 9204 Sections 4.2-4.4)

/** Bytes kept between calls while an instruction is incomplete. */
class InstructionBuffer {
    private pending: Uint8Array = new Uint8Array(0);

    append(chunk: Uint8Array): Uint8Array {
        if (this.pending.length === 0) return chunk;
        const joined = new Uint8Array(this.pending.length + chunk.length);
        joined.set(this.pending);
        joined.set(chunk, this.pending.length);
        return joined;
    }

    keep(bytes: Uint8Array, from: number): void {
        this.pending = bytes.slice(from);
    }

    get hasPartial(): boolean {
        return this.pending.length > 0;
    }
}

/**
 * The peer encoder's stream as seen by a decoder with maximum table capacity maxTableCapacity (0
 * here). Set Dynamic Table Capacity up to that maximum is accepted; any instruction that inserts
 * or duplicates an entry is a QPACK_ENCODER_STREAM_ERROR.
 */
export class QpackEncoderStreamReceiver {
    readonly maxTableCapacity: number;
    /** Capacities set by Set Dynamic Table Capacity instructions, in order. */
    readonly capacityUpdates: number[] = [];
    bytesReceived = 0;
    private readonly buffer = new InstructionBuffer();

    constructor(maxTableCapacity = 0) {
        this.maxTableCapacity = maxTableCapacity;
    }

    feed(chunk: Uint8Array): void {
        this.bytesReceived += chunk.length;
        const bytes = this.buffer.append(chunk);
        const cursor: Cursor = { bytes, pos: 0 };
        const fail = (message: string): QpackError => new QpackError(QpackErrorCode.QPACK_ENCODER_STREAM_ERROR, message);
        while (cursor.pos < bytes.length) {
            const first = bytes[cursor.pos];
            if ((first & 0x80) !== 0) throw fail(`Insert with Name Reference into a dynamic table whose capacity is ${this.currentCapacity} (maximum ${this.maxTableCapacity})`);
            if ((first & 0x40) !== 0) throw fail(`Insert with Literal Name into a dynamic table whose capacity is ${this.currentCapacity} (maximum ${this.maxTableCapacity})`);
            if ((first & 0x20) === 0) throw fail('Duplicate of an entry that does not exist (the dynamic table is empty)');
            const start = cursor.pos;
            const capacity = readInteger(cursor, 5, () => fail('Set Dynamic Table Capacity value is beyond the 62-bit integer limit'));
            if (capacity === null) {
                this.buffer.keep(bytes, start);
                return;
            }
            if (capacity > this.maxTableCapacity) throw fail(`Set Dynamic Table Capacity ${capacity} exceeds SETTINGS_QPACK_MAX_TABLE_CAPACITY ${this.maxTableCapacity}`);
            this.capacityUpdates.push(capacity);
        }
        this.buffer.keep(bytes, bytes.length);
    }

    get currentCapacity(): number {
        return this.capacityUpdates.length === 0 ? 0 : this.capacityUpdates[this.capacityUpdates.length - 1];
    }
}

/**
 * The peer decoder's stream as seen by an encoder that never references the dynamic table: Stream
 * Cancellation is accepted and recorded; Section Acknowledgment and Insert Count Increment are a
 * QPACK_DECODER_STREAM_ERROR.
 */
export class QpackDecoderStreamReceiver {
    /** Stream IDs from Stream Cancellation instructions. */
    readonly cancellations: number[] = [];
    bytesReceived = 0;
    private readonly buffer = new InstructionBuffer();

    feed(chunk: Uint8Array): void {
        this.bytesReceived += chunk.length;
        const bytes = this.buffer.append(chunk);
        const cursor: Cursor = { bytes, pos: 0 };
        const fail = (message: string): QpackError => new QpackError(QpackErrorCode.QPACK_DECODER_STREAM_ERROR, message);
        while (cursor.pos < bytes.length) {
            const first = bytes[cursor.pos];
            const start = cursor.pos;
            if ((first & 0x80) !== 0) {
                const id = readInteger(cursor, 7, () => fail('Section Acknowledgment stream ID is beyond the 62-bit integer limit'));
                throw fail(`Section Acknowledgment${id === null ? '' : ` for stream ${id}`}, but no field section with a non-zero Required Insert Count was sent`);
            }
            if ((first & 0x40) === 0) {
                const increment = readInteger(cursor, 6, () => fail('Insert Count Increment is beyond the 62-bit integer limit'));
                throw fail(`Insert Count Increment${increment === null ? '' : ` of ${increment}`}, but this encoder inserted no entries`);
            }
            const id = readInteger(cursor, 6, () => fail('Stream Cancellation stream ID is beyond the 62-bit integer limit'));
            if (id === null) {
                this.buffer.keep(bytes, start);
                return;
            }
            this.cancellations.push(id);
        }
        this.buffer.keep(bytes, bytes.length);
    }
}
