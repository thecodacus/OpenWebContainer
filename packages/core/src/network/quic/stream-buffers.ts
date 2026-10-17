import { ByteRanges } from './ranges';

/*
 * Ordered byte streams with offsets, shared by CRYPTO data (RFC 9000 Section 19.6) and STREAM data
 * (Section 19.8).
 *  - SendBuffer keeps every byte until it is acknowledged, hands out frames for new or lost ranges,
 *    and tracks the FIN bit for streams.
 *  - RecvBuffer reassembles out-of-order frames and returns the bytes that became contiguous, and
 *    enforces the final size rules of Section 4.5 for streams.
 */

export interface SendChunk {
    readonly offset: number;
    readonly data: Uint8Array;
    readonly fin: boolean;
}

export class SendBuffer {
    /** Every byte written, by offset, minus the acknowledged prefix that has been released. */
    private chunks: { offset: number; data: Uint8Array }[] = [];
    /** Total bytes written: the offset of the next new byte. */
    private written = 0;
    /** Ranges waiting to be sent: new data plus data declared lost. */
    private readonly pending = new ByteRanges();
    private readonly acked = new ByteRanges();
    /** Highest offset ever handed out in a frame (flow control counts new bytes only once). */
    private highestSent = 0;
    private finRequested = false;
    private finPending = false;
    private finAcked = false;

    get length(): number {
        return this.written;
    }

    get maxSentOffset(): number {
        return this.highestSent;
    }

    get finished(): boolean {
        return this.finRequested;
    }

    /** Whether every byte (and the FIN, when requested) has been acknowledged. */
    get allAcked(): boolean {
        return this.acked.covers(0, this.written) && (!this.finRequested || this.finAcked);
    }

    /** Whether there is anything to send, within the limit for new bytes. */
    hasPending(newDataLimit = Number.MAX_SAFE_INTEGER): boolean {
        const first = this.pending.first();
        if (first !== null && (first[0] < this.highestSent || first[0] < newDataLimit)) return true;
        return this.finPending && !this.finAcked && this.pending.isEmpty;
    }

    write(data: Uint8Array): void {
        if (this.finRequested) throw new Error('write after end of stream');
        if (data.length === 0) return;
        // new Uint8Array copies; slice() would not copy a Buffer (Buffer.prototype.slice is a view).
        this.chunks.push({ offset: this.written, data: new Uint8Array(data) });
        this.pending.add(this.written, this.written + data.length);
        this.written += data.length;
    }

    end(): void {
        if (this.finRequested) return;
        this.finRequested = true;
        this.finPending = true;
    }

    /**
     * The next frame's worth of data: the lowest pending range, at most maxBytes long, and not past
     * newDataLimit for bytes never sent before. null when nothing can be sent.
     */
    next(maxBytes: number, newDataLimit = Number.MAX_SAFE_INTEGER): SendChunk | null {
        const first = this.pending.first();
        if (first !== null) {
            const [start, rangeEnd] = first;
            // Bytes below highestSent were within the limit when first sent, so retransmitting them is
            // always allowed; bytes never sent stop at newDataLimit.
            let end = rangeEnd;
            if (end > this.highestSent) end = Math.max(Math.min(end, newDataLimit), Math.min(end, this.highestSent));
            end = Math.min(end, start + Math.max(0, maxBytes));
            if (end <= start) return null;
            this.pending.remove(start, end);
            this.highestSent = Math.max(this.highestSent, end);
            const fin = this.finPending && end === this.written && this.pending.isEmpty;
            if (fin) this.finPending = false;
            return { offset: start, data: this.read(start, end), fin };
        }
        if (this.finPending && !this.finAcked && this.pending.isEmpty) {
            this.finPending = false;
            return { offset: this.written, data: new Uint8Array(0), fin: true };
        }
        return null;
    }

    /** A frame carrying [offset, offset + length) (and FIN) was declared lost: send it again. */
    onLost(offset: number, length: number, fin: boolean): void {
        for (const [start, end] of this.acked.gaps(offset, offset + length)) this.pending.add(start, end);
        if (fin && !this.finAcked) this.finPending = true;
    }

    /** A frame carrying [offset, offset + length) (and FIN) was acknowledged. */
    onAcked(offset: number, length: number, fin: boolean): void {
        this.acked.add(offset, offset + length);
        this.pending.remove(offset, offset + length);
        if (fin) {
            this.finAcked = true;
            this.finPending = false;
        }
        const prefix = this.acked.prefixEnd();
        while (this.chunks.length > 0 && this.chunks[0].offset + this.chunks[0].data.length <= prefix) this.chunks.shift();
    }

    /** Marks every unacknowledged byte for retransmission (PTO probes of CRYPTO data). */
    requeueUnacked(): void {
        for (const [start, end] of this.acked.gaps(0, this.highestSent)) this.pending.add(start, end);
        if (this.finRequested && !this.finAcked && !this.finPending && this.highestSent === this.written) this.finPending = true;
    }

    private read(start: number, end: number): Uint8Array {
        const out = new Uint8Array(end - start);
        for (const chunk of this.chunks) {
            const chunkEnd = chunk.offset + chunk.data.length;
            if (chunkEnd <= start) continue;
            if (chunk.offset >= end) break;
            const from = Math.max(start, chunk.offset);
            const to = Math.min(end, chunkEnd);
            out.set(chunk.data.subarray(from - chunk.offset, to - chunk.offset), from - start);
        }
        return out;
    }
}

/** Why RecvBuffer refused a frame (RFC 9000 Section 4.5). */
export class FinalSizeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FinalSizeError';
    }
}

export class RecvBuffer {
    /** Offset of the next byte to deliver. */
    private delivered = 0;
    /** Received data beyond the delivered offset, ascending by offset. */
    private segments: { offset: number; data: Uint8Array }[] = [];
    private finalSizeValue: number | null = null;
    private highest = 0;

    get deliveredOffset(): number {
        return this.delivered;
    }

    /** Largest offset + length seen, the quantity flow control limits. */
    get highestOffset(): number {
        return this.highest;
    }

    get finalSize(): number | null {
        return this.finalSizeValue;
    }

    get complete(): boolean {
        return this.finalSizeValue !== null && this.delivered === this.finalSizeValue;
    }

    /** Bytes held beyond the delivered offset (CRYPTO buffer accounting). */
    get buffered(): number {
        let total = 0;
        for (const segment of this.segments) total += segment.data.length;
        return total;
    }

    /**
     * Inserts the bytes of a frame and returns the chunks that are now contiguous, in order. Throws
     * FinalSizeError when the frame contradicts a known final size.
     */
    insert(offset: number, data: Uint8Array, fin: boolean): Uint8Array[] {
        const end = offset + data.length;
        if (this.finalSizeValue !== null) {
            if (end > this.finalSizeValue) throw new FinalSizeError('data beyond the final size');
            if (fin && end !== this.finalSizeValue) throw new FinalSizeError('final size changed');
        }
        if (fin) {
            if (end < this.highest) throw new FinalSizeError('final size below data already received');
            this.finalSizeValue = end;
        }
        this.highest = Math.max(this.highest, end);
        if (end > this.delivered && data.length > 0) {
            const from = Math.max(offset, this.delivered);
            const piece = new Uint8Array(data.subarray(from - offset));
            let i = this.segments.length;
            while (i > 0 && this.segments[i - 1].offset > from) i--;
            this.segments.splice(i, 0, { offset: from, data: piece });
        }
        const out: Uint8Array[] = [];
        while (this.segments.length > 0 && this.segments[0].offset <= this.delivered) {
            const segment = this.segments.shift() as { offset: number; data: Uint8Array };
            const segmentEnd = segment.offset + segment.data.length;
            if (segmentEnd <= this.delivered) continue;
            out.push(segment.data.subarray(this.delivered - segment.offset));
            this.delivered = segmentEnd;
        }
        return out;
    }
}
