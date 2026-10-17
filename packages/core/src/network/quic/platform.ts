import type { TlsEngine, TlsEngineOptions } from './tls-types';

/*
 * What the QUIC connection layer needs from the environment it runs in. In the OWC guest these are
 * the bootstrap's timers, the tls.random and crypto.hmac capabilities and OWC_TLS13 (guest-entry.ts).
 * Packet protection itself goes through crypto.ts (host) or guest-crypto.ts (guest).
 */
export interface QuicPlatform {
    /** Milliseconds; only differences are used. */
    now(): number;
    setTimer(callback: () => void, delayMs: number): unknown;
    clearTimer(handle: unknown): void;
    /** Runs callback after the current synchronous work (a microtask). */
    defer(callback: () => void): void;
    randomBytes(length: number): Uint8Array;
    hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array;
    createTlsEngine(options: TlsEngineOptions): TlsEngine;
}

/** A bound UDP socket: one remote peer per datagram. */
export interface DatagramSocket {
    send(datagram: Uint8Array, port: number, address: string): void;
    close(): void;
    onMessage(handler: (datagram: Uint8Array, address: string, port: number) => void): void;
    address(): { address: string; port: number };
}
