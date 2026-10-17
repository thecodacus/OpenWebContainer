# 03-eliminate — owc-napi-better-sqlite3-file-db

Every unknown closed by a live differential run: the same script on the host against the
native `better-sqlite3@11.5.0` add-on (Node v24.15.0) and inside the container against the
shim, comparing stdout, stderr and exit code.

Runner: `/tmp/owc-r4/prd-bs3file/run-two.mts` (two node processes in one container) and
`/tmp/owc-r4/prd-bs3file/run-phases.mts` (N phases, each its own process), both the shape of
`/tmp/owc-r4/probe2/run-owc-repo.mts`, launched with the mandated command from
`packages/core`.

## U1, U9 — no `SQLITE_CANTOPEN` on a file path

Expected (from the row's contract, not from the code): if the row is true, every file path
throws `SQLITE_CANTOPEN`.

- The row's own repro, `/tmp/owc-r4/verify-napi-adv/repro-1/main.js`, in the container:
  `pre.db :: ok`, `./new.db :: ok`, `/work/new.db :: THROW SqliteError: table t already
  exists [code=SQLITE_ERROR]`, `pre.db size 8192`, exit 0. The third path is the same file as
  the second (`/work/new.db`), so "table t already exists" is what real better-sqlite3 gives
  too. No `SQLITE_CANTOPEN`. The row's repro is green.
- The only `SQLITE_CANTOPEN` observed anywhere is the one the host produces too:
  `new Database('nope.db', { fileMustExist: true })` ->
  `SqliteError: [SQLITE_CANTOPEN] unable to open database file`.

U1 and U9 closed: refuted at HEAD.

## U2, U3 — the four persistence phases

`/tmp/owc-r4/prd-bs3file/witness.sh` (the witness, `WITNESS.txt`):

| phase | host | container | stdout | stderr | exit |
|---|---|---|---|---|---|
| 1 write-close | `wrote :: [{"k":"alpha","v":"one"},{"k":"beta","v":"two"}]` / `closed :: ok` / `DONE` | same | match | match | 0/0 |
| 2 read | `read :: [{"k":"alpha","v":"one"},{"k":"beta","v":"two"}]` / `DONE` | same | match | match | 0/0 |
| 3 write-noclose | `wrote-no-close :: [3 rows incl. gamma]` / `exiting-without-close :: ok` | same | match | match | 0/0 |
| 4 read | `read :: [{"k":"alpha","v":"one"},{"k":"beta","v":"two"},{"k":"gamma","v":"three"}]` | same | match | match | 0/0 |

RESULT: PASS. U2 and U3 closed.

## U4 — path shapes

`main3.js`, eight names, open then reopen, container vs host, byte-identical:
`plain.db ok 8192`, `sp ace.db ok 8192`, `e.db ok 8192`, `é.db ok 8192`, `uni-é.db ok 8192`,
`od d é.db ok 8192`, `中文.db ok 8192`, `aé b.db ok 8192`; every reopen `{"n":1}`.

## U5, U6, U7 — options, size, journal modes

`main.js` (18 phases) and `main2.js` (10 phases), byte-identical to the host on both:

```
p7-missingMustExist :: THROW SqliteError: [SQLITE_CANTOPEN] unable to open database file
p8-missingDir :: THROW TypeError: Cannot open database because the directory does not exist
p9-readonlyRead :: ok :: {"a":"hello"}
p10-readonlyWrite :: THROW SqliteError: [SQLITE_READONLY] attempt to write a readonly database
p11-multipage :: ok :: size 573440        p11-reopen :: ok :: {"n":4000}
p12-twoConns :: ok :: {"n":1}
p13-wal :: ok :: [{"journal_mode":"wal"}] size 8192 wal STAT ENOENT
p14-backup :: ok :: {"totalPages":2,"remainingPages":0} -> {"a":"hello","b":42}
p15-dotdot :: ok :: {"n":3}               p16-noClose :: ok :: left open
p17-unlink :: ok :: {"n":0}               p4-memory :: ok :: {"x":7}
q1-attach :: ok :: {"a":11,"b":22}        q2-emptyName :: ok :: {"n":1}
q4-rollback :: ok :: {"n":0}              q8-bigValue :: ok :: {"n":1048576} size 1056768
q9-walRewrite :: ok :: {"n":2}            q10-copy :: ok :: {"n":3}
```

## U8 — hot journal

`crash4.js`, two processes. Container: `mid-transaction files crash.db,crash.db-journal`;
`before-reopen files crash.db,crash.db-journal`; `after-rollback count :: {"n":1}`;
`after-reopen files crash.db,crash.db-journal`. Host: identical, line for line.

## Hypotheses refuted by a run (recorded so they are not re-chased)

- **"A space in the filename corrupts the database (`SQLITE_CORRUPT: malformed database
  schema (?)`)."** Observed once, then refuted: the cause was my own harness, which mounts
  the project directory by reading and writing every file as UTF-8 text, so a binary `.db`
  left in the scratch directory arrived in the container mangled (8192 -> 8200 bytes). With
  `.db` files excluded from the mount, `sp ace.db`, `od d é.db` and `aé b.db` all open at
  8192 bytes exactly as on the host. Not a shim defect.
- **"The container loses a committed write when the process exits without `close()`."**
  Observed once as phase 4 returning 2 rows instead of 3, then refuted: it was my witness
  extractor matching the first block named `read`, so phase 4 was compared against phase 2's
  output. Fixed to match blocks in run order; three further container runs and the fixed
  witness all return 3 rows.
- **"The `Aborted(Assertion failed: list_empty(&rt->gc_obj_list), ... JS_FreeRuntime)` line on
  the host-side stderr is a better-sqlite3 shim leak."** Refuted: the same line is printed for
  a container process that only runs `console.log("hello")`. It is generic QuickJS host
  teardown noise, present on every container run, and is not program stderr.

No unknown is open.
