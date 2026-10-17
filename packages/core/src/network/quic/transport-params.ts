import { QuicError, TransportError } from './errors';
import { QuicReader, QuicWriter, VARINT_MAX } from './varint';

/*
 * QUIC transport parameters (RFC 9000 Section 18): the payload of the quic_transport_parameters TLS
 * extension, a sequence of (id varint, length varint, value). Property names are the RFC 9000
 * Section 18.2 parameter names. Integer values are bigint. Decoding raises
 * QuicError(TRANSPORT_PARAMETER_ERROR) for a malformed or invalid value, a duplicate id, and, when the
 * sender's role is given, for a server-only parameter from a client or a missing required parameter.
 */

export const TransportParameterId = {
    original_destination_connection_id: 0x00,
    max_idle_timeout: 0x01,
    stateless_reset_token: 0x02,
    max_udp_payload_size: 0x03,
    initial_max_data: 0x04,
    initial_max_stream_data_bidi_local: 0x05,
    initial_max_stream_data_bidi_remote: 0x06,
    initial_max_stream_data_uni: 0x07,
    initial_max_streams_bidi: 0x08,
    initial_max_streams_uni: 0x09,
    ack_delay_exponent: 0x0a,
    max_ack_delay: 0x0b,
    disable_active_migration: 0x0c,
    preferred_address: 0x0d,
    active_connection_id_limit: 0x0e,
    initial_source_connection_id: 0x0f,
    retry_source_connection_id: 0x10,
} as const;

export type TransportParameterName = keyof typeof TransportParameterId;

export interface PreferredAddress {
    readonly ipv4Address: Uint8Array;
    readonly ipv4Port: number;
    readonly ipv6Address: Uint8Array;
    readonly ipv6Port: number;
    readonly connectionId: Uint8Array;
    readonly statelessResetToken: Uint8Array;
}

export interface UnknownTransportParameter {
    readonly id: bigint;
    readonly value: Uint8Array;
}

export interface TransportParameters {
    readonly original_destination_connection_id?: Uint8Array;
    readonly max_idle_timeout?: bigint;
    readonly stateless_reset_token?: Uint8Array;
    readonly max_udp_payload_size?: bigint;
    readonly initial_max_data?: bigint;
    readonly initial_max_stream_data_bidi_local?: bigint;
    readonly initial_max_stream_data_bidi_remote?: bigint;
    readonly initial_max_stream_data_uni?: bigint;
    readonly initial_max_streams_bidi?: bigint;
    readonly initial_max_streams_uni?: bigint;
    readonly ack_delay_exponent?: bigint;
    readonly max_ack_delay?: bigint;
    readonly disable_active_migration?: boolean;
    readonly preferred_address?: PreferredAddress;
    readonly active_connection_id_limit?: bigint;
    readonly initial_source_connection_id?: Uint8Array;
    readonly retry_source_connection_id?: Uint8Array;
    /** Parameters without a definition here (extensions, reserved 31 * N + 27 ids), in wire order. Receivers ignore them. */
    readonly unknown?: readonly UnknownTransportParameter[];
    /** Wire order of the decoded ids; encoding follows it so decode then encode reproduces the input. */
    readonly order?: readonly bigint[];
}

/** Values that apply when a parameter is absent (RFC 9000 Section 18.2; 0 unless stated). */
export const TRANSPORT_PARAMETER_DEFAULTS = {
    max_idle_timeout: 0n,
    max_udp_payload_size: 65527n,
    initial_max_data: 0n,
    initial_max_stream_data_bidi_local: 0n,
    initial_max_stream_data_bidi_remote: 0n,
    initial_max_stream_data_uni: 0n,
    initial_max_streams_bidi: 0n,
    initial_max_streams_uni: 0n,
    ack_delay_exponent: 3n,
    max_ack_delay: 25n,
    disable_active_migration: false,
    active_connection_id_limit: 2n,
} as const;

/** Parameters a client must not send (RFC 9000 Section 18.2). */
export const SERVER_ONLY_PARAMETERS: readonly TransportParameterName[] = [
    'original_destination_connection_id',
    'preferred_address',
    'retry_source_connection_id',
    'stateless_reset_token',
];

type Kind = 'integer' | 'connection_id' | 'reset_token' | 'flag' | 'preferred_address';

const KIND: Readonly<Record<TransportParameterName, Kind>> = {
    original_destination_connection_id: 'connection_id',
    max_idle_timeout: 'integer',
    stateless_reset_token: 'reset_token',
    max_udp_payload_size: 'integer',
    initial_max_data: 'integer',
    initial_max_stream_data_bidi_local: 'integer',
    initial_max_stream_data_bidi_remote: 'integer',
    initial_max_stream_data_uni: 'integer',
    initial_max_streams_bidi: 'integer',
    initial_max_streams_uni: 'integer',
    ack_delay_exponent: 'integer',
    max_ack_delay: 'integer',
    disable_active_migration: 'flag',
    preferred_address: 'preferred_address',
    active_connection_id_limit: 'integer',
    initial_source_connection_id: 'connection_id',
    retry_source_connection_id: 'connection_id',
};

const NAMES = Object.keys(TransportParameterId) as TransportParameterName[];
const NAME_BY_ID = new Map<bigint, TransportParameterName>(NAMES.map((name) => [BigInt(TransportParameterId[name]), name]));

function parameterError(message: string): QuicError {
    return new QuicError(TransportError.TRANSPORT_PARAMETER_ERROR, message);
}

/** Range rules of RFC 9000 Sections 4.6 and 18.2 for integer parameters; returns a reason when invalid. */
function integerProblem(name: TransportParameterName, value: bigint): string | null {
    switch (name) {
        case 'max_udp_payload_size':
            return value < 1200n ? 'max_udp_payload_size below 1200' : null;
        case 'ack_delay_exponent':
            return value > 20n ? 'ack_delay_exponent above 20' : null;
        case 'max_ack_delay':
            return value >= 1n << 14n ? 'max_ack_delay of 2^14 or more' : null;
        case 'active_connection_id_limit':
            return value < 2n ? 'active_connection_id_limit below 2' : null;
        case 'initial_max_streams_bidi':
        case 'initial_max_streams_uni':
            return value > 1n << 60n ? `${name} above 2^60` : null;
        default:
            return null;
    }
}

function decodePreferredAddress(value: Uint8Array): PreferredAddress {
    const r = new QuicReader(value, 0, value.length, TransportError.TRANSPORT_PARAMETER_ERROR);
    const ipv4Address = r.take(4);
    const ipv4Port = r.uint16();
    const ipv6Address = r.take(16);
    const ipv6Port = r.uint16();
    const cidLength = r.uint8();
    if (cidLength < 1 || cidLength > 20) throw parameterError('preferred_address connection ID length outside 1..20');
    const connectionId = r.take(cidLength);
    const statelessResetToken = r.take(16);
    if (!r.eof()) throw parameterError('preferred_address has trailing bytes');
    return { ipv4Address, ipv4Port, ipv6Address, ipv6Port, connectionId, statelessResetToken };
}

/**
 * Decodes a quic_transport_parameters payload. sender, when given, enables the role checks of
 * RFC 9000 Sections 7.3 and 18.2: a client must not send server-only parameters; both endpoints must
 * send initial_source_connection_id; a server must send original_destination_connection_id.
 */
export function decodeTransportParameters(bytes: Uint8Array, sender?: 'client' | 'server'): TransportParameters {
    const r = new QuicReader(bytes, 0, bytes.length, TransportError.TRANSPORT_PARAMETER_ERROR);
    const out: Record<string, unknown> = {};
    const unknown: UnknownTransportParameter[] = [];
    const order: bigint[] = [];
    const seen = new Set<bigint>();
    while (!r.eof()) {
        const id = r.varint();
        const value = r.take(r.varintNumber());
        if (seen.has(id)) throw parameterError(`duplicate transport parameter 0x${id.toString(16)}`);
        seen.add(id);
        order.push(id);
        const name = NAME_BY_ID.get(id);
        if (name === undefined) {
            unknown.push({ id, value });
            continue;
        }
        switch (KIND[name]) {
            case 'integer': {
                const vr = new QuicReader(value, 0, value.length, TransportError.TRANSPORT_PARAMETER_ERROR);
                const v = vr.varint();
                if (!vr.eof()) throw parameterError(`${name} value does not fill its length`);
                const problem = integerProblem(name, v);
                if (problem !== null) throw parameterError(problem);
                out[name] = v;
                break;
            }
            case 'connection_id':
                if (value.length > 20) throw parameterError(`${name} longer than 20 bytes`);
                out[name] = value;
                break;
            case 'reset_token':
                if (value.length !== 16) throw parameterError('stateless_reset_token must be 16 bytes');
                out[name] = value;
                break;
            case 'flag':
                if (value.length !== 0) throw parameterError(`${name} must be empty`);
                out[name] = true;
                break;
            case 'preferred_address':
                out[name] = decodePreferredAddress(value);
                break;
        }
    }
    if (sender === 'client') {
        for (const name of SERVER_ONLY_PARAMETERS) {
            if (out[name] !== undefined) throw parameterError(`client sent server-only parameter ${name}`);
        }
    }
    if (sender !== undefined && out.initial_source_connection_id === undefined) throw parameterError('initial_source_connection_id missing');
    if (sender === 'server' && out.original_destination_connection_id === undefined) throw parameterError('original_destination_connection_id missing');
    if (unknown.length > 0) out.unknown = unknown;
    out.order = order;
    return out as TransportParameters;
}

function encodeValue(name: TransportParameterName, value: unknown): Uint8Array {
    const w = new QuicWriter(32);
    switch (KIND[name]) {
        case 'integer': {
            const v = value as bigint;
            if (typeof v !== 'bigint' || v < 0n || v > VARINT_MAX) throw new RangeError(`${name} must be a bigint in 0..2^62-1`);
            const problem = integerProblem(name, v);
            if (problem !== null) throw new RangeError(problem);
            w.varint(v);
            break;
        }
        case 'connection_id': {
            const cid = value as Uint8Array;
            if (!(cid instanceof Uint8Array) || cid.length > 20) throw new RangeError(`${name} must be at most 20 bytes`);
            w.bytes(cid);
            break;
        }
        case 'reset_token': {
            const token = value as Uint8Array;
            if (!(token instanceof Uint8Array) || token.length !== 16) throw new RangeError('stateless_reset_token must be 16 bytes');
            w.bytes(token);
            break;
        }
        case 'flag':
            break;
        case 'preferred_address': {
            const pa = value as PreferredAddress;
            if (pa.ipv4Address.length !== 4 || pa.ipv6Address.length !== 16) throw new RangeError('preferred_address addresses must be 4 and 16 bytes');
            if (pa.connectionId.length < 1 || pa.connectionId.length > 20) throw new RangeError('preferred_address connection ID must be 1..20 bytes');
            if (pa.statelessResetToken.length !== 16) throw new RangeError('preferred_address stateless reset token must be 16 bytes');
            w.bytes(pa.ipv4Address).uint16(pa.ipv4Port).bytes(pa.ipv6Address).uint16(pa.ipv6Port);
            w.uint8(pa.connectionId.length).bytes(pa.connectionId).bytes(pa.statelessResetToken);
            break;
        }
    }
    return w.finish();
}

/**
 * Encodes transport parameters. Ids listed in params.order come first in that order; the remaining
 * defined parameters follow in ascending id order, then the remaining unknown ones in their order.
 * disable_active_migration is written when true.
 */
export function encodeTransportParameters(params: TransportParameters): Uint8Array {
    const values = new Map<bigint, Uint8Array>();
    for (const name of NAMES) {
        const value = (params as Record<string, unknown>)[name];
        if (value === undefined || value === false) continue;
        values.set(BigInt(TransportParameterId[name]), encodeValue(name, value));
    }
    for (const { id, value } of params.unknown ?? []) {
        if (typeof id !== 'bigint' || id < 0n || id > VARINT_MAX) throw new RangeError('unknown parameter id out of range');
        if (values.has(id)) throw new RangeError(`parameter id 0x${id.toString(16)} given twice`);
        values.set(id, value);
    }
    // NAMES is in ascending id order, so defined ids not named by params.order land ascending.
    const candidates = [...(params.order ?? []), ...NAMES.map((name) => BigInt(TransportParameterId[name])), ...(params.unknown ?? []).map((p) => p.id)];
    const ids: bigint[] = [];
    for (const id of candidates) {
        if (values.has(id) && !ids.includes(id)) ids.push(id);
    }
    const w = new QuicWriter(128);
    for (const id of ids) {
        const value = values.get(id) as Uint8Array;
        w.varint(id).varint(value.length).bytes(value);
    }
    return w.finish();
}
