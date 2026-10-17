/**
 * The pixel store and the rasteriser. A surface is straight (non-premultiplied) RGBA, which is what
 * getImageData, ImageData and the PNG encoder all want; compositing converts to premultiplied and back
 * inside one pixel at a time, as the CSS compositing and blending spec defines it.
 *
 * Antialiasing is 4 vertical sub-scanlines per pixel row with exact horizontal span integration, so
 * horizontal and vertical edges are exact and diagonal edges get four levels of grey. Cairo's
 * rasteriser is a 256-level analytic one, so the shim's edges differ from the add-on's by up to a
 * quarter of a pixel of coverage; that is recorded in MANIFEST.md rather than hidden.
 */

import type { SubPath } from './path';

export type FillRule = 'nonzero' | 'evenodd';

/** Vertical sub-samples per pixel row. */
const SUBS = 4;

/** A pixel store: width, height and straight RGBA bytes. */
export class Surface {
    readonly width: number;
    readonly height: number;
    readonly data: Uint8Array;

    constructor(width: number, height: number, data?: Uint8Array) {
        this.width = width;
        this.height = height;
        this.data = data ? data : new Uint8Array(width * height * 4);
    }

    get stride(): number {
        return this.width * 4;
    }
}

/**
 * Fills the coverage buffer with the path's coverage, one row per pixel row, and returns the device
 * bounding box of what it touched. Every subpath is treated as closed, as a fill always is.
 */
export function rasterize(
    subpaths: readonly SubPath[],
    rule: FillRule,
    width: number,
    height: number,
    cov: Float32Array,
    rowBuf: Float32Array
): { x0: number; y0: number; x1: number; y1: number } | null {
    let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
    const crossings: number[] = [];
    const dirs: number[] = [];
    let any = false;
    for (const sp of subpaths) {
        const pts = sp.pts;
        const n = pts.length >> 1;
        if (n === 0) continue;
        any = true;
        for (let i = 0; i < pts.length; i += 2) {
            const x = pts[i], y = pts[i + 1];
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
    }
    if (!any) return null;
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(height, Math.ceil(maxY) + 1);
    if (y1 <= y0 || maxX < 0 || minX >= width) return null;

    for (let y = y0; y < y1; y++) {
        for (let x = 0; x < width; x++) rowBuf[x] = 0;
        for (let s = 0; s < SUBS; s++) {
            const ys = y + (s + 0.5) / SUBS;
            crossings.length = 0;
            dirs.length = 0;
            for (const sp of subpaths) {
                const pts = sp.pts;
                const n = pts.length >> 1;
                const last = sp.closed ? n : n - 1;
                for (let i = 0; i < last; i++) {
                    const j = (i + 1) % n;
                    const ax = pts[i * 2], ay = pts[i * 2 + 1];
                    const bx = pts[j * 2], by = pts[j * 2 + 1];
                    if (ay === by) continue;
                    const lo = ay < by ? ay : by;
                    const hi = ay < by ? by : ay;
                    if (ys < lo || ys >= hi) continue;
                    const x = ax + ((ys - ay) * (bx - ax)) / (by - ay);
                    crossings.push(x);
                    dirs.push(by > ay ? 1 : -1);
                }
            }
            const m = crossings.length;
            if (m < 2) continue;
            const order = sortIndexes(crossings);
            if (rule === 'evenodd') {
                for (let i = 0; i + 1 < m; i += 2) {
                    addSpan(rowBuf, width, crossings[order[i]], crossings[order[i + 1]]);
                }
            } else {
                let w = 0;
                let start = 0;
                for (let i = 0; i < m; i++) {
                    const k = order[i];
                    const before = w;
                    w += dirs[k];
                    if (before === 0 && w !== 0) start = crossings[k];
                    else if (before !== 0 && w === 0) addSpan(rowBuf, width, start, crossings[k]);
                }
            }
        }
        const base = y * width;
        for (let x = 0; x < width; x++) {
            const c = rowBuf[x] / SUBS;
            cov[base + x] = c > 1 ? 1 : c;
        }
    }
    return { x0: Math.max(0, Math.floor(minX)), y0: y0, x1: Math.min(width, Math.ceil(maxX) + 1), y1: y1 };
}

/** Indexes of an array of x values, ascending -- enough crossings that a plain sort is fine. */
function sortIndexes(values: number[]): number[] {
    const idx: number[] = [];
    for (let i = 0; i < values.length; i++) idx.push(i);
    idx.sort((p, q) => (values[p] < values[q] ? -1 : values[p] > values[q] ? 1 : p - q));
    return idx;
}

function addSpan(row: Float32Array, width: number, from: number, to: number): void {
    let a = from < 0 ? 0 : from;
    let b = to > width ? width : to;
    if (b <= a) return;
    const ia = Math.floor(a);
    const ib = Math.ceil(b);
    if (ib - ia === 1) {
        row[ia < 0 ? 0 : ia] += b - a;
        return;
    }
    // Partial first and last pixels, whole pixels in between.
    const first = ia + 1 - a;
    if (ia >= 0 && ia < width) row[ia] += first > 1 ? 1 : first;
    for (let x = ia + 1; x < ib - 1; x++) if (x >= 0 && x < width) row[x] += 1;
    const last = b - (ib - 1);
    if (ib - 1 >= 0 && ib - 1 < width) row[ib - 1] += last > 1 ? 1 : last;
}

/* ------------------------------------------------------------------ compositing */

function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

function lum(r: number, g: number, b: number): number {
    return 0.3 * r + 0.59 * g + 0.11 * b;
}

function sat(r: number, g: number, b: number): number {
    return Math.max(r, g, b) - Math.min(r, g, b);
}

function setLum(r: number, g: number, b: number, l: number): [number, number, number] {
    const d = l - lum(r, g, b);
    return [clamp01(r + d), clamp01(g + d), clamp01(b + d)];
}

function setSat(r: number, g: number, b: number, s: number): [number, number, number] {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx === mn) return [0, 0, 0];
    const scale = (c: number): number => ((c - mn) * s) / (mx - mn);
    return [scale(r), scale(g), scale(b)];
}

/** The separable blend functions of the CSS compositing spec, on colours in [0,1]. */
function separable(mode: string, cb: number, cs: number): number {
    switch (mode) {
        case 'multiply': return cb * cs;
        case 'screen': return cb + cs - cb * cs;
        case 'overlay': return hardLight(cs, cb);
        case 'darken': return Math.min(cb, cs);
        case 'lighten': return Math.max(cb, cs);
        case 'color-dodge': return cs === 0 ? 0 : cs === 1 ? 1 : Math.min(1, cb / (1 - cs));
        case 'color-burn': return cs === 1 ? 1 : cs === 0 ? 0 : 1 - Math.min(1, (1 - cb) / cs);
        case 'hard-light': return hardLight(cb, cs);
        case 'soft-light': return softLight(cb, cs);
        case 'difference': return Math.abs(cb - cs);
        case 'exclusion': return cb + cs - 2 * cb * cs;
        default: return cs;
    }
}

function hardLight(cb: number, cs: number): number {
    return cs <= 0.5 ? cb * 2 * cs : 1 - (1 - cb) * (1 - 2 * (cs - 0.5));
}

function softLight(cb: number, cs: number): number {
    if (cs <= 0.5) return cb - (1 - 2 * cs) * cb * (1 - cb);
    const d = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb);
    return cb + (2 * cs - 1) * (d - cb);
}

const NONSEPARABLE: { readonly [mode: string]: boolean } = {
    hue: true, saturation: true, color: true, luminosity: true, saturate: true
};

export const BLEND_MODES: { readonly [mode: string]: boolean } = {
    multiply: true, screen: true, overlay: true, darken: true, lighten: true, 'color-dodge': true,
    'color-burn': true, 'hard-light': true, 'soft-light': true, difference: true, exclusion: true,
    hue: true, saturation: true, color: true, luminosity: true, saturate: true
};

/**
 * Composites one source pixel over one destination pixel. `sr/sg/sb` are straight 0..255, `sa` is
 * 0..1, and `mode` is a globalCompositeOperation the setter has already validated.
 */
export function compositePixel(
    data: Uint8Array,
    at: number,
    sr: number, sg: number, sb: number, sa: number,
    mode: string
): void {
    const dr = data[at] / 255, dg = data[at + 1] / 255, db = data[at + 2] / 255;
    const ab = data[at + 3] / 255;
    let or = 0, og = 0, ob = 0, oa = 0;
    // Cairo composites in 8 bits, so the source alpha it uses is a truncated alpha byte: this is what
    // makes 50% blue over opaque red come back as (128, 0, 127) rather than (127, 0, 128).
    sa = sa <= 0 ? 0 : sa >= 1 ? 1 : Math.round(sa * 255) / 255;

    if (mode === 'clear') {
        data[at] = 0; data[at + 1] = 0; data[at + 2] = 0; data[at + 3] = 0;
        return;
    }
    if (mode === 'copy') {
        write(data, at, sr, sg, sb, sa);
        return;
    }
    if (mode === 'destination') return;

    const cs0 = sr / 255, cs1 = sg / 255, cs2 = sb / 255;
    const pr = cs0 * sa, pg = cs1 * sa, pb = cs2 * sa;
    const qr = dr * ab, qg = dg * ab, qb = db * ab;

    switch (mode) {
        case 'source-over': case 'normal':
            or = pr + qr * (1 - sa); og = pg + qg * (1 - sa); ob = pb + qb * (1 - sa);
            oa = sa + ab * (1 - sa);
            break;
        case 'destination-over':
            or = qr + pr * (1 - ab); og = qg + pg * (1 - ab); ob = qb + pb * (1 - ab);
            oa = ab + sa * (1 - ab);
            break;
        case 'source-in':
            or = pr * ab; og = pg * ab; ob = pb * ab; oa = sa * ab;
            break;
        case 'destination-in':
            or = qr * sa; og = qg * sa; ob = qb * sa; oa = ab * sa;
            break;
        case 'source-out':
            or = pr * (1 - ab); og = pg * (1 - ab); ob = pb * (1 - ab); oa = sa * (1 - ab);
            break;
        case 'destination-out':
            or = qr * (1 - sa); og = qg * (1 - sa); ob = qb * (1 - sa); oa = ab * (1 - sa);
            break;
        case 'source-atop':
            or = pr * ab + qr * (1 - sa); og = pg * ab + qg * (1 - sa); ob = pb * ab + qb * (1 - sa);
            oa = ab;
            break;
        case 'destination-atop':
            or = qr * sa + pr * (1 - ab); og = qg * sa + pg * (1 - ab); ob = qb * sa + pb * (1 - ab);
            oa = sa;
            break;
        case 'xor':
            or = pr * (1 - ab) + qr * (1 - sa); og = pg * (1 - ab) + qg * (1 - sa);
            ob = pb * (1 - ab) + qb * (1 - sa);
            oa = sa + ab - 2 * sa * ab;
            break;
        case 'lighter':
            or = pr + qr; og = pg + qg; ob = pb + qb; oa = sa + ab;
            if (or > 1) or = 1;
            if (og > 1) og = 1;
            if (ob > 1) ob = 1;
            if (oa > 1) oa = 1;
            break;
        default: {
            if (!BLEND_MODES[mode]) {
                or = pr + qr * (1 - sa); og = pg + qg * (1 - sa); ob = pb + qb * (1 - sa);
                oa = sa + ab * (1 - sa);
                break;
            }
            let br = 0, bg = 0, bb = 0;
            if (NONSEPARABLE[mode]) {
                if (mode === 'hue') {
                    const s0 = setSat(cs0, cs1, cs2, sat(dr, dg, db));
                    const t = setLum(s0[0], s0[1], s0[2], lum(dr, dg, db));
                    br = t[0]; bg = t[1]; bb = t[2];
                } else if (mode === 'saturation' || mode === 'saturate') {
                    const s0 = setSat(dr, dg, db, sat(cs0, cs1, cs2));
                    const t = setLum(s0[0], s0[1], s0[2], lum(dr, dg, db));
                    br = t[0]; bg = t[1]; bb = t[2];
                } else if (mode === 'color') {
                    const t = setLum(cs0, cs1, cs2, lum(dr, dg, db));
                    br = t[0]; bg = t[1]; bb = t[2];
                } else {
                    const t = setLum(dr, dg, db, lum(cs0, cs1, cs2));
                    br = t[0]; bg = t[1]; bb = t[2];
                }
            } else {
                br = separable(mode, dr, cs0);
                bg = separable(mode, dg, cs1);
                bb = separable(mode, db, cs2);
            }
            or = cs0 * sa * (1 - ab) + br * sa * ab + dr * ab * (1 - sa);
            og = cs1 * sa * (1 - ab) + bg * sa * ab + dg * ab * (1 - sa);
            ob = cs2 * sa * (1 - ab) + bb * sa * ab + db * ab * (1 - sa);
            oa = sa + ab * (1 - sa);
            break;
        }
    }
    if (oa <= 0) {
        data[at] = 0; data[at + 1] = 0; data[at + 2] = 0; data[at + 3] = 0;
        return;
    }
    if (or > 1) or = 1;
    if (og > 1) og = 1;
    if (ob > 1) ob = 1;
    write(data, at, (or / oa) * 255, (og / oa) * 255, (ob / oa) * 255, oa);
}

function write(data: Uint8Array, at: number, r: number, g: number, b: number, a: number): void {
    data[at] = r < 0 ? 0 : r > 255 ? 255 : r + 0.5 | 0;
    data[at + 1] = g < 0 ? 0 : g > 255 ? 255 : g + 0.5 | 0;
    data[at + 2] = b < 0 ? 0 : b > 255 ? 255 : b + 0.5 | 0;
    data[at + 3] = a < 0 ? 0 : a > 1 ? 255 : a * 255 + 0.5 | 0;
}

/* ------------------------------------------------------------------ shadows */

/**
 * A separable Gaussian of sigma = shadowBlur / 2, which is what the canvas shadow spec asks for. The
 * kernel is truncated at the radius the CSS filter spec derives from sigma, so the shadow spreads about
 * as far as cairo's does; cairo's is the same Gaussian, so only the truncation radius differs.
 */
export function gaussianBlur(src: Float32Array, width: number, height: number, blur: number): Float32Array {
    if (blur <= 0) return src;
    const sigma = blur / 2;
    const radius = Math.max(1, Math.round((3 * sigma * Math.sqrt(2 * Math.PI)) / 4));
    const size = 2 * radius + 1;
    const kernel = new Float32Array(size);
    let sum = 0;
    for (let i = 0; i < size; i++) {
        const d = i - radius;
        const v = Math.exp(-(d * d) / (2 * sigma * sigma));
        kernel[i] = v;
        sum += v;
    }
    for (let i = 0; i < size; i++) kernel[i] /= sum;
    const tmp = new Float32Array(src.length);
    const out = new Float32Array(src.length);
    for (let y = 0; y < height; y++) {
        const base = y * width;
        for (let x = 0; x < width; x++) {
            let acc = 0;
            for (let i = 0; i < size; i++) acc += src[base + clampIndex(x + i - radius, width)] * kernel[i];
            tmp[base + x] = acc;
        }
    }
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let acc = 0;
            for (let i = 0; i < size; i++) acc += tmp[clampIndex(y + i - radius, height) * width + x] * kernel[i];
            out[y * width + x] = acc;
        }
    }
    return out;
}

function clampIndex(i: number, n: number): number {
    return i < 0 ? 0 : i >= n ? n - 1 : i;
}

/** Bilinear sample of an RGBA byte surface at a real-valued position; outside is transparent. */
export function sampleSurface(
    s: Surface, x: number, y: number, smooth: boolean
): [number, number, number, number] {
    if (!smooth) {
        const ix = Math.floor(x), iy = Math.floor(y);
        if (ix < 0 || iy < 0 || ix >= s.width || iy >= s.height) return [0, 0, 0, 0];
        const at = (iy * s.width + ix) * 4;
        return [s.data[at], s.data[at + 1], s.data[at + 2], s.data[at + 3] / 255];
    }
    const x0 = Math.floor(x - 0.5), y0 = Math.floor(y - 0.5);
    const fx = x - 0.5 - x0, fy = y - 0.5 - y0;
    let r = 0, g = 0, b = 0, a = 0;
    for (let j = 0; j < 2; j++) {
        for (let i = 0; i < 2; i++) {
            const ix = x0 + i, iy = y0 + j;
            if (ix < 0 || iy < 0 || ix >= s.width || iy >= s.height) continue;
            const w0 = (i === 0 ? 1 - fx : fx) * (j === 0 ? 1 - fy : fy);
            const at = (iy * s.width + ix) * 4;
            const pa = s.data[at + 3] / 255;
            r += s.data[at] * pa * w0;
            g += s.data[at + 1] * pa * w0;
            b += s.data[at + 2] * pa * w0;
            a += pa * w0;
        }
    }
    if (a <= 0) return [0, 0, 0, 0];
    return [r / a, g / a, b / a, a];
}
