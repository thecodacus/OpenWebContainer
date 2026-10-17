import { IFileSystem } from '../../../filesystem';
import { InstallSpec, NpmInstaller, parseInstallSpec, ScriptRunResult } from '../../../npm/installer';
import { NpmRegistry } from '../../../npm/registry';
import {
    LIFECYCLE_COMMANDS,
    NPM_VERSION,
    findPackageRoot,
    missingScriptMessage,
    parseScriptArgs,
    readManifest,
    scriptCommandLine,
    scriptEvents,
    scriptFailureMessage,
    scriptHeader,
    scriptLabel,
    scriptList,
    scriptPath
} from '../../../npm/scripts';
import { Process, ProcessType } from '../../base';
import { dirnameOf, joinPaths, normalizeAbsolute } from '../node/runtime/resolver';

const USAGE = [
    'Usage: npm <command>',
    '',
    'Commands supported by this runtime:',
    '  npm install [<pkg>[@range] ...] [-D|--save-dev] [--no-save]   aliases: i, add',
    '  npm init [-y]',
    '  npm run [<script> [-- <args>]] [--if-present]                 alias: run-script',
    '  npm test | npm start | npm stop | npm restart',
    '',
    'npx [-y] [-p <pkg>] <command|pkg[@range]> [args...]',
    ''
].join('\n');

/**
 * `npm` and `npx` implemented on the host: packages are fetched from the registry and
 * installed into the container's file system; bins run as node child processes.
 */
export class NpmProcess extends Process {
    private fileSystem: IFileSystem;

    constructor(
        pid: number,
        executablePath: string,
        args: string[],
        fileSystem: IFileSystem,
        parentPid?: number,
        cwd?: string
    ) {
        super(pid, ProcessType.JAVASCRIPT, executablePath, args, parentPid, cwd);
        this.fileSystem = fileSystem;
    }

    protected async execute(): Promise<void> {
        const registry = new NpmRegistry();
        const log = (line: string) => this.emitOutput(line + '\n');
        try {
            this._exitCode = this.executablePath === 'npx'
                ? await this.runNpx(registry, log)
                : await this.runNpm(registry, log);
        } catch (error: any) {
            this.emitError(`${error.message}\n`);
            this._exitCode = typeof error.exitCode === 'number' ? error.exitCode : 1;
        }
    }

    private async runNpm(registry: NpmRegistry, log: (line: string) => void): Promise<number> {
        const [command, ...rest] = this.args;
        switch (command) {
            case 'install':
            case 'i':
            case 'add':
                return this.install(rest, registry, log);
            case 'init':
                return this.init();
            case undefined:
            case 'help':
            case '--help':
            case '-h':
                this.emitOutput(USAGE);
                return 0;
            case '-v':
            case '--version':
                this.emitOutput(NPM_VERSION + '\n');
                return 0;
            case 'run':
            case 'run-script':
                return this.runScript(rest);
            case 'test':
            case 'start':
            case 'stop':
            case 'restart':
                return this.runScript(rest, LIFECYCLE_COMMANDS[command]);
            default:
                this.emitError(`Unknown command: "${command}"\n`);
                return 1;
        }
    }

    private async install(args: string[], registry: NpmRegistry, log: (line: string) => void): Promise<number> {
        let save: 'dependencies' | 'devDependencies' | 'none' = 'dependencies';
        const specs: InstallSpec[] = [];
        for (const arg of args) {
            if (arg === '-D' || arg === '--save-dev') save = 'devDependencies';
            else if (arg === '-P' || arg === '--save-prod' || arg === '-S' || arg === '--save') save = 'dependencies';
            else if (arg === '--no-save') save = 'none';
            else if (arg === '-g' || arg === '--global') throw new Error('Global installs are not supported by this runtime');
            else if (arg.startsWith('-')) continue;
            else specs.push(parseInstallSpec(arg));
        }

        const installer = new NpmInstaller(this.fileSystem, registry, log, (args, cwd, env) => this.runLifecycleScript(args, cwd, env));
        const started = performance.now();
        const report = specs.length > 0
            ? await installer.addPackages(this.cwd ?? '/', specs, save)
            : await installer.installManifest(this.cwd ?? '/');
        const seconds = ((performance.now() - started) / 1000).toFixed(1);
        if (report.added.length === 0) {
            this.emitOutput(`up to date in ${seconds}s\n`);
        } else {
            this.emitOutput(`\nadded ${report.added.length} package${report.added.length === 1 ? '' : 's'} in ${seconds}s\n`);
        }
        return 0;
    }

    /**
     * `npm run <script>` and the lifecycle commands: each script runs through the shell, in the
     * package directory, with every node_modules/.bin in front of PATH, and the status of the
     * script that fails is the status npm exits with.
     */
    private async runScript(args: string[], event?: string): Promise<number> {
        const { name, ifPresent, extra } = parseScriptArgs(args, event);
        const packageDir = findPackageRoot(this.fileSystem, this.cwd ?? '/') ?? normalizeAbsolute(this.cwd ?? '/');
        const manifest = readManifest(this.fileSystem, packageDir);
        if (manifest === undefined) {
            this.emitError(`npm error code ENOENT\nnpm error enoent Could not read package.json in ${packageDir}\n`);
            return 1;
        }
        const label = scriptLabel(manifest, packageDir);
        const scripts = (manifest.scripts ?? {}) as Record<string, unknown>;

        if (name === undefined) {
            this.emitOutput(scriptList(label, scripts));
            return 0;
        }
        if (typeof scripts[name] !== 'string') {
            if (ifPresent) return 0;
            this.emitError(missingScriptMessage(name));
            return 1;
        }

        const PATH = scriptPath(this.fileSystem, packageDir, Object.fromEntries(this.env).PATH);
        for (const step of scriptEvents(name, scripts)) {
            const command = String(scripts[step]);
            const line = scriptCommandLine(scripts, step, name, extra);
            this.emitOutput(scriptHeader(label, step, line));
            const result = await this.spawnChild('sh', ['-c', line], {
                ...Object.fromEntries(this.env),
                PATH,
                npm_package_name: String(manifest.name ?? ''),
                npm_package_version: String(manifest.version ?? ''),
                npm_package_json: joinPaths(packageDir, 'package.json'),
                npm_lifecycle_event: step
            }, packageDir);
            const exitCode = result.exitCode ?? 1;
            if (exitCode === 0) continue;
            this.emitError(scriptFailureMessage(label, step, command, exitCode));
            return exitCode;
        }
        return 0;
    }

    /** A lifecycle script runs as a node child in its package directory; its exit code decides whether the install fails. */
    private async runLifecycleScript(args: string[], cwd: string, env: Record<string, string>): Promise<ScriptRunResult> {
        const result = await this.spawnChild('node', args, { ...Object.fromEntries(this.env), ...env }, cwd);
        return { exitCode: result.exitCode ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
    }

    private init(): number {
        const dir = normalizeAbsolute(this.cwd ?? '/');
        const file = joinPaths(dir, 'package.json');
        if (this.fileSystem.statPath(file)?.type === 'file') {
            this.emitError(`npm init: package.json already exists in ${dir}\n`);
            return 1;
        }
        const name = dir.split('/').filter(Boolean).pop() || 'project';
        const manifest = {
            name,
            version: '1.0.0',
            description: '',
            main: 'index.js',
            scripts: { test: 'echo "Error: no test specified" && exit 1' },
            author: '',
            license: 'ISC'
        };
        this.fileSystem.writeFile(file, JSON.stringify(manifest, null, 2) + '\n');
        this.emitOutput(`Wrote to ${file}\n`);
        return 0;
    }

    private async runNpx(registry: NpmRegistry, log: (line: string) => void): Promise<number> {
        const args = [...this.args];
        let packageArg: string | undefined;
        while (args.length > 0 && args[0].startsWith('-')) {
            const flag = args.shift()!;
            if (flag === '-p' || flag === '--package') packageArg = args.shift();
        }
        const command = args.shift();
        const requested = packageArg ?? command;
        if (requested === undefined) throw new Error('npx: a command or package is required');

        // the command names the bin, so a version on it (npx cowsay@1) is stripped: the bin is `cowsay`
        const binName = parseInstallSpec(command ?? requested).name.split('/').pop()!;
        const cwd = this.cwd ?? '/';
        let shim = packageArg === undefined ? findLocalBinShim(this.fileSystem, cwd, binName) : undefined;

        if (shim === undefined) {
            const spec = parseInstallSpec(requested);
            const cacheDir = normalizeAbsolute(`/.npm/_npx/${hashString(requested)}`);
            const packageDir = joinPaths(cacheDir, 'node_modules', spec.name);
            if (this.fileSystem.statPath(packageDir)?.type !== 'dir') {
                log(`Need to install the following packages:\n${requested}`);
                const installer = new NpmInstaller(this.fileSystem, registry, log, (args, cwd, env) => this.runLifecycleScript(args, cwd, env));
                await installer.addPackages(cacheDir, [spec], 'none');
            }
            if (binFromPackage(this.fileSystem, packageDir, binName) === undefined) {
                throw new Error(`npx: could not find a bin named '${binName}' in ${spec.name}`);
            }
            shim = joinPaths(cacheDir, 'node_modules', '.bin', binName);
        }

        // the shim, not the target, runs: the program sees the name it was invoked by in argv[1]
        const result = await this.spawnChild('node', [shim, ...args], Object.fromEntries(this.env), cwd);
        return result.exitCode;
    }
}

/** The nearest node_modules/.bin/<name> shim from `startDir` upward. */
function findLocalBinShim(fileSystem: IFileSystem, startDir: string, name: string): string | undefined {
    let dir = normalizeAbsolute(startDir);
    while (true) {
        const shim = joinPaths(dir, 'node_modules', '.bin', name);
        if (fileSystem.statPath(shim)?.type === 'file') return shim;
        if (dir === '/') return undefined;
        dir = dirnameOf(dir);
    }
}

function binFromPackage(fileSystem: IFileSystem, packageDir: string, binName: string): string | undefined {
    const file = joinPaths(packageDir, 'package.json');
    if (fileSystem.statPath(file)?.type !== 'file') return undefined;
    const manifest = JSON.parse(fileSystem.readFile(file) ?? '{}');
    const bin = manifest.bin;
    if (typeof bin === 'string') return normalizeAbsolute(joinPaths(packageDir, bin));
    if (bin && typeof bin === 'object') {
        const entries = Object.entries(bin as Record<string, string>);
        const chosen = entries.find(([name]) => name === binName) ?? (entries.length === 1 ? entries[0] : undefined);
        if (chosen) return normalizeAbsolute(joinPaths(packageDir, chosen[1]));
    }
    return undefined;
}

/** Stable short key for a spec, used to name the npx cache directory. */
function hashString(text: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}
