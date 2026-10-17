/*
 * Packet numbers (RFC 9000 Section 17.1, Appendix A.2 and A.3). A packet number is an integer in
 * 0..2^62-1 carried in the header as its 1 to 4 least significant bytes.
 */

export type PacketNumberLength = 1 | 2 | 3 | 4;

/** Largest packet number: 2^62 - 1 (RFC 9000 Section 12.3). */
export const PACKET_NUMBER_MAX = 0x3fffffffffffffffn;

function checkPacketNumber(pn: bigint, what: string): void {
    if (typeof pn !== 'bigint' || pn < 0n || pn > PACKET_NUMBER_MAX) throw new RangeError(`${what} out of range: ${String(pn)}`);
}

/**
 * Encoded length for fullPn (RFC 9000 Section 17.1).
 *
 * After an acknowledgment (largestAcked given), Section 17.1 says the sender "MUST use a packet number
 * size able to represent more than twice as large a range as the difference between the largest
 * acknowledged packet number and the packet number being sent". With n = fullPn - largestAcked the
 * result is the smallest L with 2^(8L) > 2n. The Appendix A.2 sample code (min_bits = log2(n) + 1,
 * num_bytes = ceil(min_bits / 8)) allows a range of exactly 2n, so at n = 128, 32768 and 2^23 it gives
 * one byte less than this function; the normative Section 17.1 text is followed. From n = 2^31 no
 * 4-byte encoding satisfies Section 17.1 and RangeError is thrown (A.2 gives 4 at exactly 2^31).
 *
 * Before any acknowledgment (largestAcked null), Section 17.1 requires only that "the full packet
 * number MUST be included; it is not to be truncated". The same margin is applied with n = fullPn + 1
 * while it fits in 4 bytes; beyond that, 4 bytes are returned while fullPn < 2^32 (the full number still
 * fits; at n = 2^31 this equals A.2's answer), and RangeError is thrown from fullPn = 2^32.
 */
export function packetNumberLength(fullPn: bigint, largestAcked: bigint | null): PacketNumberLength {
    checkPacketNumber(fullPn, 'packet number');
    let unacked: bigint;
    if (largestAcked === null) {
        unacked = fullPn + 1n;
    } else {
        checkPacketNumber(largestAcked, 'largest acknowledged');
        if (largestAcked >= fullPn) throw new RangeError('packet number must exceed the largest acknowledged');
        unacked = fullPn - largestAcked;
    }
    for (const length of [1, 2, 3, 4] as const) {
        if (unacked < 1n << BigInt(8 * length - 1)) return length;
    }
    if (largestAcked === null && fullPn < 1n << 32n) return 4;
    throw new RangeError(largestAcked === null
        ? `packet number ${fullPn} does not fit 4 bytes untruncated`
        : `${unacked} unacknowledged packet numbers need more than a 4-byte encoding`);
}

/** The low length bytes of fullPn, big-endian; length must be 1, 2, 3 or 4 (RFC 9000 Section 17.1). */
export function encodePacketNumber(fullPn: bigint, length: PacketNumberLength): Uint8Array {
    checkPacketNumber(fullPn, 'packet number');
    if (length !== 1 && length !== 2 && length !== 3 && length !== 4) throw new RangeError(`packet number length must be 1..4, not ${String(length)}`);
    const out = new Uint8Array(length);
    let rest = fullPn;
    for (let i = length - 1; i >= 0; i--) {
        out[i] = Number(rest & 0xffn);
        rest >>= 8n;
    }
    return out;
}

/**
 * Appendix A.3 DecodePacketNumber: the packet number closest to largestPn + 1 whose low pnNbits bits
 * equal truncatedPn. largestPn is the largest packet number successfully processed in the space, or
 * null before any (the expected packet number is then 0). As in the A.3 pseudocode, the result can
 * exceed 2^62-1 when largestPn is near the top of the range; openPacket and unprotectPacket drop such
 * packets. Invalid arguments throw RangeError.
 */
export function decodePacketNumber(largestPn: bigint | null, truncatedPn: bigint | number, pnNbits: 8 | 16 | 24 | 32): bigint {
    if (pnNbits !== 8 && pnNbits !== 16 && pnNbits !== 24 && pnNbits !== 32) throw new RangeError(`invalid packet number size ${String(pnNbits)}`);
    const truncated = BigInt(truncatedPn);
    const pnWin = 1n << BigInt(pnNbits);
    if (truncated < 0n || truncated >= pnWin) throw new RangeError('truncated packet number does not fit its size');
    if (largestPn !== null) checkPacketNumber(largestPn, 'largest packet number');
    const expectedPn = largestPn === null ? 0n : largestPn + 1n;
    const pnHwin = pnWin / 2n;
    const pnMask = pnWin - 1n;
    const candidatePn = (expectedPn & ~pnMask) | truncated;
    if (candidatePn <= expectedPn - pnHwin && candidatePn < (1n << 62n) - pnWin) return candidatePn + pnWin;
    if (candidatePn > expectedPn + pnHwin && candidatePn >= pnWin) return candidatePn - pnWin;
    return candidatePn;
}
