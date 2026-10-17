import type { CloseInfo, QuicConnection } from './connection';
import { Http3Connection, errorName } from './h3-connection';
import type { AbortInfo, HeadersEvent, Http3Options, Http3RequestStream } from './h3-connection';
import { fieldsToHeaders, headersToFields, rawHeadersOf } from './h3-fields';
import type { IncomingHeaders, OutgoingHeaders } from './h3-fields';
import { H3ErrorCode, H3FrameType, H3Setting, H3StreamType, QpackErrorCode, QpackSetting, QpackStreamType } from './http3-constants';
import { QpackDecoderStreamReceiver, QpackEncoderStreamReceiver, decodeFieldSectionDetailed, encodeFieldSection } from './qpack';

/*
 * The guest HTTP/3 API (require('owc:internal/http3')), shaped like the compatibility API of Node's
 * http2 module so a simple program carries over:
 *
 *   const http3 = require('owc:internal/http3');
 *   const server = http3.createSecureServer({ key, cert }, (req, res) => {
 *     // req.method, req.url, req.headers, req.authority, req.scheme; req is a Readable
 *     res.writeHead(200, { 'content-type': 'text/plain' });
 *     res.end('hello');
 *   });
 *   server.listen(4433, '127.0.0.1');
 *
 *   const client = http3.connect('https://localhost:4433', { ca });
 *   const req = client.request({ ':method': 'POST', ':path': '/upload' });
 *   req.on('response', (headers) => { ... headers[':status'] ... });
 *   req.on('data', (chunk) => { ... });
 *   req.on('end', () => client.close());
 *   req.end(body);
 *
 * Sessions are EventEmitters, streams are stream.Duplex, Http3ServerRequest is a stream.Readable, as
 * in Node. HTTP/3 has no PING, no SETTINGS updates and (here) no server push.
 */

/** What the API needs from the guest: Node-compatible events, stream and buffer modules, the QUIC API, and a macrotask timer. */
export interface Http3ApiEnvironment {
    readonly events: any;
    readonly stream: any;
    readonly Buffer: any;
    readonly quic: {
        createServer(options: Record<string, unknown>, onSession: (session: QuicConnection) => void): any;
        connect(options: Record<string, unknown>): QuicConnection;
    };
    readonly setTimeout: (callback: () => void, ms: number) => unknown;
}

const ERROR_CODES = { ...H3ErrorCode, ...QpackErrorCode };
/**
 * How long a graceful close waits after GOAWAY before it sends CONNECTION_CLOSE anyway. A session
 * whose request streams never report themselves idle would otherwise send nothing at all, and the
 * peer would learn of the close only from its own idle timeout.
 */
const GRACEFUL_CLOSE_GRACE_MS = 1500;

/** Raises an error thrown by user code from an event listener asynchronously, as an uncaught exception would be in Node. */
function rethrowLater(error: unknown): void {
    queueMicrotask(() => {
        throw error;
    });
}

function apiError(code: string, message: string, Ctor: ErrorConstructor = Error): Error {
    return Object.assign(new Ctor(message), { code });
}

function streamError(info: AbortInfo): Error {
    return Object.assign(new Error(`Stream closed with error code ${errorName(info.code)}`), { code: 'ERR_HTTP3_STREAM_ERROR', h3Code: info.code, reason: info.reason });
}

function sessionError(code: number, reason: string, remote: boolean): Error {
    return Object.assign(new Error(`Session closed with error code ${errorName(code)}${reason ? `: ${reason}` : ''}`), { code: 'ERR_HTTP3_SESSION_ERROR', h3Code: code, remote, reason });
}

function settingsObject(settings: ReadonlyArray<readonly [bigint, bigint]> | null): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (settings === null) return out;
    const unknown: Record<string, string> = {};
    for (const [id, value] of settings) {
        if (id === BigInt(QpackSetting.QPACK_MAX_TABLE_CAPACITY)) out.qpackMaxTableCapacity = Number(value);
        else if (id === BigInt(QpackSetting.QPACK_BLOCKED_STREAMS)) out.qpackBlockedStreams = Number(value);
        else if (id === BigInt(H3Setting.MAX_FIELD_SECTION_SIZE)) out.maxFieldSectionSize = Number(value);
        else unknown[`0x${id.toString(16)}`] = value.toString();
    }
    out.unknown = unknown;
    return out;
}

interface Authority {
    readonly host: string;
    readonly port: number;
    readonly authority: string;
}

function parseAuthority(authority: unknown): Authority {
    if (authority !== null && typeof authority === 'object') {
        const a = authority as { host?: string; hostname?: string; port?: number | string };
        const host = a.hostname ?? a.host ?? 'localhost';
        const port = Number(a.port ?? 443);
        return { host, port, authority: port === 443 ? host : `${host}:${port}` };
    }
    const match = /^https:\/\/(\[[^\]]+\]|[^:/?#]+)(?::([0-9]+))?/.exec(String(authority));
    if (match === null) throw apiError('ERR_HTTP3_UNSUPPORTED_PROTOCOL', `protocol "${String(authority).split(':')[0]}:" not supported; HTTP/3 needs https:`);
    const host = match[1].replace(/^\[|\]$/g, '');
    const port = match[2] !== undefined ? Number(match[2]) : 443;
    return { host, port, authority: match[2] !== undefined ? `${match[1]}:${match[2]}` : match[1] };
}

/** Builds the API object from the guest environment. */
export function createHttp3Api(env: Http3ApiEnvironment) {
    const EventEmitter = typeof env.events === 'function' ? env.events : env.events.EventEmitter;
    const { Duplex, Readable } = env.stream;
    const Buffer = env.Buffer;

    const toBuffer = (bytes: Uint8Array): any => (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));

    /** Emits on an emitter; a listener's exception surfaces later instead of unwinding the protocol code. */
    function deliver(target: any, name: string, ...args: unknown[]): boolean {
        try {
            return target.emit(name, ...args);
        } catch (error) {
            rethrowLater(error);
            return true;
        }
    }

    /**
     * One HTTP/3 request stream as a Duplex (Node's Http2Stream shape). Client streams emit
     * 'response' (headers, flags, rawHeaders), 'headers' for interim responses, 'trailers'; server
     * streams are passed to the 'stream' event with the request headers.
     */
    class Http3Stream extends Duplex {
        session: Http3Session;
        core: Http3RequestStream | null;
        id: number | undefined;
        sentHeaders: OutgoingHeaders | null = null;
        sentTrailers: OutgoingHeaders | null = null;
        sentInfoHeaders: OutgoingHeaders[] = [];
        headersSent = false;
        aborted = false;
        rstCode: number | undefined = undefined;
        pendingTrailers: OutgoingHeaders | null = null;
        queued: { chunk: any; callback: (error?: Error | null) => void }[] = [];
        finalCallback: ((error?: Error | null) => void) | null = null;
        readonly role: 'client' | 'server';

        constructor(session: Http3Session, core: Http3RequestStream | null, role: 'client' | 'server') {
            super({ allowHalfOpen: true, autoDestroy: false });
            this.session = session;
            this.role = role;
            this.core = null;
            this.id = undefined;
            if (core !== null) this.attach(core);
        }

        attach(core: Http3RequestStream): void {
            this.core = core;
            this.id = core.id;
            core.on('headers', (event: HeadersEvent) => this.onCoreHeaders(event));
            core.on('data', (chunk: Uint8Array) => {
                if (!this.destroyed) this.push(toBuffer(chunk));
            });
            core.on('end', () => {
                if (!this.destroyed) this.push(null);
            });
            core.on('aborted', (info: AbortInfo) => this.onCoreAborted(info));
            core.on('close', () => this.onCoreClose());
        }

        get pending(): boolean {
            return this.core === null;
        }

        get state(): Record<string, unknown> {
            return { recv: this.core?.recvState, send: this.core?.sendState, closed: this.core?.closed ?? false };
        }

        /** Client: sends the request header section once the session is connected. */
        sendRequestHeaders(headers: OutgoingHeaders, endStream: boolean): void {
            const core = this.core as Http3RequestStream;
            core.sendHeaders(headersToFields(headers, 'request'), endStream);
            this.sentHeaders = headers;
            this.headersSent = true;
            const queued = this.queued;
            this.queued = [];
            for (const entry of queued) this._write(entry.chunk, 'buffer', entry.callback);
            if (this.finalCallback !== null) {
                const callback = this.finalCallback;
                this.finalCallback = null;
                this._final(callback);
            }
        }

        /** Server: sends the response header section (Http2Stream.respond). */
        respond(headers: OutgoingHeaders = {}, options: { endStream?: boolean; waitForTrailers?: boolean } = {}): void {
            if (this.role !== 'server') throw apiError('ERR_HTTP3_INVALID_STREAM', 'respond() is for server streams');
            if (this.headersSent) throw apiError('ERR_HTTP3_HEADERS_SENT', 'Response has already been initiated.');
            if (this.destroyed || this.core === null || this.core.closed) throw apiError('ERR_HTTP3_INVALID_STREAM', 'The stream has been destroyed');
            const h: Record<string, unknown> = { ...headers };
            if (h[':status'] === undefined) h[':status'] = 200;
            const endStream = options.endStream === true;
            this.core.sendHeaders(headersToFields(h as OutgoingHeaders, 'response'), endStream);
            this.sentHeaders = h as OutgoingHeaders;
            this.headersSent = true;
            if (endStream) this.end();
        }

        /** Server: an interim (1xx) response. */
        additionalHeaders(headers: OutgoingHeaders): void {
            if (this.headersSent) throw apiError('ERR_HTTP3_HEADERS_AFTER_RESPOND', 'Cannot specify additional headers after response initiated');
            const status = Number(headers[':status']);
            if (!(status >= 100 && status < 200) || status === 101) throw apiError('ERR_HTTP3_INVALID_INFO_STATUS', `Invalid informational status code: ${String(headers[':status'])}`, RangeError);
            (this.core as Http3RequestStream).sendHeaders(headersToFields(headers, 'response'));
            this.sentInfoHeaders.push(headers);
        }

        /** Sends trailers when the writable side ends (instead of a bare FIN). */
        sendTrailers(headers: OutgoingHeaders): void {
            this.pendingTrailers = headers;
            if (!this.writableEnded) this.end();
        }

        /** Closes the stream abruptly with an HTTP/3 error code (default H3_NO_ERROR). */
        close(code: number = H3ErrorCode.H3_NO_ERROR, callback?: () => void): void {
            if (callback) this.once('close', callback);
            if (this.core !== null && !this.core.closed) this.core.cancel(code, 'closed by the application');
            else if (this.core === null) this.destroy();
        }

        _read(): void {
            // Data is pushed as it arrives; the QUIC layer extends the flow-control windows as it delivers.
        }

        _write(chunk: any, _encoding: string, callback: (error?: Error | null) => void): void {
            const core = this.core;
            if (core === null || !this.headersSent) {
                if (this.role === 'server' && core !== null) this.respond({ ':status': 200 });
                else {
                    this.queued.push({ chunk, callback });
                    return;
                }
            }
            try {
                (this.core as Http3RequestStream).sendData(chunk);
                callback();
            } catch (error) {
                callback(error as Error);
            }
        }

        _final(callback: (error?: Error | null) => void): void {
            const core = this.core;
            if (core === null || !this.headersSent) {
                if (this.role === 'server' && core !== null) {
                    this.respond({ ':status': 200 }, { endStream: this.pendingTrailers === null });
                    if (this.pendingTrailers === null) return callback();
                } else {
                    this.finalCallback = callback;
                    return;
                }
            }
            try {
                const live = this.core as Http3RequestStream;
                if (live.sendState !== 'done') {
                    if (this.pendingTrailers !== null) {
                        live.sendHeaders(headersToFields(this.pendingTrailers, 'trailers'));
                        this.sentTrailers = this.pendingTrailers;
                    } else {
                        live.end();
                    }
                }
                callback();
            } catch (error) {
                callback(error as Error);
            }
        }

        _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
            if (this.core !== null && !this.core.closed) this.core.cancel(error ? H3ErrorCode.H3_REQUEST_CANCELLED : H3ErrorCode.H3_NO_ERROR, error ? String(error.message) : 'destroyed');
            callback(error);
        }

        onCoreHeaders(event: HeadersEvent): void {
            const headers = fieldsToHeaders(event.fields);
            const raw = rawHeadersOf(event.fields);
            if (event.kind === 'trailers') deliver(this, 'trailers', headers, 0, raw);
            else if (event.kind === 'informational') deliver(this, 'headers', headers, 0, raw);
            else if (event.kind === 'response') deliver(this, 'response', headers, 0, raw);
        }

        /** As Node's http2 does for NGHTTP2_NO_ERROR and NGHTTP2_CANCEL, H3_NO_ERROR and H3_REQUEST_CANCELLED end the stream without an 'error'. */
        onCoreAborted(info: AbortInfo): void {
            this.aborted = true;
            this.rstCode = info.code;
            deliver(this, 'aborted', info);
            if (info.code === H3ErrorCode.H3_NO_ERROR || info.code === H3ErrorCode.H3_REQUEST_CANCELLED) return;
            if (!this.destroyed) this.destroy(streamError(info));
        }

        /**
         * The QUIC stream is done. After a clean exchange the Duplex is destroyed once its readable side
         * has been consumed (so no received data is dropped); 'close' then follows, after any 'error'.
         */
        onCoreClose(): void {
            if (this.destroyed) return;
            const core = this.core as Http3RequestStream;
            if (core.abort === null && core.recvEnded && !this.readableEnded) {
                this.once('end', () => {
                    if (!this.destroyed) this.destroy();
                });
                // As Node does for server streams nobody read: drop the data so the stream can close.
                if (this.role === 'server' && this.readableFlowing === null) this.resume();
                return;
            }
            this.destroy();
        }
    }

    /** Node's Http2ServerRequest shape. */
    class Http3ServerRequest extends Readable {
        stream: Http3Stream;
        headers: IncomingHeaders;
        rawHeaders: string[];
        method: string;
        url: string;
        authority: string | undefined;
        scheme: string | undefined;
        /** RFC 9114 Section 4.3.1: HTTP/3 requests implicitly have protocol version "3.0". */
        httpVersion = '3.0';
        httpVersionMajor = 3;
        httpVersionMinor = 0;
        complete = false;
        aborted = false;
        trailers: IncomingHeaders = Object.create(null);
        rawTrailers: string[] = [];

        constructor(stream: Http3Stream, headers: IncomingHeaders, raw: string[]) {
            super({ autoDestroy: false });
            this.stream = stream;
            this.headers = headers;
            this.rawHeaders = raw;
            this.method = String(headers[':method']);
            this.url = String(headers[':path'] ?? '');
            this.authority = headers[':authority'] as string | undefined;
            this.scheme = headers[':scheme'] as string | undefined;
            stream.on('data', (chunk: any) => this.push(chunk));
            stream.on('end', () => {
                this.complete = true;
                this.push(null);
            });
            stream.on('trailers', (trailers: IncomingHeaders, _flags: number, raw2: string[]) => {
                this.trailers = trailers;
                this.rawTrailers = raw2;
            });
            stream.on('aborted', () => {
                this.aborted = true;
                deliver(this, 'aborted');
            });
            stream.on('close', () => {
                this.complete = true;
                deliver(this, 'close');
            });
            stream.on('error', () => {
                // Reported on the stream and the response; the request only observes.
            });
        }

        _read(): void {
            // Fed by the stream as data arrives.
        }

        get socket(): unknown {
            return this.stream.session;
        }
    }

    /** Node's Http2ServerResponse shape. */
    class Http3ServerResponse extends EventEmitter {
        stream: Http3Stream;
        req: Http3ServerRequest;
        statusMessage = '';
        finished = false;
        status = 200;
        readonly fields: Record<string, unknown> = Object.create(null);
        trailers: Record<string, unknown> | null = null;

        constructor(stream: Http3Stream, req: Http3ServerRequest) {
            super();
            this.stream = stream;
            this.req = req;
            stream.on('finish', () => deliver(this, 'finish'));
            stream.on('close', () => deliver(this, 'close'));
            stream.on('error', () => {
                // Surfaced through 'close' and the stream's own listeners.
            });
        }

        get statusCode(): number {
            return this.status;
        }

        set statusCode(code: number) {
            const n = Number(code) | 0;
            if (n >= 100 && n < 200) throw apiError('ERR_HTTP3_INFO_STATUS_NOT_ALLOWED', 'Informational status codes cannot be used', RangeError);
            if (n < 200 || n > 599) throw apiError('ERR_HTTP3_STATUS_INVALID', `Invalid status code: ${code}`, RangeError);
            this.status = n;
        }

        get headersSent(): boolean {
            return this.stream.headersSent;
        }

        get writableEnded(): boolean {
            return this.finished;
        }

        setHeader(name: string, value: unknown): this {
            if (this.stream.headersSent) throw apiError('ERR_HTTP3_HEADERS_SENT', 'Response has already been initiated.');
            const key = String(name).toLowerCase();
            if (key.charCodeAt(0) === 0x3a) throw apiError('ERR_HTTP3_PSEUDOHEADER_NOT_ALLOWED', 'Cannot set HTTP/3 pseudo-headers', TypeError);
            if (value === undefined) throw apiError('ERR_HTTP3_INVALID_HEADER_VALUE', `Invalid value "undefined" for header "${name}"`, TypeError);
            this.fields[key] = value;
            return this;
        }

        getHeader(name: string): unknown {
            return this.fields[String(name).toLowerCase()];
        }

        getHeaders(): Record<string, unknown> {
            return { ...this.fields };
        }

        getHeaderNames(): string[] {
            return Object.keys(this.fields);
        }

        hasHeader(name: string): boolean {
            return this.fields[String(name).toLowerCase()] !== undefined;
        }

        removeHeader(name: string): void {
            if (this.stream.headersSent) throw apiError('ERR_HTTP3_HEADERS_SENT', 'Response has already been initiated.');
            delete this.fields[String(name).toLowerCase()];
        }

        addTrailers(trailers: Record<string, unknown>): void {
            const copy = this.trailers ?? {};
            for (const key of Object.keys(trailers ?? {})) copy[key.toLowerCase()] = trailers[key];
            this.trailers = copy;
        }

        writeHead(statusCode: number, statusMessage?: unknown, headers?: Record<string, unknown>): this {
            if (typeof statusMessage === 'object' && statusMessage !== null) {
                headers = statusMessage as Record<string, unknown>;
                statusMessage = undefined;
            }
            if (this.stream.headersSent) throw apiError('ERR_HTTP3_HEADERS_SENT', 'Response has already been initiated.');
            this.statusCode = statusCode;
            if (typeof statusMessage === 'string') this.statusMessage = statusMessage;
            if (headers) for (const name of Object.keys(headers)) this.setHeader(name, headers[name]);
            this.sendHead(false);
            return this;
        }

        flushHeaders(): void {
            if (!this.stream.headersSent) this.sendHead(false);
        }

        write(chunk: unknown, encoding?: unknown, callback?: unknown): boolean {
            if (typeof encoding === 'function') {
                callback = encoding;
                encoding = undefined;
            }
            if (this.finished) {
                const error = apiError('ERR_STREAM_WRITE_AFTER_END', 'write after end');
                if (typeof callback === 'function') queueMicrotask(() => (callback as (e: Error) => void)(error));
                return false;
            }
            if (this.stream.destroyed) return false;
            if (!this.stream.headersSent) this.sendHead(false);
            return this.stream.write(chunk, encoding, callback);
        }

        end(data?: unknown, encoding?: unknown, callback?: unknown): this {
            if (typeof data === 'function') {
                callback = data;
                data = undefined;
                encoding = undefined;
            } else if (typeof encoding === 'function') {
                callback = encoding;
                encoding = undefined;
            }
            if (this.finished) return this;
            this.finished = true;
            const stream = this.stream;
            if (stream.destroyed) return this;
            if (typeof callback === 'function') stream.once('finish', callback);
            const hasData = data !== undefined && data !== null;
            if (!stream.headersSent) this.sendHead(!hasData && this.trailers === null);
            if (hasData) stream.write(data, encoding);
            if (this.trailers !== null) stream.sendTrailers(this.trailers as OutgoingHeaders);
            else if (!stream.writableEnded) stream.end();
            return this;
        }

        sendHead(endStream: boolean): void {
            if (this.stream.destroyed) return;
            this.stream.respond({ ':status': this.status, ...this.fields } as OutgoingHeaders, { endStream });
        }
    }

    /**
     * One HTTP/3 connection (Node's Http2Session shape). Events: 'connect' (session), 'localSettings',
     * 'remoteSettings' (settings object), 'stream' (server: stream, headers, flags, rawHeaders),
     * 'goaway' (code, lastStreamID), 'error', 'close'.
     */
    class Http3Session extends EventEmitter {
        quic: QuicConnection;
        h3: Http3Connection;
        readonly type: 'client' | 'server';
        authority: Authority | null;
        server: Http3Server | null;
        connecting: boolean;
        destroyed = false;
        closed = false;
        closeInfo: CloseInfo | null = null;
        /** Requests made before the connection is up. */
        readonly pendingRequests: { stream: Http3Stream; headers: OutgoingHeaders; endStream: boolean }[] = [];
        /** Requests waiting for the peer to allow more bidirectional streams (MAX_STREAMS), in order. */
        readonly blockedRequests: { stream: Http3Stream; headers: OutgoingHeaders; endStream: boolean }[] = [];
        /** Live request streams of this session. */
        readonly streams = new Set<Http3Stream>();
        closing = false;
        closeArmed = false;
        closeFallback: unknown = null;
        retryArmed = false;

        constructor(quic: QuicConnection, options: Http3Options, authority: Authority | null, server: Http3Server | null) {
            super();
            this.quic = quic;
            this.type = quic.role;
            this.authority = authority;
            this.server = server;
            this.connecting = true;
            this.h3 = new Http3Connection(quic, options);
            this.h3.on('open', () => {
                this.connecting = false;
                deliver(this, 'localSettings', this.localSettings);
                if (this.type === 'client') this.flushPendingRequests();
                deliver(this, 'connect', this, null);
            });
            this.h3.on('settings', () => deliver(this, 'remoteSettings', this.remoteSettings));
            this.h3.on('goaway', (id: bigint) => deliver(this, 'goaway', H3ErrorCode.H3_NO_ERROR, Number(id)));
            this.h3.on('error', (error: Error & { code: number }) => {
                if (this.listenerCount('error') > 0) deliver(this, 'error', sessionError(error.code, error.message, false));
            });
            this.h3.on('close', (info: CloseInfo) => this.onClose(info));
            this.h3.on('idle', () => this.maybeFinishClose());
            // The peer raised our stream limit: requests that waited on it can go out now (RFC 9000 Section 4.6).
            quic.on('streams', () => this.openBlocked());
            if (this.type === 'server') {
                this.h3.on('request', (core: Http3RequestStream, event: HeadersEvent) => this.onRequest(core, event));
            }
        }

        get alpnProtocol(): string | null {
            return this.quic.alpnProtocol;
        }

        get encrypted(): boolean {
            return true;
        }

        get localSettings(): Record<string, unknown> {
            return settingsObject(this.h3.localSettings);
        }

        get remoteSettings(): Record<string, unknown> {
            return settingsObject(this.h3.peerSettings);
        }

        /** Client: opens a request; it is sent once the connection is up. */
        request(headers: OutgoingHeaders = {}, options: { endStream?: boolean } = {}): Http3Stream {
            if (this.type !== 'client') throw apiError('ERR_HTTP3_INVALID_SESSION', 'request() is for client sessions');
            if (this.destroyed || this.closed || this.closing) throw apiError('ERR_HTTP3_INVALID_SESSION', 'The session has been destroyed');
            if (this.h3.goawayReceived !== null) throw apiError('ERR_HTTP3_GOAWAY_SESSION', 'New streams cannot be created after receiving a GOAWAY');
            const h: Record<string, unknown> = { ...headers };
            const method = String(h[':method'] ?? 'GET').toUpperCase();
            h[':method'] = method;
            if (method !== 'CONNECT') {
                if (h[':scheme'] === undefined) h[':scheme'] = 'https';
                if (h[':path'] === undefined) h[':path'] = '/';
            }
            if (h[':authority'] === undefined && this.authority !== null) h[':authority'] = this.authority.authority;
            const endStream = options.endStream ?? (method === 'GET' || method === 'HEAD' || method === 'DELETE');
            // Validate now, so a bad header throws here rather than later.
            headersToFields(h as OutgoingHeaders, 'request');
            const stream = new Http3Stream(this, null, 'client');
            if (this.connecting) this.pendingRequests.push({ stream, headers: h as OutgoingHeaders, endStream });
            else this.startRequest(stream, h as OutgoingHeaders, endStream);
            return stream;
        }

        /**
         * Opens queued requests in order until the peer's stream limit stops it. The QUIC layer reports
         * the peer's MAX_STREAMS as a 'streams' event, and one of this session's requests closing reopens
         * the queue; a timer of about one RTT covers a MAX_STREAMS that was lost (RFC 9002 Section 6.2.4).
         */
        startRequest(stream: Http3Stream, headers: OutgoingHeaders, endStream: boolean): void {
            this.blockedRequests.push({ stream, headers, endStream });
            this.openBlocked();
        }

        flushPendingRequests(): void {
            const pending = this.pendingRequests.splice(0);
            for (const { stream, headers, endStream } of pending) this.startRequest(stream, headers, endStream);
        }

        /** Opens queued requests in order until the peer's stream limit stops it, then retries later. */
        openBlocked(): void {
            while (this.blockedRequests.length > 0 && !this.closed) {
                const next = this.blockedRequests[0];
                if (next.stream.destroyed) {
                    this.blockedRequests.shift();
                    continue;
                }
                let core: Http3RequestStream;
                try {
                    core = this.h3.openRequest();
                } catch (error) {
                    if ((error as { code?: string }).code === 'ERR_QUIC_STREAM_LIMIT') {
                        this.scheduleRetry();
                        return;
                    }
                    this.blockedRequests.shift();
                    next.stream.destroy(error as Error);
                    continue;
                }
                this.blockedRequests.shift();
                this.launch(next.stream, core, next.headers, next.endStream);
            }
            this.maybeFinishClose();
        }

        /**
         * The QUIC layer reports no event when the peer raises MAX_STREAMS, so a blocked queue is retried
         * when one of this session's requests closes and on a timer of about one RTT while it waits.
         */
        scheduleRetry(): void {
            if (this.retryArmed || this.closed) return;
            this.retryArmed = true;
            const rtt = this.quic.rtt.smoothed;
            env.setTimeout(() => {
                this.retryArmed = false;
                this.openBlocked();
            }, Math.min(200, Math.max(10, Math.ceil(Number.isFinite(rtt) && rtt > 0 ? rtt : 25))));
        }

        launch(stream: Http3Stream, core: Http3RequestStream, headers: OutgoingHeaders, endStream: boolean): void {
            try {
                stream.attach(core);
                this.track(stream);
                core.on('close', () => {
                    if (this.blockedRequests.length > 0) env.setTimeout(() => this.openBlocked(), 0);
                });
                stream.sendRequestHeaders(headers, endStream);
                if (endStream && !stream.writableEnded) stream.end();
                deliver(stream, 'ready');
            } catch (error) {
                stream.destroy(error as Error);
            }
        }

        track(stream: Http3Stream): void {
            this.streams.add(stream);
            stream.once('close', () => this.streams.delete(stream));
        }

        maybeFinishClose(): void {
            if (this.closing && this.h3.busyCount === 0 && this.blockedRequests.length === 0) this.finishGracefulClose();
        }

        onRequest(core: Http3RequestStream, event: HeadersEvent): void {
            const stream = new Http3Stream(this, core, 'server');
            this.track(stream);
            const headers = fieldsToHeaders(event.fields);
            const raw = rawHeadersOf(event.fields);
            deliver(this, 'stream', stream, headers, 0, raw);
            if (this.server !== null) this.server.onStream(stream, headers, raw);
        }

        /** Sends GOAWAY; a server names the first request stream it will not process. */
        goaway(_code?: number, lastStreamID?: number): void {
            this.h3.sendGoaway(lastStreamID === undefined ? undefined : BigInt(lastStreamID));
        }

        /**
         * Graceful close: GOAWAY, then CONNECTION_CLOSE with H3_NO_ERROR once the open requests are
         * done (a short delay lets the GOAWAY reach the peer first).
         */
        close(callback?: () => void): void {
            if (this.closed) {
                // Node never calls the callback of close() on a closed session; calling it avoids a silent hang.
                if (callback) env.setTimeout(callback, 0);
                return;
            }
            if (callback) this.once('close', callback);
            if (this.closing) return;
            this.closing = true;
            if (this.connecting) {
                this.destroy();
                return;
            }
            try {
                this.h3.sendGoaway();
            } catch {
                // The control stream is gone; closing anyway.
            }
            this.maybeFinishClose();
            // The streams may never reach the bookkeeping that reports them idle (a stream whose Duplex
            // is never destroyed, a request the peer never answers). GOAWAY is out, so bound the wait:
            // the peer still has to see a CONNECTION_CLOSE rather than an idle timeout.
            if (!this.closeArmed && this.closeFallback === null) {
                this.closeFallback = env.setTimeout(() => {
                    this.closeFallback = null;
                    this.finishGracefulClose();
                }, GRACEFUL_CLOSE_GRACE_MS);
            }
        }

        finishGracefulClose(): void {
            if (this.closeArmed) return;
            this.closeArmed = true;
            this.closeFallback = null;
            const rtt = this.quic.rtt.smoothed;
            const delay = Math.min(1000, Math.max(20, Math.ceil(3 * (Number.isFinite(rtt) ? rtt : 100))));
            env.setTimeout(() => {
                if (!this.closed) this.h3.close(H3ErrorCode.H3_NO_ERROR, '');
            }, delay);
        }

        /** Immediate close with an HTTP/3 error code (default H3_NO_ERROR, or H3_INTERNAL_ERROR when an error is given). */
        destroy(error?: Error, code?: number): void {
            if (this.destroyed) return;
            this.destroyed = true;
            const h3Code = code ?? (error ? H3ErrorCode.H3_INTERNAL_ERROR : H3ErrorCode.H3_NO_ERROR);
            if (error && this.listenerCount('error') > 0) deliver(this, 'error', error);
            for (const { stream } of this.pendingRequests.splice(0).concat(this.blockedRequests.splice(0))) stream.destroy(apiError('ERR_HTTP3_STREAM_CANCEL', 'The pending stream has been canceled'));
            this.h3.close(h3Code, error ? String(error.message) : '');
        }

        onClose(info: CloseInfo): void {
            if (this.closed) return;
            this.closed = true;
            this.closeInfo = info;
            this.destroyed = true;
            for (const { stream } of this.pendingRequests.splice(0).concat(this.blockedRequests.splice(0))) stream.destroy(sessionError(info.errorCode, info.reason, info.remote));
            // As Node's session destroy does: streams still open, or done but with an unread body, are destroyed now.
            for (const stream of [...this.streams]) if (!stream.destroyed) stream.destroy();
            if (info.errorCode !== H3ErrorCode.H3_NO_ERROR && info.errorCode !== 0 && this.listenerCount('error') > 0 && info.remote) {
                deliver(this, 'error', sessionError(info.errorCode, info.reason, true));
            }
            deliver(this, 'close', info);
        }
    }

    /** Node's Http2SecureServer shape over a QUIC server: 'listening', 'session', 'stream', 'request', 'close', 'error'. */
    class Http3Server extends EventEmitter {
        readonly options: Record<string, any>;
        quicServer: any = null;
        readonly sessions = new Set<Http3Session>();

        constructor(options: Record<string, any>, onRequest?: (req: Http3ServerRequest, res: Http3ServerResponse) => void) {
            super();
            this.options = options ?? {};
            if (typeof onRequest === 'function') this.on('request', onRequest);
        }

        listen(port = 0, host: string | (() => void) = '127.0.0.1', callback?: () => void): this {
            if (typeof host === 'function') {
                callback = host;
                host = '127.0.0.1';
            }
            if (callback) this.once('listening', callback);
            const o = this.options;
            const quicOptions = { ...(o.quic ?? {}), key: o.key, cert: o.cert, ca: o.ca, alpn: ['h3'], retry: o.retry, suites: o.suites, groups: o.groups, transport: o.transport, idleTimeout: o.idleTimeout, trace: o.trace };
            this.quicServer = env.quic.createServer(quicOptions, (quic: QuicConnection) => {
                const session = new Http3Session(quic, this.h3Options(), null, this);
                this.sessions.add(session);
                session.on('close', () => this.sessions.delete(session));
                deliver(this, 'session', session);
            });
            this.quicServer.on('error', (error: Error) => deliver(this, 'error', error));
            this.quicServer.on('listening', () => deliver(this, 'listening'));
            this.quicServer.listen(port, host, undefined);
            return this;
        }

        h3Options(): Http3Options {
            const o = this.options;
            return { maxFieldSectionSize: o.settings?.maxFieldSectionSize ?? o.maxFieldSectionSize, huffman: o.huffman, maxHeaderBlock: o.maxHeaderBlock, greaseSetting: o.greaseSetting, trace: o.h3Trace };
        }

        address(): { address: string; port: number; family: string } | null {
            if (this.quicServer === null) return null;
            const a = this.quicServer.address();
            return { address: a.address, port: a.port, family: a.family ?? 'IPv4' };
        }

        onStream(stream: Http3Stream, headers: IncomingHeaders, raw: string[]): void {
            deliver(this, 'stream', stream, headers, 0, raw);
            if (this.listenerCount('request') === 0) return;
            const req = new Http3ServerRequest(stream, headers, raw);
            const res = new Http3ServerResponse(stream, req);
            deliver(this, 'request', req, res);
        }

        /** Stops accepting connections: GOAWAY to every session, which closes once its requests are done. */
        close(callback?: () => void): this {
            if (callback) this.once('close', callback);
            const sessions = [...this.sessions];
            const done = (): void => {
                if (this.quicServer !== null) this.quicServer.close();
                this.quicServer = null;
                deliver(this, 'close');
            };
            if (sessions.length === 0) {
                done();
                return this;
            }
            let open = sessions.length;
            for (const session of sessions) {
                session.once('close', () => {
                    open--;
                    if (open === 0) done();
                });
                session.close();
            }
            return this;
        }
    }

    function createSecureServer(options: Record<string, unknown> | ((req: Http3ServerRequest, res: Http3ServerResponse) => void), onRequest?: (req: Http3ServerRequest, res: Http3ServerResponse) => void): Http3Server {
        if (typeof options === 'function') return new Http3Server({}, options);
        return new Http3Server(options ?? {}, onRequest);
    }

    /** Connects to an HTTP/3 server; authority is an https: URL or { host, port }. */
    function connect(authority: unknown, options: Record<string, any> = {}, listener?: (session: Http3Session) => void): Http3Session {
        if (typeof options === 'function') {
            listener = options as unknown as (session: Http3Session) => void;
            options = {};
        }
        const target = parseAuthority(authority);
        const host = options.host ?? target.host;
        const port = options.port ?? target.port;
        // Checked here: the QUIC layer would only fail when its first datagram goes out, from a timer.
        if (!Number.isInteger(port) || port <= 0 || port > 65535) throw apiError('ERR_SOCKET_BAD_PORT', `Port should be > 0 and < 65536. Received ${String(port)}.`, RangeError);
        const quic = env.quic.connect({
            ...(options.quic ?? {}),
            host,
            port,
            servername: options.servername ?? (/^[0-9.]+$/.test(target.host) || target.host.indexOf(':') >= 0 ? undefined : target.host),
            ca: options.ca,
            rejectUnauthorized: options.rejectUnauthorized,
            localPort: options.localPort,
            alpn: ['h3'],
            suites: options.suites,
            groups: options.groups,
            transport: options.transport,
            idleTimeout: options.idleTimeout,
            trace: options.trace,
            key: options.key,
            cert: options.cert,
        });
        const h3Options: Http3Options = { maxFieldSectionSize: options.settings?.maxFieldSectionSize ?? options.maxFieldSectionSize, huffman: options.huffman, maxHeaderBlock: options.maxHeaderBlock, greaseSetting: options.greaseSetting, trace: options.h3Trace };
        const session = new Http3Session(quic, h3Options, target, null);
        if (listener) session.once('connect', listener);
        return session;
    }

    return {
        createSecureServer,
        /** HTTP/3 always runs over TLS; createServer is createSecureServer. */
        createServer: createSecureServer,
        connect,
        constants: {
            ...ERROR_CODES,
            FRAME_TYPES: { ...H3FrameType },
            STREAM_TYPES: { ...H3StreamType, ...QpackStreamType },
            SETTINGS: { ...QpackSetting, ...H3Setting },
            HTTP3_HEADER_STATUS: ':status',
            HTTP3_HEADER_METHOD: ':method',
            HTTP3_HEADER_AUTHORITY: ':authority',
            HTTP3_HEADER_SCHEME: ':scheme',
            HTTP3_HEADER_PATH: ':path',
        },
        errorName,
        Http3Session,
        Http3Stream,
        Http3Server,
        Http3ServerRequest,
        Http3ServerResponse,
        /** The protocol core, for diagnostics. */
        Http3Connection,
        /** The QPACK codec (static table only) and the encoder/decoder stream receivers, for diagnostics. */
        qpack: { encodeFieldSection, decodeFieldSectionDetailed, QpackEncoderStreamReceiver, QpackDecoderStreamReceiver },
    };
}

export type Http3Api = ReturnType<typeof createHttp3Api>;
