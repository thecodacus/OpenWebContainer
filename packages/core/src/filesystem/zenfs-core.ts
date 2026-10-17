import { fs, InMemoryStore, normalizePath, StoreFS } from '@zenfs/core';
import { IFileSystem, PathStat } from './types';

/**
 * Root mount for the container file system. ZenFS allocates each file as a resizable
 * ArrayBuffer reserving its maximum size; browsers exhaust that reservation after a few
 * hundred files (an npm install reaches it), so the root reports non-resizable buffers.
 */
class ContainerRootFS extends StoreFS {
    metadata() {
        return { ...super.metadata(), noResizableBuffers: true };
    }
}

let rootMounted = false;

function mountContainerRoot(): void {
    if (rootMounted) return;
    rootMounted = true;
    const root = new ContainerRootFS(new InMemoryStore('owc-root'));
    root.checkRootSync();
    fs.umount('/');
    fs.mount('/', root);
}

export class ZenFSCore implements IFileSystem {
    private fs: typeof fs;

    constructor() {
        mountContainerRoot();
        this.fs = fs;
    }
    readBuffer(path: string): Buffer | undefined {
        return this.fs.readFileSync(path);
    }
    writeBuffer(path: string, buffer: Buffer): void {
        return this.fs.writeFileSync(path, buffer);
    }
    normalizePath(path: string): string {
        return normalizePath(path);
    }

    writeFile(path: string, content: string): void {
        this.fs.writeFileSync(path, content,{encoding:'utf-8'});
    }

    readFile(path: string): string | undefined {
        return this.fs.readFileSync(path, 'utf-8');
    }

    deleteFile(path: string, recursive = false): void {
        this.fs.rmSync(path, {
            recursive
        });
    }

    listFiles(basePath:string="/"): string[] {
        const files = [];
        const items = fs.readdirSync(basePath, { withFileTypes: true });
        if (basePath.endsWith('/')) basePath = basePath.slice(0, -1);
        for (const item of items) {
            if (item.isDirectory()) {
                files.push(...this.listFiles(`${basePath}/${item.name}`));
            } else {
                files.push(`${basePath}/${item.name}`);
            }
        }

        return files;
    }

    resolvePath(path: string, basePath: string = ''): string {
        const normalizedPath = normalizePath(path);
        const normalizedBasePath = normalizePath(basePath);
        if (normalizedPath.startsWith('/')) {
            return normalizedPath;
        }
        return normalizedBasePath + '/' + normalizedPath;
    }

    fileExists(path: string): boolean {
        return this.fs.existsSync(path);
    }

    resolveModulePath(specifier: string, basePath: string = ''): string {
        const normalizedBasePath = normalizePath(basePath);

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
            resolvedPath = normalizePath(specifier);
        }

        // Check for file existence
        if (this.fs.existsSync(resolvedPath)) {
            let stat=this.fs.lstatSync(resolvedPath)
            if(stat.isFile()) return resolvedPath;
            else if (stat.isDirectory()){
                let indexPath=normalizePath(`${resolvedPath}/index`)
                let exts=['.js', '.mjs']
                exts.forEach(ext=>{
                    let withExt = `${indexPath}${ext}`;
                    if (this.fileExists(withExt)) {
                        return withExt;
                    }
                })
                
            }
        }

        for (const ext of ['.js', '.mjs']) {
            const withExt = `${resolvedPath}${ext}`;
            if (this.fileExists(withExt)) {
                return withExt;
            }
        }

        throw new Error(`Module not found: ${specifier} (resolved to ${resolvedPath})`);
    }

    createDirectory(path: string): void {
        this.fs.mkdirSync(path,{recursive:true});
    }

    deleteDirectory(path: string): void {
        this.fs.rmdirSync(path);
    }

    listDirectory(path: string): string[] {
        return this.fs.readdirSync(path);
    }

    isDirectory(path: string): boolean {
        return this.fs.lstatSync(path).isDirectory();
    }

    statPath(path: string): PathStat | undefined {
        if (!this.fs.existsSync(path)) return undefined;
        const stat = this.fs.statSync(path);
        return {
            type: stat.isDirectory() ? 'dir' : 'file',
            size: stat.size,
            mtimeMs: stat.mtimeMs
        };
    }

    readdirNames(path: string): string[] | undefined {
        if (!this.fs.existsSync(path) || !this.fs.statSync(path).isDirectory()) return undefined;
        return this.fs.readdirSync(path);
    }

    readBytes(path: string): Uint8Array | undefined {
        if (!this.fs.existsSync(path) || this.fs.statSync(path).isDirectory()) return undefined;
        return new Uint8Array(this.fs.readFileSync(path));
    }

    writeBytes(path: string, data: Uint8Array): void {
        this.fs.writeFileSync(path, data);
    }

    removePath(path: string, recursive = false): void {
        this.fs.rmSync(path, { recursive, force: false });
    }

    renamePath(from: string, to: string): void {
        this.fs.renameSync(from, to);
    }
}
