import { IFileSystem } from '../filesystem';
import { dirnameOf, joinPaths } from '../process/executors/node/runtime/resolver';
import { PlatformFields, platformMismatch } from './platform';

/** A native file this runtime loads instead of executing: a Node-API add-on or a shared library. */
const LOADABLE_SUFFIXES = ['.node', '.so', '.dylib', '.dll'];

/** Files read while looking for one executable: enough for any platform package, and a bound on the walk. */
const SCAN_BUDGET = 2000;

/**
 * The native executable a package's install script has to run, or undefined when it needs none.
 *
 * npm places the platform package a package lists in its optionalDependencies beside the JavaScript
 * that drives it: esbuild pulls `@esbuild/linux-x64` here, and that package is one real executable.
 * The install script of the package that pulled it in is what validates and runs that binary, and
 * this container executes JavaScript only, so no way of running the script makes it succeed. The
 * install names the binary and refuses, rather than failing inside a postinstall nobody reads.
 */
export function nativeExecutable(
    fileSystem: IFileSystem,
    packageDir: string,
    manifest: Record<string, any>
): string | undefined {
    for (const name of dependencyNames(manifest)) {
        const dir = platformPackageDir(fileSystem, packageDir, name);
        if (dir === undefined) continue;
        const binary = executableIn(fileSystem, dir);
        if (binary !== undefined) return binary;
    }
    return undefined;
}

/** The packages `manifest` names as dependencies, optional ones first: npm selects those by platform. */
function dependencyNames(manifest: Record<string, any>): string[] {
    const names = new Set<string>();
    for (const field of ['optionalDependencies', 'dependencies'] as const) {
        for (const name of Object.keys((manifest[field] ?? {}) as Record<string, string>)) names.add(name);
    }
    return [...names];
}

/** The os, cpu and libc fields: what makes npm install a package for one platform alone. */
function platformFields(manifest: Record<string, any>): PlatformFields | undefined {
    const fields: PlatformFields = {};
    if (manifest.os !== undefined) fields.os = manifest.os;
    if (manifest.cpu !== undefined) fields.cpu = manifest.cpu;
    if (manifest.libc !== undefined) fields.libc = manifest.libc;
    if (fields.os === undefined && fields.cpu === undefined && fields.libc === undefined) return undefined;
    return fields;
}

/**
 * Where npm installed `name` as seen from `packageDir`, when that copy is the one this platform
 * selects: a copy whose own fields exclude this container never carries its binary here.
 */
function platformPackageDir(fileSystem: IFileSystem, packageDir: string, name: string): string | undefined {
    let dir = packageDir;
    while (true) {
        if (!dir.endsWith('/node_modules')) {
            const candidate = joinPaths(dir, 'node_modules', name);
            const manifest = readManifest(fileSystem, candidate);
            if (manifest !== undefined) {
                const fields = platformFields(manifest);
                return fields !== undefined && platformMismatch(fields) === undefined ? candidate : undefined;
            }
        }
        if (dir === '/') return undefined;
        dir = dirnameOf(dir);
    }
}

/** The first executable under `dir`, or undefined: add-ons and shared libraries are loaded, not run. */
function executableIn(fileSystem: IFileSystem, dir: string): string | undefined {
    let budget = SCAN_BUDGET;
    const pending: string[] = [dir];
    while (pending.length > 0 && budget > 0) {
        const current = pending.pop() as string;
        for (const name of fileSystem.readdirNames(current) ?? []) {
            if (name === 'node_modules') continue;
            const path = joinPaths(current, name);
            const type = fileSystem.statPath(path)?.type;
            if (type === 'dir') {
                pending.push(path);
            } else if (type === 'file' && !LOADABLE_SUFFIXES.some((suffix) => path.endsWith(suffix))) {
                budget -= 1;
                if (isExecutable(fileSystem.readBytes(path))) return path;
            }
        }
    }
    return undefined;
}

/** ELF, Mach-O and PE: the executables a JavaScript runtime cannot run. */
function isExecutable(bytes: Uint8Array | undefined): boolean {
    if (bytes === undefined || bytes.length < 4) return false;
    if (bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) return true;
    if (bytes[0] === 0x4d && bytes[1] === 0x5a) return true;
    const macho = [[0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], [0xce, 0xfa, 0xed, 0xfe], [0xcf, 0xfa, 0xed, 0xfe]];
    return macho.some((magic) => magic.every((byte, index) => bytes[index] === byte));
}

function readManifest(fileSystem: IFileSystem, dir: string): Record<string, any> | undefined {
    const file = joinPaths(dir, 'package.json');
    if (fileSystem.statPath(file)?.type !== 'file') return undefined;
    try {
        return JSON.parse(fileSystem.readFile(file) ?? '');
    } catch {
        return undefined;
    }
}
