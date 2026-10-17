import { IFileSystem } from '../../../filesystem';
import { ProcessExecutor } from '../base';
import { ShellProcess } from './process';
import { ChildProcessPayload, Process } from '../../base';
import type { NetworkHandle } from '../../../shell/commands/types';

export class ShellProcessExecutor implements ProcessExecutor {
    constructor(private fileSystem: IFileSystem, private network?: NetworkHandle) { }

    canExecute(executable: string): boolean {
        return executable === 'sh';
    }

    async execute(payload: ChildProcessPayload, pid: number, parantPid?: number): Promise<Process> {
        /* A caller's environment -- npm run's PATH of node_modules/.bin, say -- is the shell's,
           with the container's own defaults behind it for the names the caller left out. */
        const env = new Map<string, string>([
            ['PATH', '/bin:/usr/bin'],
            ['HOME', '/home'],
            ['PWD', payload.cwd || '/']
        ]);
        for (const [name, value] of Object.entries(payload.env ?? {})) env.set(name, value);
        return new ShellProcess(
            pid,
            payload.executable,
            payload.args,
            this.fileSystem,
            parantPid,
            payload.cwd,
            env,
            this.network
        );
    }
}
