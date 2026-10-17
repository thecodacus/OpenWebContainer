import { IFileSystem } from '../../../filesystem';
import { ChildProcessPayload, Process } from '../../base';
import { ProcessExecutor } from '../base';
import { NpmProcess } from './process';

export class NpmProcessExecutor implements ProcessExecutor {
    constructor(private fileSystem: IFileSystem) { }

    canExecute(executable: string): boolean {
        return executable === 'npm' || executable === 'npx';
    }

    async execute(payload: ChildProcessPayload, pid: number, parentPid?: number): Promise<Process> {
        return new NpmProcess(pid, payload.executable, payload.args, this.fileSystem, parentPid, payload.cwd || '/');
    }
}
