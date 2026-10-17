/*
 * QUIC transport error codes (RFC 9000 Section 20.1, Table 7) and the two failure types the codecs
 * raise. A QuicError is a connection error: the receiver closes the connection with errorCode. A
 * PacketDropError marks a packet the receiver discards without closing (RFC 9000 Section 12.2,
 * RFC 9001 Section 5.5): it does not parse, or it does not authenticate.
 */

export const TransportError = {
    NO_ERROR: 0x00,
    INTERNAL_ERROR: 0x01,
    CONNECTION_REFUSED: 0x02,
    FLOW_CONTROL_ERROR: 0x03,
    STREAM_LIMIT_ERROR: 0x04,
    STREAM_STATE_ERROR: 0x05,
    FINAL_SIZE_ERROR: 0x06,
    FRAME_ENCODING_ERROR: 0x07,
    TRANSPORT_PARAMETER_ERROR: 0x08,
    CONNECTION_ID_LIMIT_ERROR: 0x09,
    PROTOCOL_VIOLATION: 0x0a,
    INVALID_TOKEN: 0x0b,
    APPLICATION_ERROR: 0x0c,
    CRYPTO_BUFFER_EXCEEDED: 0x0d,
    KEY_UPDATE_ERROR: 0x0e,
    AEAD_LIMIT_REACHED: 0x0f,
    NO_VIABLE_PATH: 0x10,
} as const;

export type TransportErrorName = keyof typeof TransportError;

/** First code of the CRYPTO_ERROR range 0x0100-0x01ff (RFC 9000 Section 20.1). */
export const CRYPTO_ERROR_BASE = 0x0100;

/** The transport error code that carries a TLS alert (RFC 9001 Section 4.8): 0x0100 plus the alert description. */
export function cryptoErrorCode(alertDescription: number): number {
    if (!Number.isInteger(alertDescription) || alertDescription < 0 || alertDescription > 0xff) {
        throw new RangeError(`TLS alert description out of range: ${alertDescription}`);
    }
    return CRYPTO_ERROR_BASE + alertDescription;
}

/** A connection error: the transport error code to close with and, when a frame caused it, that frame's type. */
export class QuicError extends Error {
    readonly errorCode: number;
    readonly frameType: bigint | undefined;

    constructor(errorCode: number, message: string, frameType?: bigint) {
        super(message);
        this.name = 'QuicError';
        this.errorCode = errorCode;
        this.frameType = frameType;
    }
}

export type PacketDropReason = 'malformed' | 'authentication';

/** A packet to discard silently: it is malformed or fails authentication. */
export class PacketDropError extends Error {
    readonly reason: PacketDropReason;

    constructor(reason: PacketDropReason, message: string) {
        super(message);
        this.name = 'PacketDropError';
        this.reason = reason;
    }
}
