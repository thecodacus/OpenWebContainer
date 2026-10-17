import { copyBytes } from './bytes';
import { QuicError, TransportError } from './errors';

/*
 * Variable-length integers (RFC 9000 Section 16): the two high bits of the first byte give the
 * encoded length (1, 2, 4 or 8 bytes) and the remaining 6, 14, 30 or 62 bits hold the value in
 * network byte order. Values reach 2^62 - 1, beyond Number.MAX_SAFE_INTEGER, so decoded values are
 * bigint. Encoders take bigint or a safe-integer number and write the shortest encoding unless a
 * length is given. Decoders accept any encoding length; only frame types must be minimal
 * (RFC 9000 Section 12.4), which frames.ts checks.
 */

/** Largest value a variable-length integer holds: 2^62 - 1. */
export const VARINT_MAX = 0x3fffffffffffffffn;

export type VarintLength = 1 | 2 | 4 | 8;

const PREFIX: Readonly<Record<VarintLength, number>> = { 1: 0x00, 2: 0x40, 4: 0x80, 8: 0xc0 };

function toVarintValue(value: bigint | number): bigint {
    let v: bigint;
    if (typeof value === 'bigint') {
        v = value;
    } else {
        if (!Number.isSafeInteger(value)) throw new RangeError(`varint value is not a safe integer: ${value}`);
        v = BigInt(value);
    }
    if (v < 0n || v > VARINT_MAX) throw new RangeError(`varint value out of range 0..2^62-1: ${v}`);
    return v;
}

/** Length in bytes of the shortest encoding of value. */
export function varintLength(value: bigint | number): VarintLength {
    const v = toVarintValue(value);
    if (v < 0x40n) return 1;
    if (v < 0x4000n) return 2;
    if (v < 0x40000000n) return 4;
    return 8;
}

/** Writes value at out[offset] in length bytes (default: shortest) and returns the length written. */
export function writeVarint(out: Uint8Array, offset: number, value: bigint | number, length?: VarintLength): VarintLength {
    const v = toVarintValue(value);
    const len = length ?? varintLength(v);
    if (PREFIX[len] === undefined) throw new RangeError(`invalid varint length ${String(len)}`);
    if (v >= 1n << BigInt(len * 8 - 2)) throw new RangeError(`varint value ${v} does not fit in ${len} bytes`);
    if (!Number.isInteger(offset) || offset < 0 || offset + len > out.length) {
        throw new RangeError('varint does not fit in the output buffer');
    }
    if (len <= 4) {
        let n = Number(v);
        for (let i = len - 1; i >= 0; i--) {
            out[offset + i] = n & 0xff;
            n = Math.floor(n / 256);
        }
    } else {
        let rest = v;
        for (let i = len - 1; i >= 0; i--) {
            out[offset + i] = Number(rest & 0xffn);
            rest >>= 8n;
        }
    }
    out[offset] |= PREFIX[len];
    return len;
}

export function encodeVarint(value: bigint | number, length?: VarintLength): Uint8Array {
    const len = length ?? varintLength(value);
    const out = new Uint8Array(len);
    writeVarint(out, 0, value, len);
    return out;
}

/** Decodes the varint at bytes[offset]; throws RangeError when the input ends inside it. */
export function decodeVarint(bytes: Uint8Array, offset = 0): { value: bigint; length: VarintLength } {
    if (!Number.isInteger(offset) || offset < 0 || offset >= bytes.length) throw new RangeError('varint truncated');
    const first = bytes[offset];
    const length = (1 << (first >> 6)) as VarintLength;
    if (offset + length > bytes.length) throw new RangeError('varint truncated');
    if (length <= 4) {
        let n = first & 0x3f;
        for (let i = 1; i < length; i++) n = n * 256 + bytes[offset + i];
        return { value: BigInt(n), length };
    }
    let v = BigInt(first & 0x3f);
    for (let i = 1; i < 8; i++) v = (v << 8n) | BigInt(bytes[offset + i]);
    return { value: v, length };
}

/**
 * Cursor over a byte range. Running out of input throws a QuicError carrying errorCode, which is the
 * connection error the caller's context assigns to truncation (FRAME_ENCODING_ERROR for frames,
 * TRANSPORT_PARAMETER_ERROR for transport parameters).
 */
export class QuicReader {
    readonly bytes: Uint8Array;
    readonly end: number;
    private pos: number;
    private readonly errorCode: number;

    constructor(bytes: Uint8Array, start = 0, end = bytes.length, errorCode: number = TransportError.FRAME_ENCODING_ERROR) {
        if (start < 0 || end > bytes.length || start > end) throw new RangeError('reader range outside the input');
        this.bytes = bytes;
        this.pos = start;
        this.end = end;
        this.errorCode = errorCode;
    }

    get offset(): number {
        return this.pos;
    }

    get remaining(): number {
        return this.end - this.pos;
    }

    eof(): boolean {
        return this.pos >= this.end;
    }

    private need(count: number): void {
        if (count > this.end - this.pos) {
            throw new QuicError(this.errorCode, `input truncated: ${count} bytes needed, ${this.end - this.pos} left`);
        }
    }

    peekUint8(): number {
        this.need(1);
        return this.bytes[this.pos];
    }

    uint8(): number {
        this.need(1);
        return this.bytes[this.pos++];
    }

    uint16(): number {
        this.need(2);
        const v = (this.bytes[this.pos] << 8) | this.bytes[this.pos + 1];
        this.pos += 2;
        return v;
    }

    uint32(): number {
        this.need(4);
        const b = this.bytes;
        const p = this.pos;
        this.pos += 4;
        return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
    }

    /** A varint with the length its encoding used. */
    varintWithLength(): { value: bigint; length: VarintLength } {
        this.need(1);
        const length = (1 << (this.bytes[this.pos] >> 6)) as VarintLength;
        this.need(length);
        const decoded = decodeVarint(this.bytes, this.pos);
        this.pos += length;
        return decoded;
    }

    varint(): bigint {
        return this.varintWithLength().value;
    }

    /** A varint that counts bytes or another small quantity; values above 2^53 - 1 are a decode error. */
    varintNumber(): number {
        const value = this.varint();
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new QuicError(this.errorCode, `length field too large: ${value}`);
        }
        return Number(value);
    }

    /** A copy of the next count bytes (a fresh Uint8Array even when the input is a Node Buffer). */
    take(count: number): Uint8Array {
        if (!Number.isSafeInteger(count) || count < 0) throw new QuicError(this.errorCode, `invalid length ${count}`);
        this.need(count);
        const out = copyBytes(this.bytes, this.pos, this.pos + count);
        this.pos += count;
        return out;
    }

    skip(count: number): void {
        this.need(count);
        this.pos += count;
    }
}

/** Growable output buffer. */
export class QuicWriter {
    private buf: Uint8Array;
    private pos = 0;

    constructor(initialCapacity = 64) {
        this.buf = new Uint8Array(Math.max(16, initialCapacity));
    }

    get length(): number {
        return this.pos;
    }

    private ensure(count: number): void {
        if (this.pos + count <= this.buf.length) return;
        let capacity = this.buf.length * 2;
        while (capacity < this.pos + count) capacity *= 2;
        const next = new Uint8Array(capacity);
        next.set(this.buf.subarray(0, this.pos));
        this.buf = next;
    }

    uint8(value: number): this {
        if (!Number.isInteger(value) || value < 0 || value > 0xff) throw new RangeError(`uint8 out of range: ${value}`);
        this.ensure(1);
        this.buf[this.pos++] = value;
        return this;
    }

    uint16(value: number): this {
        if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new RangeError(`uint16 out of range: ${value}`);
        this.ensure(2);
        this.buf[this.pos++] = value >>> 8;
        this.buf[this.pos++] = value & 0xff;
        return this;
    }

    uint32(value: number): this {
        if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError(`uint32 out of range: ${value}`);
        this.ensure(4);
        this.buf[this.pos++] = value >>> 24;
        this.buf[this.pos++] = (value >>> 16) & 0xff;
        this.buf[this.pos++] = (value >>> 8) & 0xff;
        this.buf[this.pos++] = value & 0xff;
        return this;
    }

    varint(value: bigint | number, length?: VarintLength): this {
        const len = length ?? varintLength(value);
        this.ensure(len);
        writeVarint(this.buf, this.pos, value, len);
        this.pos += len;
        return this;
    }

    bytes(data: Uint8Array): this {
        this.ensure(data.length);
        this.buf.set(data, this.pos);
        this.pos += data.length;
        return this;
    }

    /** A copy of the bytes written so far. */
    finish(): Uint8Array {
        return this.buf.slice(0, this.pos);
    }
}
