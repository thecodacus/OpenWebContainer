# 02-unknowns — owc-napi-better-sqlite3-file-db

Each line states the question it answers. All are open at orient; each is closed by a live
run in 03-eliminate.

- U1. Does `new Database(<file path>)` still fail with `SQLITE_CANTOPEN` in the container at
  HEAD? (the row's whole claim)
- U2. Do the row's four persistence phases (write-close, read, write-noclose, read, each a
  separate container process) agree with real better-sqlite3?
- U3. Does a file database survive a process exit without `close()`? (phase 3 -> 4)
- U4. Do relative, absolute, subdirectory, `..`, empty-string (temp), spaces and non-ASCII
  paths all agree with real better-sqlite3?
- U5. Do `fileMustExist`, `readonly`, missing-directory and missing-file opens produce the
  same error code and message?
- U6. Do multi-page databases (4000 rows, 573440 bytes) and a 1 MiB value round-trip?
- U7. Do WAL mode, `ATTACH`, `backup()` and rollback agree?
- U8. Hot journal: does a transaction killed by process exit leave `-journal` behind and roll
  back on the next open, as it does on the host?
- U9. Is the row's repro (`/tmp/owc-r4/verify-napi-adv/repro-1`) still red?
