import { IFileSystem } from '../filesystem';
import { dirnameOf, joinPaths } from '../process/executors/node/runtime/resolver';
import { NAPI_SHIMS } from './registry';

/**
 * Writes the placeholder add-on files of a package the installer has just placed: one at every path in
 * NAPI_SHIMS where its binary loader probes, unless the package ships a file there. A placeholder is never
 * executed; process.dlopen serves the shim instead. Returns the files written.
 */
export function writeNapiPlaceholders(fileSystem: IFileSystem, packageDir: string, packageName: string): string[] {
    const written: string[] = [];
    for (const shim of NAPI_SHIMS) {
        if (!Object.prototype.hasOwnProperty.call(shim.packages, packageName)) continue;
        for (const relative of shim.packages[packageName]) {
            const file = joinPaths(packageDir, relative);
            if (fileSystem.statPath(file)) continue;
            fileSystem.createDirectory(dirnameOf(file));
            fileSystem.writeFile(file, `OWC Node-API placeholder: process.dlopen serves this add-on from owc:internal/napi/${shim.name}.\n`);
            written.push(file);
        }
    }
    return written;
}
