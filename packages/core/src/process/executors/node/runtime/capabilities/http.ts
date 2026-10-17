import { CapabilityHandler } from './types';
import { base64ToBytes, bytesToBase64, notifyGuestServer } from '../../../../../network/virtual/host-http';

/** Request headers that a browser fetch refuses, or that describe the transport rather than the message. */
const TRANSPORT_HEADERS = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'content-length', 'upgrade', 'te', 'trailer', 'expect']);

/** Upper bound for one external request, from start to the last body byte. */
const FETCH_TIMEOUT_MS = 30000;

interface FetchArgs {
    url: string;
    method?: string;
    headers?: Record<string, unknown>;
    body?: string | null;
}

function portArg(value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 65535) {
        throw Object.assign(new RangeError(`invalid port ${String(value)}`), { code: 'ERR_SOCKET_BAD_PORT' });
    }
    return value;
}

function failure(code: string, message: string, extra: Record<string, unknown> = {}): Error {
    return Object.assign(new Error(message), { code, ...extra });
}

/** Response headers as a plain object with lower-case names; set-cookie stays a list. */
function headerObject(headers: Headers): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    headers.forEach((value, name) => {
        if (name !== 'set-cookie') out[name] = value;
    });
    const cookies = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
    if (cookies && cookies.length > 0) out['set-cookie'] = cookies;
    return out;
}

/**
 * Runs one request through the host's fetch. Redirects are followed by fetch: a browser hides the
 * status of a redirect under redirect 'manual', so the guest sees the final response.
 */
async function fetchExternal(args: FetchArgs): Promise<unknown> {
    let target: URL;
    try {
        target = new URL(String(args.url));
    } catch {
        throw failure('ERR_INVALID_URL', `Invalid URL: ${String(args.url)}`);
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        throw failure('ERR_INVALID_PROTOCOL', `Protocol "${target.protocol}" not supported. Expected "http:" or "https:"`);
    }
    const method = (args.method ?? 'GET').toUpperCase();
    const headers = new Headers();
    for (const [name, value] of Object.entries(args.headers ?? {})) {
        if (TRANSPORT_HEADERS.has(name.toLowerCase())) continue;
        const values = Array.isArray(value) ? value : [value];
        for (const item of values) {
            try {
                headers.append(name, String(item));
            } catch {
                // a value the browser refuses is dropped, as fetch drops forbidden headers
            }
        }
    }
    const body = args.body === null || args.body === undefined || method === 'GET' || method === 'HEAD'
        ? undefined
        : base64ToBytes(args.body);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(target.href, { method, headers, body, redirect: 'follow', signal: controller.signal });
        const bytes = new Uint8Array(await response.arrayBuffer());
        return {
            status: response.status,
            statusText: response.statusText,
            headers: headerObject(response.headers),
            body: bytesToBase64(bytes),
            url: response.url,
        };
    } catch (error) {
        if (controller.signal.aborted) {
            throw failure('ETIMEDOUT', `request to ${target.href} timed out after ${FETCH_TIMEOUT_MS} ms`, { syscall: 'read' });
        }
        if (error instanceof TypeError) {
            // the browser reports name resolution, TLS and CORS failures the same way
            throw failure('ENOTFOUND', `getaddrinfo ENOTFOUND ${target.hostname}`, {
                syscall: 'getaddrinfo',
                hostname: target.hostname,
                detail: 'the browser could not complete the request (name resolution, TLS or CORS)',
            });
        }
        throw failure('ECONNRESET', error instanceof Error ? error.message : String(error));
    } finally {
        clearTimeout(timer);
    }
}

/** Host operations for the http area. Each one runs on behalf of the calling guest (ctx.pid). */
export const HTTP_CAPABILITIES: Record<string, CapabilityHandler> = {
    /** External request: fetch in the host, response returned with its body as base64. */
    'http.fetch': (args: FetchArgs) => fetchExternal(args),

    /** A guest http server bound its port on the hub: the container tracks it as a listening server. */
    'http.serverListening': (args, ctx) => {
        notifyGuestServer(ctx.services.network, 'listen', ctx.pid, portArg(args.port));
        return null;
    },

    /** A guest http server released its port. */
    'http.serverClosed': (args, ctx) => {
        notifyGuestServer(ctx.services.network, 'close', ctx.pid, portArg(args.port));
        return null;
    },
};
