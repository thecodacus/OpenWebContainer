/**
 * The current path, in user space, flattened to polylines as it is built. node-canvas keeps the path in
 * cairo (gpc/cairo_path_t) and flattens it at fill or stroke time; the shim flattens each curve when it
 * is added, which is the same result for every curve the 2D context can express, at a fixed subdivision
 * count chosen from the control polygon rather than from a tolerance.
 */

import type { Mat } from './matrix';
import { applyX, applyY } from './matrix';

const TWO_PI = Math.PI * 2;

/** One subpath: a flat [x0,y0,x1,y1,...] polyline and whether closePath() closed it. */
export interface SubPath {
    pts: number[];
    closed: boolean;
}

/** A path in device space, ready to be filled or stroked. */
export type DevicePath = SubPath[];

export function subPath(pts: number[], closed: boolean): SubPath {
    return { pts: pts, closed: closed };
}

export class PathBuilder {
    readonly subpaths: SubPath[] = [];
    private current: SubPath | null = null;

    private start(x: number, y: number): SubPath {
        const sp = subPath([x, y], false);
        this.subpaths.push(sp);
        this.current = sp;
        return sp;
    }

    private ensure(x: number, y: number): SubPath {
        if (this.current === null) return this.start(x, y);
        return this.current;
    }

    private push(x: number, y: number): void {
        const sp = this.ensure(x, y);
        sp.pts.push(x, y);
    }

    /** The last point, or null when the path is empty -- what the spec calls the current point. */
    lastPoint(): [number, number] | null {
        const sp = this.current;
        if (sp === null || sp.pts.length < 2) return null;
        return [sp.pts[sp.pts.length - 2], sp.pts[sp.pts.length - 1]];
    }

    isEmpty(): boolean {
        return this.subpaths.length === 0;
    }

    moveTo(x: number, y: number): void {
        this.start(x, y);
    }

    lineTo(x: number, y: number): void {
        if (this.current === null) this.start(x, y);
        else this.current.pts.push(x, y);
    }

    closePath(): void {
        if (this.current === null) return;
        this.current.closed = true;
        // Per spec, closePath() leaves the current point at the start of the closed subpath and the
        // *next* lineTo starts a new subpath there.
        const pts = this.current.pts;
        this.current = subPath([pts[0], pts[1]], false);
        this.subpaths.push(this.current);
    }

    bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void {
        const from = this.lastPoint();
        if (from === null) {
            this.start(c1x, c1y);
        }
        const p0 = from === null ? [c1x, c1y] : from;
        const steps = curveSteps(p0[0], p0[1], c1x, c1y, c2x, c2y, x, y);
        const target = this.current === null ? this.start(p0[0], p0[1]) : this.current;
        for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            const u = 1 - t;
            const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
            target.pts.push(
                a * p0[0] + b * c1x + c * c2x + d * x,
                a * p0[1] + b * c1y + c * c2y + d * y
            );
        }
    }

    quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
        const from = this.lastPoint();
        if (from === null) {
            this.start(cx, cy);
        }
        const p0 = from === null ? [cx, cy] : from;
        const steps = curveSteps(p0[0], p0[1], cx, cy, cx, cy, x, y);
        const target = this.current === null ? this.start(p0[0], p0[1]) : this.current;
        for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            const u = 1 - t;
            target.pts.push(u * u * p0[0] + 2 * u * t * cx + t * t * x, u * u * p0[1] + 2 * u * t * cy + t * t * y);
        }
    }

    /** Half a pixel of curve is enough: the subdivision count comes from the control polygon's length. */
    arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, counterclockwise: boolean): void {
        let delta = endAngle - startAngle;
        if (!counterclockwise) {
            if (delta >= TWO_PI) delta = TWO_PI;
            else if (delta < 0) delta += TWO_PI * Math.ceil(-delta / TWO_PI);
        } else {
            if (-delta >= TWO_PI) delta = -TWO_PI;
            else if (delta > 0) delta -= TWO_PI * Math.ceil(delta / TWO_PI);
        }
        const steps = Math.max(6, Math.ceil((Math.abs(delta) / TWO_PI) * 96));
        const sx = x + radius * Math.cos(startAngle);
        const sy = y + radius * Math.sin(startAngle);
        if (this.current === null) this.start(sx, sy);
        else this.current.pts.push(sx, sy);
        const target = this.current as SubPath;
        for (let i = 1; i <= steps; i++) {
            const angle = startAngle + (delta * i) / steps;
            target.pts.push(x + radius * Math.cos(angle), y + radius * Math.sin(angle));
        }
    }

    /**
     * The corner-fillet arc of arcTo(): the circle of the given radius tangent to both segments, added
     * after a line to its first tangent point, as the spec describes.
     */
    arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void {
        const p0 = this.lastPoint();
        if (p0 === null) return;
        const v1x = p0[0] - x1, v1y = p0[1] - y1;
        const v2x = x2 - x1, v2y = y2 - y1;
        const n1 = Math.sqrt(v1x * v1x + v1y * v1y);
        const n2 = Math.sqrt(v2x * v2x + v2y * v2y);
        if (n1 === 0 || n2 === 0 || radius === 0) {
            this.lineTo(x1, y1);
            return;
        }
        const u1x = v1x / n1, u1y = v1y / n1;
        const u2x = v2x / n2, u2y = v2y / n2;
        let cos = u1x * u2x + u1y * u2y;
        if (cos > 1) cos = 1;
        else if (cos < -1) cos = -1;
        const theta = Math.acos(cos);
        if (theta === 0 || Math.abs(theta - Math.PI) < 1e-9) {
            this.lineTo(x1, y1);
            return;
        }
        const tangent = radius / Math.tan(theta / 2);
        const t1x = x1 + u1x * tangent, t1y = y1 + u1y * tangent;
        const t2x = x1 + u2x * tangent, t2y = y1 + u2y * tangent;
        const bx = u1x + u2x, by = u1y + u2y;
        const bn = Math.sqrt(bx * bx + by * by);
        const cx = x1 + (bx / bn) * (radius / Math.sin(theta / 2));
        const cy = y1 + (by / bn) * (radius / Math.sin(theta / 2));
        const startAngle = Math.atan2(t1y - cy, t1x - cx);
        const endAngle = Math.atan2(t2y - cy, t2x - cx);
        const cross = v1x * v2y - v1y * v2x;
        this.lineTo(t1x, t1y);
        this.arc(cx, cy, radius, startAngle, endAngle, cross < 0);
    }

    ellipse(
        x: number, y: number, radiusX: number, radiusY: number, rotation: number,
        startAngle: number, endAngle: number, counterclockwise: boolean
    ): void {
        let delta = endAngle - startAngle;
        if (!counterclockwise) {
            if (delta >= TWO_PI) delta = TWO_PI;
            else if (delta < 0) delta += TWO_PI * Math.ceil(-delta / TWO_PI);
        } else {
            if (-delta >= TWO_PI) delta = -TWO_PI;
            else if (delta > 0) delta -= TWO_PI * Math.ceil(delta / TWO_PI);
        }
        const cosR = Math.cos(rotation), sinR = Math.sin(rotation);
        const steps = Math.max(6, Math.ceil((Math.abs(delta) / TWO_PI) * 96));
        const px = (a: number): number => x + radiusX * Math.cos(a) * cosR - radiusY * Math.sin(a) * sinR;
        const py = (a: number): number => y + radiusX * Math.cos(a) * sinR + radiusY * Math.sin(a) * cosR;
        const sx = px(startAngle), sy = py(startAngle);
        if (this.current === null) this.start(sx, sy);
        else this.current.pts.push(sx, sy);
        const target = this.current as SubPath;
        for (let i = 1; i <= steps; i++) {
            const angle = startAngle + (delta * i) / steps;
            target.pts.push(px(angle), py(angle));
        }
    }

    /** rect(): a closed subpath, then -- per spec -- a new subpath whose first point is (x, y). */
    rect(x: number, y: number, w: number, h: number): void {
        const sp = subPath([x, y, x + w, y, x + w, y + h, x, y + h], true);
        this.subpaths.push(sp);
        this.current = subPath([x, y], false);
        this.subpaths.push(this.current);
    }

    roundRect(x: number, y: number, w: number, h: number, radii: readonly number[]): void {
        const r = cornerRadii(radii, w, h);
        const tl = r[0], tr = r[1], br = r[2], bl = r[3];
        const sp = subPath([], true);
        const pts = sp.pts;
        if (tl > 0) arcInto(pts, x + tl, y + tl, tl, Math.PI, 1.5 * Math.PI, false);
        else pts.push(x, y);
        if (tr > 0) arcInto(pts, x + w - tr, y + tr, tr, 1.5 * Math.PI, TWO_PI, false);
        else pts.push(x + w, y);
        if (br > 0) arcInto(pts, x + w - br, y + h - br, br, 0, 0.5 * Math.PI, false);
        else pts.push(x + w, y + h);
        if (bl > 0) arcInto(pts, x + bl, y + h - bl, bl, 0.5 * Math.PI, Math.PI, false);
        else pts.push(x, y + h);
        this.subpaths.push(sp);
        this.current = subPath([x, y], false);
        this.subpaths.push(this.current);
    }
}

/** The four corner radii of roundRect, in the spec's order (top-left, top-right, bottom-right, bottom-left). */
function cornerRadii(radii: readonly number[], w: number, h: number): number[] {
    let list: number[] = [];
    for (let i = 0; i < radii.length && i < 4; i++) {
        const v = radii[i];
        list.push(typeof v === 'number' && isFinite(v) && v > 0 ? v : 0);
    }
    if (list.length === 0) list = [0];
    const out: number[] = [];
    for (let i = 0; i < 4; i++) out.push(list[i % list.length]);
    // The spec scales every radius down by the same factor when the corners would overlap.
    let scale = 1;
    for (let i = 0; i < 4; i++) {
        const a = out[i], b = out[(i + 1) % 4];
        const side = i % 2 === 0 ? w : h;
        if (a + b > side && a + b > 0) scale = Math.min(scale, side / (a + b));
    }
    for (let i = 0; i < 4; i++) out[i] = out[i] * scale;
    return out;
}

function arcInto(pts: number[], cx: number, cy: number, r: number, from: number, to: number, ccw: boolean): void {
    const steps = 12;
    for (let i = 0; i <= steps; i++) {
        const angle = from + ((to - from) * i) / steps;
        pts.push(cx + r * Math.cos(angle), cy + r * Math.sin(angle));
    }
}

/** Cubic subdivision count from the control polygon: ~2 user units per segment, 6..96. */
function curveSteps(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): number {
    const chord = Math.sqrt((x3 - x0) * (x3 - x0) + (y3 - y0) * (y3 - y0));
    const net =
        Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0)) +
        Math.sqrt((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1)) +
        Math.sqrt((x3 - x2) * (x3 - x2) + (y3 - y2) * (y3 - y2));
    const n = Math.ceil(Math.max(chord, net) / 2);
    return n < 6 ? 6 : n > 96 ? 96 : n;
}

/** The path in device space: every point through the current transformation matrix. */
export function transformPath(subpaths: readonly SubPath[], m: Mat): DevicePath {
    const out: SubPath[] = [];
    for (const sp of subpaths) {
        const pts = sp.pts;
        const n = pts.length >> 1;
        const t = new Array<number>(pts.length);
        for (let i = 0; i < n; i++) {
            const x = pts[i * 2], y = pts[i * 2 + 1];
            t[i * 2] = applyX(m, x, y);
            t[i * 2 + 1] = applyY(m, x, y);
        }
        out.push(subPath(t, sp.closed));
    }
    return out;
}

/** The device-space bounding box of a path, inflated by pad. */
export function boundsOf(subpaths: readonly SubPath[]): { x0: number; y0: number; x1: number; y1: number } | null {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const sp of subpaths) {
        const pts = sp.pts;
        for (let i = 0; i < pts.length; i += 2) {
            if (pts[i] < x0) x0 = pts[i];
            if (pts[i] > x1) x1 = pts[i];
            if (pts[i + 1] < y0) y0 = pts[i + 1];
            if (pts[i + 1] > y1) y1 = pts[i + 1];
        }
    }
    if (x0 === Infinity) return null;
    return { x0: x0, y0: y0, x1: x1, y1: y1 };
}
