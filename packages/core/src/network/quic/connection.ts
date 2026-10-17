import { concatBytes, equalBytes } from './bytes';
import { AEAD_TAG_LENGTH } from './crypto';
import { Emitter } from './emitter';
import { PacketDropError, QuicError, TransportError, cryptoErrorCode } from './errors';
import { decodeFrames, encodeFrames, isAckEliciting } from './frames';
import type { FramePacketType, QuicFrame } from './frames';
import { MAX_STREAMS_LIMIT } from './frames';
import { MIN_INITIAL_DATAGRAM_SIZE, openPacket, parseDatagram, sealPacket, verifyRetry } from './packet';
import type { PacketSpec, ParsedPacket } from './packet';
import { PACKET_NUMBER_MAX, decodePacketNumber, packetNumberLength } from './packet-number';
import type { QuicPlatform } from './platform';
import {
    CIPHER_SUITES,
    QUIC_VERSION_1,
    SHORT_HEADER_RESERVED_BITS,
    decryptPayload,
    derivePacketKeys,
    initialPacketKeys,
    nextKeyPhaseKeys,
    removeHeaderProtection,
} from './protection';
import type { CipherSuite, PacketKeys } from './protection';
import { PacketNumberSet } from './ranges';
import { Recovery, SPACE_IDS } from './recovery';
import type { SentPacket, SpaceId, TimerState } from './recovery';
import { FinalSizeError, RecvBuffer, SendBuffer } from './stream-buffers';
import { utf8Decode, utf8Encode } from './text';
import type { TlsEngine, TlsEvent, TlsLevel, TlsSettings } from './tls-types';
import { decodeTransportParameters, encodeTransportParameters } from './transport-params';
import type { TransportParameters } from './transport-params';
import { varintLength } from './varint';

/*
 * One QUIC version 1 connection (RFC 9000, RFC 9001, RFC 9002), client or server, built on the
 * stage 1 codecs and the guest TLS 1.3 engine in QUIC mode.
 *
 * Covered: the Initial, Handshake and Application Data packet number spaces; CRYPTO stream
 * reassembly per encryption level fed to the TLS engine; ACK generation with ranges; loss detection
 * and PTO retransmission (RFC 9002, no congestion controller: bytes in flight are capped at the
 * initial window); transport parameter exchange and the RFC 9000 Section 7.3 connection ID checks;
 * key discard (RFC 9001 Section 4.9); HANDSHAKE_DONE; the server's anti-amplification limit and
 * Initial padding (RFC 9000 Sections 8.1, 14.1); 1-RTT key update both ways (RFC 9001 Section 6);
 * bidirectional and unidirectional streams with flow control, whose limits grow as data is consumed
 * and as peer streams close (MAX_DATA, MAX_STREAM_DATA, MAX_STREAMS); Retry and Version Negotiation at the
 * client; CONNECTION_CLOSE with closing and draining periods; the idle timeout.
 *
 * Not covered: 0-RTT, connection migration and path validation beyond answering PATH_CHALLENGE,
 * issuing extra connection IDs, stateless reset, ECN, and an application-limited marker (RFC 9002 A.6).
 *
 * Congestion control is NewReno with a pacer (RFC 9002 Sections 7.2, 7.3, 7.6 and 7.7): the window
 * starts at ten datagrams, halves on entering a recovery period, drops to the minimum window on
 * persistent congestion, and sends are spread over N * window / smoothed_rtt.
 */

export type ConnectionState = 'handshake' | 'connected' | 'closing' | 'draining' | 'closed';

/** Largest datagram this endpoint sends (the minimum every QUIC path supports). */
export const MAX_DATAGRAM_SIZE = 1200;
/** Length of the connection IDs this endpoint issues. */
export const LOCAL_CID_LENGTH = 8;
const CRYPTO_BUFFER_LIMIT = 65536;
/** No longer used for a limit: the congestion window lives in Recovery (RFC 9002 Section 7). */
const MAX_BUFFERED_PACKETS = 16;
/** Frame type codes, for CONNECTION_CLOSE frame type fields. */
const FT = { ACK: 0x02, RESET_STREAM: 0x04, STOP_SENDING: 0x05, CRYPTO: 0x06, NEW_TOKEN: 0x07, STREAM: 0x08, MAX_STREAM_DATA: 0x11, NEW_CONNECTION_ID: 0x18, RETIRE_CONNECTION_ID: 0x19, HANDSHAKE_DONE: 0x1e } as const;

const PACKET_TYPE_OF: Readonly<Record<SpaceId, 'initial' | 'handshake' | '1rtt'>> = { initial: 'initial', handshake: 'handshake', application: '1rtt' };
const LEVEL_OF: Readonly<Record<SpaceId, TlsLevel>> = { initial: 'initial', handshake: 'handshake', application: '1-rtt' };
const SPACE_OF_LEVEL: Readonly<Record<TlsLevel, SpaceId>> = { initial: 'initial', handshake: 'handshake', '1-rtt': 'application' };
const TLS_LEVELS: readonly TlsLevel[] = ['initial', 'handshake', '1-rtt'];

/** Local transport settings, advertised in the transport parameters. */
export interface TransportSettings {
    readonly maxIdleTimeoutMs: number;
    readonly initialMaxData: number;
    readonly initialMaxStreamDataBidiLocal: number;
    readonly initialMaxStreamDataBidiRemote: number;
    readonly initialMaxStreamDataUni: number;
    readonly initialMaxStreamsBidi: number;
    readonly initialMaxStreamsUni: number;
    readonly activeConnectionIdLimit: number;
}

export const DEFAULT_TRANSPORT_SETTINGS: TransportSettings = {
    maxIdleTimeoutMs: 30000,
    initialMaxData: 1048576,
    initialMaxStreamDataBidiLocal: 262144,
    initialMaxStreamDataBidiRemote: 262144,
    initialMaxStreamDataUni: 262144,
    initialMaxStreamsBidi: 128,
    initialMaxStreamsUni: 16,
    activeConnectionIdLimit: 2,
};

export interface ConnectionConfig {
    readonly role: 'client' | 'server';
    readonly platform: QuicPlatform;
    /** Sends one datagram to the peer. */
    readonly sendDatagram: (datagram: Uint8Array) => void;
    /** Called once when the connection is fully closed (after the closing or draining period). */
    readonly onClosed?: () => void;
    /** This endpoint's connection ID (the peer's Destination Connection ID). */
    readonly localCid: Uint8Array;
    /** Client: the random initial Destination Connection ID. Server: the client's Source Connection ID. */
    readonly remoteCid: Uint8Array;
    /** Client: equal to remoteCid. Server: the Destination Connection ID of the client's first Initial. */
    readonly originalDcid: Uint8Array;
    /** Server: the Destination Connection ID the client used in the Initial that created this connection. */
    readonly initialDcid?: Uint8Array;
    /** Server: the Source Connection ID of the Retry this connection answers (its token was validated). */
    readonly retrySourceCid?: Uint8Array | null;
    /** Server: the client's address is validated (a valid Retry token). */
    readonly addressValidated?: boolean;
    readonly tls: TlsSettings;
    /** Client: fail the handshake when the server certificate does not verify (default true). */
    readonly rejectUnauthorized?: boolean;
    readonly transport?: Partial<TransportSettings>;
    readonly trace?: (event: Record<string, unknown>) => void;
    /** Converts received stream bytes before they are emitted (the guest wraps them in Buffer). */
    readonly wrapBytes?: (bytes: Uint8Array) => Uint8Array;
}

export interface CloseInfo {
    readonly errorCode: number;
    readonly reason: string;
    /** An application close (frame type 0x1d) rather than a transport close (0x1c). */
    readonly application: boolean;
    readonly frameType?: number;
    /** The peer closed the connection. */
    readonly remote: boolean;
    /** The idle timeout expired; no packet was exchanged. */
    readonly idle?: boolean;
    /** Client: the versions a Version Negotiation packet offered when none matched. */
    readonly versionNegotiation?: number[];
}

export interface HandshakeInfo {
    readonly role: 'client' | 'server';
    readonly version: number;
    readonly alpn: string | null;
    readonly cipher: string;
    readonly group: string;
    readonly authorized: boolean;
    readonly authorizationError: string | null;
    readonly peerCertificates: Uint8Array[];
    readonly serverName: string | null;
    readonly localTransportParameters: TransportParameters;
    readonly peerTransportParameters: TransportParameters;
    readonly localCid: Uint8Array;
    readonly remoteCid: Uint8Array;
    readonly originalDcid: Uint8Array;
    readonly retried: boolean;
}

export interface KeyUpdateInfo {
    /** Who started this key update. */
    readonly initiator: 'local' | 'peer';
    /** 'started': this endpoint switched its send keys; 'completed': the peer's packets arrived in the new phase. */
    readonly stage: 'started' | 'completed';
    readonly phase: 0 | 1;
    readonly packetNumber: string;
    readonly updates: number;
    /** The peer answered our update and started the next one before we saw the intermediate phase. */
    readonly consecutive?: boolean;
}

type FrameRecord =
    | { readonly kind: 'crypto'; readonly space: SpaceId; readonly offset: number; readonly length: number }
    | { readonly kind: 'stream'; readonly streamId: number; readonly offset: number; readonly length: number; readonly fin: boolean }
    | { readonly kind: 'reset_stream'; readonly streamId: number }
    | { readonly kind: 'stop_sending'; readonly streamId: number }
    | { readonly kind: 'handshake_done' }
    | { readonly kind: 'max_data' }
    | { readonly kind: 'max_stream_data'; readonly streamId: number }
    | { readonly kind: 'max_streams'; readonly bidirectional: boolean }
    | { readonly kind: 'retire_cid'; readonly sequence: bigint }
    | { readonly kind: 'ack'; readonly space: SpaceId };

interface ReceiveSpace {
    readonly recv: PacketNumberSet;
    largestRecv: bigint | null;
    largestRecvTime: number | null;
    ackPending: boolean;
    nextPn: bigint;
}

interface DirectionalKeys {
    read: PacketKeys;
    write: PacketKeys;
}

interface AppKeys {
    read: PacketKeys | null;
    readPhase: 0 | 1;
    readNext: PacketKeys | null;
    readPrevious: PacketKeys | null;
    readPreviousExpires: number;
    readPhaseFirstPn: bigint;
    write: PacketKeys | null;
    writePhase: 0 | 1;
    writePhaseAcked: boolean;
}

interface BuiltPacket {
    readonly space: SpaceId;
    readonly type: 'initial' | 'handshake' | '1rtt';
    readonly keys: PacketKeys;
    readonly payload: Uint8Array;
    readonly records: FrameRecord[];
    readonly ackEliciting: boolean;
    readonly hasAck: boolean;
    readonly frameTypes: string[];
    /** The packet's ACK ranges as smallest-largest (trace only). */
    readonly ackRanges?: string[];
}

export interface ConnectionStats {
    datagramsSent: number;
    datagramsReceived: number;
    packetsSent: number;
    packetsReceived: number;
    packetsDropped: number;
    duplicates: number;
    packetsLost: number;
    ptoFired: number;
    keyUpdates: number;
}

/** The OpenSSL-style alert for a certificate verdict (closest match of ssl_verify_alarm_type). */
function alertForVerifyError(code: string | null): number {
    switch (code) {
        case 'CERT_HAS_EXPIRED':
        case 'CERT_NOT_YET_VALID':
            return 45;
        case 'CERT_REVOKED':
            return 44;
        case 'UNABLE_TO_GET_ISSUER_CERT':
        case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
        case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
        case 'SELF_SIGNED_CERT_IN_CHAIN':
        case 'DEPTH_ZERO_SELF_SIGNED_CERT':
            return 48;
        default:
            return 42;
    }
}

function frameSize(frame: QuicFrame): number {
    return encodeFrames([frame]).length;
}

function hex(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return out;
}

function toSafeNumber(value: bigint): number {
    return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
}

export class QuicStream extends Emitter {
    readonly id: number;
    readonly bidirectional: boolean;
    readonly locallyInitiated: boolean;
    /** Null on a receive-only stream (the peer's unidirectional stream). */
    readonly sendBuffer: SendBuffer | null;
    /** Null on a send-only stream (our unidirectional stream). */
    readonly recvBuffer: RecvBuffer | null;
    /** Absolute offset the peer lets us send up to. */
    peerMaxStreamData = 0;
    /** Absolute offset we let the peer send up to. */
    localMaxStreamData: number;
    readonly localWindow: number;
    consumed = 0;
    endEmitted = false;
    finishEmitted = false;
    resetSent: { errorCode: bigint; finalSize: number } | null = null;
    resetReceived: { errorCode: number; finalSize: number } | null = null;
    stopSendingSent: bigint | null = null;
    /** This stream already released its slot in the peer's cumulative stream limit (RFC 9000 Section 4.6). */
    limitReleased = false;

    constructor(
        private readonly connection: QuicConnection,
        id: number,
        canSend: boolean,
        canReceive: boolean,
        receiveWindow: number,
    ) {
        super();
        this.id = id;
        this.bidirectional = (id & 2) === 0;
        this.locallyInitiated = ((id & 1) === 0) === connection.isClient;
        this.sendBuffer = canSend ? new SendBuffer() : null;
        this.recvBuffer = canReceive ? new RecvBuffer() : null;
        this.localWindow = receiveWindow;
        this.localMaxStreamData = receiveWindow;
    }

    /** Queues bytes (or a UTF-8 string) for sending. */
    write(data: Uint8Array | string): boolean {
        this.connection.streamWrite(this, typeof data === 'string' ? utf8Encode(data) : data);
        return true;
    }

    /** Queues optional final bytes, then the FIN. */
    end(data?: Uint8Array | string): void {
        if (data !== undefined) this.write(data);
        this.connection.streamEnd(this);
    }

    /** Abruptly ends the send side with RESET_STREAM. */
    reset(errorCode = 0): void {
        this.connection.streamReset(this, BigInt(errorCode));
    }

    /** Asks the peer to stop sending with STOP_SENDING. */
    stopSending(errorCode = 0): void {
        this.connection.streamStopSending(this, BigInt(errorCode));
    }

    get bytesReceived(): number {
        return this.consumed;
    }

    get bytesWritten(): number {
        return this.sendBuffer?.length ?? 0;
    }
}

export class QuicConnection extends Emitter {
    readonly role: 'client' | 'server';
    readonly isClient: boolean;
    state: ConnectionState = 'handshake';
    handshakeComplete = false;
    handshakeConfirmed = false;
    readonly localCid: Uint8Array;
    remoteCid: Uint8Array;
    readonly originalDcid: Uint8Array;
    retrySourceCid: Uint8Array | null;
    /** Client: the token sent in Initial packets (from a Retry). */
    private token: Uint8Array = new Uint8Array(0);
    /** The peer's Source Connection ID in its first Initial (RFC 9000 Section 7.3 check). */
    private peerInitialScid: Uint8Array | null;
    private receivedServerPacket = false;
    private retryReceived = false;
    private addressValidated: boolean;
    private peerAddressValidated: boolean;
    private bytesReceived = 0;
    private bytesSent = 0;
    readonly localTransportParameters: TransportParameters;
    peerTransportParameters: TransportParameters | null = null;
    private readonly settings: TransportSettings;
    private readonly tls: TlsEngine;
    private readonly rejectUnauthorized: boolean;
    handshakeInfo: HandshakeInfo | null = null;
    newToken: Uint8Array | null = null;
    readonly stats: ConnectionStats = {
        datagramsSent: 0,
        datagramsReceived: 0,
        packetsSent: 0,
        packetsReceived: 0,
        packetsDropped: 0,
        duplicates: 0,
        packetsLost: 0,
        ptoFired: 0,
        keyUpdates: 0,
    };
    closeInfo: CloseInfo | null = null;

    private readonly platform: QuicPlatform;
    private readonly sendDatagramFn: (datagram: Uint8Array) => void;
    private readonly onClosedFn: (() => void) | undefined;
    private readonly traceFn: ((event: Record<string, unknown>) => void) | undefined;
    private readonly wrapBytes: (bytes: Uint8Array) => Uint8Array;
    private readonly recovery = new Recovery<FrameRecord>();
    private readonly spaces: Record<SpaceId, ReceiveSpace>;
    private readonly cryptoSend: Record<SpaceId, SendBuffer> = { initial: new SendBuffer(), handshake: new SendBuffer(), application: new SendBuffer() };
    private readonly cryptoRecv: Record<SpaceId, RecvBuffer> = { initial: new RecvBuffer(), handshake: new RecvBuffer(), application: new RecvBuffer() };
    private initialKeys: DirectionalKeys | null;
    private handshakeKeys: DirectionalKeys | null = null;
    private readonly app: AppKeys = {
        read: null,
        readPhase: 0,
        readNext: null,
        readPrevious: null,
        readPreviousExpires: 0,
        readPhaseFirstPn: 0n,
        write: null,
        writePhase: 0,
        writePhaseAcked: false,
    };
    private keyUpdateRequested = false;
    private buffered: { space: SpaceId; packet: ParsedPacket }[] = [];
    private keysChanged = false;
    suite: CipherSuite | null = null;

    private readonly streams = new Map<number, QuicStream>();
    private nextBidiIndex = 0;
    private nextUniIndex = 0;
    private peerBidiOpened = 0;
    private peerUniOpened = 0;
    private peerMaxStreamsBidi = 0;
    private peerMaxStreamsUni = 0;
    /**
     * The cumulative number of streams of each type the peer may open, advertised in the transport
     * parameters and raised with MAX_STREAMS as peer streams close (RFC 9000 Sections 4.6 and 19.11).
     */
    private localMaxStreamsBidi: number;
    private localMaxStreamsUni: number;
    private pendingMaxStreamsBidi = false;
    private pendingMaxStreamsUni = false;
    private peerMaxData = 0;
    private dataSent = 0;
    private localMaxData: number;
    private dataReceived = 0;
    private dataConsumed = 0;
    private pendingMaxData = false;
    private readonly pendingMaxStreamData = new Set<number>();
    private readonly pendingResets = new Set<number>();
    private readonly pendingStopSending = new Set<number>();
    private pendingPathResponses: Uint8Array[] = [];
    private pendingRetire: bigint[] = [];
    private handshakeDonePending = false;
    private readonly peerCids = new Map<bigint, Uint8Array>();
    private peerCidSequence = 0n;
    private retiredBelow = 0n;
    private readonly probeSpaces = new Set<SpaceId>();
    private pingRequested = false;
    private streamCursor = 0;

    private closeDeadline = 0;
    private lastCloseSent = -Infinity;
    /** A CONNECTION_CLOSE of ours has reached the socket (RFC 9000 Section 10.2). */
    private closeSent = false;
    private lastActivity: number;
    private timer: unknown = null;
    private timerDeadline = -1;
    private readonly eventQueue: (() => void)[] = [];
    private drainingEvents = false;
    private flushing = false;
    private flushScheduled = false;
    /** The last flush stopped on the pacer, so a timer has to wake the next one. */
    private pacingBlocked = false;
    private discardInitialAfterFlush = false;
    private discardHandshakeAfterFlush = false;
    private finished = false;

    constructor(config: ConnectionConfig) {
        super();
        this.role = config.role;
        this.isClient = config.role === 'client';
        this.platform = config.platform;
        this.sendDatagramFn = config.sendDatagram;
        this.onClosedFn = config.onClosed;
        this.traceFn = config.trace;
        this.wrapBytes = config.wrapBytes ?? ((bytes) => bytes);
        this.localCid = config.localCid.slice();
        this.remoteCid = config.remoteCid.slice();
        this.originalDcid = config.originalDcid.slice();
        this.retrySourceCid = config.retrySourceCid ? config.retrySourceCid.slice() : null;
        this.retryReceived = false;
        this.peerInitialScid = this.isClient ? null : this.remoteCid.slice();
        this.addressValidated = this.isClient || config.addressValidated === true;
        this.peerAddressValidated = !this.isClient;
        this.rejectUnauthorized = config.rejectUnauthorized !== false;
        this.settings = { ...DEFAULT_TRANSPORT_SETTINGS, ...(config.transport ?? {}) };
        this.localMaxData = this.settings.initialMaxData;
        this.localMaxStreamsBidi = this.settings.initialMaxStreamsBidi;
        this.localMaxStreamsUni = this.settings.initialMaxStreamsUni;
        this.lastActivity = this.platform.now();
        const newSpace = (): ReceiveSpace => ({ recv: new PacketNumberSet(), largestRecv: null, largestRecvTime: null, ackPending: false, nextPn: 0n });
        this.spaces = { initial: newSpace(), handshake: newSpace(), application: newSpace() };
        const keyCid = this.isClient ? this.remoteCid : (config.initialDcid ?? this.originalDcid);
        const initial = initialPacketKeys(keyCid);
        this.initialKeys = this.isClient ? { read: initial.server, write: initial.client } : { read: initial.client, write: initial.server };
        this.localTransportParameters = this.buildLocalTransportParameters();
        this.tls = this.platform.createTlsEngine({
            ...config.tls,
            role: this.role,
            quic: true,
            quicTransportParameters: encodeTransportParameters(this.localTransportParameters),
        });
    }

    // ------------------------------------------------------------------ public API

    /** Client: sends the first Initial. */
    start(): void {
        if (!this.isClient) throw new Error('only a client connection starts the handshake');
        this.tls.start();
        this.collectTlsOutput();
        this.trace({ ev: 'start', dcid: hex(this.remoteCid), scid: hex(this.localCid) });
        this.flush(this.platform.now());
        this.drainEvents();
    }

    get alpnProtocol(): string | null {
        return this.tls.alpn;
    }

    get keyPhase(): { read: 0 | 1; write: 0 | 1 } {
        return { read: this.app.readPhase, write: this.app.writePhase };
    }

    /** Whether 1-RTT keys are installed in each direction. */
    get oneRttKeys(): { read: boolean; write: boolean } {
        return { read: this.app.read !== null, write: this.app.write !== null };
    }

    get rtt(): { smoothed: number; latest: number; min: number; variance: number } {
        return { smoothed: this.recovery.smoothedRtt, latest: this.recovery.latestRtt, min: this.recovery.minRtt, variance: this.recovery.rttVar };
    }

    openStream(options: { bidirectional?: boolean } = {}): QuicStream {
        if (this.state === 'closing' || this.state === 'draining' || this.state === 'closed') throw this.apiError('ERR_QUIC_CLOSED', 'the connection is closed');
        const bidirectional = options.bidirectional !== false;
        const index = bidirectional ? this.nextBidiIndex : this.nextUniIndex;
        const limit = bidirectional ? this.peerMaxStreamsBidi : this.peerMaxStreamsUni;
        if (this.peerTransportParameters !== null && index >= limit) throw this.apiError('ERR_QUIC_STREAM_LIMIT', `the peer allows ${limit} ${bidirectional ? 'bidirectional' : 'unidirectional'} streams`);
        const id = index * 4 + (this.isClient ? 0 : 1) + (bidirectional ? 0 : 2);
        if (bidirectional) this.nextBidiIndex++;
        else this.nextUniIndex++;
        const stream = new QuicStream(this, id, true, bidirectional, this.settings.initialMaxStreamDataBidiLocal);
        stream.peerMaxStreamData = this.peerStreamLimit(id);
        this.streams.set(id, stream);
        return stream;
    }

    /**
     * Starts a 1-RTT key update (RFC 9001 Section 6). Returns 'started', or 'deferred' when it must
     * wait until the handshake is confirmed and a packet of the current key phase is acknowledged.
     */
    updateKey(): 'started' | 'deferred' {
        if (this.state !== 'connected' && this.state !== 'handshake') throw this.apiError('ERR_QUIC_CLOSED', 'the connection is closed');
        if (this.canInitiateKeyUpdate()) {
            this.initiateKeyUpdate();
            this.scheduleFlush();
            return 'started';
        }
        this.keyUpdateRequested = true;
        return 'deferred';
    }

    /** Closes the connection with an application error code (CONNECTION_CLOSE type 0x1d). */
    close(errorCode = 0, reason = ''): void {
        if (this.state === 'closing' || this.state === 'draining' || this.state === 'closed') return;
        const now = this.platform.now();
        this.enterClosing({ errorCode, reason, application: true, remote: false }, now);
        this.flush(now);
        // A flush already in progress ignores this call (it re-enters), and a close that never reaches
        // the wire leaves the peer waiting for its own idle timeout: try again on the next turn.
        if (!this.closeSent) this.scheduleFlush();
        this.drainEvents();
    }

    /** Endpoint input: one datagram addressed to this connection. */
    receiveDatagram(datagram: Uint8Array): void {
        if (this.state === 'closed' || this.state === 'draining') return;
        const now = this.platform.now();
        this.bytesReceived += datagram.length;
        this.stats.datagramsReceived++;
        if (this.state === 'closing') {
            if (now - this.lastCloseSent >= Math.max(1, this.recovery.smoothedRtt)) this.flush(now);
            this.drainEvents();
            return;
        }
        const parsed = parseDatagram(datagram, this.localCid.length);
        if (parsed.stoppedBy !== null && parsed.packets.length === 0) this.stats.packetsDropped++;
        for (const packet of parsed.packets) {
            if (!this.isOpen()) break;
            this.receivePacketSafely(packet, now);
        }
        this.retryBuffered(now);
        // Packet processing may have moved the state to closing (send CONNECTION_CLOSE) or draining.
        if (this.isOpen() || (this.state as ConnectionState) === 'closing') this.flush(now);
        else this.armTimer(now);
        this.drainEvents();
    }

    // ------------------------------------------------------------------ stream plumbing

    streamWrite(stream: QuicStream, data: Uint8Array): void {
        if (stream.sendBuffer === null) throw this.apiError('ERR_QUIC_STREAM_STATE', `stream ${stream.id} is receive-only`);
        if (stream.resetSent !== null) throw this.apiError('ERR_QUIC_STREAM_STATE', `stream ${stream.id} was reset`);
        if (!this.isOpen()) throw this.apiError('ERR_QUIC_CLOSED', 'the connection is closed');
        stream.sendBuffer.write(data);
        this.scheduleFlush();
    }

    streamEnd(stream: QuicStream): void {
        if (stream.sendBuffer === null) throw this.apiError('ERR_QUIC_STREAM_STATE', `stream ${stream.id} is receive-only`);
        if (stream.resetSent !== null || !this.isOpen()) return;
        stream.sendBuffer.end();
        this.scheduleFlush();
    }

    streamReset(stream: QuicStream, errorCode: bigint): void {
        if (stream.sendBuffer === null || stream.resetSent !== null || !this.isOpen()) return;
        stream.resetSent = { errorCode, finalSize: stream.sendBuffer.maxSentOffset };
        this.pendingResets.add(stream.id);
        this.scheduleFlush();
    }

    streamStopSending(stream: QuicStream, errorCode: bigint): void {
        if (stream.recvBuffer === null || stream.stopSendingSent !== null || !this.isOpen()) return;
        stream.stopSendingSent = errorCode;
        this.pendingStopSending.add(stream.id);
        this.scheduleFlush();
    }

    // ------------------------------------------------------------------ receiving

    private isOpen(): boolean {
        return this.state === 'handshake' || this.state === 'connected';
    }

    private receivePacketSafely(packet: ParsedPacket, now: number): void {
        try {
            this.receivePacket(packet, now);
        } catch (error) {
            if (error instanceof QuicError) {
                this.closeTransport(error.errorCode, error.message, error.frameType === undefined ? 0 : Number(error.frameType), now);
                return;
            }
            if (error instanceof FinalSizeError) {
                this.closeTransport(TransportError.FINAL_SIZE_ERROR, error.message, FT.STREAM, now);
                return;
            }
            // A defect here must not take the guest process down with an uncaught exception from a
            // socket callback: close with INTERNAL_ERROR and keep the stack in the trace.
            this.trace({ ev: 'internal_error', message: String((error as Error)?.message ?? error), stack: String((error as Error)?.stack ?? '') });
            this.closeTransport(TransportError.INTERNAL_ERROR, 'internal error', 0, now);
        }
    }

    private acceptsDcid(dcid: Uint8Array): boolean {
        if (equalBytes(dcid, this.localCid)) return true;
        if (this.isClient) return false;
        return equalBytes(dcid, this.originalDcid) || (this.retrySourceCid !== null && equalBytes(dcid, this.retrySourceCid));
    }

    private readKeysFor(space: SpaceId): PacketKeys | null {
        if (space === 'initial') return this.initialKeys?.read ?? null;
        if (space === 'handshake') return this.handshakeKeys?.read ?? null;
        return this.app.read;
    }

    private writeKeysFor(space: SpaceId): PacketKeys | null {
        if (space === 'initial') return this.initialKeys?.write ?? null;
        if (space === 'handshake') return this.handshakeKeys?.write ?? null;
        return this.app.write;
    }

    private receivePacket(packet: ParsedPacket, now: number): void {
        if (packet.type === 'version_negotiation') return this.onVersionNegotiation(packet, now);
        if (packet.type === 'retry') return this.onRetry(packet, now);
        if (packet.type === 'unsupported_version' || packet.type === '0rtt') {
            this.drop(packet, 'unsupported packet type');
            return;
        }
        if (!this.acceptsDcid(packet.dcid)) {
            this.drop(packet, 'unknown destination connection id');
            return;
        }
        if (packet.type !== '1rtt' && this.isClient && this.peerInitialScid !== null && packet.scid !== null && !equalBytes(packet.scid, this.peerInitialScid)) {
            this.drop(packet, 'source connection id differs from the first server packet');
            return;
        }
        const space: SpaceId = packet.type === 'initial' ? 'initial' : packet.type === 'handshake' ? 'handshake' : 'application';
        if (this.recovery.isDiscarded(space)) {
            this.drop(packet, 'keys discarded');
            return;
        }
        const sp = this.spaces[space];
        let pn: bigint;
        let payload: Uint8Array;
        let keyPhase: 0 | 1 | null = null;
        if (packet.type === '1rtt') {
            // A server processes no 1-RTT packet before the handshake completes (RFC 9001 Section 5.7).
            if (this.app.read === null || (!this.isClient && !this.handshakeComplete)) {
                this.bufferPacket(space, packet);
                return;
            }
            const opened = this.open1Rtt(packet, now);
            if (opened === null) return;
            pn = opened.pn;
            payload = opened.payload;
            keyPhase = opened.phase;
        } else {
            const keys = this.readKeysFor(space);
            if (keys === null) {
                this.bufferPacket(space, packet);
                return;
            }
            try {
                const opened = openPacket(packet, keys, sp.largestRecv);
                pn = opened.packetNumber;
                payload = opened.payload;
            } catch (error) {
                if (error instanceof PacketDropError) {
                    this.drop(packet, error.reason);
                    return;
                }
                throw error;
            }
        }
        if (sp.recv.has(pn)) {
            this.stats.duplicates++;
            return;
        }
        const frames = decodeFrames(payload, packet.type as FramePacketType);
        if (this.isClient) this.receivedServerPacket = true;
        if (this.isClient && packet.type === 'initial' && this.peerInitialScid === null && packet.scid !== null) {
            this.peerInitialScid = packet.scid.slice();
            this.remoteCid = packet.scid.slice();
            this.peerCids.set(0n, this.remoteCid);
        }
        if (!this.isClient && packet.type === 'handshake') {
            this.addressValidated = true;
            if (!this.recovery.isDiscarded('initial')) this.discardInitial();
        }
        sp.recv.add(pn);
        if (sp.largestRecv === null || pn > sp.largestRecv) {
            sp.largestRecv = pn;
            sp.largestRecvTime = now;
        }
        this.lastActivity = now;
        this.stats.packetsReceived++;
        if (this.traceFn) {
            const ack = frames.find((frame) => frame.type === 'ACK') as Extract<QuicFrame, { type: 'ACK' }> | undefined;
            const streamFrames = frames.filter((frame) => frame.type === 'STREAM') as Extract<QuicFrame, { type: 'STREAM' }>[];
            this.trace({
                ev: 'packet_received',
                type: packet.type,
                pn: pn.toString(),
                keyPhase,
                size: packet.bytes.length,
                frames: frames.map((f) => f.type),
                ...(ack ? { ackRanges: ack.ranges.map((r) => `${r.smallest}-${r.largest}`) } : {}),
                ...(streamFrames.length > 0 ? { streams: streamFrames.map((f) => ({ id: Number(f.streamId), offset: Number(f.offset), length: f.data.length, fin: f.fin })) } : {}),
            });
        }
        let ackEliciting = false;
        for (const frame of frames) {
            if (frame.type !== 'ACK' && frame.type !== 'PADDING' && frame.type !== 'CONNECTION_CLOSE') ackEliciting = true;
            this.processFrame(frame, space, now);
            if (!this.isOpen()) return;
        }
        if (ackEliciting) sp.ackPending = true;
    }

    private drop(packet: ParsedPacket, reason: string): void {
        this.stats.packetsDropped++;
        this.trace({ ev: 'packet_dropped', type: packet.type, reason, size: packet.bytes.length });
    }

    private bufferPacket(space: SpaceId, packet: ParsedPacket): void {
        if (this.buffered.length >= MAX_BUFFERED_PACKETS) {
            this.drop(packet, 'keys unavailable, buffer full');
            return;
        }
        this.buffered.push({ space, packet: { ...packet, bytes: new Uint8Array(packet.bytes) } });
        this.trace({ ev: 'packet_buffered', type: packet.type, size: packet.bytes.length });
    }

    /** Retries packets that arrived before their keys (RFC 9001 Section 5.7). */
    private retryBuffered(now: number): void {
        while (this.keysChanged && this.buffered.length > 0 && this.isOpen()) {
            this.keysChanged = false;
            const waiting = this.buffered;
            this.buffered = [];
            for (const entry of waiting) {
                if (!this.isOpen()) return;
                const ready = this.recovery.isDiscarded(entry.space)
                    ? false
                    : entry.space === 'application'
                      ? this.app.read !== null && (this.isClient || this.handshakeComplete)
                      : this.readKeysFor(entry.space) !== null;
                if (ready) this.receivePacketSafely(entry.packet, now);
                else if (!this.recovery.isDiscarded(entry.space)) this.buffered.push(entry);
            }
        }
        this.keysChanged = false;
    }

    /** Removes 1-RTT protection, following the Key Phase bit (RFC 9001 Section 6). */
    private open1Rtt(packet: ParsedPacket, now: number): { pn: bigint; payload: Uint8Array; phase: 0 | 1 } | null {
        const app = this.app;
        const current = app.read as PacketKeys;
        const unmasked = removeHeaderProtection(current, packet.bytes, packet.pnOffset as number);
        if (unmasked === null) {
            this.drop(packet, 'malformed');
            return null;
        }
        const pn = decodePacketNumber(this.spaces.application.largestRecv, unmasked.truncatedPn, (unmasked.pnLength * 8) as 8 | 16 | 24 | 32);
        if (pn > PACKET_NUMBER_MAX) {
            this.drop(packet, 'malformed');
            return null;
        }
        const phase = ((unmasked.header[0] >> 2) & 1) as 0 | 1;
        const sealed = packet.bytes.subarray(unmasked.header.length);
        let which: 'current' | 'previous' | 'next' | 'consecutive';
        let keys: PacketKeys;
        if (phase === app.readPhase) {
            which = 'current';
            keys = current;
        } else if (app.readPrevious !== null && pn < app.readPhaseFirstPn) {
            which = 'previous';
            keys = app.readPrevious;
        } else {
            which = 'next';
            if (app.readNext === null) app.readNext = nextKeyPhaseKeys(current);
            keys = app.readNext;
        }
        let payload = decryptPayload(keys, unmasked.header, sealed, pn);
        if (payload === null && which === 'current' && app.writePhase !== app.readPhase) {
            // We started an update and the peer answered it and at once started another one, before
            // any packet of the intermediate phase reached us. RFC 9001 Section 6.5 lets an endpoint
            // treat such consecutive updates as KEY_UPDATE_ERROR; this endpoint accepts them when the
            // packet authenticates under the keys two generations ahead.
            if (app.readNext === null) app.readNext = nextKeyPhaseKeys(current);
            const twoAhead = nextKeyPhaseKeys(app.readNext);
            const candidate = decryptPayload(twoAhead, unmasked.header, sealed, pn);
            if (candidate !== null) {
                payload = candidate;
                which = 'consecutive';
                keys = twoAhead;
            }
        }
        if (payload === null) {
            this.drop(packet, which === 'next' ? 'authentication (next key phase)' : 'authentication');
            return null;
        }
        if ((unmasked.header[0] & SHORT_HEADER_RESERVED_BITS) !== 0) throw new QuicError(TransportError.PROTOCOL_VIOLATION, 'reserved header bits are not zero');
        if (which === 'consecutive') {
            app.readPrevious = current;
            app.readPreviousExpires = now + 3 * this.recovery.ptoPeriod('application');
            app.read = keys;
            app.readNext = null;
            app.readPhase = phase;
            app.readPhaseFirstPn = pn;
            // The peer's receive keys are now one generation past our send keys: follow it.
            app.write = nextKeyPhaseKeys(app.write as PacketKeys);
            app.writePhase = phase;
            app.writePhaseAcked = false;
            this.stats.keyUpdates++;
            const info: KeyUpdateInfo = { initiator: 'peer', stage: 'started', phase, packetNumber: pn.toString(), updates: this.stats.keyUpdates, consecutive: true };
            this.trace({ ev: 'key_update', ...info });
            this.queueEvent(() => this.emit('keyupdate', info));
        }
        if (which === 'next') {
            app.readPrevious = current;
            app.readPreviousExpires = now + 3 * this.recovery.ptoPeriod('application');
            app.read = app.readNext;
            app.readNext = null;
            app.readPhase = phase;
            app.readPhaseFirstPn = pn;
            if (app.writePhase !== phase) {
                // The peer started a key update: answer by updating the send keys too (Section 6.2).
                app.write = nextKeyPhaseKeys(app.write as PacketKeys);
                app.writePhase = phase;
                app.writePhaseAcked = false;
                this.stats.keyUpdates++;
                const info: KeyUpdateInfo = { initiator: 'peer', stage: 'started', phase, packetNumber: pn.toString(), updates: this.stats.keyUpdates };
                this.trace({ ev: 'key_update', ...info });
                this.queueEvent(() => this.emit('keyupdate', info));
            } else {
                const info: KeyUpdateInfo = { initiator: 'local', stage: 'completed', phase, packetNumber: pn.toString(), updates: this.stats.keyUpdates };
                this.trace({ ev: 'key_update', ...info });
                this.queueEvent(() => this.emit('keyupdate', info));
            }
        }
        return { pn, payload, phase };
    }

    private processFrame(frame: QuicFrame, space: SpaceId, now: number): void {
        switch (frame.type) {
            case 'PADDING':
            case 'PING':
                return;
            case 'ACK':
                return this.onAckFrame(space, frame, now);
            case 'CRYPTO':
                return this.onCryptoFrame(space, frame, now);
            case 'STREAM':
                return this.onStreamFrame(frame);
            case 'RESET_STREAM':
                return this.onResetStream(frame);
            case 'STOP_SENDING':
                return this.onStopSending(frame);
            case 'MAX_DATA':
                this.peerMaxData = Math.max(this.peerMaxData, toSafeNumber(frame.maximum));
                return;
            case 'MAX_STREAM_DATA': {
                const stream = this.streamFor(toSafeNumber(frame.streamId), FT.MAX_STREAM_DATA);
                if (stream.sendBuffer === null) throw new QuicError(TransportError.STREAM_STATE_ERROR, 'MAX_STREAM_DATA for a receive-only stream', BigInt(FT.MAX_STREAM_DATA));
                stream.peerMaxStreamData = Math.max(stream.peerMaxStreamData, toSafeNumber(frame.maximum));
                return;
            }
            case 'MAX_STREAMS': {
                const maximum = toSafeNumber(frame.maximum);
                if (frame.bidirectional) {
                    if (maximum <= this.peerMaxStreamsBidi) return;
                    this.peerMaxStreamsBidi = maximum;
                } else {
                    if (maximum <= this.peerMaxStreamsUni) return;
                    this.peerMaxStreamsUni = maximum;
                }
                this.trace({ ev: 'max_streams', bidirectional: frame.bidirectional, maximum });
                this.queueEvent(() => this.emit('streams', { bidirectional: frame.bidirectional, maximum }));
                return;
            }
            case 'DATA_BLOCKED':
            case 'STREAM_DATA_BLOCKED':
                return;
            case 'STREAMS_BLOCKED':
                return this.onStreamsBlocked(frame.bidirectional, frame.limit);
            case 'NEW_CONNECTION_ID':
                return this.onNewConnectionId(frame);
            case 'RETIRE_CONNECTION_ID':
                // Only sequence number 0 was ever issued, and it is the one this packet arrived on.
                throw new QuicError(TransportError.PROTOCOL_VIOLATION, `RETIRE_CONNECTION_ID ${frame.sequenceNumber} for a connection ID that cannot be retired`, BigInt(FT.RETIRE_CONNECTION_ID));
            case 'PATH_CHALLENGE':
                if (this.pendingPathResponses.length < 4) this.pendingPathResponses.push(frame.data.slice());
                return;
            case 'PATH_RESPONSE':
                return;
            case 'NEW_TOKEN':
                if (!this.isClient) throw new QuicError(TransportError.PROTOCOL_VIOLATION, 'NEW_TOKEN from a client', BigInt(FT.NEW_TOKEN));
                this.newToken = frame.token.slice();
                return;
            case 'CONNECTION_CLOSE':
                return this.onPeerClose(frame, now);
            case 'HANDSHAKE_DONE':
                if (!this.isClient) throw new QuicError(TransportError.PROTOCOL_VIOLATION, 'HANDSHAKE_DONE from a client', BigInt(FT.HANDSHAKE_DONE));
                return this.confirmHandshake(now);
        }
    }

    private onAckFrame(space: SpaceId, frame: Extract<QuicFrame, { type: 'ACK' }>, now: number): void {
        if (frame.ranges[0].largest >= this.spaces[space].nextPn) {
            throw new QuicError(TransportError.PROTOCOL_VIOLATION, 'ACK for a packet number that was never sent', BigInt(FT.ACK));
        }
        const exponent = space === 'application' ? toSafeNumber(this.peerTransportParameters?.ack_delay_exponent ?? 3n) : 3;
        const ackDelay = (toSafeNumber(frame.delay) * 2 ** exponent) / 1000;
        const outcome = this.recovery.onAckReceived(space, frame.ranges, ackDelay, now, this.handshakeConfirmed);
        if (space === 'handshake' && this.isClient) this.peerAddressValidated = true;
        for (const packet of outcome.acked) {
            for (const record of packet.frames) this.onFrameAcked(record);
            if (space === 'application') {
                if (packet.keyPhase === this.app.writePhase) this.app.writePhaseAcked = true;
                // RFC 9001 Section 4.1.2: a client may confirm the handshake on an ACK of a 1-RTT packet.
                if (this.isClient && this.handshakeComplete && !this.handshakeConfirmed) this.confirmHandshake(now);
            }
        }
        for (const packet of outcome.lost) this.onPacketLost(packet);
        if (outcome.acked.length > 0) this.trace({ ev: 'ack_received', space, acked: outcome.acked.map((p) => p.pn.toString()), lost: outcome.lost.map((p) => p.pn.toString()) });
    }

    private onFrameAcked(record: FrameRecord): void {
        switch (record.kind) {
            case 'crypto':
                this.cryptoSend[record.space].onAcked(record.offset, record.length, false);
                return;
            case 'stream': {
                const stream = this.streams.get(record.streamId);
                if (!stream || stream.sendBuffer === null) return;
                stream.sendBuffer.onAcked(record.offset, record.length, record.fin);
                if (stream.sendBuffer.finished && stream.sendBuffer.allAcked && !stream.finishEmitted) {
                    stream.finishEmitted = true;
                    this.queueEvent(() => stream.emit('finish'));
                }
                return;
            }
            default:
                return;
        }
    }

    private onPacketLost(packet: SentPacket<FrameRecord>): void {
        this.stats.packetsLost++;
        this.trace({ ev: 'packet_lost', pn: packet.pn.toString(), frames: packet.frames.map((f) => f.kind) });
        for (const record of packet.frames) this.onFrameLost(record);
    }

    private onFrameLost(record: FrameRecord): void {
        switch (record.kind) {
            case 'crypto':
                if (!this.recovery.isDiscarded(record.space)) this.cryptoSend[record.space].onLost(record.offset, record.length, false);
                return;
            case 'stream': {
                const stream = this.streams.get(record.streamId);
                if (stream && stream.sendBuffer !== null && stream.resetSent === null) stream.sendBuffer.onLost(record.offset, record.length, record.fin);
                return;
            }
            case 'reset_stream':
                this.pendingResets.add(record.streamId);
                return;
            case 'stop_sending':
                this.pendingStopSending.add(record.streamId);
                return;
            case 'handshake_done':
                this.handshakeDonePending = true;
                return;
            case 'max_data':
                this.pendingMaxData = true;
                return;
            case 'max_stream_data':
                this.pendingMaxStreamData.add(record.streamId);
                return;
            case 'max_streams':
                if (record.bidirectional) this.pendingMaxStreamsBidi = true;
                else this.pendingMaxStreamsUni = true;
                return;
            case 'retire_cid':
                this.pendingRetire.push(record.sequence);
                return;
            case 'ack':
                return;
        }
    }

    private onCryptoFrame(space: SpaceId, frame: Extract<QuicFrame, { type: 'CRYPTO' }>, now: number): void {
        const buffer = this.cryptoRecv[space];
        const offset = toSafeNumber(frame.offset);
        if (offset + frame.data.length > buffer.deliveredOffset + CRYPTO_BUFFER_LIMIT) {
            throw new QuicError(TransportError.CRYPTO_BUFFER_EXCEEDED, 'CRYPTO data beyond the buffer limit', BigInt(FT.CRYPTO));
        }
        const chunks = buffer.insert(offset, frame.data, false);
        for (const chunk of chunks) {
            if (!this.isOpen()) return;
            const events = this.tls.feedCrypto(LEVEL_OF[space], chunk);
            this.onTlsEvents(events, now);
        }
    }

    private onTlsEvents(events: TlsEvent[], now: number): void {
        for (const event of events) {
            if (!this.isOpen()) return;
            switch (event.type) {
                case 'secrets':
                    this.installSecrets(event);
                    break;
                case 'connected':
                    this.checkPeerTransportParameters(now);
                    if (this.isOpen()) this.onTlsConnected(event, now);
                    break;
                case 'error':
                    this.trace({ ev: 'tls_error', code: event.code, message: event.message, alert: event.alert });
                    this.closeTransport(event.alert === null ? TransportError.INTERNAL_ERROR : cryptoErrorCode(event.alert), `TLS: ${event.message}`, FT.CRYPTO, now);
                    return;
                default:
                    break;
            }
        }
        if (!this.isOpen()) return;
        this.checkPeerTransportParameters(now);
        if (!this.isOpen()) return;
        this.collectTlsOutput();
    }

    private installSecrets(event: Extract<TlsEvent, { type: 'secrets' }>): void {
        const suite = event.suite.name as CipherSuite;
        if (!Object.prototype.hasOwnProperty.call(CIPHER_SUITES, suite)) throw new QuicError(TransportError.INTERNAL_ERROR, `unsupported cipher suite ${event.suite.name}`);
        this.suite = suite;
        const mine = this.isClient ? event.client : event.server;
        const theirs = this.isClient ? event.server : event.client;
        if (event.level === 'handshake') {
            this.handshakeKeys = { read: derivePacketKeys(suite, theirs), write: derivePacketKeys(suite, mine) };
        } else {
            this.app.read = derivePacketKeys(suite, theirs);
            this.app.write = derivePacketKeys(suite, mine);
            this.app.readPhase = 0;
            this.app.writePhase = 0;
        }
        this.keysChanged = true;
        this.trace({ ev: 'keys_installed', level: event.level, suite });
    }

    private collectTlsOutput(): void {
        for (const level of TLS_LEVELS) {
            const bytes = this.tls.takeCrypto(level);
            if (bytes.length === 0) continue;
            const space = SPACE_OF_LEVEL[level];
            if (this.recovery.isDiscarded(space)) continue;
            this.cryptoSend[space].write(bytes);
        }
    }

    /** Decodes and checks the peer's transport parameters as soon as the TLS engine has them (RFC 9000 Section 7.3). */
    private checkPeerTransportParameters(now: number): void {
        if (this.peerTransportParameters !== null) return;
        const raw = this.tls.peerQuicTransportParameters;
        if (raw === null || raw === undefined) return;
        let params: TransportParameters;
        try {
            params = decodeTransportParameters(raw, this.isClient ? 'server' : 'client');
        } catch (error) {
            if (error instanceof QuicError) {
                this.closeTransport(error.errorCode, `transport parameters: ${error.message}`, FT.CRYPTO, now);
                return;
            }
            throw error;
        }
        const fail = (message: string): void => this.closeTransport(TransportError.TRANSPORT_PARAMETER_ERROR, message, FT.CRYPTO, now);
        const isci = params.initial_source_connection_id;
        if (isci === undefined || this.peerInitialScid === null || !equalBytes(isci, this.peerInitialScid)) return fail('initial_source_connection_id does not match the Source Connection ID of the peer\'s Initial');
        if (this.isClient) {
            const odcid = params.original_destination_connection_id;
            if (odcid === undefined || !equalBytes(odcid, this.originalDcid)) return fail('original_destination_connection_id does not match');
            if (this.retryReceived) {
                const rscid = params.retry_source_connection_id;
                if (rscid === undefined || this.retrySourceCid === null || !equalBytes(rscid, this.retrySourceCid)) return fail('retry_source_connection_id does not match the Retry');
            } else if (params.retry_source_connection_id !== undefined) {
                return fail('retry_source_connection_id without a Retry');
            }
        }
        this.peerTransportParameters = params;
        this.peerMaxData = toSafeNumber(params.initial_max_data ?? 0n);
        this.peerMaxStreamsBidi = toSafeNumber(params.initial_max_streams_bidi ?? 0n);
        this.peerMaxStreamsUni = toSafeNumber(params.initial_max_streams_uni ?? 0n);
        this.recovery.maxAckDelay = toSafeNumber(params.max_ack_delay ?? 25n);
        for (const stream of this.streams.values()) stream.peerMaxStreamData = Math.max(stream.peerMaxStreamData, this.peerStreamLimit(stream.id));
        this.trace({ ev: 'transport_parameters', peer: describeTransportParameters(params) });
    }

    private onTlsConnected(event: Extract<TlsEvent, { type: 'connected' }>, now: number): void {
        const authorized = event.peerVerify.authorized;
        const authorizationError = event.peerVerify.authorizationError;
        if (this.isClient && !authorized && this.rejectUnauthorized) {
            this.closeTransport(cryptoErrorCode(alertForVerifyError(authorizationError)), `certificate verify failed: ${authorizationError}`, FT.CRYPTO, now);
            return;
        }
        this.handshakeComplete = true;
        this.state = 'connected';
        if (!this.isClient) {
            // RFC 9001 Section 4.1.2: the server confirms the handshake when it completes, and then
            // sends HANDSHAKE_DONE; Handshake keys go once the ACK of the client's Finished is out.
            this.handshakeConfirmed = true;
            this.handshakeDonePending = true;
            this.discardHandshakeAfterFlush = true;
            // 1-RTT packets held back until completion (RFC 9001 Section 5.7) can be processed now.
            this.keysChanged = true;
        }
        const info: HandshakeInfo = {
            role: this.role,
            version: QUIC_VERSION_1,
            alpn: event.alpnProtocol,
            cipher: event.cipherName,
            group: event.group === 29 ? 'X25519' : event.group === 23 ? 'P-256' : String(event.group),
            authorized,
            authorizationError,
            peerCertificates: event.peerCertificates,
            serverName: event.peerServerName,
            localTransportParameters: this.localTransportParameters,
            peerTransportParameters: this.peerTransportParameters as TransportParameters,
            localCid: this.localCid,
            remoteCid: this.remoteCid,
            originalDcid: this.originalDcid,
            retried: this.isClient ? this.retryReceived : this.retrySourceCid !== null,
        };
        this.handshakeInfo = info;
        this.trace({ ev: 'handshake_complete', alpn: info.alpn, cipher: info.cipher, group: info.group, authorized });
        this.queueEvent(() => this.emit('handshake', info));
    }

    private confirmHandshake(now: number): void {
        if (this.handshakeConfirmed) return;
        this.handshakeConfirmed = true;
        this.peerAddressValidated = true;
        if (!this.recovery.isDiscarded('initial')) this.discardInitial();
        if (!this.recovery.isDiscarded('handshake')) this.discardHandshake();
        this.trace({ ev: 'handshake_confirmed', at: now });
        this.queueEvent(() => this.emit('confirmed'));
    }

    private onStreamFrame(frame: Extract<QuicFrame, { type: 'STREAM' }>): void {
        const id = toSafeNumber(frame.streamId);
        const stream = this.streamFor(id, FT.STREAM);
        if (stream.recvBuffer === null) throw new QuicError(TransportError.STREAM_STATE_ERROR, `STREAM frame for send-only stream ${id}`, BigInt(FT.STREAM));
        const offset = toSafeNumber(frame.offset);
        const end = offset + frame.data.length;
        if (end > stream.localMaxStreamData) throw new QuicError(TransportError.FLOW_CONTROL_ERROR, `stream ${id} data beyond its limit`, BigInt(FT.STREAM));
        const before = stream.recvBuffer.highestOffset;
        const chunks = stream.recvBuffer.insert(offset, frame.data, frame.fin);
        this.dataReceived += stream.recvBuffer.highestOffset - before;
        if (this.dataReceived > this.localMaxData) throw new QuicError(TransportError.FLOW_CONTROL_ERROR, 'connection data beyond its limit', BigInt(FT.STREAM));
        for (const chunk of chunks) {
            stream.consumed += chunk.length;
            this.dataConsumed += chunk.length;
            const bytes = this.wrapBytes(chunk.slice());
            this.queueEvent(() => stream.emit('data', bytes));
        }
        if (stream.recvBuffer.complete && !stream.endEmitted) {
            stream.endEmitted = true;
            this.queueEvent(() => stream.emit('end'));
        }
        if (stream.recvBuffer.complete) this.releaseStreamLimit(stream);
        if (!stream.recvBuffer.complete && stream.localMaxStreamData - stream.consumed < stream.localWindow / 2) {
            stream.localMaxStreamData = stream.consumed + stream.localWindow;
            this.pendingMaxStreamData.add(id);
        }
        if (this.localMaxData - this.dataConsumed < this.settings.initialMaxData / 2) {
            this.localMaxData = this.dataConsumed + this.settings.initialMaxData;
            this.pendingMaxData = true;
        }
    }

    private onResetStream(frame: Extract<QuicFrame, { type: 'RESET_STREAM' }>): void {
        const id = toSafeNumber(frame.streamId);
        const stream = this.streamFor(id, FT.RESET_STREAM);
        if (stream.recvBuffer === null) throw new QuicError(TransportError.STREAM_STATE_ERROR, `RESET_STREAM for send-only stream ${id}`, BigInt(FT.RESET_STREAM));
        const finalSize = toSafeNumber(frame.finalSize);
        const known = stream.recvBuffer.finalSize;
        if ((known !== null && known !== finalSize) || finalSize < stream.recvBuffer.highestOffset) throw new QuicError(TransportError.FINAL_SIZE_ERROR, `RESET_STREAM final size for stream ${id}`, BigInt(FT.RESET_STREAM));
        if (finalSize > stream.localMaxStreamData) throw new QuicError(TransportError.FLOW_CONTROL_ERROR, `RESET_STREAM final size beyond the limit of stream ${id}`, BigInt(FT.RESET_STREAM));
        this.dataReceived += finalSize - stream.recvBuffer.highestOffset;
        if (stream.resetReceived !== null) return;
        stream.resetReceived = { errorCode: toSafeNumber(frame.errorCode), finalSize };
        const info = stream.resetReceived;
        this.queueEvent(() => stream.emit('reset', info));
        this.releaseStreamLimit(stream);
    }

    private onStopSending(frame: Extract<QuicFrame, { type: 'STOP_SENDING' }>): void {
        const id = toSafeNumber(frame.streamId);
        const stream = this.streamFor(id, FT.STOP_SENDING);
        if (stream.sendBuffer === null) throw new QuicError(TransportError.STREAM_STATE_ERROR, `STOP_SENDING for receive-only stream ${id}`, BigInt(FT.STOP_SENDING));
        const errorCode = frame.errorCode;
        this.queueEvent(() => stream.emit('stop', { errorCode: toSafeNumber(errorCode) }));
        // RFC 9000 Section 3.5: answer STOP_SENDING with RESET_STREAM.
        this.streamReset(stream, errorCode);
    }

    private onNewConnectionId(frame: Extract<QuicFrame, { type: 'NEW_CONNECTION_ID' }>): void {
        if (this.remoteCid.length === 0) throw new QuicError(TransportError.PROTOCOL_VIOLATION, 'NEW_CONNECTION_ID with a zero-length connection ID in use', BigInt(FT.NEW_CONNECTION_ID));
        if (!this.peerCids.has(this.peerCidSequence)) this.peerCids.set(this.peerCidSequence, this.remoteCid);
        const seq = frame.sequenceNumber;
        const existing = this.peerCids.get(seq);
        if (existing !== undefined) {
            if (!equalBytes(existing, frame.connectionId)) throw new QuicError(TransportError.PROTOCOL_VIOLATION, 'NEW_CONNECTION_ID reuses a sequence number', BigInt(FT.NEW_CONNECTION_ID));
            return;
        }
        if (seq < this.retiredBelow) {
            this.pendingRetire.push(seq);
            return;
        }
        this.peerCids.set(seq, frame.connectionId.slice());
        if (frame.retirePriorTo > this.retiredBelow) {
            this.retiredBelow = frame.retirePriorTo;
            for (const known of [...this.peerCids.keys()]) {
                if (known >= this.retiredBelow) continue;
                this.peerCids.delete(known);
                this.pendingRetire.push(known);
            }
            if (this.peerCidSequence < this.retiredBelow) {
                const next = [...this.peerCids.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0];
                if (next !== undefined) {
                    this.peerCidSequence = next;
                    this.remoteCid = (this.peerCids.get(next) as Uint8Array).slice();
                }
            }
        }
        if (this.peerCids.size > this.settings.activeConnectionIdLimit) {
            throw new QuicError(TransportError.CONNECTION_ID_LIMIT_ERROR, 'more connection IDs than active_connection_id_limit', BigInt(FT.NEW_CONNECTION_ID));
        }
    }

    /** The stream a peer frame refers to, opening peer-initiated streams implicitly (RFC 9000 Section 3.2). */
    private streamFor(id: number, frameType: number): QuicStream {
        const existing = this.streams.get(id);
        if (existing) return existing;
        const clientInitiated = (id & 1) === 0;
        const unidirectional = (id & 2) !== 0;
        if (clientInitiated === this.isClient) {
            throw new QuicError(TransportError.STREAM_STATE_ERROR, `frame for locally initiated stream ${id} that was never opened`, BigInt(frameType));
        }
        const index = Math.floor(id / 4);
        const limit = unidirectional ? this.localMaxStreamsUni : this.localMaxStreamsBidi;
        if (index >= limit) throw new QuicError(TransportError.STREAM_LIMIT_ERROR, `stream ${id} exceeds the stream limit`, BigInt(frameType));
        const opened = unidirectional ? this.peerUniOpened : this.peerBidiOpened;
        for (let i = opened; i <= index; i++) {
            const sid = i * 4 + (clientInitiated ? 0 : 1) + (unidirectional ? 2 : 0);
            const window = unidirectional ? this.settings.initialMaxStreamDataUni : this.settings.initialMaxStreamDataBidiRemote;
            const stream = new QuicStream(this, sid, !unidirectional, true, window);
            stream.peerMaxStreamData = this.peerStreamLimit(sid);
            this.streams.set(sid, stream);
            this.queueEvent(() => this.emit('stream', stream));
        }
        if (unidirectional) this.peerUniOpened = index + 1;
        else this.peerBidiOpened = index + 1;
        return this.streams.get(id) as QuicStream;
    }

    /** The peer's initial send limit for a stream (its transport parameters; RFC 9000 Section 18.2). */
    private peerStreamLimit(id: number): number {
        const params = this.peerTransportParameters;
        if (params === null) return 0;
        if ((id & 2) !== 0) return toSafeNumber(params.initial_max_stream_data_uni ?? 0n);
        const local = ((id & 1) === 0) === this.isClient;
        // Our stream is "remote" from the peer's point of view, and the peer's stream is its "local" one.
        return toSafeNumber((local ? params.initial_max_stream_data_bidi_remote : params.initial_max_stream_data_bidi_local) ?? 0n);
    }

    // ------------------------------------------------------------------ stream limits (RFC 9000 Section 4.6)

    /**
     * A stream the peer opened is finished in both directions: its slot in the cumulative limit is
     * given back and MAX_STREAMS is queued. RFC 9000 Section 4.6 leaves the schedule to the
     * implementation and notes that limits might be raised as streams are closed; it also requires
     * that credit not be withheld until the peer sends STREAMS_BLOCKED (Section 19.14).
     */
    private releaseStreamLimit(stream: QuicStream): void {
        if (stream.locallyInitiated || stream.limitReleased) return;
        const sendDone = stream.sendBuffer === null || stream.resetSent !== null || stream.sendBuffer.finished;
        const recvDone = stream.recvBuffer === null || stream.resetReceived !== null || stream.recvBuffer.complete;
        if (!sendDone || !recvDone) return;
        stream.limitReleased = true;
        const bidirectional = stream.bidirectional;
        const current = bidirectional ? this.localMaxStreamsBidi : this.localMaxStreamsUni;
        if (current >= Number(MAX_STREAMS_LIMIT)) return;
        if (bidirectional) {
            this.localMaxStreamsBidi = current + 1;
            this.pendingMaxStreamsBidi = true;
        } else {
            this.localMaxStreamsUni = current + 1;
            this.pendingMaxStreamsUni = true;
        }
        this.trace({ ev: 'stream_limit_released', stream: stream.id, maxStreams: current + 1, bidirectional });
        this.scheduleFlush();
    }

    /** Raises the limit by one when the peer says it is blocked and we have given it no headroom. */
    private onStreamsBlocked(bidirectional: boolean, limit: bigint): void {
        const used = bidirectional ? this.peerBidiOpened : this.peerUniOpened;
        const current = bidirectional ? this.localMaxStreamsBidi : this.localMaxStreamsUni;
        const reported = toSafeNumber(limit);
        if (reported < used || current > used) return;
        if (current >= Number(MAX_STREAMS_LIMIT)) return;
        if (bidirectional) {
            this.localMaxStreamsBidi = current + 1;
            this.pendingMaxStreamsBidi = true;
        } else {
            this.localMaxStreamsUni = current + 1;
            this.pendingMaxStreamsUni = true;
        }
        this.trace({ ev: 'streams_blocked', bidirectional, limit: reported, maxStreams: current + 1 });
        this.scheduleFlush();
    }

    // ------------------------------------------------------------------ Retry and Version Negotiation (client)

    private onRetry(packet: ParsedPacket, now: number): void {
        if (!this.isClient || this.retryReceived || this.receivedServerPacket) return this.drop(packet, 'unexpected Retry');
        if (!equalBytes(packet.dcid, this.localCid) || packet.scid === null) return this.drop(packet, 'Retry for another connection');
        if (equalBytes(packet.scid, this.remoteCid)) return this.drop(packet, 'Retry with an unchanged connection ID');
        if (!verifyRetry(packet, this.originalDcid)) return this.drop(packet, 'Retry integrity tag mismatch');
        this.retryReceived = true;
        this.retrySourceCid = packet.scid.slice();
        this.remoteCid = packet.scid.slice();
        this.token = (packet.token as Uint8Array).slice();
        const initial = initialPacketKeys(this.remoteCid);
        this.initialKeys = { read: initial.server, write: initial.client };
        // Everything sent in Initial packets so far is resent under the new keys; packet numbers continue.
        for (const sent of this.recovery.takeAll('initial')) {
            for (const record of sent.frames) if (record.kind === 'crypto') this.cryptoSend.initial.onLost(record.offset, record.length, false);
        }
        this.recovery.ptoCount = 0;
        this.trace({ ev: 'retry_received', scid: hex(this.remoteCid), tokenLength: this.token.length });
        this.flush(now);
    }

    private onVersionNegotiation(packet: ParsedPacket, now: number): void {
        if (!this.isClient || this.receivedServerPacket || this.retryReceived) return this.drop(packet, 'unexpected Version Negotiation');
        if (!equalBytes(packet.dcid, this.localCid) || packet.scid === null || !equalBytes(packet.scid, this.remoteCid)) return this.drop(packet, 'Version Negotiation for another connection');
        const versions = (packet.supportedVersions ?? []).slice();
        // RFC 9000 Section 6.2: a Version Negotiation packet that lists the version we use is ignored.
        if (versions.includes(QUIC_VERSION_1)) return this.drop(packet, 'Version Negotiation lists version 1');
        this.trace({ ev: 'version_negotiation', versions: versions.map((v) => '0x' + v.toString(16).padStart(8, '0')) });
        this.closeSilently({ errorCode: TransportError.INTERNAL_ERROR, reason: 'no common QUIC version', application: false, remote: true, versionNegotiation: versions }, now);
    }

    // ------------------------------------------------------------------ key update

    private canInitiateKeyUpdate(): boolean {
        if (!this.handshakeConfirmed || this.app.write === null || this.app.read === null) return false;
        // RFC 9001 Section 6.1: no update before an ACK of a packet sent in the current phase, and
        // not while the previous update's old read keys are still kept.
        if (this.stats.keyUpdates > 0 && !this.app.writePhaseAcked) return false;
        if (this.app.readPhase !== this.app.writePhase) return false;
        return true;
    }

    private initiateKeyUpdate(): void {
        const app = this.app;
        app.write = nextKeyPhaseKeys(app.write as PacketKeys);
        app.writePhase = (app.writePhase ^ 1) as 0 | 1;
        app.writePhaseAcked = false;
        this.stats.keyUpdates++;
        this.keyUpdateRequested = false;
        this.pingRequested = true;
        const info: KeyUpdateInfo = { initiator: 'local', stage: 'started', phase: app.writePhase, packetNumber: this.spaces.application.nextPn.toString(), updates: this.stats.keyUpdates };
        this.trace({ ev: 'key_update', ...info });
        this.queueEvent(() => this.emit('keyupdate', info));
    }

    // ------------------------------------------------------------------ sending

    private scheduleFlush(): void {
        if (this.flushScheduled) return;
        this.flushScheduled = true;
        this.platform.defer(() => {
            this.flushScheduled = false;
            // 'closing' still has a CONNECTION_CLOSE to send (RFC 9000 Section 10.2).
            if (!this.isOpen() && this.state !== 'closing') return;
            this.flush(this.platform.now());
            this.drainEvents();
        });
    }

    /** Whether the pacer lets another datagram out now (RFC 9002 Section 7.7); a close or a probe is never paced. */
    private canSendNow(now: number): boolean {
        if (this.state === 'closing' || this.probeSpaces.size > 0) return true;
        return this.recovery.pacingDelay(now) === 0;
    }

    private flush(now: number): void {
        if (this.flushing || this.state === 'draining' || this.state === 'closed') return;
        this.flushing = true;
        this.pacingBlocked = false;
        try {
            if (this.keyUpdateRequested && this.canInitiateKeyUpdate()) this.initiateKeyUpdate();
            for (let i = 0; i < 256; i++) {
                if (!this.canSendNow(now)) {
                    this.pacingBlocked = true;
                    break;
                }
                const datagram = this.buildDatagram(now);
                if (datagram === null) break;
                this.bytesSent += datagram.length;
                this.stats.datagramsSent++;
                this.sendDatagramFn(datagram);
                this.recovery.onPacedSend(datagram.length, now);
                if (this.state === 'closing') {
                    this.closeSent = true;
                    this.lastCloseSent = now;
                    break;
                }
            }
        } finally {
            this.flushing = false;
        }
        this.probeSpaces.clear();
        if (this.discardInitialAfterFlush) {
            this.discardInitialAfterFlush = false;
            if (!this.recovery.isDiscarded('initial')) this.discardInitial();
        }
        if (this.discardHandshakeAfterFlush) {
            this.discardHandshakeAfterFlush = false;
            if (!this.recovery.isDiscarded('handshake')) this.discardHandshake();
        }
        this.armTimer(now);
    }

    private headerLength(type: 'initial' | 'handshake' | '1rtt', space: SpaceId): number {
        const pnLength = packetNumberLength(this.spaces[space].nextPn, this.recovery.largestAcked(space));
        if (type === '1rtt') return 1 + this.remoteCid.length + pnLength;
        let length = 1 + 4 + 1 + this.remoteCid.length + 1 + this.localCid.length + 2 + pnLength;
        if (type === 'initial') length += varintLength(this.token.length) + this.token.length;
        return length;
    }

    private buildDatagram(now: number): Uint8Array | null {
        const closing = this.state === 'closing';
        let budget = MAX_DATAGRAM_SIZE;
        let allowInitial = true;
        if (!this.isClient && !this.addressValidated) {
            // RFC 9000 Section 8.1: at most three times the bytes received before the address is validated.
            const allowance = 3 * this.bytesReceived - this.bytesSent;
            if (allowance <= 0) {
                if (this.cryptoSend.initial.hasPending() || this.cryptoSend.handshake.hasPending()) {
                    this.trace({ ev: 'amplification_limited', bytesReceived: this.bytesReceived, bytesSent: this.bytesSent });
                }
                return null;
            }
            if (allowance < MAX_DATAGRAM_SIZE) {
                budget = allowance;
                allowInitial = false;
            }
        }
        const probing = this.probeSpaces.size > 0;
        // RFC 9002 Section 7: new data waits while the congestion window is full; ACKs and probes do not.
        const congestionLimited = !closing && !probing && !this.recovery.canSend();
        const built: BuiltPacket[] = [];
        let used = 0;
        for (const space of SPACE_IDS) {
            const keys = this.writeKeysFor(space);
            if (keys === null || this.recovery.isDiscarded(space)) continue;
            const type = PACKET_TYPE_OF[space];
            if (type === 'initial' && !allowInitial) continue;
            const overhead = this.headerLength(type, space) + AEAD_TAG_LENGTH;
            const room = budget - used - overhead;
            if (room < 8) break;
            const content = closing ? this.closeContent(space) : this.collectFrames(space, room, now, congestionLimited);
            if (content === null) continue;
            built.push({ space, type, keys, ...content });
            used += overhead + content.payload.length;
            // One ack-eliciting packet answers a PTO for its space (RFC 9002 Section 6.2.4 allows one or two).
            if (content.ackEliciting) this.probeSpaces.delete(space);
        }
        if (built.length === 0) return null;
        const needsPadding = this.isClient ? built.some((p) => p.type === 'initial') : built.some((p) => p.type === 'initial' && p.ackEliciting);
        const parts: Uint8Array[] = [];
        let size = 0;
        for (let i = 0; i < built.length; i++) {
            const packet = built[i];
            const sp = this.spaces[packet.space];
            const pn = sp.nextPn;
            sp.nextPn = pn + 1n;
            const last = i === built.length - 1;
            const spec: PacketSpec = {
                type: packet.type,
                dcid: this.remoteCid,
                packetNumber: pn,
                largestAcked: this.recovery.largestAcked(packet.space),
                payload: packet.payload,
                ...(packet.type === '1rtt' ? { keyPhase: this.app.writePhase } : { scid: this.localCid }),
                ...(packet.type === 'initial' ? { token: this.isClient ? this.token : new Uint8Array(0) } : {}),
                ...(last && needsPadding ? { minPacketLength: Math.max(0, MIN_INITIAL_DATAGRAM_SIZE - size) } : {}),
            };
            const bytes = sealPacket(spec, packet.keys);
            parts.push(bytes);
            size += bytes.length;
            if (packet.hasAck) sp.ackPending = false;
            this.stats.packetsSent++;
            const padded = last && needsPadding;
            if (!closing) {
                this.recovery.onPacketSent(packet.space, {
                    pn,
                    timeSent: now,
                    ackEliciting: packet.ackEliciting,
                    inFlight: packet.ackEliciting || padded,
                    size: bytes.length,
                    frames: packet.records,
                    keyPhase: packet.type === '1rtt' ? this.app.writePhase : null,
                });
                if (packet.ackEliciting) this.lastActivity = now;
            }
            if (this.isClient && packet.type === 'handshake') this.discardInitialAfterFlush = true;
            if (this.traceFn) {
                const streams = packet.records.filter((r) => r.kind === 'stream') as Extract<FrameRecord, { kind: 'stream' }>[];
                this.trace({
                    ev: 'packet_sent',
                    type: packet.type,
                    pn: pn.toString(),
                    keyPhase: packet.type === '1rtt' ? this.app.writePhase : null,
                    size: bytes.length,
                    frames: packet.frameTypes,
                    ...(packet.ackRanges !== undefined ? { ackRanges: packet.ackRanges } : {}),
                    ...(streams.length > 0 ? { streams: streams.map((r) => ({ id: r.streamId, offset: r.offset, length: r.length, fin: r.fin })) } : {}),
                });
            }
        }
        return parts.length === 1 ? parts[0] : concatBytes(...parts);
    }

    /** CONNECTION_CLOSE for one space; an application close becomes APPLICATION_ERROR outside 1-RTT (RFC 9000 Section 10.2.3). */
    private closeContent(space: SpaceId): Omit<BuiltPacket, 'space' | 'type' | 'keys'> | null {
        const info = this.closeInfo;
        if (info === null) return null;
        let frame: QuicFrame;
        if (info.application && space !== 'application') {
            frame = { type: 'CONNECTION_CLOSE', application: false, errorCode: BigInt(TransportError.APPLICATION_ERROR), frameType: 0n, reason: new Uint8Array(0) };
        } else if (info.application) {
            frame = { type: 'CONNECTION_CLOSE', application: true, errorCode: BigInt(info.errorCode), reason: utf8Encode(info.reason).slice(0, 256) };
        } else {
            frame = { type: 'CONNECTION_CLOSE', application: false, errorCode: BigInt(info.errorCode), frameType: BigInt(info.frameType ?? 0), reason: utf8Encode(info.reason).slice(0, 256) };
        }
        return { payload: encodeFrames([frame]), records: [], ackEliciting: false, hasAck: false, frameTypes: ['CONNECTION_CLOSE'] };
    }

    private collectFrames(space: SpaceId, room: number, now: number, congestionLimited: boolean): Omit<BuiltPacket, 'space' | 'type' | 'keys'> | null {
        const frames: QuicFrame[] = [];
        const records: FrameRecord[] = [];
        let remaining = room;
        let hasAck = false;
        const sp = this.spaces[space];
        const add = (frame: QuicFrame, record?: FrameRecord): boolean => {
            const size = frameSize(frame);
            if (size > remaining) return false;
            frames.push(frame);
            if (record) records.push(record);
            remaining -= size;
            return true;
        };
        if (sp.ackPending && !sp.recv.isEmpty) hasAck = add(this.ackFrame(space, now), { kind: 'ack', space });
        if (!congestionLimited) {
            const crypto = this.cryptoSend[space];
            while (crypto.hasPending() && remaining > 8) {
                // Frame overhead bound: type, the offset (at most the bytes written so far), the length.
                const overhead = 1 + varintLength(crypto.length) + varintLength(Math.min(remaining, 16383));
                const chunk = crypto.next(remaining - overhead);
                if (chunk === null || chunk.data.length === 0) break;
                if (!add({ type: 'CRYPTO', offset: BigInt(chunk.offset), data: chunk.data }, { kind: 'crypto', space, offset: chunk.offset, length: chunk.data.length })) {
                    crypto.onLost(chunk.offset, chunk.data.length, false);
                    break;
                }
            }
            if (space === 'application') this.collectApplicationFrames(add, () => remaining);
        }
        const ackEliciting = frames.some((frame) => frame.type !== 'ACK');
        if (!ackEliciting && (this.probeSpaces.has(space) || (space === 'application' && this.pingRequested && !congestionLimited))) {
            if (add({ type: 'PING' })) {
                if (space === 'application') this.pingRequested = false;
            }
        }
        if (frames.length === 0) return null;
        if (!hasAck && !sp.recv.isEmpty && frames.some((frame) => frame.type !== 'ACK')) hasAck = add(this.ackFrame(space, now), { kind: 'ack', space });
        if (space === 'application' && frames.some((frame) => frame.type !== 'ACK' && frame.type !== 'PADDING')) this.pingRequested = false;
        const ack = frames.find((frame) => frame.type === 'ACK') as Extract<QuicFrame, { type: 'ACK' }> | undefined;
        return { payload: encodeFrames(frames), records, ackEliciting: isAckEliciting(frames), hasAck, frameTypes: frames.map((f) => f.type), ackRanges: ack?.ranges.map((r) => `${r.smallest}-${r.largest}`) };
    }

    private collectApplicationFrames(add: (frame: QuicFrame, record?: FrameRecord) => boolean, remaining: () => number): void {
        if (this.handshakeDonePending && !this.isClient) {
            if (add({ type: 'HANDSHAKE_DONE' }, { kind: 'handshake_done' })) this.handshakeDonePending = false;
        }
        while (this.pendingPathResponses.length > 0) {
            if (!add({ type: 'PATH_RESPONSE', data: this.pendingPathResponses[0] })) break;
            this.pendingPathResponses.shift();
        }
        while (this.pendingRetire.length > 0) {
            const sequence = this.pendingRetire[0];
            if (!add({ type: 'RETIRE_CONNECTION_ID', sequenceNumber: sequence }, { kind: 'retire_cid', sequence })) break;
            this.pendingRetire.shift();
        }
        if (this.pendingMaxData) {
            if (add({ type: 'MAX_DATA', maximum: BigInt(this.localMaxData) }, { kind: 'max_data' })) this.pendingMaxData = false;
        }
        // MAX_STREAMS (RFC 9000 Section 19.11): raise the cumulative stream limit as peer streams close.
        if (this.pendingMaxStreamsBidi) {
            if (add({ type: 'MAX_STREAMS', bidirectional: true, maximum: BigInt(this.localMaxStreamsBidi) }, { kind: 'max_streams', bidirectional: true })) this.pendingMaxStreamsBidi = false;
        }
        if (this.pendingMaxStreamsUni) {
            if (add({ type: 'MAX_STREAMS', bidirectional: false, maximum: BigInt(this.localMaxStreamsUni) }, { kind: 'max_streams', bidirectional: false })) this.pendingMaxStreamsUni = false;
        }
        for (const id of [...this.pendingMaxStreamData]) {
            const stream = this.streams.get(id);
            if (!stream || stream.recvBuffer === null || stream.recvBuffer.complete) {
                this.pendingMaxStreamData.delete(id);
                continue;
            }
            if (!add({ type: 'MAX_STREAM_DATA', streamId: BigInt(id), maximum: BigInt(stream.localMaxStreamData) }, { kind: 'max_stream_data', streamId: id })) break;
            this.pendingMaxStreamData.delete(id);
        }
        for (const id of [...this.pendingStopSending]) {
            const stream = this.streams.get(id);
            if (!stream || stream.stopSendingSent === null) {
                this.pendingStopSending.delete(id);
                continue;
            }
            if (!add({ type: 'STOP_SENDING', streamId: BigInt(id), errorCode: stream.stopSendingSent }, { kind: 'stop_sending', streamId: id })) break;
            this.pendingStopSending.delete(id);
        }
        for (const id of [...this.pendingResets]) {
            const stream = this.streams.get(id);
            if (!stream || stream.resetSent === null) {
                this.pendingResets.delete(id);
                continue;
            }
            if (!add({ type: 'RESET_STREAM', streamId: BigInt(id), errorCode: stream.resetSent.errorCode, finalSize: BigInt(stream.resetSent.finalSize) }, { kind: 'reset_stream', streamId: id })) break;
            this.pendingResets.delete(id);
            this.releaseStreamLimit(stream);
        }
        // Round robin: each packet starts with the stream after the last one that got data.
        const order = [...this.streams.values()];
        const start = order.length > 0 ? this.streamCursor % order.length : 0;
        for (let k = 0; k < order.length; k++) {
            const index = (start + k) % order.length;
            const stream = order[index];
            const buffer = stream.sendBuffer;
            if (buffer === null || stream.resetSent !== null) continue;
            let served = false;
            while (remaining() > 24) {
                // New bytes stop at the stream limit and at the connection limit (RFC 9000 Section 4.1).
                const connectionRoom = Math.max(0, this.peerMaxData - this.dataSent);
                const newDataLimit = Math.min(stream.peerMaxStreamData, buffer.maxSentOffset + connectionRoom);
                if (!buffer.hasPending(newDataLimit)) break;
                // Frame overhead bound: type, stream ID, offset (at most the bytes written), length.
                const overhead = 1 + varintLength(stream.id) + varintLength(buffer.length) + varintLength(Math.min(remaining(), 16383));
                const previousMax = buffer.maxSentOffset;
                const chunk = buffer.next(remaining() - overhead, newDataLimit);
                if (chunk === null) break;
                // Counted before the frame is placed, so a failed placement can only over-count.
                this.dataSent += Math.max(0, buffer.maxSentOffset - previousMax);
                const frame: QuicFrame = { type: 'STREAM', streamId: BigInt(stream.id), offset: BigInt(chunk.offset), data: chunk.data, fin: chunk.fin };
                if (!add(frame, { kind: 'stream', streamId: stream.id, offset: chunk.offset, length: chunk.data.length, fin: chunk.fin })) {
                    buffer.onLost(chunk.offset, chunk.data.length, chunk.fin);
                    break;
                }
                served = true;
                // The send side reaches its terminal state when the FIN goes out (RFC 9000 Section 3.3).
                if (chunk.fin) this.releaseStreamLimit(stream);
            }
            if (served) this.streamCursor = index + 1;
        }
    }

    private ackFrame(space: SpaceId, now: number): QuicFrame {
        const sp = this.spaces[space];
        let delay = 0n;
        if (space === 'application' && sp.largestRecvTime !== null) {
            // Our ack_delay_exponent is the default 3: the field counts units of 8 microseconds.
            delay = BigInt(Math.floor((Math.max(0, now - sp.largestRecvTime) * 1000) / 8));
        }
        return { type: 'ACK', delay, ranges: sp.recv.toAckRanges(32) };
    }

    // ------------------------------------------------------------------ timers

    private timerState(): TimerState {
        return {
            isClient: this.isClient,
            handshakeConfirmed: this.handshakeConfirmed,
            hasHandshakeKeys: this.handshakeKeys !== null,
            peerAddressValidated: this.peerAddressValidated,
            amplificationBlocked: !this.isClient && !this.addressValidated && 3 * this.bytesReceived - this.bytesSent <= 0,
        };
    }

    private effectiveIdleTimeout(): number | null {
        const local = this.settings.maxIdleTimeoutMs;
        const peer = this.peerTransportParameters?.max_idle_timeout !== undefined ? toSafeNumber(this.peerTransportParameters.max_idle_timeout) : 0;
        const candidates = [local, peer].filter((value) => value > 0);
        if (candidates.length === 0) return null;
        return Math.max(Math.min(...candidates), 3 * this.recovery.ptoPeriod('application'));
    }

    private armTimer(now: number): void {
        let deadline: number | null = null;
        const take = (time: number | null): void => {
            if (time !== null && (deadline === null || time < deadline)) deadline = time;
        };
        if (this.state === 'closing' || this.state === 'draining') {
            take(this.closeDeadline);
        } else if (this.state !== 'closed') {
            const loss = this.recovery.nextTimer(now, this.timerState());
            if (loss !== null) take(loss.time);
            const idle = this.effectiveIdleTimeout();
            if (idle !== null) take(this.lastActivity + idle);
            if (this.app.readPrevious !== null) take(this.app.readPreviousExpires);
            if (this.pacingBlocked) take(this.recovery.pacingDeadline());
        }
        if (deadline === null) {
            this.cancelTimer();
            return;
        }
        if (this.timer !== null && this.timerDeadline === deadline) return;
        this.cancelTimer();
        this.timerDeadline = deadline;
        this.timer = this.platform.setTimer(() => this.onTimer(), Math.max(0, deadline - now));
    }

    private cancelTimer(): void {
        if (this.timer !== null) this.platform.clearTimer(this.timer);
        this.timer = null;
        this.timerDeadline = -1;
    }

    private onTimer(): void {
        this.timer = null;
        this.timerDeadline = -1;
        const now = this.platform.now();
        if (this.state === 'closed') return;
        if (this.state === 'closing' || this.state === 'draining') {
            if (now >= this.closeDeadline) this.finishClose();
            else this.armTimer(now);
            this.drainEvents();
            return;
        }
        const idle = this.effectiveIdleTimeout();
        if (idle !== null && now >= this.lastActivity + idle) {
            this.closeSilently({ errorCode: TransportError.NO_ERROR, reason: 'idle timeout', application: false, remote: false, idle: true }, now);
            this.drainEvents();
            return;
        }
        if (this.app.readPrevious !== null && now >= this.app.readPreviousExpires) this.app.readPrevious = null;
        const loss = this.recovery.nextTimer(now, this.timerState());
        if (loss !== null && now >= loss.time) {
            if (loss.kind === 'loss') {
                for (const packet of this.recovery.detectLost(loss.space, now)) this.onPacketLost(packet);
            } else {
                this.onProbeTimeout(loss.space, now);
            }
        }
        this.flush(now);
        this.drainEvents();
    }

    /** RFC 9002 Section 6.2.4: send probes; in the handshake spaces, resend all unacknowledged CRYPTO data. */
    private onProbeTimeout(space: SpaceId, now: number): void {
        this.recovery.ptoCount++;
        this.stats.ptoFired++;
        this.trace({ ev: 'pto', space, count: this.recovery.ptoCount, at: now });
        if (space === 'initial' || space === 'handshake') {
            for (const s of ['initial', 'handshake'] as const) {
                if (!this.recovery.isDiscarded(s) && this.writeKeysFor(s) !== null) this.cryptoSend[s].requeueUnacked();
            }
        }
        this.probeSpaces.add(space);
    }

    // ------------------------------------------------------------------ closing

    /** Closes with a transport error (CONNECTION_CLOSE type 0x1c). */
    closeTransport(errorCode: number, reason: string, frameType: number, now: number): void {
        if (this.state === 'closing' || this.state === 'draining' || this.state === 'closed') return;
        this.trace({ ev: 'close_local', errorCode, reason, frameType });
        this.enterClosing({ errorCode, reason, application: false, frameType, remote: false }, now);
    }

    private enterClosing(info: CloseInfo, now: number): void {
        this.closeInfo = info;
        this.state = 'closing';
        this.closeDeadline = now + 3 * this.recovery.ptoPeriod('application');
        this.queueEvent(() => this.emit('close', info));
    }

    private onPeerClose(frame: Extract<QuicFrame, { type: 'CONNECTION_CLOSE' }>, now: number): void {
        const info: CloseInfo = {
            errorCode: toSafeNumber(frame.errorCode),
            reason: utf8Decode(frame.reason),
            application: frame.application,
            frameType: frame.frameType === undefined ? undefined : toSafeNumber(frame.frameType),
            remote: true,
        };
        this.trace({ ev: 'close_remote', errorCode: info.errorCode, reason: info.reason, application: info.application });
        this.closeInfo = info;
        this.state = 'draining';
        this.closeDeadline = now + 3 * this.recovery.ptoPeriod('application');
        this.queueEvent(() => this.emit('close', info));
    }

    private closeSilently(info: CloseInfo, now: number): void {
        if (this.state === 'closed') return;
        this.trace({ ev: 'close_silent', reason: info.reason, at: now });
        this.closeInfo = info;
        this.queueEvent(() => this.emit('close', info));
        this.finishClose();
    }

    private finishClose(): void {
        if (this.finished) return;
        this.finished = true;
        this.state = 'closed';
        this.cancelTimer();
        this.queueEvent(() => this.emit('closed'));
        this.onClosedFn?.();
    }

    private discardInitial(): void {
        this.initialKeys = null;
        this.recovery.discardSpace('initial');
        this.spaces.initial.ackPending = false;
        this.buffered = this.buffered.filter((entry) => entry.space !== 'initial');
        this.trace({ ev: 'keys_discarded', level: 'initial' });
    }

    private discardHandshake(): void {
        this.handshakeKeys = null;
        this.recovery.discardSpace('handshake');
        this.spaces.handshake.ackPending = false;
        this.buffered = this.buffered.filter((entry) => entry.space !== 'handshake');
        this.trace({ ev: 'keys_discarded', level: 'handshake' });
    }

    // ------------------------------------------------------------------ helpers

    private buildLocalTransportParameters(): TransportParameters {
        const s = this.settings;
        const params: Record<string, unknown> = {
            max_idle_timeout: BigInt(s.maxIdleTimeoutMs),
            initial_max_data: BigInt(s.initialMaxData),
            initial_max_stream_data_bidi_local: BigInt(s.initialMaxStreamDataBidiLocal),
            initial_max_stream_data_bidi_remote: BigInt(s.initialMaxStreamDataBidiRemote),
            initial_max_stream_data_uni: BigInt(s.initialMaxStreamDataUni),
            initial_max_streams_bidi: BigInt(s.initialMaxStreamsBidi),
            initial_max_streams_uni: BigInt(s.initialMaxStreamsUni),
            active_connection_id_limit: BigInt(s.activeConnectionIdLimit),
            disable_active_migration: true,
            initial_source_connection_id: this.localCid,
        };
        if (!this.isClient) {
            params.original_destination_connection_id = this.originalDcid;
            if (this.retrySourceCid !== null) params.retry_source_connection_id = this.retrySourceCid;
        }
        return params as TransportParameters;
    }

    private queueEvent(fn: () => void): void {
        this.eventQueue.push(fn);
    }

    /** Emits queued events once internal state is consistent, so listeners may call back in. */
    private drainEvents(): void {
        if (this.drainingEvents) return;
        this.drainingEvents = true;
        try {
            while (this.eventQueue.length > 0) {
                const next = this.eventQueue.shift() as () => void;
                next();
            }
        } finally {
            this.drainingEvents = false;
        }
    }

    private apiError(code: string, message: string): Error {
        return Object.assign(new Error(message), { code });
    }

    private trace(event: Record<string, unknown>): void {
        if (this.traceFn) this.traceFn({ role: this.role, t: this.platform.now(), ...event });
    }
}

/** Transport parameters as JSON-friendly values: integers as numbers, connection IDs as hex. */
export function describeTransportParameters(params: TransportParameters): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
        if (key === 'order') continue;
        if (typeof value === 'bigint') out[key] = value.toString();
        else if (value instanceof Uint8Array) out[key] = hex(value);
        else if (key === 'unknown') out[key] = (value as { id: bigint; value: Uint8Array }[]).map((p) => ({ id: '0x' + p.id.toString(16), length: p.value.length }));
        else if (key === 'preferred_address') out[key] = 'present';
        else out[key] = value;
    }
    return out;
}
