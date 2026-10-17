import type { AckRange } from './frames';

/*
 * Range sets used by the connection layer.
 *  - PacketNumberSet: received packet numbers of one packet number space, as maximal ranges in
 *    descending order, which is the order an ACK frame lists them (RFC 9000 Section 19.3.1).
 *  - ByteRanges: half-open byte ranges [start, end) in ascending order, for stream and CRYPTO data
 *    that is pending transmission or acknowledged.
 */

/** Received packet numbers as maximal ranges, largest first. */
export class PacketNumberSet {
    private ranges: { smallest: bigint; largest: bigint }[] = [];

    /** Most ranges kept; the oldest (smallest) ranges are forgotten beyond this. */
    constructor(private readonly maxRanges = 64) {}

    get isEmpty(): boolean {
        return this.ranges.length === 0;
    }

    largest(): bigint | null {
        return this.ranges.length === 0 ? null : this.ranges[0].largest;
    }

    has(pn: bigint): boolean {
        for (const range of this.ranges) {
            if (pn > range.largest) return false;
            if (pn >= range.smallest) return true;
        }
        return false;
    }

    /** Adds pn; returns false when it was already present. */
    add(pn: bigint): boolean {
        const ranges = this.ranges;
        for (let i = 0; i < ranges.length; i++) {
            const range = ranges[i];
            if (pn > range.largest + 1n) {
                ranges.splice(i, 0, { smallest: pn, largest: pn });
                this.trim();
                return true;
            }
            if (pn === range.largest + 1n) {
                range.largest = pn;
                return true;
            }
            if (pn >= range.smallest) return false;
            if (pn === range.smallest - 1n) {
                range.smallest = pn;
                const next = ranges[i + 1];
                if (next !== undefined && next.largest + 1n === range.smallest) {
                    range.smallest = next.smallest;
                    ranges.splice(i + 1, 1);
                }
                return true;
            }
        }
        ranges.push({ smallest: pn, largest: pn });
        this.trim();
        return true;
    }

    /** The ranges for an ACK frame, largest first, at most limit of them. */
    toAckRanges(limit = 32): AckRange[] {
        return this.ranges.slice(0, limit).map((range) => ({ smallest: range.smallest, largest: range.largest }));
    }

    private trim(): void {
        if (this.ranges.length > this.maxRanges) this.ranges.length = this.maxRanges;
    }
}

/** Half-open byte ranges [start, end), ascending and non-overlapping. */
export class ByteRanges {
    private list: [number, number][] = [];

    get isEmpty(): boolean {
        return this.list.length === 0;
    }

    /** The lowest range, or null. */
    first(): [number, number] | null {
        return this.list.length === 0 ? null : [this.list[0][0], this.list[0][1]];
    }

    /** Whether [start, end) is entirely covered. */
    covers(start: number, end: number): boolean {
        if (end <= start) return true;
        for (const [s, e] of this.list) {
            if (s <= start && e >= end) return true;
            if (s > start) return false;
        }
        return false;
    }

    /** The end of the range that starts at 0, or 0 when 0 is not covered. */
    prefixEnd(): number {
        return this.list.length > 0 && this.list[0][0] === 0 ? this.list[0][1] : 0;
    }

    add(start: number, end: number): void {
        if (end <= start) return;
        const out: [number, number][] = [];
        let s = start;
        let e = end;
        let placed = false;
        for (const [rs, re] of this.list) {
            if (re < s) {
                out.push([rs, re]);
            } else if (rs > e) {
                if (!placed) {
                    out.push([s, e]);
                    placed = true;
                }
                out.push([rs, re]);
            } else {
                s = Math.min(s, rs);
                e = Math.max(e, re);
            }
        }
        if (!placed) out.push([s, e]);
        this.list = out;
    }

    remove(start: number, end: number): void {
        if (end <= start) return;
        const out: [number, number][] = [];
        for (const [rs, re] of this.list) {
            if (re <= start || rs >= end) {
                out.push([rs, re]);
                continue;
            }
            if (rs < start) out.push([rs, start]);
            if (re > end) out.push([end, re]);
        }
        this.list = out;
    }

    /** The parts of [start, end) that are not covered, ascending. */
    gaps(start: number, end: number): [number, number][] {
        const out: [number, number][] = [];
        let cursor = start;
        for (const [rs, re] of this.list) {
            if (re <= cursor) continue;
            if (rs >= end) break;
            if (rs > cursor) out.push([cursor, Math.min(rs, end)]);
            cursor = Math.max(cursor, re);
            if (cursor >= end) break;
        }
        if (cursor < end) out.push([cursor, end]);
        return out;
    }
}
