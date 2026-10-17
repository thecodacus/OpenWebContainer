import { IFileSystem, PathStat } from './types';

export class VirtualFileSystem implements IFileSystem {
    private files: Map<string, string>;
    private directories: Set<string>;

    constructor() {
        this.files = new Map();
        this.directories = new Set();
        this.directories.add('/'); // Root directory
    }
    readBuffer(path: string): Buffer | undefined {
        throw new Error('Method not implemented.');
    }
    writeBuffer(path: string, buffer: Buffer): void {
        throw new Error('Method not implemented.');
    }

    normalizePath(path: string): string {
        let normalized = path.replace(/\\/g, '/');
        if (!normalized.startsWith('/')) {
            normalized = '/' + normalized;
        }
        return normalized.replace(/\/+/g, '/');
    }

    private getDirectoryPath(path: string): string {
        return this.normalizePath(path.split('/').slice(0, -1).join('/'));
    }

    createDirectory(path: string): void {
        const normalizedPath = this.normalizePath(path);
        if (this.files.has(normalizedPath)) {
            throw new Error(`File exists at path: ${path}`);
        }

        // Create parent directories if they don't exist
        const parentPath = this.getDirectoryPath(normalizedPath);
        if (parentPath !== '/' && !this.directories.has(parentPath)) {
            this.createDirectory(parentPath);
        }

        this.directories.add(normalizedPath);
    }

    deleteDirectory(path: string): void {
        const normalizedPath = this.normalizePath(path);
        if (!this.directories.has(normalizedPath)) {
            throw new Error(`Directory not found: ${path}`);
        }
        if (this.listDirectory(normalizedPath).length > 0) {
            throw new Error(`Directory not empty: ${path}`);
        }
        this.directories.delete(normalizedPath);
    }

    listDirectory(path: string): string[] {
        const normalizedPath = this.normalizePath(path);
        if (!this.directories.has(normalizedPath)) {
            throw new Error(`Directory not found: ${path}`);
        }

        const entries = new Set<string>();

        // Add subdirectories
        for (const dir of this.directories) {
            if (dir !== normalizedPath && dir.startsWith(normalizedPath)) {
                const relativePath = dir.slice(normalizedPath.length + 1);
                const topLevel = relativePath.split('/')[0];
                if (topLevel) {
                    entries.add(topLevel + '/');
                }
            }
        }

        // Add files
        for (const file of this.files.keys()) {
            if (file.startsWith(normalizedPath)) {
                const relativePath = file.slice(normalizedPath.length);
                const topLevel = relativePath.split('/')[0];
                if (topLevel) {
                    entries.add(topLevel);
                }
            }
        }

        return Array.from(entries).sort();
    }

    isDirectory(path: string): boolean {
        return this.directories.has(this.normalizePath(path));
    }

    writeFile(path: string, content: string): void {
        const normalizedPath = this.normalizePath(path);
        const dirPath = this.getDirectoryPath(normalizedPath);

        if (!this.directories.has(dirPath)) {
            this.createDirectory(dirPath);
        }

        this.files.set(normalizedPath, content);
    }

    readFile(path: string): string | undefined {
        return this.files.get(this.normalizePath(path));
    }

    deleteFile(path: string, recursive = false): void {
        const normalizedPath = this.normalizePath(path);
        if (!this.files.has(normalizedPath)) {
            throw new Error(`File not found: ${path}`);
        }
        this.files.delete(normalizedPath);
    }

    listFiles(): string[] {
        return Array.from(this.files.keys());
    }

    resolvePath(path: string, basePath: string = ''): string {
        const normalizedPath = this.normalizePath(path);
        const normalizedBasePath = this.normalizePath(basePath);
        if (normalizedPath.startsWith('/')) {
            return normalizedPath;
        }
        return normalizedBasePath + '/' + normalizedPath;
    }
    fileExists(path: string): boolean {
        const normalizedPath = this.normalizePath(path);
        return this.files.has(normalizedPath);
    }

    resolveModulePath(specifier: string, basePath: string = ''): string {
        const normalizedBasePath = this.normalizePath(basePath);

        let resolvedPath: string;

        if (specifier.startsWith('./') || specifier.startsWith('../')) {
            const baseDir = normalizedBasePath.endsWith('/') ?
                normalizedBasePath :
                normalizedBasePath + '/';

            // Split paths into segments and handle .. navigation
            const baseSegments = baseDir.split('/').filter(Boolean);
            const specSegments = specifier.split('/').filter(Boolean);

            const resultSegments = [...baseSegments];

            for (const segment of specSegments) {
                if (segment === '..') {
                    if (resultSegments.length === 0) {
                        throw new Error(`Invalid path: ${specifier} goes beyond root from ${basePath}`);
                    }
                    resultSegments.pop();
                } else if (segment !== '.') {
                    resultSegments.push(segment);
                }
            }

            resolvedPath = '/' + resultSegments.join('/');
        } else {
            resolvedPath = this.normalizePath(specifier);
        }

        // Check for file existence
        if (this.files.has(resolvedPath)) {
            return resolvedPath;
        }

        for (const ext of ['.js', '.mjs']) {
            const withExt = `${resolvedPath}${ext}`;
            if (this.files.has(withExt)) {
                return withExt;
            }
        }

        throw new Error(`Module not found: ${specifier} (resolved to ${resolvedPath})`);
    }

    statPath(path: string): PathStat | undefined {
        const normalizedPath = this.normalizePath(path);
        if (this.directories.has(normalizedPath)) {
            return { type: 'dir', size: 0, mtimeMs: 0 };
        }
        const content = this.files.get(normalizedPath);
        if (content === undefined) return undefined;
        return { type: 'file', size: content.length, mtimeMs: 0 };
    }

    readdirNames(path: string): string[] | undefined {
        if (!this.directories.has(this.normalizePath(path))) return undefined;
        return this.listDirectory(path).map(entry => entry.replace(/\/$/, ''));
    }

    readBytes(path: string): Uint8Array | undefined {
        throw new Error('Method not implemented.');
    }

    writeBytes(path: string, data: Uint8Array): void {
        throw new Error('Method not implemented.');
    }

    removePath(path: string, recursive = false): void {
        const normalizedPath = this.normalizePath(path);
        if (this.files.has(normalizedPath)) {
            this.files.delete(normalizedPath);
            return;
        }
        if (!this.directories.has(normalizedPath)) {
            throw new Error(`Path not found: ${path}`);
        }
        if (!recursive) {
            this.deleteDirectory(normalizedPath);
            return;
        }
        const prefix = normalizedPath === '/' ? '/' : normalizedPath + '/';
        for (const file of Array.from(this.files.keys())) {
            if (file.startsWith(prefix)) this.files.delete(file);
        }
        for (const dir of Array.from(this.directories)) {
            if (dir === normalizedPath || dir.startsWith(prefix)) this.directories.delete(dir);
        }
    }

    renamePath(from: string, to: string): void {
        const source = this.normalizePath(from);
        const content = this.files.get(source);
        if (content === undefined) {
            throw new Error(`File not found: ${from}`);
        }
        this.files.delete(source);
        this.writeFile(to, content);
    }
}
