import { IFileSystem } from '../../../../filesystem';

export type ResolveMode = 'require' | 'import';

const FILE_EXTENSIONS = ['.js', '.json', '.cjs', '.mjs'];
const INDEX_FILES = ['index.js', 'index.json', 'index.cjs', 'index.mjs'];

/** The source with block and whole-line comments blanked (newlines kept), so prose such as "export function" in a comment does not read as module syntax. */
function withoutComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
        .replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * Node-style module resolution over the virtual file system. Used by both the
 * CommonJS loader inside the guest (through the host bridge) and the ES module
 * loader of the QuickJS runtime, so both follow the same algorithm.
 */
export class NodeResolver {
    constructor(private fileSystem: IFileSystem) { }

    resolve(specifier: string, fromDir: string, mode: ResolveMode): string | undefined {
        if (specifier.startsWith('/')) {
            return this.resolveAsPath(normalizeAbsolute(specifier), mode, mode === 'import');
        }
        if (isRelativeSpecifier(specifier)) {
            return this.resolveAsPath(normalizeAbsolute(joinPaths(fromDir, specifier)), mode, mode === 'import');
        }
        if (specifier.startsWith('#')) {
            return this.resolveImportsField(specifier, fromDir, mode);
        }
        return this.resolvePackage(specifier, fromDir, mode);
    }

    /** `#name` specifiers resolve through the "imports" map of the nearest package.json. */
    private resolveImportsField(specifier: string, fromDir: string, mode: ResolveMode): string | undefined {
        let dir = normalizeAbsolute(fromDir);
        while (true) {
            const pkg = this.readPackageJson(dir);
            if (pkg) {
                const target = resolveImportsTarget(pkg.imports, specifier, mode);
                if (target === undefined) return undefined;
                const resolved = normalizeAbsolute(joinPaths(dir, target));
                return this.fileSystem.statPath(resolved)?.type === 'file' ? resolved : this.resolveAsPath(resolved, mode);
            }
            if (dir === '/') return undefined;
            dir = dirnameOf(dir);
        }
    }

    isESM(file: string): boolean {
        if (file.endsWith('.mjs')) return true;
        if (file.endsWith('.cjs') || file.endsWith('.json')) return false;
        if (!file.endsWith('.js')) return false;
        const packageType = this.nearestPackageType(dirnameOf(file));
        if (packageType === 'module') return true;
        if (packageType === 'commonjs') return false;
        const code = withoutComments(this.fileSystem.readFile(file) ?? '');
        return /^\s*(?:import\s+[\w{*'"]|export\s+[\w{*])/m.test(code)
            || /^(?:await\s|(?:const|let|var)\s+[^=\n]+=\s*await\s)/m.test(code);
    }

    /**
     * Resolves a path as a file. `exactOnly` is the ESM rule for a relative or absolute specifier:
     * the path names the file itself, so no extension is added, no directory index is read and no
     * "main" is consulted -- the same specifier that Node would fail to find fails here too.
     */
    private resolveAsPath(target: string, mode: ResolveMode, exactOnly = false): string | undefined {
        const direct = this.fileSystem.statPath(target);
        if (direct?.type === 'file') return target;
        if (exactOnly) return undefined;
        for (const ext of FILE_EXTENSIONS) {
            if (this.fileSystem.statPath(target + ext)?.type === 'file') return target + ext;
        }
        if (direct?.type === 'dir') {
            const pkg = this.readPackageJson(target);
            if (typeof pkg?.main === 'string') {
                const fromMain = this.resolveMain(target, pkg.main, mode);
                if (fromMain) return fromMain;
            }
            for (const index of INDEX_FILES) {
                const candidate = joinPaths(target, index);
                if (this.fileSystem.statPath(candidate)?.type === 'file') return candidate;
            }
        }
        return undefined;
    }

    private resolveMain(dir: string, main: string, mode: ResolveMode): string | undefined {
        const target = normalizeAbsolute(joinPaths(dir, main));
        const found = this.resolveAsPath(target, mode);
        if (found) return found;
        return undefined;
    }

    private resolvePackage(specifier: string, fromDir: string, mode: ResolveMode): string | undefined {
        const { name, subpath } = splitPackageSpecifier(specifier);
        let dir = normalizeAbsolute(fromDir);
        while (true) {
            if (!dir.endsWith('/node_modules')) {
                const packageDir = joinPaths(dir, 'node_modules', name);
                if (this.fileSystem.statPath(packageDir)?.type === 'dir') {
                    return this.resolvePackageDirectory(packageDir, subpath, mode);
                }
            }
            if (dir === '/') return undefined;
            dir = dirnameOf(dir);
        }
    }

    private resolvePackageDirectory(packageDir: string, subpath: string, mode: ResolveMode): string | undefined {
        const pkg = this.readPackageJson(packageDir);
        if (pkg && pkg.exports !== undefined) {
            const target = resolveExportsTarget(pkg.exports, subpath, mode);
            if (target === undefined) return undefined;
            const resolved = normalizeAbsolute(joinPaths(packageDir, target));
            if (this.fileSystem.statPath(resolved)?.type === 'file') return resolved;
            return this.resolveAsPath(resolved, mode);
        }
        if (subpath === '.') return this.resolveAsPath(packageDir, mode);
        return this.resolveAsPath(normalizeAbsolute(joinPaths(packageDir, subpath)), mode);
    }

    private readPackageJson(dir: string): Record<string, any> | undefined {
        const file = joinPaths(dir, 'package.json');
        if (this.fileSystem.statPath(file)?.type !== 'file') return undefined;
        try {
            return JSON.parse(this.fileSystem.readFile(file) ?? '');
        } catch {
            return undefined;
        }
    }

    private nearestPackageType(dir: string): string | undefined {
        let current = normalizeAbsolute(dir);
        while (true) {
            const pkg = this.readPackageJson(current);
            if (pkg) return typeof pkg.type === 'string' ? pkg.type : undefined;
            if (current === '/') return undefined;
            current = dirnameOf(current);
        }
    }
}

function isRelativeSpecifier(specifier: string): boolean {
    return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
}

export function splitPackageSpecifier(specifier: string): { name: string; subpath: string } {
    const parts = specifier.split('/');
    const nameParts = specifier.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1);
    const rest = parts.slice(nameParts.length);
    return {
        name: nameParts.join('/'),
        subpath: rest.length ? './' + rest.join('/') : '.'
    };
}

/**
 * Picks the export target for a subpath following package.json "exports":
 * conditions are matched in object order against require/import, node and default.
 */
export function resolveExportsTarget(exportsField: unknown, subpath: string, mode: ResolveMode): string | undefined {
    const conditions = mode === 'require' ? ['require', 'node', 'default'] : ['import', 'node', 'default'];
    const isSubpathMap = isPlainObject(exportsField) && Object.keys(exportsField).some(key => key.startsWith('.'));
    if (!isSubpathMap) {
        return subpath === '.' ? pickCondition(exportsField, conditions) : undefined;
    }
    const map = exportsField as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(map, subpath)) {
        return pickCondition(map[subpath], conditions);
    }
    for (const key of Object.keys(map)) {
        const star = key.indexOf('*');
        if (star < 0) continue;
        const prefix = key.slice(0, star);
        const suffix = key.slice(star + 1);
        if (subpath.length >= key.length - 1 && subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
            const matched = subpath.slice(prefix.length, subpath.length - suffix.length);
            const target = pickCondition(map[key], conditions);
            if (target !== undefined) return target.split('*').join(matched);
        }
    }
    return undefined;
}

/** Resolves a `#name` specifier against package.json "imports" (exact keys and `*` patterns). */
export function resolveImportsTarget(importsField: unknown, specifier: string, mode: ResolveMode): string | undefined {
    if (!isPlainObject(importsField)) return undefined;
    const conditions = mode === 'require' ? ['require', 'node', 'default'] : ['import', 'node', 'default'];
    const map = importsField;
    if (Object.prototype.hasOwnProperty.call(map, specifier)) {
        return pickCondition(map[specifier], conditions);
    }
    for (const key of Object.keys(map)) {
        const star = key.indexOf('*');
        if (star < 0) continue;
        const prefix = key.slice(0, star);
        const suffix = key.slice(star + 1);
        if (specifier.length >= key.length - 1 && specifier.startsWith(prefix) && specifier.endsWith(suffix)) {
            const matched = specifier.slice(prefix.length, specifier.length - suffix.length);
            const target = pickCondition(map[key], conditions);
            if (target !== undefined) return target.split('*').join(matched);
        }
    }
    return undefined;
}

function pickCondition(target: unknown, conditions: string[]): string | undefined {
    if (typeof target === 'string') return target.startsWith('./') ? target : undefined;
    if (Array.isArray(target)) {
        for (const entry of target) {
            const found = pickCondition(entry, conditions);
            if (found !== undefined) return found;
        }
        return undefined;
    }
    if (isPlainObject(target)) {
        for (const key of Object.keys(target)) {
            if (!conditions.includes(key)) continue;
            const found = pickCondition(target[key], conditions);
            if (found !== undefined) return found;
        }
    }
    return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function dirnameOf(path: string): string {
    const index = path.lastIndexOf('/');
    return index <= 0 ? '/' : path.slice(0, index);
}

export function joinPaths(...parts: string[]): string {
    return parts.filter(part => part.length > 0).join('/').replace(/\/+/g, '/');
}

export function normalizeAbsolute(path: string): string {
    const segments: string[] = [];
    for (const segment of path.split('/')) {
        if (segment === '' || segment === '.') continue;
        if (segment === '..') {
            segments.pop();
        } else {
            segments.push(segment);
        }
    }
    return '/' + segments.join('/');
}
