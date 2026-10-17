import { IFileSystem } from '../../../../../filesystem';
import { NodeResolver } from '../resolver';
import { RuntimeServices } from '../services';

/** Everything a capability handler may touch: the calling guest process and container services. */
export interface CapabilityContext {
    pid: number;
    cwd(): string;
    env(): Record<string, string>;
    fileSystem: IFileSystem;
    resolver: NodeResolver;
    services: RuntimeServices;
    /** Queues an event for a guest target; it runs as a macrotask, never inside the current call. */
    deliver(targetId: number, name: string, payload: unknown): void;
    /** Keep-alive accounting: a positive hold keeps the process alive until released. */
    holdRef(delta: number): void;
    /** Writes to this process's own output (for example stdio inherited from a child process). */
    output(message: { stdout?: string; stderr?: string }): void;
}

/** A sync capability returns its value; an async one returns a promise of it. */
export type CapabilityHandler = (args: any, context: CapabilityContext) => unknown | Promise<unknown>;

export type CapabilityEnvelope =
    | { ok: true; value: unknown }
    | { ok: false; code: string; message: string; errno?: number; syscall?: string; props?: Record<string, unknown> };
