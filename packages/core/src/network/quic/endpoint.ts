import { asciiBytes, bytesToHex, concatBytes, equalBytes } from './bytes';
import { LOCAL_CID_LENGTH, QuicConnection } from './connection';
import type { TransportSettings } from './connection';
import { Emitter } from './emitter';
import { PacketDropError, QuicError, TransportError } from './errors';
import { encodeFrames } from './frames';
import { MIN_INITIAL_DATAGRAM_SIZE, encodeRetry, encodeVersionNegotiation, openPacket, parsePacket, sealPacket } from './packet';
import type { ParsedPacket } from './packet';
import type { DatagramSocket, QuicPlatform } from './platform';
import { QUIC_VERSION_1, initialPacketKeys } from './protection';
import type { TlsSettings } from './tls-types';

/*
 * A QUIC endpoint on one UDP socket: routes datagrams to connections by Destination Connection ID,
 * accepts new server connections on a client Initial in a datagram of at least 1200 bytes
 * (RFC 9000 Section 14.1), answers an unsupported version with Version Negotiation (Section 6),
 * optionally validates client addresses with Retry (Section 8.1.2; the token is an HMAC over the
 * original Destination Connection ID, the Retry's Source Connection ID, the client address and a
 * timestamp), and starts client connections.
 */

/** How long a Retry token stays valid, in milliseconds. */
const RETRY_TOKEN_LIFETIME = 10000;
const TOKEN_VERSION = 1;
const TOKEN_MAC_LENGTH = 16;

export interface EndpointServerOptions {
    readonly tls: TlsSettings;
    /** Validate client addresses with a Retry before creating connection state. */
    readonly retry?: boolean;
    readonly transport?: Partial<TransportSettings>;
}

export interface ClientConnectOptions {
    readonly address: string;
    readonly port: number;
    readonly tls: TlsSettings;
    readonly rejectUnauthorized?: boolean;
    readonly transport?: Partial<TransportSettings>;
}

export interface EndpointOptions {
    readonly platform: QuicPlatform;
    readonly socket: DatagramSocket;
    readonly server?: EndpointServerOptions;
    readonly trace?: (event: Record<string, unknown>) => void;
    readonly wrapBytes?: (bytes: Uint8Array) => Uint8Array;
}

interface Route {
    readonly connection: QuicConnection;
    readonly keys: string[];
}

export class QuicEndpoint extends Emitter {
    private readonly platform: QuicPlatform;
    private readonly socket: DatagramSocket;
    private readonly server: EndpointServerOptions | undefined;
    private readonly traceFn: ((event: Record<string, unknown>) => void) | undefined;
    private readonly wrapBytes: ((bytes: Uint8Array) => Uint8Array) | undefined;
    private readonly routes = new Map<string, Route>();
    private readonly retrySecret: Uint8Array;
    private closed = false;
    readonly stats = { versionNegotiationSent: 0, retrySent: 0, invalidTokens: 0, dropped: 0 };

    constructor(options: EndpointOptions) {
        super();
        this.platform = options.platform;
        this.socket = options.socket;
        this.server = options.server;
        this.traceFn = options.trace;
        this.wrapBytes = options.wrapBytes;
        this.retrySecret = this.platform.randomBytes(32);
        this.socket.onMessage((datagram, address, port) => this.onDatagram(datagram, address, port));
    }

    get connectionCount(): number {
        return new Set([...this.routes.values()].map((route) => route.connection)).size;
    }

    /** Starts a client connection to address:port. The first Initial goes out after the caller's current turn. */
    connect(options: ClientConnectOptions): QuicConnection {
        if (this.closed) throw Object.assign(new Error('endpoint is closed'), { code: 'ERR_QUIC_CLOSED' });
        const dcid = this.platform.randomBytes(LOCAL_CID_LENGTH);
        const scid = this.platform.randomBytes(LOCAL_CID_LENGTH);
        const route: { connection: QuicConnection | null } = { connection: null };
        const connection = new QuicConnection({
            role: 'client',
            platform: this.platform,
            sendDatagram: (datagram) => this.send(datagram, options.port, options.address),
            onClosed: () => this.forget(route.connection as QuicConnection),
            localCid: scid,
            remoteCid: dcid,
            originalDcid: dcid,
            tls: options.tls,
            rejectUnauthorized: options.rejectUnauthorized,
            transport: options.transport,
            trace: this.traceFn,
            wrapBytes: this.wrapBytes,
        });
        route.connection = connection;
        this.register(connection, [scid]);
        this.platform.defer(() => {
            if (connection.state === 'handshake') connection.start();
        });
        return connection;
    }

    /** Closes every connection (CONNECTION_CLOSE with the given application code) and the socket. */
    close(errorCode = 0, reason = ''): void {
        if (this.closed) return;
        this.closed = true;
        for (const connection of new Set([...this.routes.values()].map((route) => route.connection))) connection.close(errorCode, reason);
        this.routes.clear();
        this.socket.close();
        this.emit('close');
    }

    private trace(event: Record<string, unknown>): void {
        if (this.traceFn) this.traceFn({ role: 'endpoint', t: this.platform.now(), ...event });
    }

    private send(datagram: Uint8Array, port: number, address: string): void {
        if (!this.closed) this.socket.send(datagram, port, address);
    }

    private register(connection: QuicConnection, cids: Uint8Array[]): void {
        const keys = cids.map((cid) => bytesToHex(cid));
        const route: Route = { connection, keys };
        for (const key of keys) this.routes.set(key, route);
    }

    private forget(connection: QuicConnection): void {
        for (const [key, route] of [...this.routes.entries()]) if (route.connection === connection) this.routes.delete(key);
        this.emit('connectionClosed', connection);
    }

    private onDatagram(datagram: Uint8Array, address: string, port: number): void {
        if (this.closed) return;
        try {
            this.route(datagram, address, port);
        } catch (error) {
            // Never let one datagram throw out of the socket callback.
            this.stats.dropped++;
            this.trace({ ev: 'datagram_error', message: String((error as Error)?.message ?? error), stack: String((error as Error)?.stack ?? ''), size: datagram.length });
        }
    }

    private route(datagram: Uint8Array, address: string, port: number): void {
        let packet: ParsedPacket;
        try {
            packet = parsePacket(datagram, 0, LOCAL_CID_LENGTH);
        } catch (error) {
            if (error instanceof PacketDropError) {
                this.stats.dropped++;
                this.trace({ ev: 'datagram_dropped', reason: error.message, size: datagram.length });
                return;
            }
            throw error;
        }
        const route = this.routes.get(bytesToHex(packet.dcid));
        if (route) {
            route.connection.receiveDatagram(datagram);
            return;
        }
        if (this.server === undefined) {
            this.stats.dropped++;
            this.trace({ ev: 'datagram_dropped', reason: 'no connection', type: packet.type, size: datagram.length });
            return;
        }
        if (packet.type === 'unsupported_version') {
            // RFC 9000 Section 5.2.2: answer only datagrams large enough to start a connection.
            if (datagram.length >= MIN_INITIAL_DATAGRAM_SIZE && packet.scid !== null) this.sendVersionNegotiation(packet, address, port);
            else this.stats.dropped++;
            return;
        }
        if (packet.type !== 'initial' || datagram.length < MIN_INITIAL_DATAGRAM_SIZE || packet.scid === null) {
            this.stats.dropped++;
            this.trace({ ev: 'datagram_dropped', reason: 'not a connection-starting Initial', type: packet.type, size: datagram.length });
            return;
        }
        // Create state only for an Initial that authenticates under the keys of its Destination
        // Connection ID (RFC 9001 Section 5.2), so stray or corrupted datagrams leave nothing behind.
        try {
            openPacket(packet, initialPacketKeys(packet.dcid).client, null);
        } catch (error) {
            if (!(error instanceof PacketDropError) && !(error instanceof QuicError)) throw error;
            this.stats.dropped++;
            this.trace({ ev: 'datagram_dropped', reason: `Initial does not open: ${(error as Error).message}`, size: datagram.length });
            return;
        }
        let originalDcid = packet.dcid;
        let retrySourceCid: Uint8Array | null = null;
        let addressValidated = false;
        if (this.server.retry) {
            const token = packet.token ?? new Uint8Array(0);
            if (token.length === 0) {
                this.sendRetry(packet, address, port);
                return;
            }
            const validated = this.validateRetryToken(token, packet.dcid, address, port);
            if (validated === null) {
                this.stats.invalidTokens++;
                this.sendInvalidTokenClose(packet, address, port);
                return;
            }
            originalDcid = validated;
            retrySourceCid = packet.dcid;
            addressValidated = true;
        }
        const localCid = this.platform.randomBytes(LOCAL_CID_LENGTH);
        const route2: { connection: QuicConnection | null } = { connection: null };
        const connection = new QuicConnection({
            role: 'server',
            platform: this.platform,
            sendDatagram: (bytes) => this.send(bytes, port, address),
            onClosed: () => this.forget(route2.connection as QuicConnection),
            localCid,
            remoteCid: packet.scid,
            originalDcid,
            initialDcid: packet.dcid,
            retrySourceCid,
            addressValidated,
            tls: this.server.tls,
            transport: this.server.transport,
            trace: this.traceFn,
            wrapBytes: this.wrapBytes,
        });
        route2.connection = connection;
        this.register(connection, [localCid, packet.dcid]);
        this.trace({ ev: 'connection_accepted', odcid: bytesToHex(originalDcid), scid: bytesToHex(localCid), retry: retrySourceCid !== null, from: `${address}:${port}` });
        this.emit('session', connection, { address, port });
        connection.receiveDatagram(datagram);
    }

    private sendVersionNegotiation(packet: ParsedPacket, address: string, port: number): void {
        const datagram = encodeVersionNegotiation({ dcid: packet.scid as Uint8Array, scid: packet.dcid, versions: [QUIC_VERSION_1] });
        this.stats.versionNegotiationSent++;
        this.trace({ ev: 'version_negotiation_sent', clientVersion: '0x' + (packet.version ?? 0).toString(16).padStart(8, '0'), to: `${address}:${port}` });
        this.send(datagram, port, address);
    }

    private retryTokenMac(body: Uint8Array, address: string, port: number): Uint8Array {
        const where = concatBytes(asciiBytes(address), Uint8Array.of(port >> 8, port & 0xff));
        return this.platform.hmacSha256(this.retrySecret, concatBytes(body, where)).slice(0, TOKEN_MAC_LENGTH);
    }

    private sendRetry(packet: ParsedPacket, address: string, port: number): void {
        const retryScid = this.platform.randomBytes(LOCAL_CID_LENGTH);
        const time = Math.floor(this.platform.now());
        const stamp = new Uint8Array(6);
        let rest = time;
        for (let i = 5; i >= 0; i--) {
            stamp[i] = rest % 256;
            rest = Math.floor(rest / 256);
        }
        const body = concatBytes(Uint8Array.of(TOKEN_VERSION), stamp, Uint8Array.of(packet.dcid.length), packet.dcid, Uint8Array.of(retryScid.length), retryScid);
        const token = concatBytes(body, this.retryTokenMac(body, address, port));
        const datagram = encodeRetry({ dcid: packet.scid as Uint8Array, scid: retryScid, token, originalDcid: packet.dcid });
        this.stats.retrySent++;
        this.trace({ ev: 'retry_sent', odcid: bytesToHex(packet.dcid), scid: bytesToHex(retryScid), to: `${address}:${port}` });
        this.send(datagram, port, address);
    }

    /** The original Destination Connection ID a valid token carries, or null. */
    private validateRetryToken(token: Uint8Array, dcid: Uint8Array, address: string, port: number): Uint8Array | null {
        if (token.length < 1 + 6 + 1 + 1 + TOKEN_MAC_LENGTH || token[0] !== TOKEN_VERSION) return null;
        const body = token.subarray(0, token.length - TOKEN_MAC_LENGTH);
        if (!equalBytes(this.retryTokenMac(body, address, port), token.subarray(token.length - TOKEN_MAC_LENGTH))) return null;
        let time = 0;
        for (let i = 1; i <= 6; i++) time = time * 256 + body[i];
        const age = this.platform.now() - time;
        if (age < 0 || age > RETRY_TOKEN_LIFETIME) return null;
        const odcidLength = body[7];
        if (8 + odcidLength >= body.length) return null;
        const odcid = body.slice(8, 8 + odcidLength);
        const scidLength = body[8 + odcidLength];
        const scid = body.slice(9 + odcidLength, 9 + odcidLength + scidLength);
        if (9 + odcidLength + scidLength !== body.length) return null;
        // The client's Initial after a Retry is addressed to the Retry's Source Connection ID.
        if (!equalBytes(scid, dcid)) return null;
        return odcid;
    }

    /** RFC 9000 Section 8.1.3: an Initial with an invalid Retry token is closed with INVALID_TOKEN. */
    private sendInvalidTokenClose(packet: ParsedPacket, address: string, port: number): void {
        const keys = initialPacketKeys(packet.dcid).server;
        const payload = encodeFrames([{ type: 'CONNECTION_CLOSE', application: false, errorCode: BigInt(TransportError.INVALID_TOKEN), frameType: 0n, reason: new Uint8Array(0) }]);
        const datagram = sealPacket({ type: 'initial', dcid: packet.scid as Uint8Array, scid: packet.dcid, token: new Uint8Array(0), packetNumber: 0n, payload }, keys);
        this.trace({ ev: 'invalid_token_close', to: `${address}:${port}` });
        this.send(datagram, port, address);
    }
}
