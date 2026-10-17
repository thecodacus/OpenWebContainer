import { concatBytes, copyBytes, hexToBytes } from './bytes';
import {
    AEAD_TAG_LENGTH,
    HASH_LENGTH,
    HP_SAMPLE_LENGTH,
    aeadOpen,
    aeadSeal,
    headerProtectionMask,
    hkdfExpandLabel,
    hkdfExtract,
} from './crypto';
import type { AeadAlgorithm, HashAlgorithm, HeaderProtectionAlgorithm } from './crypto';
import { PACKET_NUMBER_MAX, decodePacketNumber, encodePacketNumber } from './packet-number';
import type { PacketNumberLength } from './packet-number';

/*
 * QUIC packet protection (RFC 9001 Section 5): keys derived from a traffic secret, Initial secrets
 * derived from the client's Destination Connection ID, AEAD payload protection, header protection,
 * key update, and the Retry Integrity Tag. Version 1 only.
 */

export const QUIC_VERSION_1 = 0x00000001;

/** initial_salt for QUIC version 1 (RFC 9001 Section 5.2). */
export const INITIAL_SALT_V1: Uint8Array = hexToBytes('38762cf7f55934b34d179ae6a4c80cadccbb7f0a');

/** Retry Integrity Tag key and nonce for QUIC version 1 (RFC 9001 Section 5.8). */
export const RETRY_INTEGRITY_KEY_V1: Uint8Array = hexToBytes('be0c690b9f66575a1d766b54e368c84e');
export const RETRY_INTEGRITY_NONCE_V1: Uint8Array = hexToBytes('461599d35d632bf2239825bb');

/** Header bytes of a long header (0x0c) and a short header (0x18) that are reserved and must be zero once unprotected. */
export const LONG_HEADER_RESERVED_BITS = 0x0c;
export const SHORT_HEADER_RESERVED_BITS = 0x18;

const EMPTY = new Uint8Array(0);

export type CipherSuite = 'TLS_AES_128_GCM_SHA256' | 'TLS_AES_256_GCM_SHA384' | 'TLS_CHACHA20_POLY1305_SHA256';

export interface CipherSuiteInfo {
    /** TLS CipherSuite code point. */
    readonly code: number;
    readonly hash: HashAlgorithm;
    readonly aead: AeadAlgorithm;
    readonly hp: HeaderProtectionAlgorithm;
    readonly keyLength: number;
}

/** The TLS 1.3 cipher suites QUIC packet protection supports here (RFC 9001 Section 5.3; CCM is not provided). */
export const CIPHER_SUITES: Readonly<Record<CipherSuite, CipherSuiteInfo>> = {
    TLS_AES_128_GCM_SHA256: { code: 0x1301, hash: 'sha256', aead: 'aes-128-gcm', hp: 'aes-128', keyLength: 16 },
    TLS_AES_256_GCM_SHA384: { code: 0x1302, hash: 'sha384', aead: 'aes-256-gcm', hp: 'aes-256', keyLength: 32 },
    TLS_CHACHA20_POLY1305_SHA256: { code: 0x1303, hash: 'sha256', aead: 'chacha20-poly1305', hp: 'chacha20', keyLength: 32 },
};

/** The cipher suite with a TLS code point; throws RangeError for one this module does not provide. */
export function cipherSuiteFromCode(code: number): CipherSuite {
    for (const name of Object.keys(CIPHER_SUITES) as CipherSuite[]) {
        if (CIPHER_SUITES[name].code === code) return name;
    }
    throw new RangeError(`unsupported cipher suite 0x${code.toString(16)}`);
}

/** Packet protection keys for one direction and one encryption level. */
export interface PacketKeys {
    readonly suite: CipherSuite;
    /** The traffic secret the keys come from; key update derives the next secret from it. */
    readonly secret: Uint8Array;
    readonly key: Uint8Array;
    readonly iv: Uint8Array;
    readonly hp: Uint8Array;
}

/** key, iv and hp from a traffic secret with the labels "quic key", "quic iv" and "quic hp" (RFC 9001 Section 5.1). */
export function derivePacketKeys(suite: CipherSuite, secret: Uint8Array): PacketKeys {
    const info = CIPHER_SUITES[suite];
    if (info === undefined) throw new RangeError(`unsupported cipher suite ${String(suite)}`);
    if (secret.length !== HASH_LENGTH[info.hash]) throw new RangeError(`${suite} secret must be ${HASH_LENGTH[info.hash]} bytes`);
    return {
        suite,
        secret: copyBytes(secret),
        key: hkdfExpandLabel(info.hash, secret, 'quic key', EMPTY, info.keyLength),
        iv: hkdfExpandLabel(info.hash, secret, 'quic iv', EMPTY, 12),
        hp: hkdfExpandLabel(info.hash, secret, 'quic hp', EMPTY, info.keyLength),
    };
}

export interface InitialSecrets {
    readonly initialSecret: Uint8Array;
    readonly clientSecret: Uint8Array;
    readonly serverSecret: Uint8Array;
}

/**
 * RFC 9001 Section 5.2: initial_secret = HKDF-Extract(initial_salt, client_dst_connection_id), then
 * "client in" and "server in" with HKDF-Expand-Label and SHA-256. clientDcid is the Destination
 * Connection ID of the client's first Initial packet, or the server's Retry Source Connection ID
 * after a Retry (0 to 20 bytes).
 */
export function deriveInitialSecrets(clientDcid: Uint8Array, version: number = QUIC_VERSION_1): InitialSecrets {
    if (version !== QUIC_VERSION_1) throw new RangeError(`no initial salt for version 0x${version.toString(16)}`);
    if (clientDcid.length > 20) throw new RangeError('connection ID longer than 20 bytes');
    const initialSecret = hkdfExtract('sha256', INITIAL_SALT_V1, clientDcid);
    return {
        initialSecret,
        clientSecret: hkdfExpandLabel('sha256', initialSecret, 'client in', EMPTY, 32),
        serverSecret: hkdfExpandLabel('sha256', initialSecret, 'server in', EMPTY, 32),
    };
}

/** Initial packet keys of both endpoints (AEAD_AES_128_GCM, RFC 9001 Section 5.2). */
export function initialPacketKeys(clientDcid: Uint8Array, version: number = QUIC_VERSION_1): { client: PacketKeys; server: PacketKeys } {
    const secrets = deriveInitialSecrets(clientDcid, version);
    return {
        client: derivePacketKeys('TLS_AES_128_GCM_SHA256', secrets.clientSecret),
        server: derivePacketKeys('TLS_AES_128_GCM_SHA256', secrets.serverSecret),
    };
}

/**
 * Keys of the next key phase (RFC 9001 Section 6.1): secret_<n+1> = HKDF-Expand-Label(secret_<n>,
 * "quic ku", "", Hash.length), new key and iv from it, and the header protection key unchanged.
 */
export function nextKeyPhaseKeys(keys: PacketKeys): PacketKeys {
    const info = CIPHER_SUITES[keys.suite];
    const secret = hkdfExpandLabel(info.hash, keys.secret, 'quic ku', EMPTY, HASH_LENGTH[info.hash]);
    const next = derivePacketKeys(keys.suite, secret);
    return { suite: keys.suite, secret: next.secret, key: next.key, iv: next.iv, hp: copyBytes(keys.hp) };
}

/** The AEAD nonce: the 62-bit packet number, left-padded, XORed into the IV (RFC 9001 Section 5.3). */
export function packetNonce(iv: Uint8Array, packetNumber: bigint): Uint8Array {
    if (packetNumber < 0n || packetNumber > 0x3fffffffffffffffn) throw new RangeError('packet number out of range');
    const nonce = copyBytes(iv);
    let rest = packetNumber;
    for (let i = nonce.length - 1; i >= nonce.length - 8; i--) {
        nonce[i] ^= Number(rest & 0xffn);
        rest >>= 8n;
    }
    return nonce;
}

/**
 * Smallest plaintext payload that leaves room for the header protection sample: the packet number
 * field plus the protected payload must be at least 4 + 16 bytes (RFC 9001 Section 5.4.2).
 */
export function minimumPayloadLength(pnLength: PacketNumberLength): number {
    return 4 + HP_SAMPLE_LENGTH - AEAD_TAG_LENGTH - pnLength;
}

function maskBits(firstByte: number): number {
    return firstByte & 0x80 ? 0x0f : 0x1f;
}

/**
 * Applies payload protection and then header protection (RFC 9001 Sections 5.3 and 5.4.1).
 * header is the unprotected header from the first byte through the Packet Number field; the low two
 * bits of its first byte give the packet number length, and its last bytes must be the low bytes of
 * packetNumber. Returns the protected packet: header || ciphertext || tag with the first byte and
 * the packet number masked.
 */
export function protectPacket(keys: PacketKeys, header: Uint8Array, payload: Uint8Array, packetNumber: bigint): Uint8Array {
    const info = CIPHER_SUITES[keys.suite];
    const pnLength = ((header[0] & 0x03) + 1) as PacketNumberLength;
    const pnOffset = header.length - pnLength;
    if (pnOffset < 1) throw new RangeError('header too short for its packet number length');
    const expectedPn = encodePacketNumber(packetNumber, pnLength);
    for (let i = 0; i < pnLength; i++) {
        if (header[pnOffset + i] !== expectedPn[i]) throw new RangeError('header packet number does not match packetNumber');
    }
    if (payload.length < minimumPayloadLength(pnLength)) throw new RangeError('payload too short to sample for header protection');
    const ciphertext = aeadSeal(info.aead, keys.key, packetNonce(keys.iv, packetNumber), header, payload);
    const packet = concatBytes(header, ciphertext);
    const sampleOffset = pnOffset + 4;
    const mask = headerProtectionMask(info.hp, keys.hp, packet.subarray(sampleOffset, sampleOffset + HP_SAMPLE_LENGTH));
    packet[0] ^= mask[0] & maskBits(packet[0]);
    for (let i = 0; i < pnLength; i++) packet[pnOffset + i] ^= mask[1 + i];
    return packet;
}

export interface UnmaskedHeader {
    /** The unprotected header, from the first byte through the Packet Number field. */
    readonly header: Uint8Array;
    readonly pnLength: PacketNumberLength;
    readonly truncatedPn: number;
}

/**
 * Removes header protection (RFC 9001 Section 5.4.1) from packet, whose Packet Number field starts at
 * pnOffset. Returns null when the packet is too short to hold the sample at pnOffset + 4.
 */
export function removeHeaderProtection(keys: Pick<PacketKeys, 'suite' | 'hp'>, packet: Uint8Array, pnOffset: number): UnmaskedHeader | null {
    const sampleOffset = pnOffset + 4;
    if (!Number.isInteger(pnOffset) || pnOffset < 1 || sampleOffset + HP_SAMPLE_LENGTH > packet.length) return null;
    const mask = headerProtectionMask(CIPHER_SUITES[keys.suite].hp, keys.hp, packet.subarray(sampleOffset, sampleOffset + HP_SAMPLE_LENGTH));
    const first = packet[0] ^ (mask[0] & maskBits(packet[0]));
    const pnLength = ((first & 0x03) + 1) as PacketNumberLength;
    // A copy, never a view: the caller's packet bytes stay protected and unchanged.
    const header = copyBytes(packet, 0, pnOffset + pnLength);
    header[0] = first;
    let truncatedPn = 0;
    for (let i = 0; i < pnLength; i++) {
        header[pnOffset + i] ^= mask[1 + i];
        truncatedPn = truncatedPn * 256 + header[pnOffset + i];
    }
    return { header, pnLength, truncatedPn };
}

/** Removes payload protection; null when ciphertext || tag does not authenticate under header as associated data. */
export function decryptPayload(keys: PacketKeys, header: Uint8Array, sealed: Uint8Array, packetNumber: bigint): Uint8Array | null {
    return aeadOpen(CIPHER_SUITES[keys.suite].aead, keys.key, packetNonce(keys.iv, packetNumber), header, sealed);
}

export interface UnprotectedPacket extends UnmaskedHeader {
    readonly packetNumber: bigint;
    readonly payload: Uint8Array;
}

/**
 * Removes both protection layers from one packet (exactly its bytes, no coalesced packets after it).
 * largestPn is the largest packet number processed in the packet number space, or null. Returns null
 * when the packet is too short to sample, its packet number decodes above 2^62-1, or it does not
 * authenticate.
 */
export function unprotectPacket(keys: PacketKeys, packet: Uint8Array, pnOffset: number, largestPn: bigint | null): UnprotectedPacket | null {
    const unmasked = removeHeaderProtection(keys, packet, pnOffset);
    if (unmasked === null) return null;
    const packetNumber = decodePacketNumber(largestPn, unmasked.truncatedPn, (unmasked.pnLength * 8) as 8 | 16 | 24 | 32);
    if (packetNumber > PACKET_NUMBER_MAX) return null;
    const payload = decryptPayload(keys, unmasked.header, packet.subarray(unmasked.header.length), packetNumber);
    if (payload === null) return null;
    return { header: unmasked.header, pnLength: unmasked.pnLength, truncatedPn: unmasked.truncatedPn, packetNumber, payload };
}

/**
 * The Retry Integrity Tag (RFC 9001 Section 5.8): AEAD_AES_128_GCM with the version 1 key and nonce,
 * an empty plaintext, and the Retry Pseudo-Packet (ODCID length, ODCID, Retry packet without its tag)
 * as associated data.
 */
export function retryIntegrityTag(originalDcid: Uint8Array, retryWithoutTag: Uint8Array): Uint8Array {
    if (originalDcid.length > 20) throw new RangeError('original destination connection ID longer than 20 bytes');
    const pseudoPacket = concatBytes(Uint8Array.of(originalDcid.length), originalDcid, retryWithoutTag);
    return aeadSeal('aes-128-gcm', RETRY_INTEGRITY_KEY_V1, RETRY_INTEGRITY_NONCE_V1, pseudoPacket, EMPTY);
}
