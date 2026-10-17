// Synchronous child runs (child_process.spawnSync, execSync, execFileSync).
//
// A capability call cannot await, and a child node process cannot finish its boot without one (its QuickJS module
// loads asynchronously). So a synchronous child boots on the module the last boot loaded, and NodeProcess
// .runToCompletionSync (process.ts) steps it from inside the call: guest jobs, due virtual timers and synchronous
// host operations, until nothing refs the process. This file holds what does not need the process itself.
import type { IFileSystem } from '../../../filesystem';
import type { RuntimeServices } from './runtime/services';

/** One synchronous node child, with the executable and arguments already resolved as NodeProcessExecutor resolves them. */
export interface SyncChildRequest {
    pid: number;
    parentPid: number;
    /** A script path, or '[eval]' when evalSource is set. */
    file: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    evalSource?: string;
    fileSystem: IFileSystem;
    services: RuntimeServices;
    /** 0 means no deadline. */
    timeoutMs: number;
    killSignal: string;
}

export interface SyncChildResult {
    /** null when the child was killed (deadline) */
    status: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    /** The child waits on host work that cannot be stepped inside a synchronous call; the text says what. */
    blocked?: string;
}

export type SyncNodeRunner = (request: SyncChildRequest) => SyncChildResult;

let syncRuns = 0;

/** A synchronous run is on the stack: capabilities answer synchronously and deliver through the owning process's queue. */
export function enterSyncRun(): void {
    syncRuns += 1;
}

export function leaveSyncRun(): void {
    syncRuns -= 1;
}

export function syncRunActive(): boolean {
    return syncRuns > 0;
}

/** Filled in by process.ts when it loads, so capabilities/child.ts reaches the node runner without importing it. */
export const nodeSyncRunner: { run?: SyncNodeRunner } = {};

const waitCell = typeof SharedArrayBuffer === 'function' ? new Int32Array(new SharedArrayBuffer(4)) : undefined;

/** Blocks the calling thread for ms: Atomics.wait where the thread allows it, a spin otherwise. */
export function sleepMs(ms: number): void {
    if (!(ms > 0)) return;
    if (waitCell !== undefined) {
        try {
            Atomics.wait(waitCell, 0, 0, ms);
            return;
        } catch {
            // this thread may not wait (some browser main threads): spin instead
        }
    }
    const until = performance.now() + ms;
    while (performance.now() < until) {
        // spin
    }
}
