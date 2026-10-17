# 05-validate — owc-napi-better-sqlite3-file-db

Witness: `/tmp/owc-r4/prd-bs3file/witness.sh`, output
`/tmp/owc-r4/prd-bs3file/WITNESS.txt`, sha256
`8deb18de2db8157f6a79cd175d3bb3a9db39c89b4ca1b684567eddc7f8d5198a`, exit code 0,
run 2026-10-17T06:20:04Z on HEAD `54e91e8cf627f8c5464f55456c1e3f924e5cdcb7`
(working tree clean for `packages/core/src/napi/better-sqlite3/` and the generated guest
modules).

One expected value per acceptance clause, written before running:

1. "create a file DB" — the container opens `persist-bs3.db` (a path, not `:memory:`) and
   `CREATE TABLE` + `INSERT` succeed. Observed: `wrote :: [{"k":"alpha","v":"one"},
   {"k":"beta","v":"two"}]`.
2. "write, close" — `closed :: ok`, exit 0.
3. "reopen in a NEW container process and read the row back" — a second `node` process in the
   same container reads `read :: [{"k":"alpha","v":"one"},{"k":"beta","v":"two"}]`.
4. The durability arm: a third process writes `gamma` and exits without `close()`; a fourth
   process reads all three rows back.

Observed for all four: container stdout identical to the host's native-add-on stdout, both
stderr empty, all exit codes 0. `RESULT: PASS`.

Against the row's words, not the diff: the row asserts file databases cannot be opened at
all and that all four persistence phases fail. All four phases pass and agree with real
better-sqlite3 line for line, and no `SQLITE_CANTOPEN` occurs on any file path. The row's
premise is false at HEAD; the behaviour it asks for is already present.

STATUS: verified — witness `/tmp/owc-r4/prd-bs3file/WITNESS.txt`, copied to
`.gm/receipts/owc-napi-better-sqlite3-file-db/witness.txt`,
sha256 `8deb18de2db8157f6a79cd175d3bb3a9db39c89b4ca1b684567eddc7f8d5198a`, exit 0.

The same witness was then run as a live gm dispatch of its own: `bash` verb, dispatch
`1792218141947-500-3201d2a3f3f91a18`, task `task-ae4-18df1b4303a3c128-5`, `exit_code: 0`,
stdout ending `RESULT: PASS`. That dispatch id is the witness's live-run id for this project.
