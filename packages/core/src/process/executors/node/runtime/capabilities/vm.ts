import type { QuickJSContext, QuickJSHandle, QuickJSRuntime } from 'quickjs-emscripten';
import { CapabilityContext, CapabilityHandler } from './types';

/**
 * Host half of the vm `timeout` option. The guest hands the evaluation over as a thunk
 * (api.vmThunk) and calls vm.run with the timeout. The host arms the deadline, runs the thunk, and
 * disarms the deadline before returning, so no guest code runs between arming and the thunk.
 * QuickJS delivers an interrupt as an uncatchable InternalError: guest catch and finally blocks are
 * skipped, so the interruption is caught here, at the host call boundary, and reported as a value.
 */

interface VmHost {
    context: QuickJSContext;
    /** The guest bootstrap API object; vm.run reads the thunk from its `vmThunk` slot. */
    api: QuickJSHandle;
    /** Armed deadline in epoch milliseconds; 0 while nothing is armed. */
    deadline: number;
    /** Set by the interrupt handler when it interrupts; read by vm.run. */
    fired: boolean;
}

const hosts = new WeakMap<CapabilityContext, VmHost>();

/**
 * Installs the vm interrupt handler on a runtime and binds it to the owning process. Call once per
 * runtime, after the bootstrap has produced its API object. With no deadline armed the handler does
 * one comparison per interrupt check.
 */
export function bindVmRuntime(owner: CapabilityContext, runtime: QuickJSRuntime, context: QuickJSContext, api: QuickJSHandle): void {
    const host: VmHost = { context, api, deadline: 0, fired: false };
    hosts.set(owner, host);
    runtime.setInterruptHandler(() => {
        if (host.deadline !== 0 && Date.now() >= host.deadline) {
            host.fired = true;
            return true;
        }
        return false;
    });
}

function describeError(error: unknown): string {
    if (error !== null && typeof error === 'object' && 'message' in error) {
        return String((error as { message: unknown }).message);
    }
    return String(error);
}

export const VM_CAPABILITIES: Record<string, CapabilityHandler> = {
    /**
     * Runs the guest thunk (api.vmThunk) synchronously under a deadline `timeout` ms from now, never
     * later than an enclosing one. An interruption returns { interrupted: true }; { unbound: true }
     * means no runtime is bound and nothing ran.
     */
    'vm.run': (args, ctx) => {
        const host = hosts.get(ctx);
        if (!host) return { unbound: true };
        const { context } = host;
        const thunk = context.getProp(host.api, 'vmThunk');
        const outer = host.deadline;
        const limit = Date.now() + Number(args.timeout);
        host.deadline = outer === 0 ? limit : Math.min(outer, limit);
        try {
            host.fired = false;
            const result = context.callFunction(thunk, context.undefined);
            if (result.error) {
                const error = context.dump(result.error);
                result.error.dispose();
                return host.fired ? { interrupted: true } : { interrupted: false, error: describeError(error) };
            }
            result.value.dispose();
            return { interrupted: false };
        } finally {
            host.deadline = outer;
            thunk.dispose();
        }
    }
};
