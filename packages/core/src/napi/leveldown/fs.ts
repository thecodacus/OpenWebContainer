/**
 * The filesystem the leveldown and rocksdb shims persist through.
 *
 * A real add-on reaches the disk through leveldb::Env; the guest has no such thing, so the host hands
 * the shim this interface when it calls createAddon(). It is deliberately narrower than node:fs --
 * six operations, byte arrays in and out, no encodings, no streams, no file descriptors -- because a
 * shim bundled for QuickJS cannot use node:fs itself and because every operation the shim needs has
 * to be one the host can answer from the virtual filesystem.
 *
 * Contract:
 *  - Paths are absolute, already resolved against the guest's cwd.
 *  - read() returns undefined for a missing file. Any other failure throws; the shim lets it throw.
 *  - write() replaces the file's whole contents, creating it (and failing if a parent is missing).
 *  - append() creates the file when it is absent and otherwise adds to the end.
 *  - rename() replaces the destination; it is the shim's atomic replace, used to swap a rewritten
 *    log into place. The host must not leave a window in which the destination is missing.
 *  - unlink() on a missing file is not an error.
 *  - mkdir() creates the directory and any missing parent; an existing directory is not an error.
 *  - readdir() returns the entry names (not paths), or undefined when the directory is absent.
 *  - stat() returns the kind of an existing path, or undefined when nothing is there.
 */
export type NapiFileType = 'file' | 'dir';

export interface NapiFileSystem {
    read(path: string): Uint8Array | undefined;
    write(path: string, bytes: Uint8Array): void;
    append(path: string, bytes: Uint8Array): void;
    rename(from: string, to: string): void;
    unlink(path: string): void;
    mkdir(path: string): void;
    /** Removes an empty directory; used by destroy_db once it has taken our files. */
    rmdir(path: string): void;
    readdir(path: string): string[] | undefined;
    stat(path: string): NapiFileType | undefined;
}

/** The options createAddon() takes: the filesystem, and the Buffer constructor of the guest. */
export interface NapiAddonOptions {
    fs: NapiFileSystem;
    Buffer: BufferConstructorLike;
}

export interface BufferConstructorLike {
    from(data: ArrayBuffer, byteOffset?: number, length?: number): Uint8Array;
}
