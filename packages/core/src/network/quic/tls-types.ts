/*
 * The part of the guest TLS 1.3 engine (guest/modules/tls-engine.ts, OWC_TLS13.createEngine with
 * quic: true) that the QUIC connection layer uses, typed from the engine's documented QUIC-mode
 * interface: handshake bytes per encryption level, per-level traffic secrets, transport parameters
 * in extension 57, mandatory ALPN.
 */

export type TlsLevel = 'initial' | 'handshake' | '1-rtt';

export interface TlsSuiteInfo {
    readonly name: string;
    readonly hash: string;
    readonly aead: string;
    readonly keyLen: number;
}

export interface TlsPeerVerdict {
    readonly authorized: boolean;
    readonly authorizationError: string | null;
    readonly error: unknown;
}

export type TlsEvent =
    | { readonly type: 'secrets'; readonly level: 'handshake' | '1-rtt'; readonly client: Uint8Array; readonly server: Uint8Array; readonly suite: TlsSuiteInfo }
    | {
          readonly type: 'connected';
          readonly alpnProtocol: string | null;
          readonly cipherName: string;
          readonly group: number;
          readonly peerVerify: TlsPeerVerdict;
          readonly peerCertificates: Uint8Array[];
          readonly peerServerName: string | null;
          readonly peerQuicTransportParameters: Uint8Array | null;
      }
    | { readonly type: 'clienthello'; readonly serverName: string | null; readonly alpn: string[] }
    | { readonly type: 'error'; readonly code: string; readonly message: string; readonly alert: number | null; readonly received?: boolean };

export interface TlsEngine {
    start(): Uint8Array;
    takeCrypto(level: TlsLevel): Uint8Array;
    feedCrypto(level: TlsLevel, bytes: Uint8Array): TlsEvent[];
    readonly alpn: string | null;
    readonly peerQuicTransportParameters: Uint8Array | null;
    readonly connected: boolean;
    readonly dead: boolean;
}

/** A certificate chain (DER, leaf first) and its private key as the engine parses it (loadPem().key). */
export interface TlsCertificateContext {
    readonly certificates: Uint8Array[];
    readonly privateKey: unknown;
}

/** createEngine options other than role, quic, cap and quicTransportParameters, which the connection sets. */
export interface TlsSettings {
    readonly ALPNProtocols: string[];
    /** Client: server name for SNI. */
    readonly serverName?: string;
    /** Client: trust anchors (DER). */
    readonly anchors?: Uint8Array[];
    /** Client: host name for the identity check (Node's checkServerIdentity rules). */
    readonly hostname?: string;
    readonly allowPartialTrustChain?: boolean;
    /** Server: certificate chains and keys; client: a certificate for client authentication. */
    readonly contexts?: TlsCertificateContext[];
    readonly requestCert?: boolean;
    readonly rejectUnauthorized?: boolean;
    /** TLS cipher suite code points in preference order (0x1301, 0x1302, 0x1303). */
    readonly suites?: number[];
    /** Named groups (29 X25519, 23 P-256). */
    readonly groups?: number[];
    readonly keyShareGroups?: number[];
}

export interface TlsEngineOptions extends TlsSettings {
    readonly role: 'client' | 'server';
    readonly quic: true;
    readonly quicTransportParameters: Uint8Array;
}
