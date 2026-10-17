import { CODEC_SRC } from './guest/codec';
import { LOADER_SRC } from './guest/loader';
import { SPINE_SRC } from './guest/spine';
import { PATH_SRC } from './guest/path-events';
import { UTIL_ASSERT_SRC } from './guest/util-assert';
import { BUFFER_FS_SRC } from './guest/buffer-fs';
import { MISC_SRC } from './guest/misc';
import { GLOBALS_SRC } from './guest/globals';
import { WASM_SRC } from './guest/wasm';
import { MODULE_SRCS } from './guest/modules';

/**
 * The guest bootstrap: a single expression evaluated once per QuickJS context.
 * It receives the host bridge object and returns the guest API object that the
 * host drives (runMain, fire, deliver, settle, keysOf, exportsOf, finalExitCode, ...).
 */
export const BOOTSTRAP_SRC = [
    '(function (host) {',
    CODEC_SRC,
    LOADER_SRC,
    SPINE_SRC,
    PATH_SRC,
    UTIL_ASSERT_SRC,
    BUFFER_FS_SRC,
    MISC_SRC,
    WASM_SRC,
    GLOBALS_SRC,
    ...MODULE_SRCS,
    'Object.defineProperty(globalThis, "__owc_api", { value: api, enumerable: false });',
    'return api;',
    '})'
].join('\n');
