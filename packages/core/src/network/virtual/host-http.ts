/**
 * Host side of the HTTP bridge over the virtual network.
 *
 * 1. The preview path: a host request (the playground's preview) reaches a guest http server on a
 *    port. The host opens a loopback connection with HOST_PID, writes the raw HTTP/1.1 request, and
 *    reads the raw response until its framing completes (Content-Length, chunked, or close).
 * 2. Observers: the guest http capabilities report when a server binds or releases a port, so the
 *    container's server list and listen callbacks stay in step with the hub.
 *
 * attachHostHttp installs the host sink (the only consumer of deliveries for HOST_PID owners). It is
 * idempotent per hub, so the NetworkManager that owns the hub calls it once.
 */
import { HOST_PID, VirtualNetwork, VirtualSink } from './hub';

export interface GuestServerObserver {
    listen(pid: number, port: number): void;
    close(pid: number, port: number): void;
}

/** The request fields the preview path uses (a subset of the container's HostRequest). */
export interface HostHttpRequest {
    method?: string;
    url?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string;
}

interface ParsedHead {
    status: number;
    statusText: string;
    headers: Array<[string, string]>;
}

interface HostHttpState {
    attached: boolean;
    nextTargetId: number;
    targets: Map<number, (name: string, payload: unknown) => void>;
    observers: Set<GuestServerObserver>;
}

const REQUEST_TIMEOUT_MS = 30000;
const HOP_BY_HOP_REQUEST_HEADERS = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'content-length', 'te', 'trailer', 'upgrade']);
const NO_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);
const states = new WeakMap<VirtualNetwork, HostHttpState>();

function stateOf(network: VirtualNetwork): HostHttpState {
    let state = states.get(network);
    if (!state) {
        state = { attached: false, nextTargetId: 1, targets: new Map(), observers: new Set() };
        states.set(network, state);
    }
    return state;
}

/** Installs the host sink that receives deliveries for HOST_PID owners. Idempotent per hub. */
export function attachHostHttp(network: VirtualNetwork): void {
    const state = stateOf(network);
    if (state.attached) return;
    state.attached = true;
    const sink: VirtualSink = {
        deliver(targetId, name, payload) {
            const handler = state.targets.get(targetId);
            if (handler) handler(name, payload);
        },
        holdRef() {
            // host connections hold nothing alive: each request is bounded by its own timeout
        },
    };
    network.setHostSink(sink);
}

/** Subscribes to guest server bind and release events on a hub. Returns the unsubscribe function. */
export function watchGuestServers(network: VirtualNetwork, observer: GuestServerObserver): () => void {
    const state = stateOf(network);
    state.observers.add(observer);
    return () => {
        state.observers.delete(observer);
    };
}

/** Called by the http capabilities when a guest server binds or releases its port. */
export function notifyGuestServer(network: VirtualNetwork, event: 'listen' | 'close', pid: number, port: number): void {
    for (const observer of stateOf(network).observers) {
        if (event === 'listen') observer.listen(pid, port);
        else observer.close(pid, port);
    }
}

export function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(offset, offset + 0x8000)));
    }
    return btoa(binary);
}

export function base64ToBytes(text: string): Uint8Array {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
    let length = 0;
    for (const part of parts) length += part.length;
    const out = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

/** HTTP head bytes are latin1: one byte per character, so the guest parses what was written. */
function latin1Bytes(text: string): Uint8Array {
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
    return bytes;
}

function latin1Text(bytes: Uint8Array): string {
    let text = '';
    for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
    return text;
}

function indexOfCrlf(bytes: Uint8Array): number {
    for (let i = 0; i + 1 < bytes.length; i++) {
        if (bytes[i] === 13 && bytes[i + 1] === 10) return i;
    }
    return -1;
}

function indexOfHeadEnd(bytes: Uint8Array): number {
    for (let i = 0; i + 3 < bytes.length; i++) {
        if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return i;
    }
    return -1;
}

function protocolError(code: string, message: string): Error {
    return Object.assign(new Error(message), { code });
}

function parseHead(text: string): ParsedHead | undefined {
    const lines = text.split('\r\n');
    const match = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(lines[0]);
    if (!match) return undefined;
    const headers: Array<[string, string]> = [];
    for (const line of lines.slice(1)) {
        if (line === '') continue;
        const colon = line.indexOf(':');
        if (colon <= 0) return undefined;
        headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
    }
    return { status: Number(match[1]), statusText: match[2] ?? '', headers };
}

function headerValue(headers: Array<[string, string]>, name: string): string | undefined {
    const found = headers.find(([key]) => key.toLowerCase() === name);
    return found?.[1];
}

function requestTarget(request: HostHttpRequest): string {
    const direct = request.url && request.url.startsWith('/') ? request.url : request.path || request.url || '/';
    if (/^https?:\/\//i.test(direct)) {
        const parsed = new URL(direct);
        return parsed.pathname + parsed.search;
    }
    return direct.startsWith('/') ? direct : `/${direct}`;
}

/** The raw HTTP/1.1 bytes of a preview request: head (latin1) followed by the UTF-8 body. */
function encodeRequest(request: HostHttpRequest, port: number): Uint8Array {
    const method = (request.method || 'GET').toUpperCase();
    const lines = [`${method} ${requestTarget(request)} HTTP/1.1`];
    let hasHost = false;
    for (const [name, value] of Object.entries(request.headers || {})) {
        const key = name.toLowerCase();
        if (HOP_BY_HOP_REQUEST_HEADERS.has(key)) continue;
        if (key === 'host') hasHost = true;
        lines.push(`${name}: ${value}`);
    }
    if (!hasHost) lines.push(`Host: localhost:${port}`);
    lines.push('Connection: close');
    const body = request.body === undefined || request.body === null
        ? new Uint8Array(0)
        : new TextEncoder().encode(String(request.body));
    if (body.length > 0 || method === 'POST' || method === 'PUT' || method === 'PATCH') {
        lines.push(`Content-Length: ${body.length}`);
    }
    return concatBytes([latin1Bytes(lines.join('\r\n') + '\r\n\r\n'), body]);
}

/** Incremental reader for one HTTP/1.x response: head, then Content-Length, chunked, or close-delimited body. */
class ResponseReader {
    private pending: Uint8Array = new Uint8Array(0);
    private head?: ParsedHead;
    private mode: 'none' | 'length' | 'chunked' | 'eof' = 'eof';
    private remaining = 0;
    private chunkState: 'size' | 'data' | 'dataEnd' | 'trailer' = 'size';
    private parts: Uint8Array[] = [];
    private complete = false;

    constructor(private readonly method: string) { }

    /** Feeds received bytes; true once the response is complete. */
    feed(bytes: Uint8Array): boolean {
        if (this.complete) return true;
        this.pending = concatBytes([this.pending, bytes]);
        while (!this.complete && this.pending.length > 0) {
            if (!this.head) {
                const end = indexOfHeadEnd(this.pending);
                if (end < 0) return false;
                const head = parseHead(latin1Text(this.pending.subarray(0, end)));
                this.pending = this.pending.subarray(end + 4);
                if (!head) throw protocolError('HPE_INVALID_CONSTANT', 'Parse Error: Expected HTTP/');
                if (head.status >= 100 && head.status < 200 && head.status !== 101) continue; // interim response
                this.head = head;
                this.selectFraming(head);
                continue;
            }
            if (this.mode === 'eof') {
                this.parts.push(this.pending);
                this.pending = new Uint8Array(0);
                return false;
            }
            if (this.mode === 'length') {
                const take = Math.min(this.remaining, this.pending.length);
                this.parts.push(this.pending.subarray(0, take));
                this.pending = this.pending.subarray(take);
                this.remaining -= take;
                if (this.remaining === 0) this.complete = true;
                continue;
            }
            if (this.mode === 'chunked') {
                if (!this.chunkStep()) return false;
                continue;
            }
            return false;
        }
        return this.complete;
    }

    /** The peer closed: a close-delimited body is complete; anything else is truncated. */
    end(): boolean {
        if (this.complete) return true;
        if (this.head && this.mode === 'eof') this.complete = true;
        return this.complete;
    }

    response(): Response {
        const head = this.head;
        if (!head) throw protocolError('ECONNRESET', 'socket hang up');
        const headers = new Headers();
        for (const [name, value] of head.headers) {
            if (this.mode === 'chunked' && name.toLowerCase() === 'transfer-encoding') continue;
            try {
                headers.append(name, value);
            } catch {
                // a header the Response refuses is dropped
            }
        }
        const body = this.method === 'HEAD' || NO_BODY_STATUSES.has(head.status) ? null : concatBytes(this.parts);
        const statusText = head.statusText.replace(/[^\t\x20-\x7e\x80-\xff]/g, '');
        return new Response(body as unknown as BodyInit | null, { status: head.status, statusText, headers });
    }

    private selectFraming(head: ParsedHead): void {
        if (this.method === 'HEAD' || head.status === 101 || head.status === 204 || head.status === 304) {
            this.mode = 'none';
            this.complete = true;
            return;
        }
        const encoding = headerValue(head.headers, 'transfer-encoding');
        const length = headerValue(head.headers, 'content-length');
        if (encoding !== undefined && /chunked/i.test(encoding)) {
            this.mode = 'chunked';
            this.chunkState = 'size';
        } else if (length !== undefined) {
            this.remaining = Number(length);
            if (!Number.isInteger(this.remaining) || this.remaining < 0) {
                throw protocolError('HPE_INVALID_CONTENT_LENGTH', 'Parse Error: Invalid Content-Length');
            }
            this.mode = 'length';
            if (this.remaining === 0) this.complete = true;
        } else {
            this.mode = 'eof';
        }
    }

    /** One chunked-decoding step; false when more bytes are needed. */
    private chunkStep(): boolean {
        if (this.chunkState === 'size') {
            const lineEnd = indexOfCrlf(this.pending);
            if (lineEnd < 0) return false;
            const sizeText = latin1Text(this.pending.subarray(0, lineEnd)).split(';')[0].trim();
            this.pending = this.pending.subarray(lineEnd + 2);
            if (!/^[0-9a-fA-F]+$/.test(sizeText)) throw protocolError('HPE_INVALID_CHUNK_SIZE', 'Parse Error: Invalid character in chunk size');
            this.remaining = parseInt(sizeText, 16);
            this.chunkState = this.remaining === 0 ? 'trailer' : 'data';
            return true;
        }
        if (this.chunkState === 'data') {
            const take = Math.min(this.remaining, this.pending.length);
            this.parts.push(this.pending.subarray(0, take));
            this.pending = this.pending.subarray(take);
            this.remaining -= take;
            if (this.remaining === 0) this.chunkState = 'dataEnd';
            return true;
        }
        if (this.chunkState === 'dataEnd') {
            if (this.pending.length < 2) return false;
            this.pending = this.pending.subarray(2);
            this.chunkState = 'size';
            return true;
        }
        const trailerEnd = indexOfCrlf(this.pending);
        if (trailerEnd < 0) return false;
        const trailer = latin1Text(this.pending.subarray(0, trailerEnd));
        this.pending = this.pending.subarray(trailerEnd + 2);
        if (trailer === '') this.complete = true;
        return true;
    }
}

/**
 * Sends a request to the guest server listening on `port` and resolves with its response.
 * Rejects with ECONNREFUSED when no server listens there (the caller maps that to 503).
 */
export function requestGuestServer(network: VirtualNetwork, port: number, request: HostHttpRequest): Promise<Response> {
    attachHostHttp(network);
    const state = stateOf(network);
    const method = (request.method || 'GET').toUpperCase();
    const outgoing = encodeRequest(request, port);
    return new Promise<Response>((resolve, reject) => {
        const targetId = state.nextTargetId++;
        const reader = new ResponseReader(method);
        let connectionId: number | undefined;
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settle = (error: unknown, response?: Response) => {
            if (settled) return;
            settled = true;
            state.targets.delete(targetId);
            if (timer !== undefined) clearTimeout(timer);
            if (connectionId !== undefined) network.destroy(connectionId);
            if (error) reject(error);
            else resolve(response as Response);
        };
        state.targets.set(targetId, (name, payload) => {
            if (settled) return;
            try {
                if (name === 'data') {
                    if (reader.feed(base64ToBytes(payload as string))) settle(undefined, reader.response());
                } else if (name === 'end' || name === 'close') {
                    if (reader.end()) settle(undefined, reader.response());
                    else settle(protocolError('ECONNRESET', 'socket hang up'));
                }
            } catch (error) {
                settle(error);
            }
        });
        try {
            connectionId = network.connect({ ownerPid: HOST_PID, address: '127.0.0.1', port, targetId }).id;
        } catch (error) {
            state.targets.delete(targetId);
            reject(error);
            return;
        }
        network.write(connectionId, bytesToBase64(outgoing));
        timer = setTimeout(() => settle(protocolError('ETIMEDOUT', `request to port ${port} timed out`)), REQUEST_TIMEOUT_MS);
    });
}
