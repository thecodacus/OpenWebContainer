/**
 * The native binding of rocksdb 5.2.1, which ships the same add-on as leveldown 6.1.1: its
 * leveldown.js, iterator.js and chained-batch.js are byte-identical to leveldown's, and the add-on
 * exports the same 23 names in the same order. The store is the same too, so this shim is the
 * leveldown one under a second name -- registered separately because process.dlopen routes by the
 * package that owns the add-on file, not by what the add-on does.
 *
 * The differences are the ones the C++ and the JS wrapper carry, all measured against the real
 * rocksdb on Node 24.15 and recorded in MANIFEST.md:
 *  - The package's own name and prebuild basenames (prebuilds/<platform>-<arch>/node.napi*.node).
 *  - getProperty: leveldb's properties are named leveldb.* and rocksdb answers '' for every one of
 *    them, because RocksDB's own property names (rocksdb.*) differ; the shim returns '' for both.
 *  - Everything else -- NotFound, iterator framing, batch atomicity, range and limit semantics --
 *    is identical, and the battery measures it as identical.
 */
export { createAddon } from '../leveldown/index';
