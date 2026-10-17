/*
 * HTTP/3 (RFC 9114 Section 11.2) and QPACK (RFC 9204 Section 8) code points for the stages built on
 * this transport. Values are checked against the saved RFC texts by the Witness C script.
 */

/** RFC 9114 Section 11.2.1, Table 2. */
export const H3FrameType = {
    DATA: 0x00,
    HEADERS: 0x01,
    CANCEL_PUSH: 0x03,
    SETTINGS: 0x04,
    PUSH_PROMISE: 0x05,
    GOAWAY: 0x07,
    MAX_PUSH_ID: 0x0d,
} as const;

/** HTTP/2 frame types reserved in HTTP/3; receipt is a connection error of type H3_FRAME_UNEXPECTED (RFC 9114 Section 7.2.8). */
export const H3_RESERVED_FRAME_TYPES: readonly number[] = [0x02, 0x06, 0x08, 0x09];

/** RFC 9114 Section 8.1 and Section 11.2.3, Table 4. */
export const H3ErrorCode = {
    H3_NO_ERROR: 0x0100,
    H3_GENERAL_PROTOCOL_ERROR: 0x0101,
    H3_INTERNAL_ERROR: 0x0102,
    H3_STREAM_CREATION_ERROR: 0x0103,
    H3_CLOSED_CRITICAL_STREAM: 0x0104,
    H3_FRAME_UNEXPECTED: 0x0105,
    H3_FRAME_ERROR: 0x0106,
    H3_EXCESSIVE_LOAD: 0x0107,
    H3_ID_ERROR: 0x0108,
    H3_SETTINGS_ERROR: 0x0109,
    H3_MISSING_SETTINGS: 0x010a,
    H3_REQUEST_REJECTED: 0x010b,
    H3_REQUEST_CANCELLED: 0x010c,
    H3_REQUEST_INCOMPLETE: 0x010d,
    H3_MESSAGE_ERROR: 0x010e,
    H3_CONNECT_ERROR: 0x010f,
    H3_VERSION_FALLBACK: 0x0110,
} as const;

/** RFC 9114 Section 11.2.2, Table 3 (names without the SETTINGS_ prefix). */
export const H3Setting = {
    MAX_FIELD_SECTION_SIZE: 0x06,
} as const;

/** HTTP/2 setting identifiers reserved in HTTP/3; receipt is a connection error of type H3_SETTINGS_ERROR (RFC 9114 Section 7.2.4.1). */
export const H3_RESERVED_SETTINGS: readonly number[] = [0x00, 0x02, 0x03, 0x04, 0x05];

/** RFC 9114 Section 11.2.4, Table 5. */
export const H3StreamType = {
    CONTROL: 0x00,
    PUSH: 0x01,
} as const;

/** RFC 9204 Section 8.1, Table 1 (names without the SETTINGS_ prefix). */
export const QpackSetting = {
    QPACK_MAX_TABLE_CAPACITY: 0x01,
    QPACK_BLOCKED_STREAMS: 0x07,
} as const;

/** RFC 9204 Section 8.2, Table 2. */
export const QpackStreamType = {
    ENCODER: 0x02,
    DECODER: 0x03,
} as const;

/** RFC 9204 Section 8.3, Table 3. */
export const QpackErrorCode = {
    QPACK_DECOMPRESSION_FAILED: 0x0200,
    QPACK_ENCODER_STREAM_ERROR: 0x0201,
    QPACK_DECODER_STREAM_ERROR: 0x0202,
} as const;

/**
 * Whether a frame type, setting identifier, error code or stream type is of the reserved form
 * 0x1f * N + 0x21 (RFC 9114 Sections 6.2.3, 7.2.4.1, 7.2.8 and 8.1). Takes a bigint, as the varint
 * decoders return; any other type throws TypeError.
 */
export function isReservedH3CodePoint(value: bigint): boolean {
    if (typeof value !== 'bigint') throw new TypeError('isReservedH3CodePoint takes a bigint');
    return value >= 0x21n && value <= 0x3fffffffffffffffn && (value - 0x21n) % 0x1fn === 0n;
}
