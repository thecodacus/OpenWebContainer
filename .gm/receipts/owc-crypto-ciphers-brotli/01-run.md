# owc-crypto-ciphers-brotli — one run, nine stages

Row: `owc-crypto-ciphers-brotli`. Session: `mcp-instruction-56080-1792097621879`.

## 1 SPECIFY

The row names three gaps and one decision. Located by `codesearch` in `literal` mode:

- `packages/core/src/process/executors/node/runtime/guest/misc.ts:793` — `createCipheriv: unavailable('createCipheriv')` (and `createDecipheriv` on the next line), inside `BF.crypto`, a `String.raw` guest snippet.
- `packages/core/src/process/executors/node/runtime/guest/modules/zlib.ts:392-408` — brotli and zstd declared through `unsupportedSync` / `unsupportedCallback`.

The guest is source text evaluated inside QuickJS (see `guest/loader.ts`, `guest/spine.ts`): it cannot `import`, so `@noble/ciphers` must run on the host. `@noble/ciphers@1.3.0` is already a dependency of `packages/core` and reaches the host today through `capabilities/tls-crypto.ts`.

Acceptance derived from the row: `createCipheriv` / `createDecipheriv` over AES-CBC, AES-CTR, AES-GCM and ChaCha20-Poly1305 as `@noble/ciphers` provides them, Node's error codes for bad keys and IVs, witnessed against Node's own `crypto`; brotli and zstd decided and recorded first.

## 1b ELIMINATE

Live JIT probes under `/tmp/owc-cipher-probe/` (scratch, outside the repo):

- `probe1.mjs` — noble vs Node, one shot, 12 algorithms: all match, CBC/ECB padding included.
- `probe2.mjs` — Node's error codes: `ERR_CRYPTO_UNKNOWN_CIPHER`, `ERR_CRYPTO_INVALID_KEYLEN` (RangeError), `ERR_CRYPTO_INVALID_IV` (TypeError), `ERR_CRYPTO_INVALID_STATE`, `ERR_OSSL_WRONG_FINAL_BLOCK_LENGTH`, `ERR_OSSL_BAD_DECRYPT`, and the uncoded `Unsupported state or unable to authenticate data`.
- `probe3.mjs` / `probe4.mjs` — GCM nonce lengths (noble refuses < 8), Node's emission profile per mode, ECB requires a null IV, ChaCha20-Poly1305 requires exactly 12.
- `probe5.mjs` — OpenSSL's decrypt hold-back rule and `setAAD` / `setAuthTag` return values.
- `cfb.mjs` — noble's CFB register advances per block, not per byte; the first chained model was refuted by this run and replaced.

## 1c EDIT

- `packages/core/src/process/executors/node/runtime/capabilities/crypto.ts` — host side: `crypto.ciphers`, `crypto.cipher.open|update|final|setAAD|setAuthTag|setAutoPadding`.
- `packages/core/src/process/executors/node/runtime/guest/misc.ts` — guest side: `Cipher` with `update`/`final`/`setAutoPadding`/`setAAD`/`getAuthTag`, `setAuthTag` only on a decipher, `getCiphers` now asks the host.
- `packages/core/src/process/executors/node/runtime/guest/modules/zlib.ts` — the brotli/zstd decision recorded where the unsupported stubs are.
- `Readme.md` — the limitations line no longer claims ciphers are unimplemented.

## 2 PROVE / 3 EMIT / 4 VALIDATE

Two instruments over the real source, both differential against Node:

1. `diff.ts` — guest source evaluated in a `vm` with a host stub that routes `host.cap` into the real `CAPABILITIES`, compared against `node:crypto`. 146 checks, 0 failures: 16 algorithms × (one-shot ciphertext, chunked ciphertext, update() lengths, auth tag, round trip, streaming decrypt, empty input) plus no-AAD AEAD.
2. `errors.ts` — 25 probes comparing constructor, `code` and message with Node. 31 checks, 0 failures.

End-to-end witness in the live container: headless Chrome on `http://localhost:5173` (the playground dev server, `--strictPort`), `ContainerManager` imported from the served module graph, a script written into the container and run under its own `node`. **RESULT: PASS pass=77 fail=0.**

The served bundle was confirmed to be the new one: `worker-code.js` served by 5173 is 23,370,697 bytes, sha256 `2af35f10d2f780c4b13997c5aadb89ec481402e1fc58f324cd9949cfeacc4ad9`, and contains `crypto.cipher.open`.

## 4 STATE

A cipher owns exactly one host-side record, keyed by an id, released when `final()` runs (which is why `final` returns the tag). Nothing else persists: a caller that abandons a cipher without `final()` leaves one record, and the map is capped at 256 open ciphers with oldest-first eviction.

## 5 CONC

Files touched: the three above plus `Readme.md`. `capabilities/index.ts` already spreads `CRYPTO_CAPABILITIES`, so no registration change was needed and no other lane's file was edited. `host-bridge.ts`, `guest/globals.ts`, `capabilities/index.ts` and `runtime/guest/wasm.ts` were not touched.

## 6 SEC

Keys and IVs cross the capability boundary as base64 inside JSON and live only in the host record, deleted at `final()`; nothing is logged. The algorithm name indexes a fixed table, so no capability is dispatched from caller text. No credentials, no new network surface.

## 7 RES

Failure modes exercised and matched to Node: unknown cipher, bad key length, bad IV length (checked before the key, as Node does), update after final, final twice, `getAuthTag` before final or on a non-AEAD cipher, `setAAD` after data, missing or wrong auth tag, bad PKCS#7 padding, non-multiple final block, `setAutoPadding(false)` leftovers, string and `KeyObject` keys.

## 8 DECIDE / 9 COMPLETE

Two known divergences, both in the code comments and here rather than hidden:

- **AEAD emission.** GCM and ChaCha20-Poly1305 emit at `final()`, not at `update()`, because `@noble/ciphers` exposes them one-shot. `update()` + `final()` is byte-identical to Node; only the chunking differs. The differential asserts the buffered profile explicitly.
- **GCM nonces of 1-7 bytes.** Node accepts them, `@noble/ciphers` refuses below 8, so they raise `ERR_CRYPTO_INVALID_IV`.

**Decision on brotli and zstd** (recorded on the row by `prd-block`, and in `zlib.ts`): measured 2026-10-16 — pure-JS brotli (`brotli` 2.1.0) 2.2 MB unpacked, `brotli-wasm` 3.0.1 a 3.2 MB package around a WASM module, `@bokuweb/zstd-wasm` 904 KB, `fzstd` 0.1.1 65 KB but decompress-only. Both codecs go through the WebAssembly bridge as codec modules rather than as JS inlined into the guest source. Follow-up row: `owc-brotli-zstd-wasm`.
