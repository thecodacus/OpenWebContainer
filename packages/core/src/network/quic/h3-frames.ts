import { copyBytes } from './bytes';
import { H3ErrorCode, H3_RESERVED_SETTINGS } from './http3-constants';
import { decodeVarint, varintLength, writeVarint } from './varint';

/*
 * HTTP/3 frame layer (RFC 9114 Section 7): frame headers, the SETTINGS, GOAWAY, MAX_PUSH_ID and
 * CANCEL_PUSH payloads, and an incremental reader that splits one stream's bytes into frames as they
 * arrive, buffering a frame whole or passing its payload through in pieces, as the caller chooses per
 * frame.
 */

/** An HTTP/3 error: code is an RFC 9114 Section 8.1 or RFC 9204 Section 6 error code. */
export class H3Error extends Error {
    readonly code: number;

    constructor(code: number, message: string) {
        super(message);
        this.name = 'H3Error';
        this.code = code;
    }
}

/** Type and Length of a frame header (RFC 9114 Section 7.1). */
export function encodeFrameHeader(type: number | bigint, length: number): Uint8Array {
    const out = new Uint8Array(varintLength(type) + varintLength(length));
    const n = writeVarint(out, 0, type);
    writeVarint(out, n, length);
    return out;
}

export function encodeFrame(type: number | bigint, payload: Uint8Array): Uint8Array {
    const header = encodeFrameHeader(type, payload.length);
    const out = new Uint8Array(header.length + payload.length);
    out.set(header);
    out.set(payload, header.length);
    return out;
}

/** Concatenated varints. */
export function encodeVarints(values: readonly (number | bigint)[]): Uint8Array {
    let length = 0;
    for (const value of values) length += varintLength(value);
    const out = new Uint8Array(length);
    let offset = 0;
    for (const value of values) offset += writeVarint(out, offset, value);
    return out;
}

/** SETTINGS payload (RFC 9114 Section 7.2.4): identifier and value varints, in the given order. */
export function encodeSettingsPayload(settings: ReadonlyArray<readonly [number | bigint, number | bigint]>): Uint8Array {
    const values: (number | bigint)[] = [];
    for (const [id, value] of settings) values.push(id, value);
    return encodeVarints(values);
}

/**
 * Parses a SETTINGS payload. A payload that ends inside a parameter is H3_FRAME_ERROR (Section 7.1);
 * an identifier reserved from HTTP/2 or a repeated identifier is H3_SETTINGS_ERROR (Sections 7.2.4
 * and 7.2.4.1). Identifiers this endpoint does not understand are returned too; the caller ignores them.
 */
export function decodeSettingsPayload(payload: Uint8Array): Array<[bigint, bigint]> {
    const out: Array<[bigint, bigint]> = [];
    const seen = new Set<string>();
    let pos = 0;
    while (pos < payload.length) {
        let id: bigint;
        let value: bigint;
        try {
            const a = decodeVarint(payload, pos);
            pos += a.length;
            const b = decodeVarint(payload, pos);
            pos += b.length;
            id = a.value;
            value = b.value;
        } catch {
            throw new H3Error(H3ErrorCode.H3_FRAME_ERROR, 'SETTINGS frame ends inside a parameter');
        }
        if (id <= 0xffn && H3_RESERVED_SETTINGS.includes(Number(id))) throw new H3Error(H3ErrorCode.H3_SETTINGS_ERROR, `SETTINGS carries the HTTP/2 identifier 0x${id.toString(16)}, reserved in HTTP/3`);
        const key = id.toString();
        if (seen.has(key)) throw new H3Error(H3ErrorCode.H3_SETTINGS_ERROR, `SETTINGS carries identifier 0x${id.toString(16)} twice`);
        seen.add(key);
        out.push([id, value]);
    }
    return out;
}

/** A payload of exactly one varint (GOAWAY, MAX_PUSH_ID, CANCEL_PUSH); anything else is H3_FRAME_ERROR. */
export function decodeSingleVarintPayload(payload: Uint8Array, frameName: string): bigint {
    if (payload.length === 0) throw new H3Error(H3ErrorCode.H3_FRAME_ERROR, `${frameName} frame without its identifier`);
    let decoded: { value: bigint; length: number };
    try {
        decoded = decodeVarint(payload, 0);
    } catch {
        throw new H3Error(H3ErrorCode.H3_FRAME_ERROR, `${frameName} frame ends inside its identifier`);
    }
    if (decoded.length !== payload.length) throw new H3Error(H3ErrorCode.H3_FRAME_ERROR, `${frameName} frame has ${payload.length - decoded.length} bytes after its identifier`);
    return decoded.value;
}

export type FrameMode = 'buffer' | 'stream' | 'skip';

/** Receives the frames of one stream from a FrameReader. Any method may throw H3Error to stop. */
export interface FrameSink {
    /** A frame header was read; the return value says how to treat the payload. */
    frameStart(type: number, length: number): FrameMode;
    /** 'buffer' mode: the whole payload. */
    frame(type: number, payload: Uint8Array): void;
    /** 'stream' mode: one non-empty piece of the payload, in order. */
    data(type: number, chunk: Uint8Array): void;
    /** 'stream' mode: the payload is complete. */
    frameEnd(type: number): void;
}

/** Largest frame Length this reader handles; a larger one is beyond what a JavaScript number counts exactly. */
const MAX_FRAME_LENGTH = Number.MAX_SAFE_INTEGER;

/**
 * Splits one stream's bytes into HTTP/3 frames incrementally. Frame types are numbers: types of
 * 2^53 and above lose precision, which cannot turn them into any type this endpoint knows.
 */
export class FrameReader {
    private readonly sink: FrameSink;
    private readonly header = new Uint8Array(16);
    private headerLength = 0;
    private type = -1;
    private remaining = 0;
    private mode: FrameMode = 'skip';
    private parts: Uint8Array[] = [];
    private inFrame = false;
    /** Frames completed so far. */
    frames = 0;

    constructor(sink: FrameSink) {
        this.sink = sink;
    }

    /** Whether the bytes so far end inside a frame (a truncated frame if the stream ends here). */
    get midFrame(): boolean {
        return this.headerLength > 0 || this.inFrame;
    }

    push(chunk: Uint8Array): void {
        let pos = 0;
        while (pos < chunk.length) {
            if (!this.inFrame) {
                pos = this.readHeader(chunk, pos);
                continue;
            }
            const take = Math.min(this.remaining, chunk.length - pos);
            if (take > 0) {
                const piece = chunk.subarray(pos, pos + take);
                if (this.mode === 'buffer') this.parts.push(piece);
                else if (this.mode === 'stream') this.sink.data(this.type, piece);
                this.remaining -= take;
                pos += take;
            }
            if (this.remaining === 0) this.finishFrame();
        }
    }

    /** The stream ended cleanly; a truncated frame is H3_FRAME_ERROR (RFC 9114 Section 7.1). */
    end(): void {
        if (this.midFrame) throw new H3Error(H3ErrorCode.H3_FRAME_ERROR, 'the stream ended inside a frame');
    }

    private readHeader(chunk: Uint8Array, pos: number): number {
        while (pos < chunk.length) {
            this.header[this.headerLength++] = chunk[pos++];
            const typeLength = 1 << (this.header[0] >> 6);
            if (this.headerLength < typeLength + 1) continue;
            const lengthLength = 1 << (this.header[typeLength] >> 6);
            if (this.headerLength < typeLength + lengthLength) continue;
            const type = decodeVarint(this.header, 0).value;
            const length = decodeVarint(this.header, typeLength).value;
            this.headerLength = 0;
            if (length > BigInt(MAX_FRAME_LENGTH)) throw new H3Error(H3ErrorCode.H3_EXCESSIVE_LOAD, `frame Length ${length} is beyond what this endpoint handles`);
            this.type = Number(type);
            this.remaining = Number(length);
            this.inFrame = true;
            this.parts = [];
            this.mode = this.sink.frameStart(this.type, this.remaining);
            if (this.remaining === 0) this.finishFrame();
            return pos;
        }
        return pos;
    }

    private finishFrame(): void {
        this.inFrame = false;
        this.frames++;
        if (this.mode === 'buffer') {
            const parts = this.parts;
            this.parts = [];
            let payload: Uint8Array;
            if (parts.length === 1) {
                payload = copyBytes(parts[0]);
            } else {
                let total = 0;
                for (const part of parts) total += part.length;
                payload = new Uint8Array(total);
                let offset = 0;
                for (const part of parts) {
                    payload.set(part, offset);
                    offset += part.length;
                }
            }
            this.sink.frame(this.type, payload);
        } else if (this.mode === 'stream') {
            this.sink.frameEnd(this.type);
        }
    }
}
