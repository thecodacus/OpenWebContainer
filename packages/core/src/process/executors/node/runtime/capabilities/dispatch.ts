import { CAPABILITIES } from './index';
import { CapabilityContext, CapabilityEnvelope } from './types';

/**
 * Turns any thrown value into the envelope the guest turns back into an Error. Extra own
 * enumerable properties (for example hostname or address) travel as JSON in `props`.
 */
export function errorEnvelope(error: unknown): CapabilityEnvelope {
    const err = error as { code?: unknown; message?: unknown; errno?: unknown; syscall?: unknown } | undefined;
    const standard = new Set(['code', 'message', 'errno', 'syscall', 'stack', 'name']);
    let props: Record<string, unknown> | undefined;
    if (typeof error === 'object' && error !== null) {
        const extra: Record<string, unknown> = {};
        for (const key of Object.keys(error)) {
            if (standard.has(key)) continue;
            const value = (error as Record<string, unknown>)[key];
            if (value === undefined || typeof value === 'function') continue;
            try {
                extra[key] = JSON.parse(JSON.stringify(value));
            } catch {
                // values that cannot be serialized are dropped, as the envelope is JSON
            }
        }
        if (Object.keys(extra).length > 0) props = extra;
    }
    return {
        ok: false,
        code: typeof err?.code === 'string' ? err.code : 'ERR_CAPABILITY',
        message: typeof err?.message === 'string' ? err.message : String(error),
        errno: typeof err?.errno === 'number' ? err.errno : undefined,
        syscall: typeof err?.syscall === 'string' ? err.syscall : undefined,
        props
    };
}

function handlerFor(op: string) {
    const handler = CAPABILITIES[op];
    if (!handler) {
        return undefined;
    }
    return handler;
}

/** Runs a synchronous capability. Returns an envelope; never throws into the guest. */
export function invokeSync(op: string, argsJson: string, context: CapabilityContext): CapabilityEnvelope {
    const handler = handlerFor(op);
    if (!handler) return errorEnvelope(Object.assign(new Error(`unknown capability ${op}`), { code: 'ERR_UNKNOWN_CAPABILITY' }));
    try {
        const value = handler(JSON.parse(argsJson), context);
        if (value instanceof Promise) {
            value.catch(() => undefined);
            return errorEnvelope(Object.assign(new Error(`${op} is asynchronous`), { code: 'ERR_ASYNC_CAPABILITY' }));
        }
        return { ok: true, value: value === undefined ? null : value };
    } catch (error) {
        return errorEnvelope(error);
    }
}

/**
 * Runs an asynchronous capability; `settle` receives exactly one envelope, always on a later
 * macrotask so the guest has registered its pending operation before it can settle.
 */
export function invokeAsync(
    op: string,
    argsJson: string,
    context: CapabilityContext,
    settle: (envelope: CapabilityEnvelope) => void
): void {
    const finish = (envelope: CapabilityEnvelope) => setTimeout(() => settle(envelope), 0);
    const handler = handlerFor(op);
    if (!handler) {
        finish(errorEnvelope(Object.assign(new Error(`unknown capability ${op}`), { code: 'ERR_UNKNOWN_CAPABILITY' })));
        return;
    }
    let outcome: unknown;
    try {
        outcome = handler(JSON.parse(argsJson), context);
    } catch (error) {
        finish(errorEnvelope(error));
        return;
    }
    Promise.resolve(outcome).then(
        (value) => finish({ ok: true, value: value === undefined ? null : value }),
        (error) => finish(errorEnvelope(error))
    );
}
