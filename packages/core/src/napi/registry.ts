/**
 * Node-API add-ons the guest serves from JavaScript shims. Native code cannot run in the guest, so
 * process.dlopen (and require of a .node file) looks the add-on up here: a file whose basename is in
 * `binaries`, or any add-on file inside a package named in `packages`, gets the exports of the shim's
 * createAddon(). Anything else fails with ERR_DLOPEN_FAILED, as dlopen fails in Node.
 *
 * A shim is src/napi/<name>/index.ts exporting createAddon(): object, the add-on's exports, built only from
 * pure JavaScript (no WebAssembly, Node built-ins or native code). scripts/build-napi-guest.mjs bundles it
 * into the guest module guest/modules/napi-<name>.ts, served as 'owc:internal/napi/<name>' and compiled on
 * first use. Adding a shim: an entry here, then `node scripts/build-napi-guest.mjs` in packages/core.
 *
 * `packages` maps each package to the paths, relative to its directory, where the package's binary loader
 * (node-pre-gyp, bindings, node-gyp-build) looks for the add-on, read from that package's own source. The
 * installer writes a placeholder file at each of them that the package does not ship, so the loader's
 * existence checks succeed and its require reaches process.dlopen.
 */
export interface NapiShim {
    /** The shim directory under src/napi, and the guest module owc:internal/napi/<name>. */
    name: string;
    /** Add-on file basenames served by this shim wherever the file is. */
    binaries: readonly string[];
    /** Package name to the add-on paths its binary loader probes, relative to the package directory. */
    packages: Readonly<Record<string, readonly string[]>>;
}

export const NAPI_SHIMS: readonly NapiShim[] = [
    {
        name: 'bcrypt',
        binaries: ['bcrypt_lib.node'],
        // bcrypt 5.x: @mapbox/node-pre-gyp find() resolves binary.module_path ./lib/binding/napi-v{napi_build_version}
        // with napi_versions [3], plus module_name bcrypt_lib
        packages: { bcrypt: ['lib/binding/napi-v3/bcrypt_lib.node'] }
    },
    {
        // leveldown 6.1.1: node-gyp-build probes build/Release then build/Debug for any .node file,
        // then prebuilds/<platform>-<arch>/<tags>.node. The package ships the prebuilds, so the
        // placeholder is only needed at the two build paths.
        name: 'leveldown',
        binaries: [],
        packages: {
            leveldown: [
                'build/Release/leveldown.node',
                'build/Debug/leveldown.node',
                'prebuilds/linux-x64/node.napi.node',
                'prebuilds/linux-x64/node.napi.glibc.node',
                'prebuilds/linux-x64/node.napi.musl.node'
            ]
        }
    },
    {
        // rocksdb 5.2.1: the same loader, the same prebuild names, a different package directory.
        name: 'rocksdb',
        binaries: [],
        packages: {
            rocksdb: [
                'build/Release/rocksdb.node',
                'build/Debug/rocksdb.node',
                'prebuilds/linux-x64/node.napi.node',
                'prebuilds/linux-x64/node.napi.glibc.node',
                'prebuilds/linux-x64/node.napi.musl.node'
            ]
        }
    },
    {
        name: 'sodium',
        binaries: ['sodium-native.node'],
        // sodium-native 4.x: index.js is require('require-addon')('.', __filename), which resolves
        // prebuilds/<platform>-<arch>/sodium-native.node. The guest reports linux-x64.
        packages: { 'sodium-native': ['prebuilds/linux-x64/sodium-native.node'] }
    },
    {
        name: 'better-sqlite3',
        binaries: ['better_sqlite3.node'],
        packages: { 'better-sqlite3': ['build/Release/better_sqlite3.node'] }
    },
    {
        // node-pty 1.1.0: lib/utils.js loadNativeModule('pty') probes ../build/Release, ./build/Release,
        // ../build/Debug, ./build/Debug and then ../prebuilds/<platform>-<arch>, from lib/. The guest
        // reports linux-x64, and the package ships no linux prebuild, so all three are placeholders.
        name: 'node-pty',
        binaries: ['pty.node'],
        packages: {
            'node-pty': ['build/Release/pty.node', 'build/Debug/pty.node', 'prebuilds/linux-x64/pty.node']
        }
    },
    {
        name: 'canvas',
        binaries: ['canvas.node'],
        // canvas 3.x: bindings-style load resolves build/Release/canvas.node
        packages: { canvas: ['build/Release/canvas.node'] }
    },
    {
        // sharp 0.33.5: lib/sharp.js tries ../src/build/Release/sharp-<platform><libc>-<arch>.node, then
        // ../src/build/Release/sharp-wasm32.node, then @img/sharp-<same>/sharp.node and then
        // @img/sharp-wasm32/sharp.node. The guest's detect-libc finds no getconf, so runtimePlatformArch()
        // ends up 'linuxnull-x64'; the plain prebuilt platform is listed as well in case that changes.
        // The @img packages ship their own binary, so they need no placeholder; its basename is a binary
        // here so that any of them reaches this shim even without one.
        name: 'sharp',
        binaries: ['sharp.node', 'sharp-linuxnull-x64.node', 'sharp-linux-x64.node', 'sharp-wasm32.node'],
        packages: {
            sharp: [
                'src/build/Release/sharp-linuxnull-x64.node',
                'src/build/Release/sharp-linux-x64.node',
                'src/build/Release/sharp-wasm32.node'
            ]
        }
    }
];
