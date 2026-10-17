import type { FieldLine } from './qpack';

/*
 * HTTP/3 field sections as messages (RFC 9114 Sections 4.2 and 4.3): validation of a received header
 * or trailer section (a failure makes the message malformed, a stream error of type
 * H3_MESSAGE_ERROR, Section 4.1.2), conversion of a Node-style headers object into field lines for
 * sending, and of received field lines into the headers object Node's http2 module would produce.
 */

export type MessageKind = 'request' | 'response' | 'trailers';

export type OutgoingHeaderValue = string | number | ReadonlyArray<string | number>;
export type OutgoingHeaders = Readonly<Record<string, OutgoingHeaderValue | undefined | null>>;
export type IncomingHeaders = Record<string, string | string[] | number | undefined>;

const REQUEST_PSEUDO: ReadonlySet<string> = new Set([':method', ':scheme', ':authority', ':path']);
const RESPONSE_PSEUDO: ReadonlySet<string> = new Set([':status']);
/** Fields that only make sense on a single hop (RFC 9114 Section 4.2); te is checked separately. */
const CONNECTION_SPECIFIC: ReadonlySet<string> = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade']);
/** RFC 9110 token characters, lowercase only (RFC 9114 Section 4.2). */
const FIELD_NAME = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/;
/** Node's http2 keeps the first of these when a field repeats (lib/internal/http2/util.js kSingleValueHeaders). */
const SINGLE_VALUE: ReadonlySet<string> = new Set([
    ':status', ':method', ':authority', ':scheme', ':path', ':protocol', 'access-control-allow-credentials', 'access-control-max-age',
    'access-control-request-method', 'age', 'authorization', 'content-encoding', 'content-language', 'content-length', 'content-location',
    'content-md5', 'content-range', 'content-type', 'date', 'dnt', 'etag', 'expires', 'from', 'host', 'if-match', 'if-modified-since',
    'if-none-match', 'if-range', 'if-unmodified-since', 'last-modified', 'location', 'max-forwards', 'proxy-authorization', 'range',
    'referer', 'retry-after', 'tk', 'upgrade-insecure-requests', 'user-agent', 'x-content-type-options',
]);

/** Why a field value is invalid (NUL, CR or LF anywhere; SP or HTAB at either end), or null. */
export function fieldValueProblem(value: string): string | null {
    for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i);
        if (c === 0x00 || c === 0x0a || c === 0x0d) return `contains the byte 0x${c.toString(16).padStart(2, '0')}`;
        if (c > 0xff) return `contains the character U+${c.toString(16).padStart(4, '0')}`;
    }
    if (value.length > 0) {
        const first = value.charCodeAt(0);
        const last = value.charCodeAt(value.length - 1);
        if (first === 0x20 || first === 0x09 || last === 0x20 || last === 0x09) return 'starts or ends with whitespace';
    }
    return null;
}

export interface ValidatedMessage {
    /** Why the message is malformed (RFC 9114 Section 4.1.2), or null when it is valid. */
    readonly error: string | null;
    readonly method?: string;
    readonly scheme?: string;
    readonly authority?: string;
    readonly path?: string;
    readonly status?: number;
    /** The Content-Length value, or null when absent. */
    readonly contentLength: number | null;
}

/** Validates a received header or trailer section as a request, a response or trailers. */
export function validateMessage(fields: readonly FieldLine[], kind: MessageKind): ValidatedMessage {
    const allowed = kind === 'request' ? REQUEST_PSEUDO : kind === 'response' ? RESPONSE_PSEUDO : new Set<string>();
    const pseudo: Record<string, string> = {};
    let regularSeen = false;
    let contentLength: number | null = null;
    let host: string | null = null;
    const malformed = (error: string): ValidatedMessage => ({ error, contentLength });
    for (const [name, value] of fields) {
        if (name.length === 0) return malformed('empty field name');
        if (name.charCodeAt(0) === 0x3a) {
            if (regularSeen) return malformed(`pseudo-header ${name} after a regular field`);
            if (!allowed.has(name)) return malformed(kind === 'trailers' ? `pseudo-header ${name} in a trailer section` : `pseudo-header ${name} is not defined for a ${kind}`);
            if (Object.prototype.hasOwnProperty.call(pseudo, name)) return malformed(`pseudo-header ${name} appears twice`);
            const problem = fieldValueProblem(value);
            if (problem !== null) return malformed(`${name} value ${problem}`);
            pseudo[name] = value;
            continue;
        }
        regularSeen = true;
        if (!FIELD_NAME.test(name)) return malformed(/[A-Z]/.test(name) ? `field name ${JSON.stringify(name)} contains uppercase characters` : `field name ${JSON.stringify(name)} contains invalid characters`);
        const problem = fieldValueProblem(value);
        if (problem !== null) return malformed(`field ${name} value ${problem}`);
        if (CONNECTION_SPECIFIC.has(name)) return malformed(`connection-specific field ${name}`);
        if (name === 'te' && (kind !== 'request' || value !== 'trailers')) return malformed(kind === 'request' ? `te field with a value other than "trailers"` : `te field in a ${kind}`);
        if (name === 'content-length') {
            if (!/^[0-9]+$/.test(value)) return malformed(`content-length ${JSON.stringify(value)} is not a non-negative integer`);
            const n = Number(value);
            if (contentLength !== null && contentLength !== n) return malformed('conflicting content-length values');
            contentLength = n;
        }
        if (name === 'host') host = value;
    }
    if (kind === 'request') {
        const method = pseudo[':method'];
        if (method === undefined) return malformed('request without :method');
        if (method === 'CONNECT') {
            // RFC 9114 Section 4.4: :scheme and :path are omitted, :authority is required.
            if (pseudo[':scheme'] !== undefined || pseudo[':path'] !== undefined) return malformed('CONNECT request with :scheme or :path');
            if (!pseudo[':authority']) return malformed('CONNECT request without :authority');
        } else {
            if (pseudo[':scheme'] === undefined) return malformed('request without :scheme');
            if (pseudo[':path'] === undefined) return malformed('request without :path');
            const scheme = pseudo[':scheme'];
            if (scheme === 'http' || scheme === 'https') {
                const authority = pseudo[':authority'];
                if (pseudo[':path'] === '') return malformed(`empty :path for scheme ${scheme}`);
                if (authority === undefined && host === null) return malformed(`${scheme} request without :authority or host`);
                if (authority === '' || host === '') return malformed(`${scheme} request with an empty :authority or host`);
                if (authority !== undefined && host !== null && authority !== host) return malformed(':authority and host differ');
            }
        }
        return { error: null, method, scheme: pseudo[':scheme'], authority: pseudo[':authority'], path: pseudo[':path'], contentLength };
    }
    if (kind === 'response') {
        const status = pseudo[':status'];
        if (status === undefined) return malformed('response without :status');
        if (!/^[1-9][0-9][0-9]$/.test(status)) return malformed(`:status ${JSON.stringify(status)} is not a three-digit status code`);
        // RFC 9114 Section 4.5: no 101 (Switching Protocols).
        if (status === '101') return malformed(':status 101 is not supported in HTTP/3');
        return { error: null, status: Number(status), contentLength };
    }
    return { error: null, contentLength };
}

function headerError(code: string, message: string, Ctor: ErrorConstructor | TypeErrorConstructor = TypeError): Error {
    return Object.assign(new Ctor(message), { code });
}

/**
 * Field lines for a headers object, pseudo-headers first (RFC 9114 Section 4.3). Names are lowercased,
 * arrays become one field line per element, undefined and null are skipped. Throws for
 * connection-specific fields, pseudo-headers that do not belong to the message kind, repeated
 * pseudo-headers, invalid names and invalid values.
 */
export function headersToFields(headers: OutgoingHeaders, kind: MessageKind): FieldLine[] {
    const allowed = kind === 'request' ? REQUEST_PSEUDO : kind === 'response' ? RESPONSE_PSEUDO : new Set<string>();
    const pseudoLines: FieldLine[] = [];
    const lines: FieldLine[] = [];
    for (const rawName of Object.keys(headers)) {
        const value = headers[rawName];
        if (value === undefined || value === null) continue;
        const name = rawName.toLowerCase();
        const values = Array.isArray(value) ? (value as ReadonlyArray<string | number>) : [value as string | number];
        if (name.charCodeAt(0) === 0x3a) {
            if (!allowed.has(name)) throw headerError('ERR_HTTP3_INVALID_PSEUDOHEADER', `"${name}" is an invalid pseudoheader or is used incorrectly`);
            if (values.length !== 1) throw headerError('ERR_HTTP3_HEADER_SINGLE_VALUE', `Header field "${name}" must only have a single value`);
            const text = String(values[0]);
            const problem = fieldValueProblem(text);
            if (problem !== null) throw headerError('ERR_INVALID_CHAR', `Invalid character in header content ["${name}"]: value ${problem}`);
            pseudoLines.push([name, text]);
            continue;
        }
        if (!FIELD_NAME.test(name)) throw headerError('ERR_INVALID_HTTP_TOKEN', `Header name must be a valid HTTP token ["${rawName}"]`);
        if (CONNECTION_SPECIFIC.has(name) || (name === 'te' && (kind !== 'request' || values.some((v) => String(v) !== 'trailers')))) {
            throw headerError('ERR_HTTP3_INVALID_CONNECTION_HEADERS', `HTTP/1 Connection specific headers are forbidden: "${name}"`);
        }
        for (const element of values) {
            const text = String(element);
            const problem = fieldValueProblem(text);
            if (problem !== null) throw headerError('ERR_INVALID_CHAR', `Invalid character in header content ["${name}"]: value ${problem}`);
            lines.push([name, text]);
        }
    }
    return pseudoLines.concat(lines);
}

/** The headers object Node's http2 module builds from received field lines (toHeaderObject). */
export function fieldsToHeaders(fields: readonly FieldLine[]): IncomingHeaders {
    const out: IncomingHeaders = Object.create(null);
    for (const [name, value] of fields) {
        const existing = out[name];
        if (existing === undefined) {
            out[name] = name === ':status' ? Number(value) | 0 : name === 'set-cookie' ? [value] : value;
        } else if (!SINGLE_VALUE.has(name)) {
            if (name === 'cookie') out[name] = `${existing as string}; ${value}`;
            else if (name === 'set-cookie') (existing as string[]).push(value);
            else out[name] = `${existing as string}, ${value}`;
        }
    }
    return out;
}

/** Field lines as Node's rawHeaders: a flat [name, value, name, value, ...] list. */
export function rawHeadersOf(fields: readonly FieldLine[]): string[] {
    const out: string[] = [];
    for (const [name, value] of fields) out.push(name, value);
    return out;
}

/** Size of a field section as RFC 9114 Section 4.2.2 counts it: name and value bytes plus 32 per field. */
export function fieldSectionSize(fields: readonly FieldLine[]): number {
    let size = 0;
    for (const [name, value] of fields) size += name.length + value.length + 32;
    return size;
}
