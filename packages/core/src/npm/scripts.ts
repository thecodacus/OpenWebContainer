import { IFileSystem } from '../filesystem';
import { dirnameOf, joinPaths, normalizeAbsolute } from '../process/executors/node/runtime/resolver';

/**
 * What `npm run` and the lifecycle commands share: where the package is, which of its scripts a
 * command runs and in what order, and the PATH a script sees. The npm process and the synchronous
 * shell in the guest both answer a script through these, so a script behaves the same in both.
 */

/** The lifecycle commands that run one script of the package's own, and the script each names. */
export const LIFECYCLE_COMMANDS: Record<string, string> = {
    test: 'test',
    start: 'start',
    stop: 'stop',
    restart: 'restart'
};

/** The npm version this runtime answers `--version` with. */
export const NPM_VERSION = '10.9.0';

export interface ParsedScriptArgs {
    /** The script to run: the one the lifecycle command names, or the first bare word of the line. */
    name?: string;
    ifPresent: boolean;
    /** Words after the script name, or after `--`, which npm appends to the script's command. */
    extra: string[];
}

/** Reads `npm run [name] [-- args]` and the same words behind `npm test`: flags belong to npm, `--` starts the script's. */
export function parseScriptArgs(args: string[], event?: string): ParsedScriptArgs {
    let name = event;
    let ifPresent = false;
    const extra: string[] = [];
    let passthrough = false;
    for (const arg of args) {
        if (passthrough) extra.push(arg);
        else if (arg === '--') passthrough = true;
        else if (arg === '--if-present') ifPresent = true;
        else if (arg.startsWith('-') && arg !== '-') continue;
        else if (name === undefined) name = arg;
        else extra.push(arg);
    }
    return { name, ifPresent, extra };
}

/** The nearest directory holding a package.json, at or above `startDir`: the package npm acts on. */
export function findPackageRoot(fileSystem: IFileSystem, startDir: string): string | undefined {
    let dir = normalizeAbsolute(startDir);
    while (true) {
        if (fileSystem.statPath(joinPaths(dir, 'package.json'))?.type === 'file') return dir;
        if (dir === '/') return undefined;
        dir = dirnameOf(dir);
    }
}

export function readManifest(fileSystem: IFileSystem, dir: string): Record<string, any> | undefined {
    const file = joinPaths(dir, 'package.json');
    if (fileSystem.statPath(file)?.type !== 'file') return undefined;
    try {
        return JSON.parse(fileSystem.readFile(file) ?? '');
    } catch {
        return undefined;
    }
}

/** npm puts every node_modules/.bin at or above the package in front of PATH, so a script runs the bins of its tree by name. */
export function binPathDirectories(fileSystem: IFileSystem, packageDir: string): string[] {
    const dirs: string[] = [];
    let dir = normalizeAbsolute(packageDir);
    while (true) {
        const bin = joinPaths(dir, 'node_modules', '.bin');
        if (fileSystem.statPath(bin)?.type === 'dir') dirs.push(bin);
        if (dir === '/') return dirs;
        dir = dirnameOf(dir);
    }
}

/** PATH for a script: the bins of the tree first, then what the caller already had. */
export function scriptPath(fileSystem: IFileSystem, packageDir: string, PATH: string | undefined): string {
    return [...binPathDirectories(fileSystem, packageDir), PATH ?? '/bin:/usr/bin'].join(':');
}

/** `name@version`, as npm heads each script it runs; a package with no name keeps its directory's. */
export function scriptLabel(manifest: Record<string, any>, packageDir: string): string {
    const name = typeof manifest.name === 'string' ? manifest.name : packageDir.split('/').filter(Boolean).pop() ?? 'project';
    return `${name}@${manifest.version ?? ''}`;
}

/** The scripts one command runs, in order: `pre<name>`, the script, `post<name>`. */
export function scriptEvents(name: string, scripts: Record<string, unknown>): string[] {
    /* npm restart has no script of its own to fall back on: it stops the project and starts it. */
    const events = name === 'restart' && typeof scripts.restart !== 'string'
        ? ['prestop', 'stop', 'poststop', 'prestart', 'start', 'poststart']
        : [`pre${name}`, name, `post${name}`];
    return events.filter((event) => typeof scripts[event] === 'string');
}

/** The line one event runs: the script, with the run's extra words on the script that was named. */
export function scriptCommandLine(scripts: Record<string, unknown>, event: string, name: string, extra: string[]): string {
    return [String(scripts[event]), ...(event === name ? extra : [])].join(' ');
}

/** `npm error` lines for a script the package does not have, as npm prints them. */
export function missingScriptMessage(name: string): string {
    return `npm error Missing script: "${name}"\n\nnpm error To see a list of scripts, run:\nnpm error   npm run\n`;
}

/** What `npm run` prints when no script is named. */
export function scriptList(label: string, scripts: Record<string, unknown>): string {
    const lines = [`Scripts available in ${label} via \`npm run-script\`:`];
    for (const [name, command] of Object.entries(scripts)) {
        if (typeof command !== 'string') continue;
        lines.push(`  ${name}`, `    ${command}`);
    }
    return lines.join('\n') + '\n';
}

/** The header npm prints above each script it is about to run. */
export function scriptHeader(label: string, event: string, line: string): string {
    return `\n> ${label} ${event}\n> ${line}\n`;
}

/** The `npm error` block of a script that failed, carrying the status npm exits with. */
export function scriptFailureMessage(label: string, event: string, command: string, exitCode: number): string {
    return `npm error code ELIFECYCLE\nnpm error errno ${exitCode}\n` +
        `npm error ${label} ${event}: \`${command}\`\nnpm error Exit status ${exitCode}\n`;
}
