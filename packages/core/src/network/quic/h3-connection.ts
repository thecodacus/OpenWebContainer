import type { CloseInfo, QuicConnection, QuicStream } from './connection';
import { Emitter } from './emitter';
import { fieldSectionSize, validateMessage } from './h3-fields';
import type { MessageKind, ValidatedMessage } from './h3-fields';
import { FrameReader, H3Error, decodeSettingsPayload, decodeSingleVarintPayload, encodeFrame, encodeFrameHeader, encodeSettingsPayload, encodeVarints } from './h3-frames';
import type { FrameMode, FrameSink } from './h3-frames';
import { H3ErrorCode, H3FrameType, H3Setting, H3StreamType, H3_RESERVED_FRAME_TYPES, QpackSetting, QpackStreamType } from './http3-constants';
import { QpackDecoderStreamReceiver, QpackEncoderStreamReceiver, QpackError, decodeFieldSectionDetailed, encodeFieldSection } from './qpack';
import type { FieldLine, HuffmanMode } from './qpack';
import { decodeVarint } from './varint';

/*
 * HTTP/3 (RFC 9114) over one QUIC connection of the connection layer, client or server, with QPACK
 * (RFC 9204) limited to the static table (qpack.ts).
 *
 * Connection: when the QUIC handshake completes, each side opens its control stream (SETTINGS first:
 * QPACK_MAX_TABLE_CAPACITY 0, QPACK_BLOCKED_STREAMS 0, optionally MAX_FIELD_SECTION_SIZE, and one
 * reserved setting of the form 0x1f * N + 0x21) and its QPACK encoder and decoder streams, which carry
 * only their stream type because the dynamic table is never used. Peer streams: one control stream
 * (SETTINGS first, else H3_MISSING_SETTINGS), one encoder and one decoder stream (a second of any is
 * H3_STREAM_CREATION_ERROR, closing any is H3_CLOSED_CRITICAL_STREAM), push streams refused
 * (H3_STREAM_CREATION_ERROR from a client, H3_ID_ERROR at a client that sent no MAX_PUSH_ID), unknown
 * stream types read-aborted with H3_STREAM_CREATION_ERROR, a server-initiated bidirectional stream
 * H3_STREAM_CREATION_ERROR. Control frames: SETTINGS once (identifiers reserved from HTTP/2 or repeated
 * are H3_SETTINGS_ERROR, unknown identifiers ignored), GOAWAY both ways (never increasing, a client
 * checks it names a client-initiated bidirectional stream), MAX_PUSH_ID at a server, CANCEL_PUSH
 * (H3_ID_ERROR: no push was promised or allowed), DATA/HEADERS/PUSH_PROMISE and the HTTP/2 frame types
 * H3_FRAME_UNEXPECTED, unknown types ignored.
 *
 * Request streams: HEADERS, DATA*, optional trailing HEADERS, interim (1xx) responses before the final
 * one; DATA before HEADERS or anything after the trailers is H3_FRAME_UNEXPECTED; frames that belong on
 * the control stream are H3_FRAME_UNEXPECTED; PUSH_PROMISE is H3_FRAME_UNEXPECTED at a server and
 * H3_ID_ERROR at a client; unknown frame types are ignored; a stream that ends inside a frame is
 * H3_FRAME_ERROR. Malformed messages (h3-fields.ts, and a Content-Length that differs from the DATA
 * received) are stream errors of type H3_MESSAGE_ERROR; a request stream that ends without a request is
 * reset with H3_REQUEST_INCOMPLETE; requests at or above a GOAWAY the server sent are rejected with
 * H3_REQUEST_REJECTED.
 *
 * Connection errors close the QUIC connection with the HTTP/3 or QPACK error code as an application
 * error (CONNECTION_CLOSE type 0x1d).
 */

const LOCAL_SETTINGS_IDS = { capacity: BigInt(QpackSetting.QPACK_MAX_TABLE_CAPACITY), blocked: BigInt(QpackSetting.QPACK_BLOCKED_STREAMS), fieldSection: BigInt(H3Setting.MAX_FIELD_SECTION_SIZE) };
/** Largest SETTINGS payload accepted (the frame is buffered whole). */
const MAX_SETTINGS_PAYLOAD = 16384;
/** Default largest encoded field section accepted in a HEADERS frame. */
const DEFAULT_MAX_HEADER_BLOCK = 1048576;

export interface Http3Options {
    /** SETTINGS_MAX_FIELD_SECTION_SIZE to advertise; unset means unlimited and nothing is sent. */
    readonly maxFieldSectionSize?: number;
    /** Send one reserved setting of the form 0x1f * N + 0x21 (RFC 9114 Section 7.2.4.1). Default true. */
    readonly greaseSetting?: boolean;
    /** Huffman coding of the strings this endpoint encodes. Default 'auto'. */
    readonly huffman?: HuffmanMode;
    /** Largest encoded field section accepted in a HEADERS frame, in bytes. Default 1 MiB. */
    readonly maxHeaderBlock?: number;
    readonly trace?: (event: Record<string, unknown>) => void;
}

/** A stream error (RFC 9114 Section 8): the stream is reset and reading is aborted with code. */
export class H3StreamError extends H3Error {
    constructor(code: number, message: string) {
        super(code, message);
        this.name = 'H3StreamError';
    }
}

/** How a request stream or the connection ended abnormally, as reported to listeners. */
export interface AbortInfo {
    readonly code: number;
    readonly reason: string;
    /** 'reset': the peer reset its send side; 'stop': the peer asked us to stop sending; 'local': this endpoint's stream error; 'connection': the connection closed. */
    readonly how: 'reset' | 'stop' | 'local' | 'connection';
}

export interface HeadersEvent {
    readonly kind: 'request' | 'informational' | 'response' | 'trailers';
    readonly fields: FieldLine[];
    readonly message: ValidatedMessage;
    readonly representations: string[];
}

export function errorName(code: number): string {
    for (const [name, value] of Object.entries(H3ErrorCode)) if (value === code) return name;
    if (code === 0x200) return 'QPACK_DECOMPRESSION_FAILED';
    if (code === 0x201) return 'QPACK_ENCODER_STREAM_ERROR';
    if (code === 0x202) return 'QPACK_DECODER_STREAM_ERROR';
    return `0x${code.toString(16)}`;
}

function frameTypeName(type: number): string {
    for (const [name, value] of Object.entries(H3FrameType)) if (value === type) return name;
    if (H3_RESERVED_FRAME_TYPES.includes(type)) return `HTTP/2 type 0x${type.toString(16)}`;
    return `unknown 0x${type.toString(16)}`;
}

function isReservedCodePoint(value: number): boolean {
    return value >= 0x21 && (value - 0x21) % 0x1f === 0;
}

/**
 * One request stream (a client-initiated bidirectional QUIC stream), at either end. Events:
 * 'headers' (HeadersEvent), 'data' (Uint8Array), 'end', 'aborted' (AbortInfo), 'close'.
 */
export class Http3RequestStream extends Emitter implements FrameSink {
    readonly id: number;
    readonly connection: Http3Connection;
    readonly quic: QuicStream;
    /** Receive side: 'headers' until the request or final response, 'body' until trailers, 'done' after them. */
    recvState: 'headers' | 'body' | 'done' = 'headers';
    recvEnded = false;
    /** Send side: 'headers' until the header section is sent, 'body' while DATA may follow, 'done' after the FIN or a reset. */
    sendState: 'headers' | 'body' | 'done' = 'headers';
    /** Server: the request received. Client: the request sent. */
    request: ValidatedMessage | null = null;
    response: ValidatedMessage | null = null;
    abort: AbortInfo | null = null;
    closed = false;
    private readonly reader: FrameReader;
    private expectedLength: number | null = null;
    private receivedLength = 0;
    private sendFinished = false;

    constructor(connection: Http3Connection, quic: QuicStream) {
        super();
        this.id = quic.id;
        this.connection = connection;
        this.quic = quic;
        this.reader = new FrameReader(this);
        quic.on('data', (chunk: Uint8Array) => this.guard(() => this.reader.push(chunk)));
        quic.on('end', () => this.guard(() => this.onEnd()));
        quic.on('reset', (info: { errorCode: number }) => this.onPeerReset(info.errorCode));
        quic.on('stop', (info: { errorCode: number }) => this.onPeerStop(info.errorCode));
        quic.on('finish', () => {
            this.sendFinished = true;
            this.maybeClose();
        });
    }

    get isServer(): boolean {
        return this.connection.role === 'server';
    }

    // ------------------------------------------------------------------ sending

    /** Sends a header section: request or response headers, or trailers once the body has started. */
    sendHeaders(fields: readonly FieldLine[], endStream = false): void {
        if (this.sendState === 'done') throw Object.assign(new Error(`stream ${this.id} cannot send headers: its send side is closed`), { code: 'ERR_HTTP3_STREAM_CLOSED' });
        const limit = this.connection.peerMaxFieldSectionSize;
        if (limit !== null && fieldSectionSize(fields) > limit) {
            throw Object.assign(new RangeError(`field section of ${fieldSectionSize(fields)} bytes exceeds the peer's SETTINGS_MAX_FIELD_SECTION_SIZE ${limit}`), { code: 'ERR_HTTP3_HEADERS_TOO_LARGE' });
        }
        const informational = this.isServer && this.sendState === 'headers' && fields.length > 0 && fields[0][0] === ':status' && /^1[0-9][0-9]$/.test(fields[0][1]);
        if (informational && fields[0][1] === '101') throw Object.assign(new RangeError('HTTP/3 has no 101 (Switching Protocols) response (RFC 9114 Section 4.5)'), { code: 'ERR_HTTP3_INVALID_INFO_STATUS' });
        if (informational && endStream) throw Object.assign(new Error('an interim (1xx) response cannot end the stream'), { code: 'ERR_HTTP3_INFO_STATUS_NOT_ALLOWED' });
        const block = encodeFieldSection(fields, { huffman: this.connection.huffman });
        this.quic.write(encodeFrame(H3FrameType.HEADERS, block));
        this.connection.stats.headersSent++;
        this.connection.traceEvent({ ev: 'h3_headers_sent', stream: this.id, fields: fields.length, bytes: block.length, end: endStream });
        if (!this.isServer && this.sendState === 'headers') this.request = validateMessage(fields, 'request');
        if (informational) return;
        const trailers = this.sendState === 'body';
        this.sendState = trailers || endStream ? 'done' : 'body';
        if (trailers || endStream) this.finishSending();
    }

    /** Sends one DATA frame (nothing for an empty chunk) and, with endStream, the FIN. */
    sendData(chunk: Uint8Array, endStream = false): void {
        if (this.sendState !== 'body') throw Object.assign(new Error(`stream ${this.id} cannot send DATA ${this.sendState === 'headers' ? 'before its header section' : 'after its send side closed'}`), { code: 'ERR_HTTP3_STREAM_CLOSED' });
        if (chunk.length > 0) {
            this.quic.write(encodeFrameHeader(H3FrameType.DATA, chunk.length));
            this.quic.write(chunk);
            this.connection.stats.dataBytesSent += chunk.length;
        }
        if (endStream) {
            this.sendState = 'done';
            this.finishSending();
        }
    }

    /** Closes the send side cleanly (FIN) after the body. */
    end(): void {
        if (this.sendState === 'done') return;
        if (this.sendState === 'headers') throw Object.assign(new Error(`stream ${this.id} cannot end before its header section`), { code: 'ERR_HTTP3_STREAM_CLOSED' });
        this.sendState = 'done';
        this.finishSending();
    }

    /**
     * Abruptly ends both directions with code on the wire (RFC 9114 Section 4.1.1); listeners see
     * reportCode, which defaults to code.
     */
    cancel(code: number = H3ErrorCode.H3_REQUEST_CANCELLED, reason = 'cancelled', reportCode: number = code): void {
        if (this.closed) return;
        this.resetBoth(code);
        this.recvEnded = true;
        this.sendFinished = true;
        this.setAbort({ code: reportCode, reason, how: 'local' });
        this.close();
    }

    private finishSending(): void {
        this.quic.end();
    }

    /** Resets what is still open: the send side if it has not sent its FIN, the receive side if it has not ended. */
    private resetBoth(code: number): void {
        if (this.sendState !== 'done') this.quic.reset(code);
        if (!this.recvEnded) this.quic.stopSending(code);
        this.sendState = 'done';
    }

    // ------------------------------------------------------------------ receiving (FrameSink)

    frameStart(type: number, length: number): FrameMode {
        switch (type) {
            case H3FrameType.DATA:
                if (this.recvState !== 'body') throw new H3Error(H3ErrorCode.H3_FRAME_UNEXPECTED, this.recvState === 'headers' ? `DATA frame before HEADERS on request stream ${this.id}` : `DATA frame after the trailers on request stream ${this.id}`);
                return 'stream';
            case H3FrameType.HEADERS:
                if (this.recvState === 'done') throw new H3Error(H3ErrorCode.H3_FRAME_UNEXPECTED, `HEADERS frame after the trailers on request stream ${this.id}`);
                if (length > this.connection.maxHeaderBlock) throw new H3Error(H3ErrorCode.H3_EXCESSIVE_LOAD, `HEADERS frame of ${length} bytes exceeds the ${this.connection.maxHeaderBlock}-byte limit`);
                return 'buffer';
            case H3FrameType.PUSH_PROMISE:
                if (this.isServer) throw new H3Error(H3ErrorCode.H3_FRAME_UNEXPECTED, 'PUSH_PROMISE frame from a client');
                if (length > this.connection.maxHeaderBlock) throw new H3Error(H3ErrorCode.H3_EXCESSIVE_LOAD, `PUSH_PROMISE frame of ${length} bytes exceeds the limit`);
                return 'buffer';
            case H3FrameType.CANCEL_PUSH:
            case H3FrameType.SETTINGS:
            case H3FrameType.GOAWAY:
            case H3FrameType.MAX_PUSH_ID:
                throw new H3Error(H3ErrorCode.H3_FRAME_UNEXPECTED, `${frameTypeName(type)} frame on request stream ${this.id}`);
            default:
                if (H3_RESERVED_FRAME_TYPES.includes(type)) throw new H3Error(H3ErrorCode.H3_FRAME_UNEXPECTED, `${frameTypeName(type)} frame on request stream ${this.id}`);
                this.connection.noteUnknownFrame('request', type, length);
                return 'skip';
        }
    }

    frame(type: number, payload: Uint8Array): void {
        if (type === H3FrameType.PUSH_PROMISE) {
            let pushId: bigint;
            try {
                pushId = decodeVarint(payload, 0).value;
            } catch {
                throw new H3Error(H3ErrorCode.H3_FRAME_ERROR, 'PUSH_PROMISE frame ends inside its push ID');
            }
            throw new H3Error(H3ErrorCode.H3_ID_ERROR, `PUSH_PROMISE with push ID ${pushId}, but this client sent no MAX_PUSH_ID`);
        }
        this.onHeaders(payload);
    }

    data(_type: number, chunk: Uint8Array): void {
        this.receivedLength += chunk.length;
        this.connection.stats.dataBytesReceived += chunk.length;
        if (this.expectedLength !== null && this.receivedLength > this.expectedLength) {
            throw new H3StreamError(H3ErrorCode.H3_MESSAGE_ERROR, `DATA exceeds content-length ${this.expectedLength}`);
        }
        this.emit('data', chunk);
    }

    frameEnd(): void {
        // DATA frame boundaries carry no meaning.
    }

    private onHeaders(block: Uint8Array): void {
        const decoded = decodeFieldSectionDetailed(block);
        this.connection.noteFieldSection(decoded.representations);
        if (this.recvState === 'body') {
            const message = validateMessage(decoded.fields, 'trailers');
            if (message.error !== null) throw new H3StreamError(H3ErrorCode.H3_MESSAGE_ERROR, `malformed trailers: ${message.error}`);
            this.checkLength();
            this.recvState = 'done';
            this.emit('headers', { kind: 'trailers', fields: decoded.fields, message, representations: decoded.representations } as HeadersEvent);
            return;
        }
        const kind: MessageKind = this.isServer ? 'request' : 'response';
        const message = validateMessage(decoded.fields, kind);
        if (message.error !== null) throw new H3StreamError(H3ErrorCode.H3_MESSAGE_ERROR, `malformed ${kind}: ${message.error}`);
        if (kind === 'response' && message.status !== undefined && message.status < 200) {
            // An interim response: the final response is still to come (RFC 9114 Section 4.1).
            this.emit('headers', { kind: 'informational', fields: decoded.fields, message, representations: decoded.representations } as HeadersEvent);
            return;
        }
        if (kind === 'request') this.request = message;
        else this.response = message;
        this.expectedLength = this.hasContent(message) ? message.contentLength : null;
        this.recvState = 'body';
        this.emit('headers', { kind, fields: decoded.fields, message, representations: decoded.representations } as HeadersEvent);
    }

    /** Whether Content-Length describes DATA for this message (not for HEAD responses, 204 or 304). */
    private hasContent(message: ValidatedMessage): boolean {
        if (this.isServer) return true;
        if (this.request?.method === 'HEAD') return false;
        return message.status !== 204 && message.status !== 304;
    }

    private checkLength(): void {
        if (this.expectedLength !== null && this.receivedLength !== this.expectedLength) {
            throw new H3StreamError(H3ErrorCode.H3_MESSAGE_ERROR, `content-length ${this.expectedLength} but ${this.receivedLength} bytes of DATA`);
        }
    }

    private onEnd(): void {
        this.reader.end();
        this.recvEnded = true;
        if (this.recvState === 'headers') {
            if (this.isServer) throw new H3StreamError(H3ErrorCode.H3_REQUEST_INCOMPLETE, `request stream ${this.id} ended without a request`);
            throw new H3StreamError(H3ErrorCode.H3_MESSAGE_ERROR, `response stream ${this.id} ended without a final response`);
        }
        this.checkLength();
        this.emit('end');
        this.maybeClose();
    }

    private onPeerReset(code: number): void {
        if (this.closed) return;
        this.recvEnded = true;
        this.setAbort({ code, reason: `peer reset the stream with ${errorName(code)}`, how: 'reset' });
        if (this.sendState !== 'done') {
            // RFC 9114 Section 4.1.1: cancel what is still open in the other direction.
            this.quic.reset(H3ErrorCode.H3_REQUEST_CANCELLED);
            this.sendState = 'done';
        }
        this.maybeClose();
    }

    private onPeerStop(code: number): void {
        if (this.closed) return;
        // The QUIC layer answers STOP_SENDING with RESET_STREAM (RFC 9000 Section 3.5).
        const complete = this.sendState === 'done';
        this.sendState = 'done';
        this.sendFinished = true;
        // A server that aborts reading the request with H3_NO_ERROR after a complete response is not an error (Section 4.1).
        if (!(code === H3ErrorCode.H3_NO_ERROR && complete)) this.setAbort({ code, reason: `peer asked to stop sending with ${errorName(code)}`, how: 'stop' });
        this.maybeClose();
    }

    /** Called by the connection when it closes. */
    connectionClosed(info: AbortInfo): void {
        if (this.closed) return;
        if (!this.recvEnded || this.sendState !== 'done') this.setAbort(info);
        this.close();
    }

    private setAbort(info: AbortInfo): void {
        if (this.abort !== null) return;
        this.abort = info;
        this.connection.traceEvent({ ev: 'h3_stream_aborted', stream: this.id, code: info.code, how: info.how, reason: info.reason });
        this.emit('aborted', info);
    }

    private streamError(error: H3Error): void {
        if (this.closed) return;
        this.connection.stats.streamErrors++;
        this.connection.traceEvent({ ev: 'h3_stream_error', stream: this.id, code: error.code, name: errorName(error.code), reason: error.message });
        this.resetBoth(error.code);
        this.recvEnded = true;
        this.sendFinished = true;
        this.setAbort({ code: error.code, reason: error.message, how: 'local' });
        this.close();
    }

    private maybeClose(): void {
        if (!this.closed && this.recvEnded && this.sendState === 'done' && (this.sendFinished || this.abort !== null)) this.close();
    }

    private close(): void {
        if (this.closed) return;
        this.closed = true;
        this.connection.forgetRequest(this);
        this.emit('close');
    }

    private guard(fn: () => void): void {
        if (this.closed || this.connection.closed) return;
        try {
            fn();
        } catch (error) {
            if (error instanceof H3StreamError) return this.streamError(error);
            if (error instanceof QpackError && error.streamError) return this.streamError(new H3StreamError(error.code, error.message));
            this.connection.failWith(error);
        }
    }
}

type UniKind = 'control' | 'encoder' | 'decoder' | 'unknown';

/**
 * HTTP/3 over one QUIC connection. Events: 'open' (the local control and QPACK streams are open and
 * SETTINGS is queued), 'settings' (the peer's SETTINGS as [id, value] bigint pairs), 'stream' (server:
 * a new request stream, before any of its events), 'request' (server: a request stream and the
 * HeadersEvent of its request), 'goaway' (bigint id), 'idle' (no request streams left), 'error'
 * (H3Error: this endpoint is closing the connection with a connection error), 'close' (CloseInfo).
 */
export class Http3Connection extends Emitter {
    readonly role: 'client' | 'server';
    readonly quic: QuicConnection;
    readonly huffman: HuffmanMode;
    readonly maxHeaderBlock: number;
    readonly localSettings: Array<[bigint, bigint]>;
    peerSettings: Array<[bigint, bigint]> | null = null;
    peerMaxFieldSectionSize: number | null = null;
    goawaySent: bigint | null = null;
    goawayReceived: bigint | null = null;
    maxPushIdReceived: bigint | null = null;
    opened = false;
    closed = false;
    closeInfo: CloseInfo | null = null;
    /** Set when this endpoint closed with a connection error. */
    localError: H3Error | null = null;
    readonly encoderReceiver = new QpackEncoderStreamReceiver(0);
    readonly decoderReceiver = new QpackDecoderStreamReceiver();
    readonly stats = {
        headersSent: 0,
        headersReceived: 0,
        dataBytesSent: 0,
        dataBytesReceived: 0,
        streamErrors: 0,
        requestsRejected: 0,
        representations: {} as Record<string, number>,
        unknownFrames: [] as { where: string; type: string; length: number }[],
        unknownStreamTypes: [] as string[],
        unknownSettings: [] as string[],
    };
    private readonly traceFn: ((event: Record<string, unknown>) => void) | undefined;
    private controlStream: QuicStream | null = null;
    private encoderStream: QuicStream | null = null;
    private decoderStream: QuicStream | null = null;
    private peerControl: QuicStream | null = null;
    private peerEncoder: QuicStream | null = null;
    private peerDecoder: QuicStream | null = null;
    private settingsReceived = false;
    private readonly requests = new Map<number, Http3RequestStream>();
    /** Server: the highest client request stream ID accepted, for GOAWAY. */
    private highestRequestId = -1;

    constructor(quic: QuicConnection, options: Http3Options = {}) {
        super();
        this.quic = quic;
        this.role = quic.role;
        this.huffman = options.huffman ?? 'auto';
        this.maxHeaderBlock = options.maxHeaderBlock ?? DEFAULT_MAX_HEADER_BLOCK;
        this.traceFn = options.trace;
        const settings: Array<[bigint, bigint]> = [
            [LOCAL_SETTINGS_IDS.capacity, 0n],
            [LOCAL_SETTINGS_IDS.blocked, 0n],
        ];
        if (options.maxFieldSectionSize !== undefined) settings.push([LOCAL_SETTINGS_IDS.fieldSection, BigInt(options.maxFieldSectionSize)]);
        if (options.greaseSetting !== false) {
            const n = BigInt(Math.floor(Math.random() * 0x7fff));
            settings.push([0x1fn * n + 0x21n, BigInt(Math.floor(Math.random() * 0x3fff))]);
        }
        this.localSettings = settings;
        quic.on('handshake', () => this.failSafe(() => this.open()));
        quic.on('stream', (stream: QuicStream) => this.failSafe(() => this.onQuicStream(stream)));
        quic.on('close', (info: CloseInfo) => this.onQuicClose(info));
        if (quic.handshakeComplete) this.failSafe(() => this.open());
    }

    get requestCount(): number {
        return this.requests.size;
    }

    /**
     * Request streams whose HTTP/3 exchange is not over yet: a stream that has received the peer's
     * final message and closed its send side counts as done even before its stream object is torn
     * down, so a close is not held up by stream bookkeeping that has yet to run.
     */
    get busyCount(): number {
        let busy = 0;
        for (const request of this.requests.values()) {
            if (request.closed) continue;
            if (request.recvEnded && request.sendState === 'done') continue;
            busy++;
        }
        return busy;
    }

    traceEvent(event: Record<string, unknown>): void {
        if (this.traceFn) this.traceFn({ role: this.role, ...event });
    }

    // ------------------------------------------------------------------ local streams

    private open(): void {
        if (this.opened || this.closed) return;
        this.opened = true;
        this.controlStream = this.quic.openStream({ bidirectional: false });
        this.controlStream.write(encodeVarints([H3StreamType.CONTROL]));
        this.controlStream.write(encodeFrame(H3FrameType.SETTINGS, encodeSettingsPayload(this.localSettings)));
        this.encoderStream = this.quic.openStream({ bidirectional: false });
        this.encoderStream.write(encodeVarints([QpackStreamType.ENCODER]));
        this.decoderStream = this.quic.openStream({ bidirectional: false });
        this.decoderStream.write(encodeVarints([QpackStreamType.DECODER]));
        for (const [stream, name] of [[this.controlStream, 'control'], [this.encoderStream, 'QPACK encoder'], [this.decoderStream, 'QPACK decoder']] as const) {
            stream.on('stop', (info: { errorCode: number }) => this.failSafe(() => {
                throw new H3Error(H3ErrorCode.H3_CLOSED_CRITICAL_STREAM, `peer sent STOP_SENDING (${errorName(info.errorCode)}) for the local ${name} stream`);
            }));
        }
        this.traceEvent({ ev: 'h3_open', control: this.controlStream.id, encoder: this.encoderStream.id, decoder: this.decoderStream.id, settings: this.localSettings.map(([id, value]) => [`0x${id.toString(16)}`, value.toString()]) });
        this.emit('open');
    }

    /** Opens a request stream (client). */
    openRequest(): Http3RequestStream {
        if (this.role !== 'client') throw Object.assign(new Error('only a client opens request streams'), { code: 'ERR_HTTP3_INVALID_SESSION' });
        if (this.closed) throw Object.assign(new Error('the HTTP/3 connection is closed'), { code: 'ERR_HTTP3_INVALID_SESSION' });
        if (this.goawayReceived !== null) throw Object.assign(new Error('New streams cannot be created after receiving a GOAWAY'), { code: 'ERR_HTTP3_GOAWAY_SESSION' });
        const stream = new Http3RequestStream(this, this.quic.openStream({ bidirectional: true }));
        this.requests.set(stream.id, stream);
        return stream;
    }

    /**
     * Sends GOAWAY (RFC 9114 Section 5.2). A server names the first request stream it will not process
     * (by default one past the highest accepted); a client sends push ID 0 (it accepts no pushes).
     */
    sendGoaway(id?: bigint): bigint {
        if (this.controlStream === null || this.closed) throw Object.assign(new Error('the HTTP/3 connection is not open'), { code: 'ERR_HTTP3_INVALID_SESSION' });
        // RFC 9114 Section 5.2: zero when no request was processed; push ID 0 from a client that accepts no pushes.
        let value = id ?? (this.role === 'server' && this.highestRequestId >= 0 ? BigInt(this.highestRequestId + 4) : 0n);
        if (this.goawaySent !== null && value > this.goawaySent) value = this.goawaySent;
        this.goawaySent = value;
        this.controlStream.write(encodeFrame(H3FrameType.GOAWAY, encodeVarints([value])));
        this.traceEvent({ ev: 'h3_goaway_sent', id: value.toString() });
        return value;
    }

    /** Immediate close of the QUIC connection with an application error code (default H3_NO_ERROR). */
    close(code: number = H3ErrorCode.H3_NO_ERROR, reason = ''): void {
        if (this.closed) return;
        this.quic.close(code, reason);
    }

    // ------------------------------------------------------------------ peer streams

    private onQuicStream(stream: QuicStream): void {
        if (stream.bidirectional) {
            if (this.role === 'client') throw new H3Error(H3ErrorCode.H3_STREAM_CREATION_ERROR, `server-initiated bidirectional stream ${stream.id}`);
            this.acceptRequest(stream);
            return;
        }
        let header: number[] | null = [];
        let kind: UniKind | null = null;
        stream.on('data', (chunk: Uint8Array) => this.failSafe(() => {
            let rest = chunk;
            if (kind === null) {
                const bytes = header as number[];
                let i = 0;
                while (i < chunk.length) {
                    bytes.push(chunk[i++]);
                    if (bytes.length === 1 << (bytes[0] >> 6)) break;
                }
                if (bytes.length < 1 << (bytes[0] >> 6)) return;
                header = null;
                kind = this.classifyUniStream(stream, decodeVarint(Uint8Array.from(bytes), 0).value);
                rest = chunk.subarray(i);
            }
            if (rest.length > 0) this.uniData(kind, rest);
        }));
        const closedCritical = (how: string): void => this.failSafe(() => {
            if (kind === 'control' || kind === 'encoder' || kind === 'decoder') throw new H3Error(H3ErrorCode.H3_CLOSED_CRITICAL_STREAM, `peer ${how} its ${kind === 'control' ? 'control' : `QPACK ${kind}`} stream ${stream.id}`);
        });
        stream.on('end', () => closedCritical('closed'));
        stream.on('reset', () => closedCritical('reset'));
    }

    private classifyUniStream(stream: QuicStream, type: bigint): UniKind {
        const typeName = `0x${type.toString(16)}`;
        this.traceEvent({ ev: 'h3_peer_uni_stream', stream: stream.id, type: typeName });
        switch (type) {
            case BigInt(H3StreamType.CONTROL):
                if (this.peerControl !== null) throw new H3Error(H3ErrorCode.H3_STREAM_CREATION_ERROR, `second control stream ${stream.id}`);
                this.peerControl = stream;
                this.attachControlReader();
                return 'control';
            case BigInt(H3StreamType.PUSH):
                if (this.role === 'server') throw new H3Error(H3ErrorCode.H3_STREAM_CREATION_ERROR, `client-initiated push stream ${stream.id}`);
                throw new H3Error(H3ErrorCode.H3_ID_ERROR, `push stream ${stream.id}, but this client sent no MAX_PUSH_ID`);
            case BigInt(QpackStreamType.ENCODER):
                if (this.peerEncoder !== null) throw new H3Error(H3ErrorCode.H3_STREAM_CREATION_ERROR, `second QPACK encoder stream ${stream.id}`);
                this.peerEncoder = stream;
                return 'encoder';
            case BigInt(QpackStreamType.DECODER):
                if (this.peerDecoder !== null) throw new H3Error(H3ErrorCode.H3_STREAM_CREATION_ERROR, `second QPACK decoder stream ${stream.id}`);
                this.peerDecoder = stream;
                return 'decoder';
            default:
                // RFC 9114 Section 6.2: abort reading an unknown stream type, never a connection error.
                this.stats.unknownStreamTypes.push(typeName);
                stream.stopSending(H3ErrorCode.H3_STREAM_CREATION_ERROR);
                return 'unknown';
        }
    }

    private controlReader: FrameReader | null = null;

    private attachControlReader(): void {
        const sink: FrameSink = {
            frameStart: (type, length) => this.controlFrameStart(type, length),
            frame: (type, payload) => this.controlFrame(type, payload),
            data: () => undefined,
            frameEnd: () => undefined,
        };
        this.controlReader = new FrameReader(sink);
    }

    /** Bytes after the stream type of a peer unidirectional stream; an unknown type's bytes are discarded. */
    private uniData(kind: UniKind, bytes: Uint8Array): void {
        if (kind === 'control') (this.controlReader as FrameReader).push(bytes);
        else if (kind === 'encoder') this.encoderReceiver.feed(bytes);
        else if (kind === 'decoder') this.decoderReceiver.feed(bytes);
    }

    private controlFrameStart(type: number, length: number): FrameMode {
        // RFC 9114 Section 6.2.1: the first frame must be SETTINGS; any other type, unknown ones included, is H3_MISSING_SETTINGS.
        if (!this.settingsReceived && type !== H3FrameType.SETTINGS) throw new H3Error(H3ErrorCode.H3_MISSING_SETTINGS, `first frame on the control stream is ${frameTypeName(type)}, not SETTINGS`);
        switch (type) {
            case H3FrameType.SETTINGS:
                if (this.settingsReceived) throw new H3Error(H3ErrorCode.H3_FRAME_UNEXPECTED, 'second SETTINGS frame on the control stream');
                if (length > MAX_SETTINGS_PAYLOAD) throw new H3Error(H3ErrorCode.H3_EXCESSIVE_LOAD, `SETTINGS frame of ${length} bytes`);
                return 'buffer';
            case H3FrameType.MAX_PUSH_ID:
            case H3FrameType.GOAWAY:
            case H3FrameType.CANCEL_PUSH:
                if (type === H3FrameType.MAX_PUSH_ID && this.role === 'client') throw new H3Error(H3ErrorCode.H3_FRAME_UNEXPECTED, 'MAX_PUSH_ID frame from a server');
                if (length > 8) throw new H3Error(H3ErrorCode.H3_FRAME_ERROR, `${frameTypeName(type)} frame of ${length} bytes cannot hold exactly one identifier`);
                return 'buffer';
            case H3FrameType.DATA:
            case H3FrameType.HEADERS:
            case H3FrameType.PUSH_PROMISE:
                throw new H3Error(H3ErrorCode.H3_FRAME_UNEXPECTED, `${frameTypeName(type)} frame on the control stream`);
            default:
                if (H3_RESERVED_FRAME_TYPES.includes(type)) throw new H3Error(H3ErrorCode.H3_FRAME_UNEXPECTED, `${frameTypeName(type)} frame on the control stream`);
                this.noteUnknownFrame('control', type, length);
                return 'skip';
        }
    }

    private controlFrame(type: number, payload: Uint8Array): void {
        switch (type) {
            case H3FrameType.SETTINGS:
                return this.onSettings(payload);
            case H3FrameType.GOAWAY:
                return this.onGoaway(decodeSingleVarintPayload(payload, 'GOAWAY'));
            case H3FrameType.MAX_PUSH_ID: {
                const id = decodeSingleVarintPayload(payload, 'MAX_PUSH_ID');
                if (this.maxPushIdReceived !== null && id < this.maxPushIdReceived) throw new H3Error(H3ErrorCode.H3_ID_ERROR, `MAX_PUSH_ID ${id} reduces the maximum push ID ${this.maxPushIdReceived}`);
                this.maxPushIdReceived = id;
                this.traceEvent({ ev: 'h3_max_push_id', id: id.toString() });
                return;
            }
            case H3FrameType.CANCEL_PUSH: {
                const id = decodeSingleVarintPayload(payload, 'CANCEL_PUSH');
                throw new H3Error(H3ErrorCode.H3_ID_ERROR, this.role === 'server' ? `CANCEL_PUSH for push ID ${id}, which no PUSH_PROMISE mentioned` : `CANCEL_PUSH for push ID ${id}, beyond the maximum push ID (none was sent)`);
            }
            default:
                return;
        }
    }

    private onSettings(payload: Uint8Array): void {
        const settings = decodeSettingsPayload(payload);
        this.settingsReceived = true;
        this.peerSettings = settings;
        for (const [id, value] of settings) {
            if (id === LOCAL_SETTINGS_IDS.fieldSection) {
                this.peerMaxFieldSectionSize = value > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(value);
            } else if (id !== LOCAL_SETTINGS_IDS.capacity && id !== LOCAL_SETTINGS_IDS.blocked) {
                // Unknown identifiers, reserved ones included, are ignored (Section 7.2.4).
                this.stats.unknownSettings.push(`0x${id.toString(16)}${id <= 0xffffffffn && isReservedCodePoint(Number(id)) ? ' (reserved)' : ''}`);
            }
        }
        this.traceEvent({ ev: 'h3_settings_received', settings: settings.map(([id, value]) => [`0x${id.toString(16)}`, value.toString()]) });
        this.emit('settings', settings);
    }

    private onGoaway(id: bigint): void {
        if (this.role === 'client' && id % 4n !== 0n) throw new H3Error(H3ErrorCode.H3_ID_ERROR, `GOAWAY names stream ${id}, which is not a client-initiated bidirectional stream`);
        if (this.goawayReceived !== null && id > this.goawayReceived) throw new H3Error(H3ErrorCode.H3_ID_ERROR, `GOAWAY ${id} is larger than the previous GOAWAY ${this.goawayReceived}`);
        this.goawayReceived = id;
        this.traceEvent({ ev: 'h3_goaway_received', id: id.toString() });
        this.emit('goaway', id);
        if (this.role === 'client') {
            // Requests at or above the identifier were not processed (Section 5.2). They are cancelled with
            // H3_REQUEST_CANCELLED on the wire (a client may not send H3_REQUEST_REJECTED, Section 4.1.1)
            // and reported as H3_REQUEST_REJECTED: safe to retry on another connection.
            for (const request of [...this.requests.values()]) {
                if (BigInt(request.id) >= id) request.cancel(H3ErrorCode.H3_REQUEST_CANCELLED, `the server's GOAWAY ${id} did not accept stream ${request.id}`, H3ErrorCode.H3_REQUEST_REJECTED);
            }
        }
    }

    private acceptRequest(stream: QuicStream): void {
        const request = new Http3RequestStream(this, stream);
        this.requests.set(stream.id, request);
        if (this.goawaySent !== null && BigInt(stream.id) >= this.goawaySent) {
            this.stats.requestsRejected++;
            request.cancel(H3ErrorCode.H3_REQUEST_REJECTED, `request stream ${stream.id} arrived at or above the GOAWAY ${this.goawaySent} this server sent`);
            return;
        }
        if (stream.id > this.highestRequestId) this.highestRequestId = stream.id;
        this.emit('stream', request);
        request.on('headers', (event: HeadersEvent) => {
            if (event.kind === 'request') this.emit('request', request, event);
        });
    }

    // ------------------------------------------------------------------ bookkeeping

    noteUnknownFrame(where: string, type: number, length: number): void {
        if (this.stats.unknownFrames.length < 32) this.stats.unknownFrames.push({ where, type: `0x${type.toString(16)}${isReservedCodePoint(type) ? ' (reserved)' : ''}`, length });
    }

    noteFieldSection(representations: readonly string[]): void {
        this.stats.headersReceived++;
        for (const r of representations) {
            const key = r.replace(/:[0-9]+/, '');
            this.stats.representations[key] = (this.stats.representations[key] ?? 0) + 1;
        }
    }

    forgetRequest(request: Http3RequestStream): void {
        this.requests.delete(request.id);
        if (this.requests.size === 0) this.emit('idle');
    }

    /** A protocol failure outside a request stream: connection errors close the connection; anything else is an internal error. */
    failWith(error: unknown): void {
        if (this.closed) return;
        if (error instanceof H3Error) return this.connectionError(error);
        if (error instanceof QpackError) return this.connectionError(new H3Error(error.code, error.message));
        const message = String((error as Error)?.message ?? error);
        this.traceEvent({ ev: 'h3_internal_error', message, stack: String((error as Error)?.stack ?? '') });
        this.connectionError(new H3Error(H3ErrorCode.H3_INTERNAL_ERROR, `internal error: ${message}`));
    }

    private failSafe(fn: () => void): void {
        if (this.closed) return;
        try {
            fn();
        } catch (error) {
            this.failWith(error);
        }
    }

    private connectionError(error: H3Error): void {
        if (this.closed) return;
        this.localError = error;
        this.traceEvent({ ev: 'h3_connection_error', code: error.code, name: errorName(error.code), reason: error.message });
        this.emit('error', error);
        this.quic.close(error.code, error.message);
    }

    private onQuicClose(info: CloseInfo): void {
        if (this.closed) return;
        this.closed = true;
        this.closeInfo = info;
        const abort: AbortInfo = { code: info.errorCode, reason: info.reason || `connection closed with ${errorName(info.errorCode)}`, how: 'connection' };
        for (const request of [...this.requests.values()]) request.connectionClosed(abort);
        this.traceEvent({ ev: 'h3_closed', code: info.errorCode, name: errorName(info.errorCode), remote: info.remote, application: info.application, reason: info.reason });
        this.emit('close', info);
    }
}
