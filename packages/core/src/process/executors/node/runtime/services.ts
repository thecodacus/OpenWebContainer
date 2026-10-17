import { Process } from '../../../base';
import { VirtualNetwork, VirtualSink } from '../../../../network/virtual/hub';

/** Container-level services a guest process may use through capabilities. */
export interface StartProcessRequest {
    parentPid: number;
    executable: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
    /** Runs before the process starts, so a caller can listen for every event. */
    beforeStart?: (process: Process) => void;
}

export interface RuntimeServices {
    network: VirtualNetwork;
    /** Starts a container process (child_process, fork, worker_threads, cluster all use this). */
    startProcess(request: StartProcessRequest): Promise<Process>;
    /** Delivery sink for a running guest process, if it is still alive. */
    sinkFor(pid: number): VirtualSink | undefined;
}
