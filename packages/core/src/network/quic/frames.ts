import { QuicError, TransportError } from './errors';
import { QuicReader, QuicWriter, VARINT_MAX, varintLength } from './varint';

/*
 * QUIC version 1 frames (RFC 9000 Section 19) and the frame type table (Section 12.4, Table 3).
 * Varint-valued fields are bigint. Decoding raises QuicError with the connection error the RFC
 * assigns: FRAME_ENCODING_ERROR for an unknown type, a truncated or malformed frame, or a value
 * outside its range; PROTOCOL_VIOLATION for an empty payload, a frame type that is not minimally
 * encoded, or a frame not permitted in the packet type. Re-encoding a decoded frame reproduces its
 * bytes when the sender used minimal varint encodings, because the STREAM OFF/LEN bits are kept.
 */

export const FrameType = {
    PADDING: 0x00,
    PING: 0x01,
    ACK: 0x02,
    ACK_ECN: 0x03,
    RESET_STREAM: 0x04,
    STOP_SENDING: 0x05,
    CRYPTO: 0x06,
    NEW_TOKEN: 0x07,
    STREAM: 0x08,
    MAX_DATA: 0x10,
    MAX_STREAM_DATA: 0x11,
    MAX_STREAMS_BIDI: 0x12,
    MAX_STREAMS_UNI: 0x13,
    DATA_BLOCKED: 0x14,
    STREAM_DATA_BLOCKED: 0x15,
    STREAMS_BLOCKED_BIDI: 0x16,
    STREAMS_BLOCKED_UNI: 0x17,
    NEW_CONNECTION_ID: 0x18,
    RETIRE_CONNECTION_ID: 0x19,
    PATH_CHALLENGE: 0x1a,
    PATH_RESPONSE: 0x1b,
    CONNECTION_CLOSE: 0x1c,
    CONNECTION_CLOSE_APPLICATION: 0x1d,
    HANDSHAKE_DONE: 0x1e,
} as const;

/** STREAM frame type bits (RFC 9000 Section 19.8). */
export const STREAM_OFF_BIT = 0x04;
export const STREAM_LEN_BIT = 0x02;
export const STREAM_FIN_BIT = 0x01;

export interface FrameTableEntry {
    readonly first: number;
    readonly last: number;
    readonly name: string;
    /** Table 3 "Pkts": I Initial, H Handshake, 0 0-RTT, 1 1-RTT, _ not permitted; "ih" = only type 0x1c in Initial and Handshake. */
    readonly pkts: string;
    /** Table 3 "Spec": N not ack-eliciting, C not counted in flight, P probing, F flow controlled. */
    readonly spec: string;
}

/** RFC 9000 Section 12.4, Table 3. */
export const FRAME_TABLE: readonly FrameTableEntry[] = [
    { first: 0x00, last: 0x00, name: 'PADDING', pkts: 'IH01', spec: 'NP' },
    { first: 0x01, last: 0x01, name: 'PING', pkts: 'IH01', spec: '' },
    { first: 0x02, last: 0x03, name: 'ACK', pkts: 'IH_1', spec: 'NC' },
    { first: 0x04, last: 0x04, name: 'RESET_STREAM', pkts: '__01', spec: '' },
    { first: 0x05, last: 0x05, name: 'STOP_SENDING', pkts: '__01', spec: '' },
    { first: 0x06, last: 0x06, name: 'CRYPTO', pkts: 'IH_1', spec: '' },
    { first: 0x07, last: 0x07, name: 'NEW_TOKEN', pkts: '___1', spec: '' },
    { first: 0x08, last: 0x0f, name: 'STREAM', pkts: '__01', spec: 'F' },
    { first: 0x10, last: 0x10, name: 'MAX_DATA', pkts: '__01', spec: '' },
    { first: 0x11, last: 0x11, name: 'MAX_STREAM_DATA', pkts: '__01', spec: '' },
    { first: 0x12, last: 0x13, name: 'MAX_STREAMS', pkts: '__01', spec: '' },
    { first: 0x14, last: 0x14, name: 'DATA_BLOCKED', pkts: '__01', spec: '' },
    { first: 0x15, last: 0x15, name: 'STREAM_DATA_BLOCKED', pkts: '__01', spec: '' },
    { first: 0x16, last: 0x17, name: 'STREAMS_BLOCKED', pkts: '__01', spec: '' },
    { first: 0x18, last: 0x18, name: 'NEW_CONNECTION_ID', pkts: '__01', spec: 'P' },
    { first: 0x19, last: 0x19, name: 'RETIRE_CONNECTION_ID', pkts: '__01', spec: '' },
    { first: 0x1a, last: 0x1a, name: 'PATH_CHALLENGE', pkts: '__01', spec: 'P' },
    { first: 0x1b, last: 0x1b, name: 'PATH_RESPONSE', pkts: '___1', spec: 'P' },
    { first: 0x1c, last: 0x1d, name: 'CONNECTION_CLOSE', pkts: 'ih01', spec: 'N' },
    { first: 0x1e, last: 0x1e, name: 'HANDSHAKE_DONE', pkts: '___1', spec: '' },
];

/** Packet types that carry frames. */
export type FramePacketType = 'initial' | 'handshake' | '0rtt' | '1rtt';

const PKTS_INDEX: Readonly<Record<FramePacketType, number>> = { initial: 0, handshake: 1, '0rtt': 2, '1rtt': 3 };

/** Largest Maximum Streams value (RFC 9000 Sections 19.11 and 19.14). */
export const MAX_STREAMS_LIMIT = 1n << 60n;

export interface AckRange {
    readonly smallest: bigint;
    readonly largest: bigint;
}

export interface EcnCounts {
    readonly ect0: bigint;
    readonly ect1: bigint;
    readonly ce: bigint;
}

export type QuicFrame =
    /** A run of PADDING frames (each a single 0x00 byte). */
    | { readonly type: 'PADDING'; readonly length: number }
    | { readonly type: 'PING' }
    /** ranges in descending order; ranges[0].largest is the Largest Acknowledged. ecn present means type 0x03. */
    | { readonly type: 'ACK'; readonly delay: bigint; readonly ranges: readonly AckRange[]; readonly ecn?: EcnCounts }
    | { readonly type: 'RESET_STREAM'; readonly streamId: bigint; readonly errorCode: bigint; readonly finalSize: bigint }
    | { readonly type: 'STOP_SENDING'; readonly streamId: bigint; readonly errorCode: bigint }
    | { readonly type: 'CRYPTO'; readonly offset: bigint; readonly data: Uint8Array }
    | { readonly type: 'NEW_TOKEN'; readonly token: Uint8Array }
    /** explicitOffset / explicitLength are the OFF and LEN bits; defaults: OFF when offset > 0, LEN set. */
    | {
          readonly type: 'STREAM';
          readonly streamId: bigint;
          readonly offset: bigint;
          readonly data: Uint8Array;
          readonly fin: boolean;
          readonly explicitOffset?: boolean;
          readonly explicitLength?: boolean;
      }
    | { readonly type: 'MAX_DATA'; readonly maximum: bigint }
    | { readonly type: 'MAX_STREAM_DATA'; readonly streamId: bigint; readonly maximum: bigint }
    | { readonly type: 'MAX_STREAMS'; readonly bidirectional: boolean; readonly maximum: bigint }
    | { readonly type: 'DATA_BLOCKED'; readonly limit: bigint }
    | { readonly type: 'STREAM_DATA_BLOCKED'; readonly streamId: bigint; readonly limit: bigint }
    | { readonly type: 'STREAMS_BLOCKED'; readonly bidirectional: boolean; readonly limit: bigint }
    | {
          readonly type: 'NEW_CONNECTION_ID';
          readonly sequenceNumber: bigint;
          readonly retirePriorTo: bigint;
          readonly connectionId: Uint8Array;
          readonly statelessResetToken: Uint8Array;
      }
    | { readonly type: 'RETIRE_CONNECTION_ID'; readonly sequenceNumber: bigint }
    | { readonly type: 'PATH_CHALLENGE'; readonly data: Uint8Array }
    | { readonly type: 'PATH_RESPONSE'; readonly data: Uint8Array }
    /** application false: type 0x1c with frameType (0 when unknown); application true: type 0x1d, no frameType. */
    | { readonly type: 'CONNECTION_CLOSE'; readonly application: boolean; readonly errorCode: bigint; readonly frameType?: bigint; readonly reason: Uint8Array }
    | { readonly type: 'HANDSHAKE_DONE' };

function tableEntry(typeCode: number): FrameTableEntry | undefined {
    return FRAME_TABLE.find((entry) => typeCode >= entry.first && typeCode <= entry.last);
}

/** Whether a frame type may appear in a packet type (Table 3 "Pkts"; Section 12.5). */
export function frameAllowedIn(typeCode: number, packetType: FramePacketType): boolean {
    const entry = tableEntry(typeCode);
    if (entry === undefined) return false;
    if (entry.pkts === 'ih01') {
        return packetType === 'initial' || packetType === 'handshake' ? typeCode === FrameType.CONNECTION_CLOSE : true;
    }
    return entry.pkts[PKTS_INDEX[packetType]] !== '_';
}

/** The frame type a frame encodes to. */
export function frameTypeCode(frame: QuicFrame): number {
    switch (frame.type) {
        case 'PADDING': return FrameType.PADDING;
        case 'PING': return FrameType.PING;
        case 'ACK': return frame.ecn ? FrameType.ACK_ECN : FrameType.ACK;
        case 'RESET_STREAM': return FrameType.RESET_STREAM;
        case 'STOP_SENDING': return FrameType.STOP_SENDING;
        case 'CRYPTO': return FrameType.CRYPTO;
        case 'NEW_TOKEN': return FrameType.NEW_TOKEN;
        case 'STREAM': {
            const off = frame.explicitOffset ?? frame.offset !== 0n;
            const len = frame.explicitLength ?? true;
            return FrameType.STREAM | (off ? STREAM_OFF_BIT : 0) | (len ? STREAM_LEN_BIT : 0) | (frame.fin ? STREAM_FIN_BIT : 0);
        }
        case 'MAX_DATA': return FrameType.MAX_DATA;
        case 'MAX_STREAM_DATA': return FrameType.MAX_STREAM_DATA;
        case 'MAX_STREAMS': return frame.bidirectional ? FrameType.MAX_STREAMS_BIDI : FrameType.MAX_STREAMS_UNI;
        case 'DATA_BLOCKED': return FrameType.DATA_BLOCKED;
        case 'STREAM_DATA_BLOCKED': return FrameType.STREAM_DATA_BLOCKED;
        case 'STREAMS_BLOCKED': return frame.bidirectional ? FrameType.STREAMS_BLOCKED_BIDI : FrameType.STREAMS_BLOCKED_UNI;
        case 'NEW_CONNECTION_ID': return FrameType.NEW_CONNECTION_ID;
        case 'RETIRE_CONNECTION_ID': return FrameType.RETIRE_CONNECTION_ID;
        case 'PATH_CHALLENGE': return FrameType.PATH_CHALLENGE;
        case 'PATH_RESPONSE': return FrameType.PATH_RESPONSE;
        case 'CONNECTION_CLOSE': return frame.application ? FrameType.CONNECTION_CLOSE_APPLICATION : FrameType.CONNECTION_CLOSE;
        case 'HANDSHAKE_DONE': return FrameType.HANDSHAKE_DONE;
        default: throw new TypeError(`unknown frame type ${String((frame as { type?: unknown }).type)}`);
    }
}

/** A packet is ack-eliciting when it carries a frame other than ACK, PADDING and CONNECTION_CLOSE (Table 3 "N"). */
export function isAckEliciting(frames: readonly QuicFrame[]): boolean {
    return frames.some((frame) => !(tableEntry(frameTypeCode(frame))?.spec.includes('N') ?? false));
}

function encodingError(message: string, frameType: number): QuicError {
    return new QuicError(TransportError.FRAME_ENCODING_ERROR, message, BigInt(frameType));
}

function decodeAck(reader: QuicReader, code: number): QuicFrame {
    const largest = reader.varint();
    const delay = reader.varint();
    const rangeCount = reader.varint();
    const firstRange = reader.varint();
    if (firstRange > largest) throw encodingError('First ACK Range exceeds Largest Acknowledged', code);
    // Each further range takes at least two bytes, so a count beyond that is truncated input.
    if (rangeCount > BigInt(Math.floor(reader.remaining / 2))) throw encodingError('ACK Range Count exceeds the frame', code);
    let smallest = largest - firstRange;
    const ranges: AckRange[] = [{ smallest, largest }];
    for (let i = 0n; i < rangeCount; i++) {
        const gap = reader.varint();
        const length = reader.varint();
        const rangeLargest = smallest - gap - 2n;
        const rangeSmallest = rangeLargest - length;
        if (rangeLargest < 0n || rangeSmallest < 0n) throw encodingError('ACK range below packet number 0', code);
        ranges.push({ smallest: rangeSmallest, largest: rangeLargest });
        smallest = rangeSmallest;
    }
    if (code === FrameType.ACK_ECN) {
        const ecn: EcnCounts = { ect0: reader.varint(), ect1: reader.varint(), ce: reader.varint() };
        return { type: 'ACK', delay, ranges, ecn };
    }
    return { type: 'ACK', delay, ranges };
}

function checkStreamExtent(offset: bigint, length: number, code: number): void {
    if (offset + BigInt(length) > VARINT_MAX) throw encodingError('offset + length exceeds 2^62-1', code);
}

function decodeBody(reader: QuicReader, code: number): QuicFrame {
    switch (code) {
        case FrameType.PADDING: {
            let length = 1;
            while (!reader.eof() && reader.peekUint8() === 0x00) {
                reader.skip(1);
                length++;
            }
            return { type: 'PADDING', length };
        }
        case FrameType.PING:
            return { type: 'PING' };
        case FrameType.ACK:
        case FrameType.ACK_ECN:
            return decodeAck(reader, code);
        case FrameType.RESET_STREAM:
            return { type: 'RESET_STREAM', streamId: reader.varint(), errorCode: reader.varint(), finalSize: reader.varint() };
        case FrameType.STOP_SENDING:
            return { type: 'STOP_SENDING', streamId: reader.varint(), errorCode: reader.varint() };
        case FrameType.CRYPTO: {
            const offset = reader.varint();
            const length = reader.varintNumber();
            checkStreamExtent(offset, length, code);
            return { type: 'CRYPTO', offset, data: reader.take(length) };
        }
        case FrameType.NEW_TOKEN: {
            const length = reader.varintNumber();
            if (length === 0) throw encodingError('NEW_TOKEN with an empty token', code);
            return { type: 'NEW_TOKEN', token: reader.take(length) };
        }
        case FrameType.MAX_DATA:
            return { type: 'MAX_DATA', maximum: reader.varint() };
        case FrameType.MAX_STREAM_DATA:
            return { type: 'MAX_STREAM_DATA', streamId: reader.varint(), maximum: reader.varint() };
        case FrameType.MAX_STREAMS_BIDI:
        case FrameType.MAX_STREAMS_UNI: {
            const maximum = reader.varint();
            if (maximum > MAX_STREAMS_LIMIT) throw encodingError('Maximum Streams exceeds 2^60', code);
            return { type: 'MAX_STREAMS', bidirectional: code === FrameType.MAX_STREAMS_BIDI, maximum };
        }
        case FrameType.DATA_BLOCKED:
            return { type: 'DATA_BLOCKED', limit: reader.varint() };
        case FrameType.STREAM_DATA_BLOCKED:
            return { type: 'STREAM_DATA_BLOCKED', streamId: reader.varint(), limit: reader.varint() };
        case FrameType.STREAMS_BLOCKED_BIDI:
        case FrameType.STREAMS_BLOCKED_UNI: {
            const limit = reader.varint();
            if (limit > MAX_STREAMS_LIMIT) throw encodingError('Maximum Streams exceeds 2^60', code);
            return { type: 'STREAMS_BLOCKED', bidirectional: code === FrameType.STREAMS_BLOCKED_BIDI, limit };
        }
        case FrameType.NEW_CONNECTION_ID: {
            const sequenceNumber = reader.varint();
            const retirePriorTo = reader.varint();
            const length = reader.uint8();
            if (length < 1 || length > 20) throw encodingError(`NEW_CONNECTION_ID length ${length} outside 1..20`, code);
            const connectionId = reader.take(length);
            const statelessResetToken = reader.take(16);
            if (retirePriorTo > sequenceNumber) throw encodingError('Retire Prior To exceeds Sequence Number', code);
            return { type: 'NEW_CONNECTION_ID', sequenceNumber, retirePriorTo, connectionId, statelessResetToken };
        }
        case FrameType.RETIRE_CONNECTION_ID:
            return { type: 'RETIRE_CONNECTION_ID', sequenceNumber: reader.varint() };
        case FrameType.PATH_CHALLENGE:
            return { type: 'PATH_CHALLENGE', data: reader.take(8) };
        case FrameType.PATH_RESPONSE:
            return { type: 'PATH_RESPONSE', data: reader.take(8) };
        case FrameType.CONNECTION_CLOSE: {
            const errorCode = reader.varint();
            const frameType = reader.varint();
            return { type: 'CONNECTION_CLOSE', application: false, errorCode, frameType, reason: reader.take(reader.varintNumber()) };
        }
        case FrameType.CONNECTION_CLOSE_APPLICATION: {
            const errorCode = reader.varint();
            return { type: 'CONNECTION_CLOSE', application: true, errorCode, reason: reader.take(reader.varintNumber()) };
        }
        case FrameType.HANDSHAKE_DONE:
            return { type: 'HANDSHAKE_DONE' };
        default: {
            // 0x08..0x0f: STREAM.
            const streamId = reader.varint();
            const explicitOffset = (code & STREAM_OFF_BIT) !== 0;
            const explicitLength = (code & STREAM_LEN_BIT) !== 0;
            const offset = explicitOffset ? reader.varint() : 0n;
            const length = explicitLength ? reader.varintNumber() : reader.remaining;
            checkStreamExtent(offset, length, code);
            return { type: 'STREAM', streamId, offset, data: reader.take(length), fin: (code & STREAM_FIN_BIT) !== 0, explicitOffset, explicitLength };
        }
    }
}

/**
 * Decodes a packet payload into frames. With packetType, each frame is checked against Table 3.
 * Consecutive PADDING bytes come back as one PADDING entry with their count.
 */
export function decodeFrames(payload: Uint8Array, packetType?: FramePacketType): QuicFrame[] {
    if (payload.length === 0) throw new QuicError(TransportError.PROTOCOL_VIOLATION, 'packet payload contains no frames');
    const reader = new QuicReader(payload, 0, payload.length, TransportError.FRAME_ENCODING_ERROR);
    const frames: QuicFrame[] = [];
    while (!reader.eof()) {
        const { value: type, length } = reader.varintWithLength();
        if (length !== varintLength(type)) {
            throw new QuicError(TransportError.PROTOCOL_VIOLATION, 'frame type is not minimally encoded', type);
        }
        if (type > BigInt(FrameType.HANDSHAKE_DONE)) {
            throw new QuicError(TransportError.FRAME_ENCODING_ERROR, `unknown frame type 0x${type.toString(16)}`, type);
        }
        const code = Number(type);
        if (packetType !== undefined && !frameAllowedIn(code, packetType)) {
            throw new QuicError(TransportError.PROTOCOL_VIOLATION, `frame type 0x${code.toString(16)} not permitted in ${packetType} packets`, type);
        }
        try {
            frames.push(decodeBody(reader, code));
        } catch (error) {
            if (error instanceof QuicError && error.frameType === undefined) throw new QuicError(error.errorCode, error.message, type);
            throw error;
        }
    }
    return frames;
}

function checkRange(value: bigint, max: bigint, what: string): void {
    if (typeof value !== 'bigint' || value < 0n || value > max) throw new RangeError(`${what} out of range: ${String(value)}`);
}

function checkLength(bytes: Uint8Array, min: number, max: number, what: string): void {
    if (!(bytes instanceof Uint8Array) || bytes.length < min || bytes.length > max) throw new RangeError(`${what} must be ${min === max ? min : `${min}..${max}`} bytes`);
}

function encodeAck(frame: Extract<QuicFrame, { type: 'ACK' }>, w: QuicWriter): void {
    const ranges = frame.ranges;
    if (ranges.length === 0) throw new RangeError('ACK needs at least one range');
    for (let i = 0; i < ranges.length; i++) {
        checkRange(ranges[i].smallest, VARINT_MAX, 'ACK range smallest');
        checkRange(ranges[i].largest, VARINT_MAX, 'ACK range largest');
        if (ranges[i].smallest > ranges[i].largest) throw new RangeError('ACK range smallest exceeds largest');
        if (i > 0 && ranges[i].largest > ranges[i - 1].smallest - 2n) throw new RangeError('ACK ranges must descend with a gap of at least one');
    }
    w.varint(ranges[0].largest);
    w.varint(frame.delay);
    w.varint(ranges.length - 1);
    w.varint(ranges[0].largest - ranges[0].smallest);
    for (let i = 1; i < ranges.length; i++) {
        w.varint(ranges[i - 1].smallest - ranges[i].largest - 2n);
        w.varint(ranges[i].largest - ranges[i].smallest);
    }
    if (frame.ecn) w.varint(frame.ecn.ect0).varint(frame.ecn.ect1).varint(frame.ecn.ce);
}

/**
 * Appends one frame to w; nothing is appended when the frame is invalid. A STREAM frame without its LEN
 * bit extends to the end of the packet, so it must be the last frame (encodeFrames enforces this).
 */
export function encodeFrame(frame: QuicFrame, w: QuicWriter): void {
    const tmp = new QuicWriter(32);
    writeFrame(frame, tmp);
    w.bytes(tmp.finish());
}

function writeFrame(frame: QuicFrame, w: QuicWriter): void {
    const code = frameTypeCode(frame);
    switch (frame.type) {
        case 'PADDING':
            if (!Number.isInteger(frame.length) || frame.length < 1) throw new RangeError('PADDING length must be at least 1');
            w.bytes(new Uint8Array(frame.length));
            return;
        case 'PING':
        case 'HANDSHAKE_DONE':
            w.varint(code);
            return;
        case 'ACK':
            w.varint(code);
            encodeAck(frame, w);
            return;
        case 'RESET_STREAM':
            w.varint(code).varint(frame.streamId).varint(frame.errorCode).varint(frame.finalSize);
            return;
        case 'STOP_SENDING':
            w.varint(code).varint(frame.streamId).varint(frame.errorCode);
            return;
        case 'CRYPTO':
            checkRange(frame.offset + BigInt(frame.data.length), VARINT_MAX, 'CRYPTO offset + length');
            w.varint(code).varint(frame.offset).varint(frame.data.length).bytes(frame.data);
            return;
        case 'NEW_TOKEN':
            checkLength(frame.token, 1, Number.MAX_SAFE_INTEGER, 'NEW_TOKEN token');
            w.varint(code).varint(frame.token.length).bytes(frame.token);
            return;
        case 'STREAM': {
            checkRange(frame.offset + BigInt(frame.data.length), VARINT_MAX, 'STREAM offset + length');
            if (frame.explicitOffset === false && frame.offset !== 0n) throw new RangeError('STREAM offset > 0 needs the OFF bit');
            w.varint(code).varint(frame.streamId);
            if (code & STREAM_OFF_BIT) w.varint(frame.offset);
            if (code & STREAM_LEN_BIT) w.varint(frame.data.length);
            w.bytes(frame.data);
            return;
        }
        case 'MAX_DATA':
            w.varint(code).varint(frame.maximum);
            return;
        case 'MAX_STREAM_DATA':
            w.varint(code).varint(frame.streamId).varint(frame.maximum);
            return;
        case 'MAX_STREAMS':
            checkRange(frame.maximum, MAX_STREAMS_LIMIT, 'Maximum Streams');
            w.varint(code).varint(frame.maximum);
            return;
        case 'DATA_BLOCKED':
            w.varint(code).varint(frame.limit);
            return;
        case 'STREAM_DATA_BLOCKED':
            w.varint(code).varint(frame.streamId).varint(frame.limit);
            return;
        case 'STREAMS_BLOCKED':
            checkRange(frame.limit, MAX_STREAMS_LIMIT, 'Maximum Streams');
            w.varint(code).varint(frame.limit);
            return;
        case 'NEW_CONNECTION_ID':
            checkLength(frame.connectionId, 1, 20, 'NEW_CONNECTION_ID connection ID');
            checkLength(frame.statelessResetToken, 16, 16, 'stateless reset token');
            if (frame.retirePriorTo > frame.sequenceNumber) throw new RangeError('Retire Prior To exceeds Sequence Number');
            w.varint(code).varint(frame.sequenceNumber).varint(frame.retirePriorTo);
            w.uint8(frame.connectionId.length).bytes(frame.connectionId).bytes(frame.statelessResetToken);
            return;
        case 'RETIRE_CONNECTION_ID':
            w.varint(code).varint(frame.sequenceNumber);
            return;
        case 'PATH_CHALLENGE':
        case 'PATH_RESPONSE':
            checkLength(frame.data, 8, 8, `${frame.type} data`);
            w.varint(code).bytes(frame.data);
            return;
        case 'CONNECTION_CLOSE':
            w.varint(code).varint(frame.errorCode);
            if (!frame.application) w.varint(frame.frameType ?? 0n);
            else if (frame.frameType !== undefined) throw new TypeError('an application CONNECTION_CLOSE carries no frame type');
            w.varint(frame.reason.length).bytes(frame.reason);
            return;
        default:
            throw new TypeError(`unknown frame type ${String((frame as { type?: unknown }).type)}`);
    }
}

/** Encodes a packet payload. A STREAM frame without its LEN bit is allowed only as the last frame. */
export function encodeFrames(frames: readonly QuicFrame[]): Uint8Array {
    const w = new QuicWriter(256);
    frames.forEach((frame, i) => {
        if (frame.type === 'STREAM' && frame.explicitLength === false && i !== frames.length - 1) {
            throw new RangeError('a STREAM frame without a Length field must be the last frame of the payload');
        }
        writeFrame(frame, w);
    });
    return w.finish();
}
