import { base64ToBytes, bytesToBase64 } from './b64';
import { DEFAULT_TRANSPORT_SETTINGS, MAX_DATAGRAM_SIZE, QuicConnection, QuicStream, describeTransportParameters } from './connection';
import type { TransportSettings } from './connection';
import { Emitter } from './emitter';
import { QuicEndpoint } from './endpoint';
import { createHttp3Api } from './h3-api';
import type { Http3Api } from './h3-api';
import type { DatagramSocket, QuicPlatform } from './platform';
import { QUIC_VERSION_1 } from './protection';
import type { TlsEngine, TlsEngineOptions, TlsSettings } from './tls-types';
import { decodeTransportParameters, encodeTransportParameters } from './transport-params';

/*
 * Guest entry of the QUIC transport. scripts/build-quic-guest.mjs bundles this file and the codecs
 * it reaches into one script, carried by QUIC_SRC (guest/modules/quic.ts), which the guest bootstrap
 * evaluates after the TLS engine. QUIC_SRC defines the bootstrap-scope function OWC_QUIC(): the first
 * call compiles and runs this bundle and returns its exports ({ API, loadHttp3 }); the internal built-in
 * 'owc:internal/quic' returns OWC_QUIC().API and 'owc:internal/http3' returns OWC_QUIC().loadHttp3()
 * (neither is a Node module; Node 24 has no QUIC or HTTP/3 module).
 *
 * It binds the connection layer to the guest: timers, the tls.random and crypto.hmac capabilities,
 * the TLS engine (OWC_TLS13 in QUIC mode), and UDP sockets from the guest's dgram module.
 *
 *   const quic = require('owc:internal/quic');
 *   const server = quic.createServer({ key, cert, alpn: ['h3'] }, (session) => { ... });
 *   server.listen(4433, '127.0.0.1');
 *   const session = quic.connect({ host: '127.0.0.1', port: 4433, servername: 'localhost', ca });
 *   session.on('handshake', (info) => { const stream = session.openStream(); stream.end('hello'); });
 */

declare const callCap: (op: string, args?: unknown) => any;
declare const OWC_TLS13: {
    createEngine(options: TlsEngineOptions & { cap: unknown }): TlsEngine;
    loadPem(input: unknown): { certs: Uint8Array[]; key: unknown };
    parsePem(input: unknown): { label: string; der: Uint8Array }[];
};
declare function requireBuiltin(name: string): any;
declare const Buffer: { from(buffer: ArrayBufferLike, byteOffset?: number, length?: number): Uint8Array; isBuffer(value: unknown): boolean };

const platform: QuicPlatform = {
    now: () => Date.now(),
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    defer: (callback) => queueMicrotask(callback),
    randomBytes: (length) => base64ToBytes(callCap('tls.random', { bytes: length }).data as string),
    hmacSha256: (key, data) => base64ToBytes(callCap('crypto.hmac', { algorithm: 'sha256', key: bytesToBase64(key), data: bytesToBase64(data) }) as string),
    createTlsEngine: (options) => OWC_TLS13.createEngine({ ...options, cap: callCap }),
};

function asBuffer(bytes: Uint8Array): Uint8Array {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

const SUITE_CODES: Readonly<Record<string, number>> = {
    TLS_AES_128_GCM_SHA256: 0x1301,
    TLS_AES_256_GCM_SHA384: 0x1302,
    TLS_CHACHA20_POLY1305_SHA256: 0x1303,
};
const GROUP_CODES: Readonly<Record<string, number>> = { X25519: 29, 'P-256': 23, prime256v1: 23, secp256r1: 23 };

function codes(list: unknown, table: Readonly<Record<string, number>>, what: string): number[] | undefined {
    if (list === undefined || list === null) return undefined;
    const items = Array.isArray(list) ? list : String(list).split(':');
    return items.map((item) => {
        if (typeof item === 'number') return item;
        const code = table[String(item)];
        if (code === undefined) throw Object.assign(new TypeError(`unknown ${what} ${String(item)}`), { code: 'ERR_INVALID_ARG_VALUE' });
        return code;
    });
}

function certificatesOf(pem: unknown): Uint8Array[] {
    if (pem === undefined || pem === null) return [];
    const list = Array.isArray(pem) ? pem : [pem];
    const out: Uint8Array[] = [];
    for (const entry of list) {
        for (const block of OWC_TLS13.parsePem(entry)) if (/CERTIFICATE$/.test(block.label)) out.push(block.der);
    }
    return out;
}

interface CommonOptions {
    alpn?: string[];
    suites?: (string | number)[] | string;
    groups?: (string | number)[] | string;
    idleTimeout?: number;
    transport?: Partial<TransportSettings>;
    trace?: (event: Record<string, unknown>) => void;
}

interface ServerOptions extends CommonOptions {
    key: unknown;
    cert: unknown;
    ca?: unknown;
    requestCert?: boolean;
    retry?: boolean;
}

interface ClientOptions extends CommonOptions {
    host?: string;
    port: number;
    servername?: string;
    ca?: unknown;
    rejectUnauthorized?: boolean;
    localPort?: number;
    localAddress?: string;
    key?: unknown;
    cert?: unknown;
}

function transportOf(options: CommonOptions): Partial<TransportSettings> {
    const transport: Partial<TransportSettings> = { ...(options.transport ?? {}) };
    if (typeof options.idleTimeout === 'number') return { ...transport, maxIdleTimeoutMs: options.idleTimeout };
    return transport;
}

/**
 * A dgram socket as the endpoint's DatagramSocket. Received datagrams are copied into plain
 * Uint8Arrays: Buffer.prototype.slice returns a view (in the guest as in Node), and the codecs treat
 * slice() as a copy (removeHeaderProtection writes the unmasked header into packet.slice(...)), so a
 * Buffer would be unmasked in place.
 */
function adaptSocket(socket: any): DatagramSocket {
    return {
        send: (datagram, port, address) => socket.send(asBuffer(datagram), port, address),
        close: () => socket.close(),
        onMessage: (handler) => {
            socket.on('message', (message: Uint8Array, rinfo: { address: string; port: number }) => handler(new Uint8Array(message), rinfo.address, rinfo.port));
        },
        address: () => socket.address(),
    };
}

class QuicServer extends Emitter {
    private socket: any = null;
    endpoint: QuicEndpoint | null = null;

    constructor(private readonly options: ServerOptions) {
        super();
    }

    listen(port = 0, host = '127.0.0.1', callback?: () => void): this {
        if (this.socket !== null) throw Object.assign(new Error('server is already listening'), { code: 'ERR_SERVER_ALREADY_LISTEN' });
        const dgram = requireBuiltin('dgram');
        const socket = dgram.createSocket(host.indexOf(':') >= 0 ? 'udp6' : 'udp4');
        this.socket = socket;
        socket.on('error', (error: unknown) => this.emit('error', error));
        socket.bind(port, host);
        const key = OWC_TLS13.loadPem(this.options.key).key;
        const certs = OWC_TLS13.loadPem(this.options.cert).certs;
        const tls: TlsSettings = {
            ALPNProtocols: this.options.alpn ?? ['h3'],
            contexts: [{ certificates: certs, privateKey: key }],
            suites: codes(this.options.suites, SUITE_CODES, 'cipher suite'),
            groups: codes(this.options.groups, GROUP_CODES, 'group'),
            requestCert: this.options.requestCert === true,
            anchors: certificatesOf(this.options.ca),
        };
        this.endpoint = new QuicEndpoint({
            platform,
            socket: adaptSocket(socket),
            server: { tls, retry: this.options.retry === true, transport: transportOf(this.options) },
            trace: this.options.trace,
            wrapBytes: asBuffer,
        });
        this.endpoint.on('session', (session: QuicConnection) => this.emit('session', session));
        socket.once('listening', () => {
            this.emit('listening');
            if (callback) callback();
        });
        return this;
    }

    address(): { address: string; port: number } {
        return this.socket.address();
    }

    close(callback?: () => void): void {
        if (this.endpoint !== null) this.endpoint.close();
        this.endpoint = null;
        this.socket = null;
        this.emit('close');
        if (callback) callback();
    }
}

function createServer(options: ServerOptions, onSession?: (session: QuicConnection) => void): QuicServer {
    const server = new QuicServer(options);
    if (onSession) server.on('session', onSession);
    return server;
}

/** Connects to a QUIC server; the socket closes when the connection has fully closed. */
function connect(options: ClientOptions): QuicConnection & { endpoint: QuicEndpoint; localPort: number } {
    const dgram = requireBuiltin('dgram');
    const host = options.host ?? '127.0.0.1';
    const socket = dgram.createSocket(host.indexOf(':') >= 0 ? 'udp6' : 'udp4');
    socket.bind(options.localPort ?? 0, options.localAddress ?? (host.indexOf(':') >= 0 ? '::1' : '127.0.0.1'));
    const endpoint = new QuicEndpoint({ platform, socket: adaptSocket(socket), trace: options.trace, wrapBytes: asBuffer });
    const servername = options.servername ?? (/^[0-9.]+$/.test(host) || host.indexOf(':') >= 0 ? undefined : host);
    const contexts = options.key !== undefined && options.cert !== undefined ? [{ certificates: OWC_TLS13.loadPem(options.cert).certs, privateKey: OWC_TLS13.loadPem(options.key).key }] : undefined;
    const tls: TlsSettings = {
        ALPNProtocols: options.alpn ?? ['h3'],
        serverName: servername,
        anchors: certificatesOf(options.ca),
        hostname: servername ?? host,
        suites: codes(options.suites, SUITE_CODES, 'cipher suite'),
        groups: codes(options.groups, GROUP_CODES, 'group'),
        contexts,
    };
    const connection = endpoint.connect({
        address: host,
        port: options.port,
        tls,
        rejectUnauthorized: options.rejectUnauthorized,
        transport: transportOf(options),
    }) as QuicConnection & { endpoint: QuicEndpoint; localPort: number };
    connection.endpoint = endpoint;
    Object.defineProperty(connection, 'localPort', { get: () => socket.address().port, enumerable: true });
    endpoint.on('connectionClosed', () => endpoint.close());
    return connection;
}

export const API = {
    createServer,
    connect,
    QuicConnection,
    QuicStream,
    QuicEndpoint,
    describeTransportParameters,
    decodeTransportParameters,
    encodeTransportParameters,
    VERSION: QUIC_VERSION_1,
    DEFAULT_TRANSPORT_SETTINGS,
    MAX_DATAGRAM_SIZE,
};

let http3: Http3Api | null = null;

/**
 * The HTTP/3 API behind the internal built-in 'owc:internal/http3' (h3-api.ts), built on first use
 * from the guest's events, stream and buffer modules and the QUIC API above.
 */
export function loadHttp3(): Http3Api {
    if (http3 === null) {
        http3 = createHttp3Api({
            events: requireBuiltin('events'),
            stream: requireBuiltin('stream'),
            Buffer,
            quic: { createServer: createServer as never, connect: connect as never },
            setTimeout: (callback, ms) => setTimeout(callback, ms),
        });
    }
    return http3;
}
