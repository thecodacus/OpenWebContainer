import { concatBytes, copyBytes, equalBytes } from './bytes';
import { AEAD_TAG_LENGTH } from './crypto';
import { PacketDropError, QuicError, TransportError } from './errors';
import { decodeFrames } from './frames';
import { PACKET_NUMBER_MAX, decodePacketNumber, encodePacketNumber, packetNumberLength } from './packet-number';
import type { PacketNumberLength } from './packet-number';
import {
    LONG_HEADER_RESERVED_BITS,
    QUIC_VERSION_1,
    SHORT_HEADER_RESERVED_BITS,
    decryptPayload,
    minimumPayloadLength,
    protectPacket,
    removeHeaderProtection,
    retryIntegrityTag,
} from './protection';
import type { PacketKeys } from './protection';
import { QuicReader, QuicWriter } from './varint';
import type { VarintLength } from './varint';

/*
 * QUIC version 1 packet headers (RFC 9000 Section 17): long headers (Initial, 0-RTT, Handshake,
 * Retry), Version Negotiation, and the 1-RTT short header, plus coalesced packets in one datagram
 * (Section 12.2). Parsing reads the header up to the Packet Number field without removing
 * protection; openPacket removes protection with the keys of the packet's encryption level and
 * sealPacket builds and protects one version 1 packet.
 */

export type LongPacketType = 'initial' | '0rtt' | 'handshake' | 'retry';
export type PacketType = LongPacketType | '1rtt' | 'version_negotiation';
/** A long header with a version other than 0 and 1: only the version-independent fields are read (RFC 8999). */
export type ParsedPacketType = PacketType | 'unsupported_version';

const LONG_TYPE_BITS: Readonly<Record<LongPacketType, number>> = { initial: 0, '0rtt': 1, handshake: 2, retry: 3 };
const LONG_TYPE_FROM_BITS: readonly LongPacketType[] = ['initial', '0rtt', 'handshake', 'retry'];
const SEALABLE_TYPES: ReadonlySet<string> = new Set(['initial', '0rtt', 'handshake', '1rtt']);

/** Longest connection ID in QUIC version 1 (RFC 9000 Section 17.2). */
export const MAX_CID_LENGTH = 20;
/** Smallest datagram payload that may carry a client's Initial packet (RFC 9000 Section 14.1). */
export const MIN_INITIAL_DATAGRAM_SIZE = 1200;
export const RETRY_INTEGRITY_TAG_LENGTH = 16;

export interface ParsedPacket {
    readonly type: ParsedPacketType;
    /** Long header version; null for a short header. */
    readonly version: number | null;
    readonly dcid: Uint8Array;
    /** Long header Source Connection ID; null for a short header. */
    readonly scid: Uint8Array | null;
    /** Initial packet token or Retry token; null for other types. */
    readonly token: Uint8Array | null;
    /** Version Negotiation version list; null for other types. */
    readonly supportedVersions: readonly number[] | null;
    /** Retry Integrity Tag; null for other types. */
    readonly retryIntegrityTag: Uint8Array | null;
    /** Offset of the Packet Number field within bytes; null for packets without packet protection. */
    readonly pnOffset: number | null;
    /** Offset of this packet in the datagram. */
    readonly offset: number;
    /** A copy of exactly this packet's bytes (a long header's Length field bounds it); never a view of the caller's datagram. */
    readonly bytes: Uint8Array;
}

export interface OpenedPacket extends ParsedPacket {
    /** The unprotected header, from the first byte through the Packet Number field. */
    readonly header: Uint8Array;
    readonly packetNumber: bigint;
    readonly pnLength: PacketNumberLength;
    /** The frames, decrypted. */
    readonly payload: Uint8Array;
    /** Short header Key Phase bit; null for long headers. */
    readonly keyPhase: 0 | 1 | null;
    /** Short header Spin bit; null for long headers. */
    readonly spin: boolean | null;
}

function malformed(message: string): PacketDropError {
    return new PacketDropError('malformed', message);
}

/**
 * Parses the packet that starts at datagram[offset]. shortDcidLength is the length of this
 * endpoint's connection IDs, which a short header does not state. Throws PacketDropError when the
 * packet is malformed (RFC 9000: fixed bit zero, a version 1 connection ID over 20 bytes, a Length
 * beyond the datagram, a truncated field, a Retry with an empty token per Section 17.2.5.2).
 */
export function parsePacket(datagram: Uint8Array, offset: number, shortDcidLength: number): ParsedPacket {
    if (!Number.isInteger(offset) || offset < 0 || offset >= datagram.length) throw malformed('no packet at offset');
    const reader = new QuicReader(datagram, offset, datagram.length);
    try {
        const first = reader.uint8();
        if ((first & 0x80) === 0) {
            if ((first & 0x40) === 0) throw malformed('short header with the fixed bit zero');
            const dcid = reader.take(shortDcidLength);
            return {
                type: '1rtt', version: null, dcid, scid: null, token: null, supportedVersions: null, retryIntegrityTag: null,
                pnOffset: 1 + shortDcidLength, offset, bytes: copyBytes(datagram, offset),
            };
        }
        const version = reader.uint32();
        const dcidLength = reader.uint8();
        if (version === QUIC_VERSION_1 && dcidLength > MAX_CID_LENGTH) throw malformed('version 1 Destination Connection ID over 20 bytes');
        const dcid = reader.take(dcidLength);
        const scidLength = reader.uint8();
        if (version === QUIC_VERSION_1 && scidLength > MAX_CID_LENGTH) throw malformed('version 1 Source Connection ID over 20 bytes');
        const scid = reader.take(scidLength);
        if (version === 0) {
            if (reader.remaining % 4 !== 0) throw malformed('Version Negotiation version list is not a multiple of 4 bytes');
            const supportedVersions: number[] = [];
            while (!reader.eof()) supportedVersions.push(reader.uint32());
            return {
                type: 'version_negotiation', version, dcid, scid, token: null, supportedVersions, retryIntegrityTag: null,
                pnOffset: null, offset, bytes: copyBytes(datagram, offset),
            };
        }
        if (version !== QUIC_VERSION_1) {
            return {
                type: 'unsupported_version', version, dcid, scid, token: null, supportedVersions: null, retryIntegrityTag: null,
                pnOffset: null, offset, bytes: copyBytes(datagram, offset),
            };
        }
        if ((first & 0x40) === 0) throw malformed('long header with the fixed bit zero');
        const type = LONG_TYPE_FROM_BITS[(first >> 4) & 0x03];
        if (type === 'retry') {
            const tokenLength = reader.remaining - RETRY_INTEGRITY_TAG_LENGTH;
            if (tokenLength < 0) throw malformed('Retry packet shorter than its integrity tag');
            if (tokenLength === 0) throw malformed('Retry packet with a zero-length token');
            const token = reader.take(tokenLength);
            const tag = reader.take(RETRY_INTEGRITY_TAG_LENGTH);
            return {
                type, version, dcid, scid, token, supportedVersions: null, retryIntegrityTag: tag,
                pnOffset: null, offset, bytes: copyBytes(datagram, offset),
            };
        }
        let token: Uint8Array | null = null;
        if (type === 'initial') token = reader.take(reader.varintNumber());
        const length = reader.varintNumber();
        const pnStart = reader.offset;
        if (length > datagram.length - pnStart) throw malformed('Length field runs past the end of the datagram');
        return {
            type, version, dcid, scid, token, supportedVersions: null, retryIntegrityTag: null,
            pnOffset: pnStart - offset, offset, bytes: copyBytes(datagram, offset, pnStart + length),
        };
    } catch (error) {
        if (error instanceof QuicError) throw malformed(error.message);
        throw error;
    }
}

export interface ParsedDatagram {
    readonly packets: readonly ParsedPacket[];
    /** Bytes after the last packet kept (zero when the whole datagram was used). */
    readonly trailing: number;
    /** Why parsing stopped before the end of the datagram, when it did. */
    readonly stoppedBy: PacketDropError | null;
}

/**
 * Splits a datagram into its coalesced packets (RFC 9000 Section 12.2). Parsing stops at the first
 * packet that does not parse, such as zero padding after the last packet, and at the first packet
 * whose Destination Connection ID differs from the first packet's, which Section 12.2 says receivers
 * SHOULD ignore. Packets before the stop are returned.
 */
export function parseDatagram(datagram: Uint8Array, shortDcidLength: number): ParsedDatagram {
    const packets: ParsedPacket[] = [];
    let offset = 0;
    while (offset < datagram.length) {
        let packet: ParsedPacket;
        try {
            packet = parsePacket(datagram, offset, shortDcidLength);
        } catch (error) {
            if (error instanceof PacketDropError) return { packets, trailing: datagram.length - offset, stoppedBy: error };
            throw error;
        }
        if (packets.length > 0 && !equalBytes(packet.dcid, packets[0].dcid)) {
            return { packets, trailing: datagram.length - offset, stoppedBy: malformed('Destination Connection ID differs from the first packet in the datagram') };
        }
        packets.push(packet);
        offset += packet.bytes.length;
    }
    return { packets, trailing: 0, stoppedBy: null };
}

/**
 * Removes header and payload protection from a parsed packet with the keys of its encryption level.
 * largestPn is the largest packet number processed in the packet's number space, or null. Throws
 * PacketDropError when the packet is too short to sample or its packet number decodes above 2^62-1
 * ('malformed') or it does not authenticate ('authentication'), and QuicError(PROTOCOL_VIOLATION)
 * when reserved bits are set in an authenticated packet (RFC 9000 Sections 17.2 and 17.3.1). A 1-RTT
 * receiver that follows key updates reads keyPhase via removeHeaderProtection and picks the keys for
 * decryptPayload itself.
 */
export function openPacket(packet: ParsedPacket, keys: PacketKeys, largestPn: bigint | null): OpenedPacket {
    if (packet.pnOffset === null) throw new TypeError(`${packet.type} packets carry no protected payload`);
    const unmasked = removeHeaderProtection(keys, packet.bytes, packet.pnOffset);
    if (unmasked === null) throw malformed('packet too short for the header protection sample');
    const packetNumber = decodePacketNumber(largestPn, unmasked.truncatedPn, (unmasked.pnLength * 8) as 8 | 16 | 24 | 32);
    if (packetNumber > PACKET_NUMBER_MAX) throw malformed('packet number decodes above 2^62-1');
    const payload = decryptPayload(keys, unmasked.header, packet.bytes.subarray(unmasked.header.length), packetNumber);
    if (payload === null) throw new PacketDropError('authentication', 'packet does not authenticate');
    const first = unmasked.header[0];
    const short = packet.type === '1rtt';
    if ((first & (short ? SHORT_HEADER_RESERVED_BITS : LONG_HEADER_RESERVED_BITS)) !== 0) {
        throw new QuicError(TransportError.PROTOCOL_VIOLATION, 'reserved header bits are not zero');
    }
    return {
        ...packet,
        header: unmasked.header,
        packetNumber,
        pnLength: unmasked.pnLength,
        payload,
        keyPhase: short ? (((first >> 2) & 1) as 0 | 1) : null,
        spin: short ? (first & 0x20) !== 0 : null,
    };
}

export interface PacketSpec {
    readonly type: 'initial' | '0rtt' | 'handshake' | '1rtt';
    readonly dcid: Uint8Array;
    /** Long header Source Connection ID; default empty. */
    readonly scid?: Uint8Array;
    /** Initial packet token; default empty. */
    readonly token?: Uint8Array;
    readonly packetNumber: bigint;
    /**
     * Default: packetNumberLength(packetNumber, largestAcked), with null or absent meaning nothing
     * acknowledged. A length given together with largestAcked must be at least that.
     */
    readonly packetNumberLength?: PacketNumberLength;
    readonly largestAcked?: bigint | null;
    /** 1-RTT Key Phase bit; default 0. Ignored for long headers. */
    readonly keyPhase?: 0 | 1;
    /** 1-RTT Spin bit; default false. Ignored for long headers. */
    readonly spin?: boolean;
    /**
     * Encoded frames; at least one, each well formed and permitted in this packet type by RFC 9000
     * Table 3 (checked with decodeFrames; a violation throws RangeError). PADDING (zero bytes) is placed in front of the frames when the
     * payload is shorter than the header protection sample needs or than minPacketLength requires, so a
     * final STREAM frame without a Length field keeps its data.
     */
    readonly payload: Uint8Array;
    /**
     * Pad so the protected packet is exactly this long, or leave it as is when already longer (for
     * example 1200 for a client Initial). To hit the size exactly, a long header's Length field may be
     * written in more bytes than its value needs.
     */
    readonly minPacketLength?: number;
    /** Bytes for a long header's Length field; default the shortest encoding. */
    readonly lengthFieldLength?: VarintLength;
}

function headerBytes(spec: PacketSpec, pnLength: PacketNumberLength, payloadLength: number, lengthFieldLength: VarintLength | undefined): Uint8Array {
    const w = new QuicWriter(64);
    if (spec.type === '1rtt') {
        w.uint8(0x40 | (spec.spin ? 0x20 : 0) | ((spec.keyPhase ?? 0) << 2) | (pnLength - 1));
        w.bytes(spec.dcid);
    } else {
        const scid = spec.scid ?? new Uint8Array(0);
        w.uint8(0xc0 | (LONG_TYPE_BITS[spec.type] << 4) | (pnLength - 1));
        w.uint32(QUIC_VERSION_1);
        w.uint8(spec.dcid.length).bytes(spec.dcid);
        w.uint8(scid.length).bytes(scid);
        if (spec.type === 'initial') {
            const token = spec.token ?? new Uint8Array(0);
            w.varint(token.length).bytes(token);
        }
        w.varint(pnLength + payloadLength + AEAD_TAG_LENGTH, lengthFieldLength);
    }
    w.bytes(encodePacketNumber(spec.packetNumber, pnLength));
    return w.finish();
}

function checkSpec(spec: PacketSpec): PacketNumberLength {
    if (!SEALABLE_TYPES.has(spec.type)) throw new TypeError(`cannot seal a packet of type ${String(spec.type)}`);
    if (!(spec.payload instanceof Uint8Array) || spec.payload.length === 0) throw new RangeError('a packet payload must contain at least one frame');
    // The same frame parser and Table 3 permissions a receiver applies (RFC 9000 Sections 12.4, 12.5).
    try {
        decodeFrames(spec.payload, spec.type);
    } catch (error) {
        if (error instanceof QuicError) throw new RangeError(`payload not valid for packet type ${spec.type}: ${error.message}`);
        throw error;
    }
    if (spec.dcid.length > MAX_CID_LENGTH || (spec.scid?.length ?? 0) > MAX_CID_LENGTH) throw new RangeError('version 1 connection IDs are at most 20 bytes');
    if (spec.type === '1rtt') {
        if (spec.scid !== undefined || spec.token !== undefined) throw new TypeError('a short header carries no Source Connection ID or token');
        if (spec.keyPhase !== undefined && spec.keyPhase !== 0 && spec.keyPhase !== 1) throw new RangeError('Key Phase must be 0 or 1');
    } else if (spec.type !== 'initial' && spec.token !== undefined) {
        throw new TypeError('only Initial packets carry a token');
    }
    if (spec.packetNumberLength === undefined) return packetNumberLength(spec.packetNumber, spec.largestAcked ?? null);
    const length = spec.packetNumberLength;
    if (length !== 1 && length !== 2 && length !== 3 && length !== 4) throw new RangeError(`packet number length must be 1..4, not ${String(length)}`);
    if (spec.largestAcked !== undefined && length < packetNumberLength(spec.packetNumber, spec.largestAcked)) {
        throw new RangeError('packet number length too short for the distance from the largest acknowledged (RFC 9000 Section 17.1)');
    }
    return length;
}

/** Builds and protects one version 1 packet (RFC 9000 Section 17, RFC 9001 Section 5). */
export function sealPacket(spec: PacketSpec, keys: PacketKeys): Uint8Array {
    const pnLength = checkSpec(spec);
    const smallest = Math.max(spec.payload.length, minimumPayloadLength(pnLength));
    let payloadLength = smallest;
    let lengthFieldLength = spec.lengthFieldLength;
    const target = spec.minPacketLength;
    if (target !== undefined) {
        if (!Number.isSafeInteger(target) || target < 0) throw new RangeError('minPacketLength must be a non-negative integer');
        if (spec.type === '1rtt') {
            payloadLength = Math.max(smallest, target - headerBytes(spec, pnLength, 0, undefined).length - AEAD_TAG_LENGTH);
        } else {
            // Header bytes other than the Length field, then the smallest Length field size that gets the
            // packet to exactly target bytes (when padding is needed at all).
            const rest = headerBytes(spec, pnLength, 0, 8).length - 8;
            const sizes: readonly VarintLength[] = spec.lengthFieldLength !== undefined ? [spec.lengthFieldLength] : [1, 2, 4, 8];
            const fit = sizes.find((size) => pnLength + Math.max(smallest, target - rest - size - AEAD_TAG_LENGTH) + AEAD_TAG_LENGTH < 2 ** (8 * size - 2));
            if (fit === undefined) throw new RangeError('minPacketLength cannot be met with this Length field size');
            payloadLength = Math.max(smallest, target - rest - fit - AEAD_TAG_LENGTH);
            lengthFieldLength = fit;
        }
    }
    const header = headerBytes(spec, pnLength, payloadLength, lengthFieldLength);
    const payload = payloadLength === spec.payload.length ? spec.payload : concatBytes(new Uint8Array(payloadLength - spec.payload.length), spec.payload);
    return protectPacket(keys, header, payload, spec.packetNumber);
}

export interface RetrySpec {
    readonly dcid: Uint8Array;
    readonly scid: Uint8Array;
    /** The Retry token; it must not be empty (RFC 9000 Section 17.2.5.2). */
    readonly token: Uint8Array;
    /** The Destination Connection ID of the Initial packet the Retry answers. */
    readonly originalDcid: Uint8Array;
    /** The four Unused bits of the first byte (arbitrary per RFC 9000 Section 17.2.5); default 0. */
    readonly unusedBits?: number;
}

/** A version 1 Retry packet with its integrity tag (RFC 9000 Section 17.2.5, RFC 9001 Section 5.8). */
export function encodeRetry(spec: RetrySpec): Uint8Array {
    if (spec.dcid.length > MAX_CID_LENGTH || spec.scid.length > MAX_CID_LENGTH) throw new RangeError('version 1 connection IDs are at most 20 bytes');
    if (spec.token.length === 0) throw new RangeError('a Retry token must not be empty');
    const unused = spec.unusedBits ?? 0;
    if (!Number.isInteger(unused) || unused < 0 || unused > 0x0f) throw new RangeError('Retry unused bits must be 0..15');
    const w = new QuicWriter(64);
    w.uint8(0xc0 | (LONG_TYPE_BITS.retry << 4) | unused);
    w.uint32(QUIC_VERSION_1);
    w.uint8(spec.dcid.length).bytes(spec.dcid);
    w.uint8(spec.scid.length).bytes(spec.scid);
    w.bytes(spec.token);
    const withoutTag = w.finish();
    return concatBytes(withoutTag, retryIntegrityTag(spec.originalDcid, withoutTag));
}

/** Whether a parsed Retry packet has a non-empty token and an integrity tag that matches originalDcid. */
export function verifyRetry(packet: ParsedPacket, originalDcid: Uint8Array): boolean {
    if (packet.type !== 'retry' || packet.retryIntegrityTag === null || packet.token === null || packet.token.length === 0) return false;
    const withoutTag = packet.bytes.subarray(0, packet.bytes.length - RETRY_INTEGRITY_TAG_LENGTH);
    return equalBytes(retryIntegrityTag(originalDcid, withoutTag), packet.retryIntegrityTag);
}

export interface VersionNegotiationSpec {
    readonly dcid: Uint8Array;
    readonly scid: Uint8Array;
    readonly versions: readonly number[];
    /** The seven Unused bits of the first byte; default 0x40, which RFC 9000 Section 17.2.1 recommends setting. */
    readonly unusedBits?: number;
}

/** A Version Negotiation packet (RFC 9000 Section 17.2.1); connection IDs may be up to 255 bytes. */
export function encodeVersionNegotiation(spec: VersionNegotiationSpec): Uint8Array {
    const unused = spec.unusedBits ?? 0x40;
    if (!Number.isInteger(unused) || unused < 0 || unused > 0x7f) throw new RangeError('Version Negotiation unused bits must be 0..127');
    if (spec.dcid.length > 255 || spec.scid.length > 255) throw new RangeError('connection IDs are at most 255 bytes');
    const w = new QuicWriter(16 + spec.dcid.length + spec.scid.length + 4 * spec.versions.length);
    w.uint8(0x80 | unused);
    w.uint32(0);
    w.uint8(spec.dcid.length).bytes(spec.dcid);
    w.uint8(spec.scid.length).bytes(spec.scid);
    for (const version of spec.versions) w.uint32(version);
    return w.finish();
}
