import type { AckRange } from './frames';

/*
 * Loss detection and probe timeouts (RFC 9002 Sections 5, 6 and Appendix A), per packet number
 * space: RTT estimation, packet and time threshold loss detection, and the PTO timer with
 * exponential backoff; plus the NewReno congestion controller (RFC 9002 Section 7) -- slow start,
 * the recovery period, persistent congestion (Section 7.6) -- and a pacer (Section 7.7).
 */

export type SpaceId = 'initial' | 'handshake' | 'application';
export const SPACE_IDS: readonly SpaceId[] = ['initial', 'handshake', 'application'];

/** RFC 9002 Section 6.2.2 and Appendix A.2 constants, in milliseconds. */
export const INITIAL_RTT = 333;
export const GRANULARITY = 1;
const PACKET_THRESHOLD = 3n;
const TIME_THRESHOLD = 9 / 8;

/** RFC 9002 Section 7: congestion window constants, in bytes. max_datagram_size is 1200 (connection.ts). */
export const MAX_DATAGRAM_SIZE_FOR_CWND = 1200;
/** RFC 9002 Section 7.2: ten times the maximum datagram size, capped at 14720 (RFC 6928); the cap does not bind. */
export const INITIAL_WINDOW = 10 * MAX_DATAGRAM_SIZE_FOR_CWND;
/** RFC 9002 Section 7.2: two times the maximum datagram size. */
export const MINIMUM_WINDOW = 2 * MAX_DATAGRAM_SIZE_FOR_CWND;
/** RFC 9002 Section 7.3.2: the slow start threshold is half the window on entering recovery. */
const LOSS_REDUCTION_FACTOR = 0.5;
/** RFC 9002 Section 7.6.1: persistent congestion spans three PTO periods. */
const PERSISTENT_CONGESTION_THRESHOLD = 3;
/** RFC 9002 Section 7.7: "a value for N that is small, but at least 1 (for example, 1.25)". */
const PACING_N = 1.25;
/**
 * Floor on the gap the pacer puts between two datagrams, milliseconds. Pacing stops smoothing and
 * becomes a throughput ceiling once the RTT is large enough that N * cwnd / srtt drops below
 * max_datagram_size / this gap; the floor keeps a slow path from stalling a transfer outright.
 */
const MAX_PACING_INTERVAL = 10;

export interface SentPacket<F> {
    readonly pn: bigint;
    readonly timeSent: number;
    readonly ackEliciting: boolean;
    readonly inFlight: boolean;
    readonly size: number;
    readonly frames: F[];
    /** 1-RTT Key Phase the packet was protected with; null for long headers. */
    readonly keyPhase: 0 | 1 | null;
}

interface SpaceState<F> {
    readonly sent: Map<bigint, SentPacket<F>>;
    largestAcked: bigint | null;
    lossTime: number | null;
    timeOfLastAckEliciting: number | null;
    discarded: boolean;
}

export interface AckOutcome<F> {
    readonly acked: SentPacket<F>[];
    readonly lost: SentPacket<F>[];
    /** The packet that carried the Largest Acknowledged, when it was newly acknowledged. */
    readonly largestNewlyAcked: SentPacket<F> | null;
}

export interface TimerState {
    readonly isClient: boolean;
    readonly handshakeConfirmed: boolean;
    readonly hasHandshakeKeys: boolean;
    /** RFC 9002 A.6 PeerCompletedAddressValidation: always true at a server. */
    readonly peerAddressValidated: boolean;
    /** A server limited by the anti-amplification factor arms no PTO (RFC 9002 Section 6.2.2.1). */
    readonly amplificationBlocked: boolean;
}

export interface LossTimer {
    readonly kind: 'loss' | 'pto';
    readonly time: number;
    readonly space: SpaceId;
}

export class Recovery<F> {
    latestRtt = 0;
    smoothedRtt = INITIAL_RTT;
    rttVar = INITIAL_RTT / 2;
    minRtt = 0;
    private hasRttSample = false;
    /** The peer's max_ack_delay transport parameter, milliseconds. */
    maxAckDelay = 25;
    ptoCount = 0;
    bytesInFlight = 0;
    /** RFC 9002 Section 7.2: the congestion window, in bytes. */
    congestionWindow = INITIAL_WINDOW;
    /** The slow start threshold, in bytes; Infinity means "no threshold yet" (slow start). */
    slowStartThreshold = Number.POSITIVE_INFINITY;
    /** When the current recovery period started, or null outside one (RFC 9002 Section 7.3.2). */
    recoveryStartTime: number | null = null;
    /** Time the pacer allows the next datagram out (RFC 9002 Section 7.7). */
    private nextSendTime = 0;
    private readonly spaces: Record<SpaceId, SpaceState<F>> = {
        initial: Recovery.emptySpace<F>(),
        handshake: Recovery.emptySpace<F>(),
        application: Recovery.emptySpace<F>(),
    };

    private static emptySpace<T>(): SpaceState<T> {
        return { sent: new Map(), largestAcked: null, lossTime: null, timeOfLastAckEliciting: null, discarded: false };
    }

    largestAcked(space: SpaceId): bigint | null {
        return this.spaces[space].largestAcked;
    }

    isDiscarded(space: SpaceId): boolean {
        return this.spaces[space].discarded;
    }

    ackElicitingInFlight(space?: SpaceId): number {
        let count = 0;
        for (const id of space ? [space] : SPACE_IDS) {
            for (const packet of this.spaces[id].sent.values()) if (packet.ackEliciting && packet.inFlight) count++;
        }
        return count;
    }

    unacked(space: SpaceId): SentPacket<F>[] {
        return [...this.spaces[space].sent.values()];
    }

    onPacketSent(space: SpaceId, packet: SentPacket<F>): void {
        const state = this.spaces[space];
        if (state.discarded) return;
        state.sent.set(packet.pn, packet);
        if (packet.inFlight) {
            this.bytesInFlight += packet.size;
            if (packet.ackEliciting) state.timeOfLastAckEliciting = packet.timeSent;
        }
    }

    /** RFC 9002 A.7 OnAckReceived. ackDelay is in milliseconds, already scaled by the peer's exponent. */
    onAckReceived(space: SpaceId, ranges: readonly AckRange[], ackDelay: number, now: number, handshakeConfirmed: boolean): AckOutcome<F> {
        const state = this.spaces[space];
        if (state.discarded || ranges.length === 0) return { acked: [], lost: [], largestNewlyAcked: null };
        const largest = ranges[0].largest;
        if (state.largestAcked === null || largest > state.largestAcked) state.largestAcked = largest;
        const acked: SentPacket<F>[] = [];
        for (const packet of [...state.sent.values()]) {
            if (!ranges.some((range) => packet.pn >= range.smallest && packet.pn <= range.largest)) continue;
            state.sent.delete(packet.pn);
            if (packet.inFlight) this.bytesInFlight -= packet.size;
            acked.push(packet);
        }
        if (acked.length === 0) return { acked, lost: [], largestNewlyAcked: null };
        const largestNewlyAcked = acked.find((packet) => packet.pn === largest) ?? null;
        if (largestNewlyAcked !== null && acked.some((packet) => packet.ackEliciting)) {
            this.updateRtt(now - largestNewlyAcked.timeSent, space === 'application' && handshakeConfirmed ? ackDelay : 0);
        }
        for (const packet of acked) this.onPacketAcked(packet);
        const lost = this.detectLost(space, now);
        this.ptoCount = 0;
        return { acked, lost, largestNewlyAcked };
    }

    /** RFC 9002 Section 5.3. */
    private updateRtt(latest: number, ackDelay: number): void {
        this.latestRtt = Math.max(latest, 0);
        if (!this.hasRttSample) {
            this.hasRttSample = true;
            this.minRtt = this.latestRtt;
            this.smoothedRtt = this.latestRtt;
            this.rttVar = this.latestRtt / 2;
            return;
        }
        this.minRtt = Math.min(this.minRtt, this.latestRtt);
        const delay = Math.min(ackDelay, this.maxAckDelay);
        const adjusted = this.latestRtt >= this.minRtt + delay ? this.latestRtt - delay : this.latestRtt;
        this.rttVar = 0.75 * this.rttVar + 0.25 * Math.abs(this.smoothedRtt - adjusted);
        this.smoothedRtt = 0.875 * this.smoothedRtt + 0.125 * adjusted;
    }

    /** RFC 9002 A.10 DetectAndRemoveLostPackets. */
    detectLost(space: SpaceId, now: number): SentPacket<F>[] {
        const state = this.spaces[space];
        state.lossTime = null;
        if (state.largestAcked === null) return [];
        const lossDelay = Math.max(TIME_THRESHOLD * Math.max(this.latestRtt, this.smoothedRtt), GRANULARITY);
        const lostSendTime = now - lossDelay;
        const lost: SentPacket<F>[] = [];
        for (const packet of [...state.sent.values()]) {
            if (packet.pn > state.largestAcked) continue;
            if (packet.timeSent <= lostSendTime || state.largestAcked >= packet.pn + PACKET_THRESHOLD) {
                state.sent.delete(packet.pn);
                if (packet.inFlight) this.bytesInFlight -= packet.size;
                lost.push(packet);
            } else {
                const when = packet.timeSent + lossDelay;
                state.lossTime = state.lossTime === null ? when : Math.min(state.lossTime, when);
            }
        }
        // RFC 9002 A.7 / A.8: declaring packets lost is a congestion event (Section 7.3.2, 7.6).
        this.congestionEvent(lost, now);
        return lost;
    }

    // ------------------------------------------------------------------ congestion control (RFC 9002 Section 7)

    /** The congestion window, in bytes (RFC 9002 Section 7.2). */
    get cwnd(): number {
        return this.congestionWindow;
    }

    /** The slow start threshold, in bytes (RFC 9002 Section 7.3.1). */
    get ssthresh(): number {
        return this.slowStartThreshold;
    }

    /** Whether a packet sent at time falls inside the current recovery period (RFC 9002 Section 7.3.2). */
    private inCongestionRecovery(time: number): boolean {
        return this.recoveryStartTime !== null && time <= this.recoveryStartTime;
    }

    /** RFC 9002 Section 7.4: whether the congestion window still admits more bytes in flight. */
    canSend(): boolean {
        return this.bytesInFlight < this.congestionWindow;
    }

    /** RFC 9002 A.13 OnPacketAcked: grow the window, and end the recovery period once it is over. */
    private onPacketAcked(packet: SentPacket<F>): void {
        if (!packet.inFlight) return;
        if (this.recoveryStartTime !== null && packet.timeSent > this.recoveryStartTime) this.recoveryStartTime = null;
        if (this.inCongestionRecovery(packet.timeSent)) return;
        if (this.congestionWindow < this.slowStartThreshold) {
            // Slow start (Section 7.3.1).
            this.congestionWindow += packet.size;
        } else {
            // Congestion avoidance (Section 7.3.1): one maximum datagram per window.
            this.congestionWindow += (MAX_DATAGRAM_SIZE_FOR_CWND * packet.size) / this.congestionWindow;
        }
    }

    /** RFC 9002 A.11 InPersistentCongestion: two losses a persistent congestion period apart. */
    private inPersistentCongestion(lost: readonly SentPacket<F>[]): boolean {
        if (!this.hasRttSample || lost.length < 2) return false;
        const oldest = lost[0];
        const newest = lost[lost.length - 1];
        if (!oldest.ackEliciting || !newest.ackEliciting) return false;
        const period = (this.smoothedRtt + Math.max(4 * this.rttVar, GRANULARITY) + this.maxAckDelay) * PERSISTENT_CONGESTION_THRESHOLD;
        return newest.timeSent - oldest.timeSent > period;
    }

    /** RFC 9002 A.12 CongestionEvent, plus Section 7.6 on persistent congestion. */
    private congestionEvent(lost: readonly SentPacket<F>[], now: number): void {
        if (lost.length === 0) return;
        let largestSent = lost[0].timeSent;
        for (const packet of lost) if (packet.timeSent > largestSent) largestSent = packet.timeSent;
        if (this.inPersistentCongestion(lost)) {
            // Section 7.6.2: as after an RTO, drop to the minimum window.
            this.recoveryStartTime = null;
            this.congestionWindow = MINIMUM_WINDOW;
            this.slowStartThreshold = MINIMUM_WINDOW;
            return;
        }
        if (this.inCongestionRecovery(largestSent)) return;
        this.recoveryStartTime = now;
        this.slowStartThreshold = Math.floor(this.congestionWindow * LOSS_REDUCTION_FACTOR);
        this.congestionWindow = Math.max(this.slowStartThreshold, MINIMUM_WINDOW);
    }

    // ------------------------------------------------------------------ pacing (RFC 9002 Section 7.7)

    /** The pacing rate in bytes per millisecond: N * congestion_window / smoothed_rtt. */
    pacingRate(): number {
        const rtt = Math.max(this.smoothedRtt, 1);
        return (PACING_N * this.congestionWindow) / rtt;
    }

    /** Milliseconds to wait before the next datagram may go out; 0 when it may go now. */
    pacingDelay(now: number): number {
        return this.nextSendTime <= now ? 0 : this.nextSendTime - now;
    }

    /** When pacingDelay is non-zero, the time to wake on. */
    pacingDeadline(): number {
        return this.nextSendTime;
    }

    /** Charges the pacer for one datagram: interval = size / rate, floored at MAX_PACING_INTERVAL. */
    onPacedSend(size: number, now: number): void {
        const interval = Math.min(size / Math.max(1, this.pacingRate()), MAX_PACING_INTERVAL);
        // An idle sender does not build up credit: restart the clock when the debt is old.
        if (this.nextSendTime < now) this.nextSendTime = now;
        this.nextSendTime += interval;
    }

    /** The PTO period without backoff (RFC 9002 Section 6.2.1); max_ack_delay applies to Application Data only. */
    ptoPeriod(space: SpaceId): number {
        return this.smoothedRtt + Math.max(4 * this.rttVar, GRANULARITY) + (space === 'application' ? this.maxAckDelay : 0);
    }

    /** RFC 9002 A.8 SetLossDetectionTimer: the earliest loss time, else the PTO deadline. */
    nextTimer(now: number, s: TimerState): LossTimer | null {
        let loss: LossTimer | null = null;
        for (const space of SPACE_IDS) {
            const state = this.spaces[space];
            if (state.discarded || state.lossTime === null) continue;
            if (loss === null || state.lossTime < loss.time) loss = { kind: 'loss', time: state.lossTime, space };
        }
        if (loss !== null) return loss;
        if (s.amplificationBlocked) return null;
        const backoff = 2 ** this.ptoCount;
        if (this.ackElicitingInFlight() === 0) {
            if (s.peerAddressValidated) return null;
            // Client anti-deadlock (RFC 9002 Section 6.2.2.1): probe even with nothing in flight.
            const space: SpaceId = s.hasHandshakeKeys ? 'handshake' : 'initial';
            return { kind: 'pto', time: now + this.ptoPeriod(space) * backoff, space };
        }
        let best: LossTimer | null = null;
        for (const space of SPACE_IDS) {
            const state = this.spaces[space];
            if (state.discarded || state.timeOfLastAckEliciting === null || this.ackElicitingInFlight(space) === 0) continue;
            if (space === 'application' && !s.handshakeConfirmed) continue;
            const time = state.timeOfLastAckEliciting + this.ptoPeriod(space) * backoff;
            if (best === null || time < best.time) best = { kind: 'pto', time, space };
        }
        return best;
    }

    /** Forgets a packet number space whose keys were discarded (RFC 9002 Section 6.4). */
    discardSpace(space: SpaceId): void {
        const state = this.spaces[space];
        for (const packet of state.sent.values()) if (packet.inFlight) this.bytesInFlight -= packet.size;
        state.sent.clear();
        state.lossTime = null;
        state.timeOfLastAckEliciting = null;
        state.discarded = true;
        this.ptoCount = 0;
    }

    /** Removes every in-flight packet of a space without discarding it, returning them (Retry: resend from scratch). */
    takeAll(space: SpaceId): SentPacket<F>[] {
        const state = this.spaces[space];
        const packets = [...state.sent.values()];
        for (const packet of packets) if (packet.inFlight) this.bytesInFlight -= packet.size;
        state.sent.clear();
        state.lossTime = null;
        state.timeOfLastAckEliciting = null;
        return packets;
    }
}
