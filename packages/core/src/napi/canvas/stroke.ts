/**
 * Turning a path into the outline a stroke fills. The add-on hands cairo a path and a line width and
 * cairo strokes it in user space, so a non-uniform transform shears the stroke; the shim transforms the
 * path to device space first and strokes it there with the geometric mean of the two axis scales, which
 * is what most 2D renderers without a full stroker do. Under a uniform scale, a rotation or a skew-free
 * translate the two agree exactly; under a non-uniform scale the shim's stroke is uniform where cairo's
 * is not, and MANIFEST.md says so.
 *
 * Joins, caps and dashes follow the HTML canvas spec: a miter join falls back to a bevel past
 * miterLimit, an odd dash array is duplicated, and a dash of total length zero is no dash at all.
 */

import type { SubPath } from './path';
import { subPath } from './path';

export type LineCap = 'butt' | 'round' | 'square';
export type LineJoin = 'miter' | 'round' | 'bevel';

export interface StrokeStyle {
    width: number;
    cap: LineCap;
    join: LineJoin;
    miterLimit: number;
    dash: readonly number[];
    dashOffset: number;
}

interface Polyline {
    pts: number[];
    closed: boolean;
}

/** Splits the path by the dash pattern; returns the same polylines when there is no dash. */
function dashPath(path: readonly SubPath[], dash: readonly number[], dashOffset: number): Polyline[] {
    if (dash.length === 0) return path.map((sp) => ({ pts: sp.pts, closed: sp.closed }));
    let total = 0;
    for (const d of dash) total += d;
    if (total <= 0) return path.map((sp) => ({ pts: sp.pts, closed: sp.closed }));
    const pattern = dash.length % 2 === 1 ? dash.concat(dash) : dash;
    const out: Polyline[] = [];
    for (const sp of path) {
        const pts = sp.pts;
        const n = pts.length >> 1;
        if (n < 2) continue;
        const off = ((dashOffset % total) + total) % total;
        let idx = 0;
        let acc = 0;
        while (acc + pattern[idx] <= off && idx < pattern.length) acc += pattern[idx++];
        let rem = acc + pattern[idx] - off;
        let on = idx % 2 === 0;
        let cur: number[] | null = null;
        const flush = (): void => {
            if (cur !== null && cur.length >= 4) out.push({ pts: cur, closed: false });
            cur = null;
        };
        const count = sp.closed ? n : n - 1;
        for (let i = 0; i < count; i++) {
            const j = (i + 1) % n;
            const ax = pts[i * 2], ay = pts[i * 2 + 1];
            const bx = pts[j * 2], by = pts[j * 2 + 1];
            const len = Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay));
            if (len === 0) continue;
            let t = 0;
            while (t < len - 1e-12) {
                const step = Math.min(rem, len - t);
                const t0 = t / len, t1 = (t + step) / len;
                if (on) {
                    if (cur === null) cur = [ax + (bx - ax) * t0, ay + (by - ay) * t0];
                    cur.push(ax + (bx - ax) * t1, ay + (by - ay) * t1);
                }
                t += step;
                rem -= step;
                if (rem <= 1e-12) {
                    idx = (idx + 1) % pattern.length;
                    rem = pattern[idx];
                    on = idx % 2 === 0;
                    if (!on) flush();
                }
            }
        }
        flush();
    }
    return out;
}

/** A convex polygon of one piece of the stroke, wound so that overlapping pieces add instead of cancel. */
function emit(out: SubPath[], pts: number[]): void {
    if (pts.length < 6) return;
    let area = 0;
    for (let i = 0; i < pts.length; i += 2) {
        const j = (i + 2) % pts.length;
        area += pts[i] * pts[j + 1] - pts[j] * pts[i + 1];
    }
    out.push(subPath(area < 0 ? reverse(pts) : pts, true));
}

function reverse(pts: number[]): number[] {
    const out: number[] = [];
    for (let i = pts.length - 2; i >= 0; i -= 2) out.push(pts[i], pts[i + 1]);
    return out;
}

function circle(cx: number, cy: number, r: number): number[] {
    const steps = Math.max(6, Math.min(48, Math.ceil(r * 2)));
    const pts: number[] = [];
    for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        pts.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
    }
    return pts;
}

/** The stroke of `path` as a path: the outline a fill of it paints. */
export function strokeOutline(path: readonly SubPath[], style: StrokeStyle): SubPath[] {
    const hw = style.width / 2;
    const out: SubPath[] = [];
    if (!(hw > 0)) return out;
    const pieces = dashPath(path, style.dash, style.dashOffset);

    for (const piece of pieces) {
        const pts = piece.pts;
        const n = pts.length >> 1;
        if (n < 2) continue;
        const segs = piece.closed ? n : n - 1;
        for (let i = 0; i < segs; i++) {
            const j = (i + 1) % n;
            const ax = pts[i * 2], ay = pts[i * 2 + 1];
            const bx = pts[j * 2], by = pts[j * 2 + 1];
            let dx = bx - ax, dy = by - ay;
            const len = Math.sqrt(dx * dx + dy * dy);
            if (len === 0) continue;
            dx /= len;
            dy /= len;
            const nx = -dy, ny = dx;
            emit(out, [
                ax + nx * hw, ay + ny * hw,
                bx + nx * hw, by + ny * hw,
                bx - nx * hw, by - ny * hw,
                ax - nx * hw, ay - ny * hw
            ]);
        }
        for (let i = 0; i < n; i++) {
            const last = !piece.closed && (i === 0 || i === n - 1);
            if (last) {
                // An endpoint: a cap, on the outside of the single segment that reaches it.
                const j = i === 0 ? 1 : n - 2;
                let dx = pts[i * 2] - pts[j * 2], dy = pts[i * 2 + 1] - pts[j * 2 + 1];
                const len = Math.sqrt(dx * dx + dy * dy);
                const cx = pts[i * 2], cy = pts[i * 2 + 1];
                if (len > 0) {
                    dx /= len;
                    dy /= len;
                }
                // A zero-length segment still paints a round cap: measured on the add-on,
                // moveTo(10,10); lineTo(10,10); stroke() with lineWidth 8 and a round cap fills
                // about 52 px, and that is how the glyph table draws a dot. A square cap has no
                // direction to extend along, so it paints nothing, and a butt cap never does.
                if (style.cap === 'round') {
                    emit(out, circle(cx, cy, hw));
                } else if (style.cap === 'square' && len > 0) {
                    const ex = cx + dx * hw, ey = cy + dy * hw;
                    const nx = -dy, ny = dx;
                    emit(out, [
                        cx + nx * hw, cy + ny * hw,
                        ex + nx * hw, ey + ny * hw,
                        ex - nx * hw, ey - ny * hw,
                        cx - nx * hw, cy - ny * hw
                    ]);
                }
                continue;
            }
            const prev = i === 0 ? n - 1 : i - 1;
            const next = i === n - 1 ? 0 : i + 1;
            const px = pts[prev * 2], py = pts[prev * 2 + 1];
            const cx = pts[i * 2], cy = pts[i * 2 + 1];
            const qx = pts[next * 2], qy = pts[next * 2 + 1];
            let d1x = cx - px, d1y = cy - py;
            let d2x = qx - cx, d2y = qy - cy;
            const l1 = Math.sqrt(d1x * d1x + d1y * d1y);
            const l2 = Math.sqrt(d2x * d2x + d2y * d2y);
            if (l1 === 0 || l2 === 0) continue;
            d1x /= l1; d1y /= l1;
            d2x /= l2; d2y /= l2;
            const n1x = -d1y, n1y = d1x;
            const n2x = -d2y, n2y = d2x;
            // Both corners of the join: the inner one is already covered, and covering it twice only
            // raises the winding, which the nonzero rule clamps away.
            emit(out, [cx, cy, cx + n1x * hw, cy + n1y * hw, cx + n2x * hw, cy + n2y * hw]);
            emit(out, [cx, cy, cx - n2x * hw, cy - n2y * hw, cx - n1x * hw, cy - n1y * hw]);
            if (style.join === 'round') {
                emit(out, circle(cx, cy, hw));
            } else if (style.join === 'miter') {
                const sx = n1x + n2x, sy = n1y + n2y;
                const s2 = sx * sx + sy * sy;
                if (s2 > 1e-12 && 2 / Math.sqrt(s2) <= style.miterLimit) {
                    const k = (2 * hw) / s2;
                    // Both sides: only the outer one is a corner that needs filling, but the inner one
                    // lies inside the quads already, so filling it too only raises the winding.
                    emit(out, [cx + n1x * hw, cy + n1y * hw, cx + sx * k, cy + sy * k, cx + n2x * hw, cy + n2y * hw]);
                    emit(out, [cx - n1x * hw, cy - n1y * hw, cx - sx * k, cy - sy * k, cx - n2x * hw, cy - n2y * hw]);
                }
            }
        }
    }
    return out;
}
