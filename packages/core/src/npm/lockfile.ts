import { IFileSystem } from '../filesystem';
import { joinPaths, normalizeAbsolute } from '../process/executors/node/runtime/resolver';

/** The layout this runtime writes: npm 7+ (no `dependencies` block, `packages` keyed by path). */
export const LOCKFILE_VERSION = 3;

/** One package of the installed tree, as the lockfile records it. */
export interface LockTreeNode {
    /** The lockfile key: the package directory relative to the project root, `node_modules/a/node_modules/b`. */
    key: string;
    version: string;
    /** The tarball URL and integrity the registry gave for this version; absent when only the tree is known. */
    resolved?: string;
    integrity?: string;
    /** Reached only through devDependencies. */
    dev: boolean;
    /** Reached through an optionalDependencies entry. */
    optional: boolean;
    manifest: Record<string, any>;
}

interface LockPackage {
    resolved?: string;
    integrity?: string;
    [field: string]: unknown;
}

/**
 * Writes `package-lock.json` for the installed tree.
 *
 * A node the tree already carried keeps the `resolved` and `integrity` of the lockfile being
 * replaced, so a second install does not spend a registry request to re-derive what the last
 * one already recorded.
 */
export function writeLockfile(
    fileSystem: IFileSystem,
    root: string,
    rootManifest: Record<string, any>,
    nodes: LockTreeNode[]
): void {
    const previous = readLockfile(fileSystem, root);
    const packages: Record<string, LockPackage> = { '': rootEntry(rootManifest) };
    for (const node of nodes) {
        packages[node.key] = packageEntry(node, previous.packages?.[node.key]);
    }
    /* The lockfile is the whole tree, not what this run added: a package already installed and not
       touched here stays, with the resolved and integrity the lockfile being replaced recorded. */
    for (const key of installedKeys(fileSystem, root)) {
        if (packages[key] !== undefined) continue;
        const manifest = readManifest(fileSystem, joinPaths(root, key));
        const entry = packageEntry(
            {
                key,
                version: asString(manifest?.version) ?? asString(previous.packages?.[key]?.version) ?? '',
                dev: previous.packages?.[key]?.dev === true,
                optional: previous.packages?.[key]?.optional === true,
                manifest: manifest ?? {}
            },
            previous.packages?.[key]
        );
        packages[key] = entry;
    }
    const lockfile: Record<string, unknown> = {
        lockfileVersion: LOCKFILE_VERSION,
        requires: true,
        packages: sortPackages(packages)
    };
    const name = asString(rootManifest.name);
    const version = asString(rootManifest.version);
    if (name !== undefined) lockfile.name = name;
    if (version !== undefined) lockfile.version = version;
    /* name and version lead the file, the way they lead npm's own: the object is rebuilt so the
       printed order is the order a reader of an npm lockfile expects. */
    const ordered: Record<string, unknown> = {};
    for (const field of ['name', 'version', 'lockfileVersion', 'requires', 'packages']) {
        if (lockfile[field] !== undefined) ordered[field] = lockfile[field];
    }
    fileSystem.writeFile(joinPaths(root, 'package-lock.json'), JSON.stringify(ordered, null, 2) + '\n');
}

/** The `""` entry: what the project's own package.json declares. */
function rootEntry(manifest: Record<string, any>): LockPackage {
    const entry: LockPackage = {};
    for (const field of ['name', 'version', 'license', 'engines', 'bin', 'dependencies', 'devDependencies', 'optionalDependencies']) {
        if (manifest[field] !== undefined) entry[field] = manifest[field];
    }
    return entry;
}

function packageEntry(node: LockTreeNode, previous: LockPackage | undefined): LockPackage {
    const manifest = node.manifest ?? {};
    const entry: LockPackage = { version: node.version };
    const resolved = node.resolved ?? asString(previous?.resolved);
    const integrity = node.integrity ?? asString(previous?.integrity);
    if (resolved !== undefined) entry.resolved = resolved;
    if (integrity !== undefined) entry.integrity = integrity;
    if (node.dev) entry.dev = true;
    if (node.optional) entry.optional = true;
    if (hasInstallScript(manifest)) entry.hasInstallScript = true;
    /* the order npm writes the fields in, so a lockfile this runtime writes reads like npm's own */
    for (const field of [
        'license', 'os', 'cpu', 'libc', 'bin',
        'dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta',
        'engines'
    ]) {
        if (manifest[field] !== undefined) entry[field] = manifest[field];
    }
    /* npm records `funding: "<url>"` the way it normalizes a manifest: as `{ url: "<url>" }`. */
    const funding = fundingEntry(manifest.funding);
    if (funding !== undefined) entry.funding = funding;
    return entry;
}

function fundingEntry(value: unknown): unknown {
    if (typeof value === 'string') return { url: value };
    if (Array.isArray(value)) return value.map(fundingEntry);
    return value === undefined ? undefined : value;
}

/** npm records that a package has to be built, so a later install knows to run its scripts. */
function hasInstallScript(manifest: Record<string, any>): boolean {
    const scripts = manifest.scripts;
    if (scripts === undefined || typeof scripts !== 'object') return false;
    for (const event of ['preinstall', 'install', 'postinstall']) {
        if (typeof (scripts as Record<string, unknown>)[event] === 'string') return true;
    }
    return false;
}

/** The lockfile key of a package directory: its path relative to the project root. */
export function lockKey(root: string, dir: string): string {
    const base = normalizeAbsolute(root);
    const target = normalizeAbsolute(dir);
    if (target === base) return '';
    return target.startsWith(base + '/') ? target.slice(base.length + 1) : target;
}

/** Every package installed under the project root, as lockfile keys: the whole tree, nested copies included. */
function installedKeys(fileSystem: IFileSystem, root: string): string[] {
    const keys: string[] = [];
    const walk = (dir: string): void => {
        let names: string[];
        try {
            names = fileSystem.listDirectory(dir);
        } catch {
            return;
        }
        for (const name of names) {
            if (name === '.bin') continue;
            const child = joinPaths(dir, name);
            // a scope holds packages, not one itself
            if (name.startsWith('@')) {
                walk(child);
                continue;
            }
            if (fileSystem.statPath(joinPaths(child, 'package.json'))?.type === 'file') keys.push(lockKey(root, child));
            walk(joinPaths(child, 'node_modules'));
        }
    };
    walk(joinPaths(root, 'node_modules'));
    return keys;
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

function readLockfile(fileSystem: IFileSystem, root: string): { packages?: Record<string, LockPackage> } {
    const file = joinPaths(root, 'package-lock.json');
    if (fileSystem.statPath(file)?.type !== 'file') return {};
    try {
        const parsed = JSON.parse(fileSystem.readFile(file) ?? '{}');
        return parsed !== null && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

/** `""` first, then the paths in the order npm sorts them. */
function sortPackages(packages: Record<string, LockPackage>): Record<string, LockPackage> {
    const sorted: Record<string, LockPackage> = {};
    for (const key of Object.keys(packages).sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))) {
        sorted[key] = packages[key];
    }
    return sorted;
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}
