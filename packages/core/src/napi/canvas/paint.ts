/**
 * The three paints a fillStyle or strokeStyle can hold besides a colour: a linear gradient, a radial
 * gradient and a pattern. A paint answers `colorAt(x, y)` for a point in **user space**, so the caller
 * converts each device pixel centre back through the inverse of the current transformation matrix and
 * the paint itself needs no matrix. Gradient coordinates therefore follow the spec: they are in the
 * user space of the drawing operation, not of the gradient's creation.
 *
 * Stops are interpolated in premultiplied space (mixColor), which is what the canvas gradient spec asks
 * for and what cairo does. Cairo also extends the first and last stop's colour past 0 and 1, which the
 * shim copies. The radial solution takes the larger root of the cone equation, the branch the spec
 * describes; where no real root exists the first stop's colour is used.
 */

import type { RGBA } from './color';
import { cloneColor, mixColor, rgba } from './color';
import type { Mat } from './matrix';
import { invert } from './matrix';
import type { Surface } from './raster';
import { sampleSurface } from './raster';

export interface Paint {
    /** The paint's colour at a user-space point. */
    colorAt(x: number, y: number): RGBA;
    /** True when the paint is the same colour everywhere, which lets the renderer skip per-pixel work. */
    readonly uniform: boolean;
}

export interface Stop {
    offset: number;
    color: RGBA;
}

function stopsAt(stops: readonly Stop[], t: number): RGBA {
    const n = stops.length;
    if (n === 0) return rgba(0, 0, 0, 0);
    if (t <= stops[0].offset) return cloneColor(stops[0].color);
    if (t >= stops[n - 1].offset) return cloneColor(stops[n - 1].color);
    for (let i = 0; i + 1 < n; i++) {
        const a = stops[i], b = stops[i + 1];
        if (t >= a.offset && t <= b.offset) {
            const span = b.offset - a.offset;
            return span <= 0 ? cloneColor(b.color) : mixColor(a.color, b.color, (t - a.offset) / span);
        }
    }
    return cloneColor(stops[n - 1].color);
}

export class SolidPaint implements Paint {
    readonly uniform = true;
    readonly color: RGBA;

    constructor(color: RGBA) {
        this.color = color;
    }

    colorAt(): RGBA {
        return this.color;
    }
}

export class LinearGradient implements Paint {
    readonly uniform = false;
    stops: Stop[] = [];

    constructor(private x0: number, private y0: number, private x1: number, private y1: number) {}

    add(offset: number, color: RGBA): void {
        const at: Stop = { offset: offset, color: color };
        let i = this.stops.length;
        while (i > 0 && this.stops[i - 1].offset > offset) i--;
        this.stops.splice(i, 0, at);
    }

    colorAt(x: number, y: number): RGBA {
        const dx = this.x1 - this.x0, dy = this.y1 - this.y0;
        const len2 = dx * dx + dy * dy;
        if (len2 === 0) return stopsAt(this.stops, 1);
        const t = ((x - this.x0) * dx + (y - this.y0) * dy) / len2;
        return stopsAt(this.stops, t);
    }
}

export class RadialGradient implements Paint {
    readonly uniform = false;
    stops: Stop[] = [];

    constructor(
        private x0: number, private y0: number, private r0: number,
        private x1: number, private y1: number, private r1: number
    ) {}

    add(offset: number, color: RGBA): void {
        const at: Stop = { offset: offset, color: color };
        let i = this.stops.length;
        while (i > 0 && this.stops[i - 1].offset > offset) i--;
        this.stops.splice(i, 0, at);
    }

    colorAt(x: number, y: number): RGBA {
        const dx = this.x1 - this.x0, dy = this.y1 - this.y0;
        const dr = this.r1 - this.r0;
        const qx = x - this.x0, qy = y - this.y0;
        const a = dx * dx + dy * dy - dr * dr;
        const b = -2 * (qx * dx + qy * dy + this.r0 * dr);
        const c = qx * qx + qy * qy - this.r0 * this.r0;
        let t: number;
        if (Math.abs(a) < 1e-12) {
            if (Math.abs(b) < 1e-12) return stopsAt(this.stops, 0);
            t = -c / b;
        } else {
            const disc = b * b - 4 * a * c;
            if (disc < 0) return stopsAt(this.stops, 0);
            const root = Math.sqrt(disc);
            const t1 = (-b + root) / (2 * a);
            const t2 = (-b - root) / (2 * a);
            t = t1 > t2 ? t1 : t2;
        }
        return stopsAt(this.stops, t);
    }
}

export type Repetition = 'repeat' | 'repeat-x' | 'repeat-y' | 'no-repeat';

export class Pattern implements Paint {
    readonly uniform = false;
    transform: Mat | null = null;

    constructor(private surface: Surface, private repetition: Repetition, private smooth: boolean) {}

    colorAt(x: number, y: number): RGBA {
        let px = x, py = y;
        if (this.transform) {
            const inv = invert(this.transform);
            if (inv === null) return rgba(0, 0, 0, 0);
            px = inv.a * x + inv.c * y + inv.e;
            py = inv.b * x + inv.d * y + inv.f;
        }
        const w = this.surface.width, h = this.surface.height;
        if (w === 0 || h === 0) return rgba(0, 0, 0, 0);
        let sx = px, sy = py;
        if (this.repetition === 'repeat' || this.repetition === 'repeat-x') sx = wrap(sx, w);
        if (this.repetition === 'repeat' || this.repetition === 'repeat-y') sy = wrap(sy, h);
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) return rgba(0, 0, 0, 0);
        const c = sampleSurface(this.surface, sx, sy, this.smooth);
        return rgba(c[0], c[1], c[2], c[3] * 255);
    }
}

function wrap(v: number, n: number): number {
    const m = v % n;
    return m < 0 ? m + n : m;
}
