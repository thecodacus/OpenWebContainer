/**
 * The in-memory sorted map: a two-level B+ tree (a root array of sorted leaves) over byte strings,
 * persistent through copy-on-write. snapshot() hands out the current root; the next write copies
 * the root and each leaf it touches once, so a snapshot (an iterator's view, LevelDB's implicit
 * snapshot) never changes and costs nothing until the store is written again.
 */
import type { ByteString } from './bytes';

export interface Leaf {
    keys: ByteString[];
    vals: ByteString[];
    /** The store epoch that may mutate this leaf in place; an older leaf belongs to a snapshot. */
    epoch: number;
}

/** A frozen view: neither the array nor any leaf in it is mutated after snapshot() returned it. */
export type Snapshot = readonly Leaf[];

/** A leaf is split in two when it grows past LEAF_MAX entries; bulk loads fill leaves to LEAF_FILL. */
const LEAF_MAX = 256;
const LEAF_FILL = 128;

function lowerBound(keys: readonly ByteString[], key: ByteString): number {
    let lo = 0;
    let hi = keys.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (keys[mid] < key) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/** Index of the first leaf whose last key is >= key, or leaves.length when key is above every key. */
function leafIndex(leaves: Snapshot, key: ByteString): number {
    let lo = 0;
    let hi = leaves.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const ks = leaves[mid].keys;
        if (ks[ks.length - 1] < key) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

export class SortedStore {
    private leaves: Leaf[] = [];
    private rootEpoch = 0;
    private epoch = 0;
    /** Live entries. */
    count = 0;
    /** Sum of key and value lengths of the live entries. */
    bytes = 0;

    /** Builds a store from keys in strictly ascending byte order and their values. */
    static fromSorted(keys: ByteString[], vals: ByteString[]): SortedStore {
        const store = new SortedStore();
        for (let i = 0; i < keys.length; i += LEAF_FILL) {
            store.leaves.push({ keys: keys.slice(i, i + LEAF_FILL), vals: vals.slice(i, i + LEAF_FILL), epoch: 0 });
        }
        store.count = keys.length;
        let bytes = 0;
        for (let i = 0; i < keys.length; i++) bytes += keys[i].length + vals[i].length;
        store.bytes = bytes;
        return store;
    }

    /** The current contents, frozen. Later writes copy before they mutate. */
    snapshot(): Snapshot {
        const view = this.leaves;
        this.epoch++;
        return view;
    }

    get(key: ByteString): ByteString | undefined {
        const li = leafIndex(this.leaves, key);
        if (li >= this.leaves.length) return undefined;
        const leaf = this.leaves[li];
        const ki = lowerBound(leaf.keys, key);
        return ki < leaf.keys.length && leaf.keys[ki] === key ? leaf.vals[ki] : undefined;
    }

    put(key: ByteString, val: ByteString): void {
        if (this.leaves.length === 0) {
            this.writableRoot();
            this.leaves.push({ keys: [key], vals: [val], epoch: this.epoch });
            this.count = 1;
            this.bytes = key.length + val.length;
            return;
        }
        let li = leafIndex(this.leaves, key);
        if (li >= this.leaves.length) li = this.leaves.length - 1;
        const leaf = this.writableLeaf(li);
        const ki = lowerBound(leaf.keys, key);
        if (ki < leaf.keys.length && leaf.keys[ki] === key) {
            this.bytes += val.length - leaf.vals[ki].length;
            leaf.vals[ki] = val;
            return;
        }
        leaf.keys.splice(ki, 0, key);
        leaf.vals.splice(ki, 0, val);
        this.count++;
        this.bytes += key.length + val.length;
        if (leaf.keys.length > LEAF_MAX) this.split(li);
    }

    del(key: ByteString): boolean {
        const li = leafIndex(this.leaves, key);
        if (li >= this.leaves.length) return false;
        const ki = lowerBound(this.leaves[li].keys, key);
        if (ki >= this.leaves[li].keys.length || this.leaves[li].keys[ki] !== key) return false;
        const leaf = this.writableLeaf(li);
        this.bytes -= key.length + leaf.vals[ki].length;
        leaf.keys.splice(ki, 1);
        leaf.vals.splice(ki, 1);
        this.count--;
        if (leaf.keys.length === 0) {
            this.writableRoot();
            this.leaves.splice(li, 1);
        }
        return true;
    }

    private writableRoot(): void {
        if (this.rootEpoch !== this.epoch) {
            this.leaves = this.leaves.slice();
            this.rootEpoch = this.epoch;
        }
    }

    private writableLeaf(li: number): Leaf {
        let leaf = this.leaves[li];
        if (leaf.epoch !== this.epoch) {
            this.writableRoot();
            leaf = { keys: leaf.keys.slice(), vals: leaf.vals.slice(), epoch: this.epoch };
            this.leaves[li] = leaf;
        }
        return leaf;
    }

    private split(li: number): void {
        const leaf = this.leaves[li];
        const half = leaf.keys.length >>> 1;
        const right: Leaf = { keys: leaf.keys.slice(half), vals: leaf.vals.slice(half), epoch: this.epoch };
        leaf.keys.length = half;
        leaf.vals.length = half;
        this.writableRoot();
        this.leaves.splice(li + 1, 0, right);
    }
}

/** Calls fn for every entry of a snapshot in ascending key order. */
export function forEachEntry(view: Snapshot, fn: (key: ByteString, val: ByteString) => void): void {
    for (let li = 0; li < view.length; li++) {
        const { keys, vals } = view[li];
        for (let ki = 0; ki < keys.length; ki++) fn(keys[ki], vals[ki]);
    }
}

/**
 * A leveldb::Iterator over a snapshot: Seek (first key >= target), SeekToFirst, SeekToLast, Next,
 * Prev, Valid. Moving an invalid cursor leaves it invalid.
 */
export class Cursor {
    private li = -1;
    private ki = 0;

    constructor(private readonly view: Snapshot) {}

    valid(): boolean {
        return this.li >= 0 && this.li < this.view.length;
    }

    key(): ByteString {
        return this.view[this.li].keys[this.ki];
    }

    value(): ByteString {
        return this.view[this.li].vals[this.ki];
    }

    seekToFirst(): void {
        this.li = this.view.length > 0 ? 0 : -1;
        this.ki = 0;
    }

    seekToLast(): void {
        this.li = this.view.length - 1;
        this.ki = this.li >= 0 ? this.view[this.li].keys.length - 1 : 0;
    }

    seek(target: ByteString): void {
        const li = leafIndex(this.view, target);
        if (li >= this.view.length) {
            this.li = -1;
            return;
        }
        this.li = li;
        this.ki = lowerBound(this.view[li].keys, target);
    }

    next(): void {
        if (!this.valid()) return;
        if (++this.ki >= this.view[this.li].keys.length) {
            this.li++;
            this.ki = 0;
        }
    }

    prev(): void {
        if (!this.valid()) return;
        if (--this.ki < 0) {
            this.li--;
            this.ki = this.li >= 0 ? this.view[this.li].keys.length - 1 : 0;
        }
    }
}
