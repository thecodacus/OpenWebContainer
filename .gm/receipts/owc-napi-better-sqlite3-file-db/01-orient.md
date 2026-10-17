# 01-orient — owc-napi-better-sqlite3-file-db

Row: `.gm/prd/owc-napi-better-sqlite3-file-db.yml` (status pending, session
82e15910-75ce-4750-b785-b7acfbfe2bfb).

## Acceptance (from the row's own words)

The row's subject gives the checkable clause and names its witness:

> create a file DB, write, close, reopen in a NEW container process and read the row back.

and claims the contrary: "any path other than `:memory:` fails with `SQLITE_CANTOPEN`, so all
four persistence phases fail". "The four persistence phases" is the row's own repro family,
`persist.js bs3 <write-close|read|write-noclose|read>` (from
`/tmp/owc-r4/verify-napi-adv/cases/persist.js`), each phase a separate process.

## Code the row names

- `packages/core/src/napi/better-sqlite3/index.ts` — the shim. `createAddon()` (line 346),
  `Database` (797), the whole-file VFS (1683-2080), `vfs_open` (1684), `flush` (1628),
  `fullPathname` (1659), `SQLITE_CANTOPEN` (135).
- `packages/core/src/napi/better-sqlite3/sqlite3-engine.cjs` — SQLite 3.47.0, wasm2js.
- `packages/core/src/process/executors/node/runtime/guest/modules/napi-better-sqlite3.ts` —
  the generated guest bundle of the shim (`build-napi-guest.mjs`).
- `packages/core/src/napi/registry.ts:70-74` — `better-sqlite3` maps `better_sqlite3.node`
  and `build/Release/better_sqlite3.node` to the shim.

`codeinsight` `callers` on `createAddon` recorded 0 call edges (edges are keyed by simple
callee name; the shim is reached through the generated bundle and `process.dlopen`), so the
shim was reached through a live run instead.

## Facts the row relies on

1. The container's npm skips the native install script ("only `node <file>` and `node -e
   <code>` run in this runtime"), so `require('better-sqlite3')` in the container is always
   the JavaScript shim. Observed in every run.
2. `git_status` scoped to `packages/core/src/napi/better-sqlite3/` and to the generated guest
   modules: clean at HEAD `54e91e8cf627f8c5464f55456c1e3f924e5cdcb7` (only
   `napi-sodium.ts` is dirty, another lane's file). So the tree under test is the committed
   tree, not a lane's uncommitted edit.
3. `node scripts/build-napi-guest.mjs --check`: every generated guest bundle is up to date,
   `napi-better-sqlite3.ts` included (2788971 bytes from 2 modules). The bundle the container
   runs is the bundle `index.ts` builds.
4. HEAD is `main`, upstream `origin/main`, remote `dywongcloud/OpenWebContainer`.

## Method

Differential against the real add-on on this machine's Node 24.15.0: the identical script
runs (a) on the host with the native `better-sqlite3@11.5.0` add-on and (b) inside the
container against the shim, and stdout, stderr and exit code are compared.
