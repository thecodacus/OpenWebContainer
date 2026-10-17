import { CapabilityHandler } from './types';
import { hostsFileAddresses } from './dns';

/** errno values for the codes the virtual network raises (macOS numbering: the reference platform). */
const ERRNO: Record<string, number> = {
    EADDRINUSE: -48,
    EADDRNOTAVAIL: -49,
    ECONNREFUSED: -61,
    ENETUNREACH: -51,
    EBADF: -9,
};

/** Converts a hub failure into an error that the guest turns back into an Error with code, errno and syscall. */
function failure(error: unknown, syscall: string): Error {
    const code = typeof (error as { code?: unknown } | undefined)?.code === 'string'
        ? (error as { code: string }).code
        : 'ERR_NET';
    const message = error instanceof Error ? error.message : String(error);
    return Object.assign(new Error(message), { code, errno: ERRNO[code], syscall });
}

function guard<T>(syscall: string, run: () => T): T {
    try {
        return run();
    } catch (error) {
        throw failure(error, syscall);
    }
}

/** False when the object no longer exists (nothing to do); throws EBADF when another guest owns it. */
function ownedBy(owner: number | undefined, pid: number): boolean {
    if (owner === undefined) return false;
    if (owner !== pid) {
        throw Object.assign(new Error('bad file descriptor'), { code: 'EBADF', errno: ERRNO.EBADF, syscall: 'net' });
    }
    return true;
}

function numberArg(value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw Object.assign(new TypeError(`expected an integer id, got ${String(value)}`), { code: 'ERR_INVALID_ARG_TYPE' });
    }
    return value;
}

function portArg(value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 65535) {
        throw Object.assign(new RangeError(`Port should be >= 0 and < 65536. Received ${String(value)}.`), { code: 'ERR_SOCKET_BAD_PORT' });
    }
    return value;
}

function targetArg(value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
        throw Object.assign(new TypeError(`invalid event target ${String(value)}`), { code: 'ERR_INVALID_ARG_VALUE' });
    }
    return value;
}

function dataArg(value: unknown): string {
    if (typeof value !== 'string') {
        throw Object.assign(new TypeError('data must be base64 text'), { code: 'ERR_INVALID_ARG_TYPE' });
    }
    return value;
}

function addressArg(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

/**
 * Host operations for the net area (net, tls, dgram). Each one is a synchronous call into the
 * in-container virtual network, made on behalf of the calling guest (ctx.pid). Binary payloads
 * travel as base64. Objects owned by another guest are refused with EBADF.
 */
export const NET_CAPABILITIES: Record<string, CapabilityHandler> = {
    'net.listen': (args, ctx) => guard('listen', () => ctx.services.network.listen({
        ownerPid: ctx.pid,
        protocol: 'tcp',
        address: addressArg(args.address),
        port: portArg(args.port),
        targetId: targetArg(args.targetId),
    })),

    'net.closeListener': (args, ctx) => guard('close', () => {
        const id = numberArg(args.id);
        if (ownedBy(ctx.services.network.ownerOfListener(id), ctx.pid)) ctx.services.network.closeListener(id);
        return null;
    }),

    'net.connect': (args, ctx) => guard('connect', () => ctx.services.network.connect({
        ownerPid: ctx.pid,
        address: addressArg(args.address) ?? 'localhost',
        port: portArg(args.port),
        targetId: targetArg(args.targetId),
        localPort: args.localPort ? portArg(args.localPort) : undefined,
    })),

    'net.attach': (args, ctx) => guard('attach', () => {
        const connectionId = numberArg(args.connectionId);
        if (ownedBy(ctx.services.network.ownerOfConnection(connectionId), ctx.pid)) {
            ctx.services.network.attach(connectionId, targetArg(args.targetId));
        }
        return null;
    }),

    'net.write': (args, ctx) => guard('write', () => {
        const connectionId = numberArg(args.connectionId);
        if (!ownedBy(ctx.services.network.ownerOfConnection(connectionId), ctx.pid)) return false;
        return ctx.services.network.write(connectionId, dataArg(args.data));
    }),

    'net.end': (args, ctx) => guard('end', () => {
        const connectionId = numberArg(args.connectionId);
        if (ownedBy(ctx.services.network.ownerOfConnection(connectionId), ctx.pid)) {
            ctx.services.network.end(connectionId);
        }
        return null;
    }),

    'net.destroy': (args, ctx) => guard('destroy', () => {
        const connectionId = numberArg(args.connectionId);
        if (ownedBy(ctx.services.network.ownerOfConnection(connectionId), ctx.pid)) {
            ctx.services.network.destroy(connectionId);
        }
        return null;
    }),

    'net.udpBind': (args, ctx) => guard('bind', () => ctx.services.network.bindUdp({
        ownerPid: ctx.pid,
        protocol: 'udp',
        address: addressArg(args.address),
        port: portArg(args.port),
        targetId: targetArg(args.targetId),
        family: args.family === 'IPv6' ? 'IPv6' : 'IPv4',
    })),

    'net.udpSend': (args, ctx) => guard('send', () => {
        const socketId = numberArg(args.socketId);
        if (!ownedBy(ctx.services.network.ownerOfUdp(socketId), ctx.pid)) return false;
        return ctx.services.network.sendUdp({
            socketId,
            address: addressArg(args.address) ?? 'localhost',
            port: portArg(args.port),
            dataBase64: dataArg(args.data),
        });
    }),

    'net.udpClose': (args, ctx) => guard('close', () => {
        const id = numberArg(args.id);
        if (ownedBy(ctx.services.network.ownerOfUdp(id), ctx.pid)) ctx.services.network.closeUdp(id);
        return null;
    }),

    /** Synchronous name lookup (registerHost entries, loopback names, then /etc/hosts); null when unknown. */
    'net.resolveHost': (args, ctx) => {
        const name = String(args.name);
        return ctx.services.network.resolveHost(name) ?? hostsFileAddresses(name, ctx)[0] ?? null;
    },
};
