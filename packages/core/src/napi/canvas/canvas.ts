/**
 * The classes the add-on exports: Canvas, CanvasRenderingContext2d, CanvasGradient, CanvasPattern,
 * Image and ImageData, and the drawing pipeline behind them.
 *
 * Everything is pure JavaScript over one straight-RGBA pixel store. The pipeline for a fill or a stroke
 * is: transform the path to device space, rasterise its coverage into a scratch buffer, intersect that
 * coverage with the clip mask, and composite a colour per pixel -- the colour coming from a solid
 * colour, a gradient, a pattern or an image sampler, all of which answer in user space, so the caller
 * converts each device pixel centre back through the inverse of the current transformation matrix.
 *
 * Operations the shim refuses throw an Error whose message begins 'OWC_CANVAS_UNSUPPORTED' and are
 * named in MANIFEST.md; none of them silently draws nothing.
 */

import type { RGBA } from './color';
import { formatColor, parseColor, rgba } from './color';
import type { Mat } from './matrix';
import { clone as cloneMat, identity, invert, mat, matFrom, multiply, scaleOf } from './matrix';
import { PathBuilder, transformPath } from './path';
import type { DevicePath, SubPath } from './path';
import type { FillRule } from './raster';
import { Surface, gaussianBlur, compositePixel, rasterize, sampleSurface } from './raster';
import type { Paint, Repetition } from './paint';
import { LinearGradient, Pattern as PatternPaint, RadialGradient, SolidPaint } from './paint';
import { strokeOutline } from './stroke';
import type { StrokeStyle } from './stroke';
import type { TextMetrics } from './text';
import { alignOffset, baselineOffset, defaultFont, layoutText, parseFont, stemWidth } from './text';
import { encodePNG } from './png';
import { decodePNG } from './png-decode';
import { encodeJPEG } from './jpeg-enc';
import { decodeJPEG } from './jpeg-decode';

export interface NapiFileSystem {
    read(path: string): Uint8Array | undefined;
}

export interface BufferConstructorLike {
    from(data: ArrayBuffer, byteOffset?: number, length?: number): Uint8Array;
}

/** What createAddon() takes: the guest's Buffer and, for an Image src that is a file path, the filesystem. */
export interface CanvasAddonOptions {
    fs?: NapiFileSystem;
    Buffer?: BufferConstructorLike;
}

export function unsupported(what: string): Error {
    return new Error('OWC_CANVAS_UNSUPPORTED: ' + what);
}

/** The guest's macrotask queue, the one src/napi/bcrypt's AsyncWorker uses. */
declare function setImmediate(fn: () => void): void;

/**
 * One add-on instance serves one guest process, so the session the host handed createAddon() lives on
 * the module: the Buffer constructor, the filesystem, the DOMMatrix class index.js registers, and the
 * families registerFont() was called with.
 */
const SESSION: {
    fs: NapiFileSystem | undefined;
    Buffer: BufferConstructorLike | undefined;
    DOMMatrix: (new (init?: unknown) => { a: number; b: number; c: number; d: number; e: number; f: number }) | null;
    registered: { [family: string]: boolean };
} = { fs: undefined, Buffer: undefined, DOMMatrix: null, registered: {} };

/* ------------------------------------------------------------------ ImageData */

export class ImageData {
    readonly data: Uint8ClampedArray;
    readonly width: number;
    readonly height: number;

    constructor(a: number | ArrayBufferView, b?: number, c?: number) {
        if (typeof a === 'number') {
            this.width = Math.max(0, Math.floor(a));
            this.height = b === undefined ? 0 : Math.max(0, Math.floor(b));
            this.data = new Uint8ClampedArray(this.width * this.height * 4);
            return;
        }
        const bytes = a as ArrayBufferView;
        if (!bytes || typeof bytes.byteLength !== 'number') throw new TypeError('ImageData: data expected');
        const w = Math.max(0, Math.floor(b === undefined ? 0 : b));
        const per = w * 4;
        const h = c === undefined ? (per === 0 ? 0 : Math.floor(bytes.byteLength / per)) : Math.max(0, Math.floor(c));
        if (w * h * 4 > bytes.byteLength) throw new RangeError('source data is too small');
        this.width = w;
        this.height = h;
        if (bytes instanceof Uint8ClampedArray) {
            this.data = bytes;
        } else {
            const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            this.data = new Uint8ClampedArray(w * h * 4);
            this.data.set(view.subarray(0, w * h * 4));
        }
    }
}

/* ------------------------------------------------------------------ Canvas */

interface EncodeConfig {
    quality?: number;
    progressive?: boolean;
    resolution?: number;
    palette?: ArrayBufferView;
    compressionLevel?: number;
    filters?: number;
}

/** The add-on's own limit: cairo_dimension_t is a 16-bit integer, so 32767 is the largest side. */
const MAX_DIMENSION = 32767;

/**
 * What the add-on does with a dimension argument: ToUint32, so 3.7 truncates to 3, NaN and an
 * infinity give 0, and a negative value wraps to a huge one that then fails the limit below --
 * `createCanvas(-1, 4)` is refused with "Canvas width cannot exceed 32767" (measured).
 */
function toDimension(value: number): number {
    const truncated = Math.trunc(value);
    if (!isFinite(truncated)) return 0;
    const wrapped = truncated % 4294967296;
    return wrapped < 0 ? wrapped + 4294967296 : wrapped;
}

export class Canvas {
    private w: number;
    private h: number;
    readonly type = 'image';

    static readonly PNG_NO_FILTERS = 0;
    static readonly PNG_ALL_FILTERS = 248;
    static readonly PNG_FILTER_NONE = 8;
    static readonly PNG_FILTER_SUB = 16;
    static readonly PNG_FILTER_UP = 32;
    static readonly PNG_FILTER_AVG = 64;
    static readonly PNG_FILTER_PAETH = 128;

    private surface: Surface;

    constructor(width?: number, height?: number, type?: string) {
        if (type !== undefined && type !== null && type !== 'image') {
            throw unsupported(
                'canvas type ' + JSON.stringify(String(type)) + ' -- the shim renders image canvases only; ' +
                'it has no cairo PDF or SVG surface'
            );
        }
        // Both dimensions come from numbers, and the height is only read when the width was one:
        // createCanvas() is 0x0, createCanvas('20', 30) is 0x0 and createCanvas(20, '30') is 20x0.
        let w = 0;
        let h = 0;
        if (typeof width === 'number') {
            w = toDimension(width);
            if (typeof height === 'number') h = toDimension(height);
        }
        if (w > MAX_DIMENSION) throw new Error('Canvas width cannot exceed 32767');
        if (h > MAX_DIMENSION) throw new Error('Canvas height cannot exceed 32767');
        this.w = w;
        this.h = h;
        this.surface = new Surface(this.w, this.h);
    }

    /** Resizing: a number at most 32767 replaces the side, anything else is ignored (measured). */
    get width(): number {
        return this.w;
    }

    set width(value: number) {
        if (typeof value !== 'number') return;
        const next = toDimension(value);
        if (next > MAX_DIMENSION) return;
        this.w = next;
    }

    get height(): number {
        return this.h;
    }

    set height(value: number) {
        if (typeof value !== 'number') return;
        const next = toDimension(value);
        if (next > MAX_DIMENSION) return;
        this.h = next;
    }

    get stride(): number {
        return this.width * 4;
    }

    /** The pixel store the context draws into; resizing replaces it, as cairo recreates the surface. */
    pixels(): Surface {
        if (this.surface.width !== this.width || this.surface.height !== this.height) {
            this.surface = new Surface(this.width, this.height);
        }
        return this.surface;
    }

    private empty(): never {
        throw new Error('the surface type is not appropriate for the operation');
    }

    /** toBuffer(type?, config?) or toBuffer(cb, type?, config?) -- the add-on's two overloads. */
    toBuffer(a?: unknown, b?: unknown, c?: unknown): Uint8Array | undefined {
        if (typeof a === 'function') {
            const cb = a as (err: Error | null, result?: Uint8Array) => void;
            const type = typeof b === 'string' ? b : 'image/png';
            const config = (typeof b === 'object' && b !== null ? b : typeof c === 'object' && c !== null ? c : undefined) as EncodeConfig;
            setImmediate(() => {
                let out: Uint8Array | undefined;
                try {
                    out = this.encode(type, config);
                } catch (error) {
                    cb(error instanceof Error ? error : new Error(String(error)));
                    return;
                }
                cb(null, this.wrap(out));
            });
            return undefined;
        }
        const type = typeof a === 'string' ? a : 'image/png';
        const config = (typeof b === 'object' && b !== null ? b : undefined) as EncodeConfig;
        return this.wrap(this.encode(type, config));
    }

    /** Hand the page the guest's own Buffer, so toDataURL's buf.toString('base64') works. */
    private wrap(bytes: Uint8Array | undefined): Uint8Array | undefined {
        const B = SESSION.Buffer;
        if (!B || !bytes) return bytes;
        const copy = new Uint8Array(bytes.length);
        copy.set(bytes);
        return B.from(copy.buffer, copy.byteOffset, copy.byteLength);
    }

    private encode(type: string, config: EncodeConfig | undefined): Uint8Array | undefined {
        if (this.width === 0 || this.height === 0) this.empty();
        const t = (type || 'image/png').toLowerCase();
        if (t === 'image/png') {
            if (config && config.palette) {
                throw unsupported('PNG palette (indexed) output -- the shim always writes 8-bit RGBA');
            }
            return encodePNG(this.pixels().data, this.width, this.height, config && config.resolution);
        }
        if (t === 'image/jpeg') {
            const quality = config && typeof config.quality === 'number' ? config.quality : 0.75;
            if (config && config.progressive) {
                throw unsupported('progressive JPEG output -- the shim writes baseline JPEG only');
            }
            return encodeJPEG(this.pixels().data, this.width, this.height, quality);
        }
        if (t === 'raw') {
            const src = this.pixels().data;
            const out = new Uint8Array(src.length);
            // The add-on returns the cairo surface's own words: BGRA on a little-endian host, ARGB on a big one.
            for (let i = 0; i < src.length; i += 4) {
                out[i] = src[i + 2];
                out[i + 1] = src[i + 1];
                out[i + 2] = src[i];
                out[i + 3] = src[i + 3];
            }
            return out;
        }
        // A PDF canvas has no PDF surface to write: the add-on recognises both PDF mime types and
        // returns undefined for an image canvas, where the shim refuses with a named error.
        if (t === 'application/pdf' || t === 'image/pdf') throw unsupported('PDF output -- the shim has no PDF surface');
        // Anything else, as the add-on does: no image, and no error either.
        return undefined;
    }

    streamPNGSync(cb: (err: Error | null, chunk?: Uint8Array | null, len?: number) => void, config?: unknown): void {
        if (typeof cb !== 'function') throw new TypeError('callback function required');
        let bytes: Uint8Array;
        try {
            if (this.width === 0 || this.height === 0) this.empty();
            const cfg = config as EncodeConfig;
            if (cfg && cfg.palette) throw unsupported('PNG palette (indexed) output -- the shim always writes 8-bit RGBA');
            bytes = encodePNG(this.pixels().data, this.width, this.height, cfg && cfg.resolution);
        } catch (error) {
            cb(error instanceof Error ? error : new Error(String(error)));
            return;
        }
        const out = this.wrap(bytes) as Uint8Array;
        cb(null, out, out.length);
        cb(null, null, 0);
    }

    streamJPEGSync(config: unknown, cb: (err: Error | null, chunk?: Uint8Array | null) => void): void {
        if (typeof cb !== 'function') throw new TypeError('callback function required');
        let bytes: Uint8Array;
        try {
            if (this.width === 0 || this.height === 0) this.empty();
            const cfg = (config && typeof config === 'object' ? config : {}) as EncodeConfig;
            if (cfg.progressive) throw unsupported('progressive JPEG output -- the shim writes baseline JPEG only');
            bytes = encodeJPEG(this.pixels().data, this.width, this.height, typeof cfg.quality === 'number' ? cfg.quality : 0.75);
        } catch (error) {
            cb(error instanceof Error ? error : new Error(String(error)));
            return;
        }
        cb(null, this.wrap(bytes));
        cb(null, null);
    }

    streamPDFSync(): void {
        throw unsupported('PDF output -- the shim has no PDF surface');
    }

    /**
     * registerFont() cannot be honoured -- there is no font engine to load a file into -- so the family
     * is recorded and text drawn in it is refused rather than silently substituted.
     */
    static _registerFont(path: string, fontFace: { family?: string }): void {
        const family = String(fontFace && fontFace.family ? fontFace.family : '').toLowerCase();
        SESSION.registered[family] = true;
    }

    static _deregisterAllFonts(): void {
        SESSION.registered = {};
    }
}

/* ------------------------------------------------------------------ Image */

export class Image {
    static readonly MODE_IMAGE = 1;
    static readonly MODE_MIME = 2;

    width = 0;
    height = 0;
    dataMode = Image.MODE_IMAGE;
    onload: (() => void) | null = null;
    onerror: ((err: Error) => void) | null = null;

    private bitmap: Surface | null = null;
    private naturalW = 0;
    private naturalH = 0;
    private pending: unknown;
    /** Why the last source failed, for a caller that never set onerror. */
    lastError: Error | null = null;

    constructor() {
        this.pending = undefined;
    }

    get complete(): boolean {
        return this.pending === undefined;
    }

    get naturalWidth(): number {
        return this.naturalW;
    }

    get naturalHeight(): number {
        return this.naturalH;
    }

    /** The decoded bitmap, or null while the source is loading or failed to decode. */
    surface(): Surface | null {
        return this.bitmap;
    }

    /** SetSource.call(img, src) from lib/image.js: encoded bytes or a path. */
    setSource(src: unknown): void {
        this.pending = src;
        this.bitmap = null;
        this.width = 0;
        this.height = 0;
        this.naturalW = 0;
        this.naturalH = 0;
        setImmediate(() => this.load(src));
    }

    /** GetSource.call(img) from lib/image.js. */
    getSource(): unknown {
        return this.pending;
    }

    private load(src: unknown): void {
        let bytes: Uint8Array | undefined;
        if (src instanceof Uint8Array) bytes = src;
        else if (src && typeof src === 'object' && ArrayBuffer.isView(src)) {
            const v = src as ArrayBufferView;
            bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
        } else if (typeof src === 'string') {
            if (!SESSION.fs) {
                this.fail(new Error('OWC_CANVAS_IMAGE_UNREADABLE: an Image src that is a path needs the host filesystem'));
                return;
            }
            bytes = SESSION.fs.read(src);
        }
        if (bytes === undefined || bytes === null) {
            this.fail(new Error('OWC_CANVAS_IMAGE_UNREADABLE: the image source is neither bytes nor a readable path'));
            return;
        }
        let decoded: { width: number; height: number; data: Uint8Array };
        try {
            decoded = sniff(bytes);
        } catch (error) {
            this.fail(error instanceof Error ? error : new Error(String(error)));
            return;
        }
        this.bitmap = new Surface(decoded.width, decoded.height, new Uint8Array(decoded.data));
        this.naturalW = decoded.width;
        this.naturalH = decoded.height;
        this.width = decoded.width;
        this.height = decoded.height;
        this.pending = undefined;
        if (typeof this.onload === 'function') this.onload();
    }

    /**
     * A source that could not be read or decoded. With an onerror handler it is reported, as
     * lib/image.js asks; without one node-canvas leaves the image unloaded and complete (measured),
     * and the shim does the same rather than throw inside a macrotask, where nothing can catch it.
     */
    private fail(error: Error): void {
        this.pending = undefined;
        this.lastError = error;
        if (typeof this.onerror === 'function') this.onerror(error);
    }
}

/** Chooses a decoder from the magic bytes; anything else is a named refusal. */
function sniff(bytes: Uint8Array): { width: number; height: number; data: Uint8Array } {
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
        return decodePNG(bytes);
    }
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return decodeJPEG(bytes);
    }
    if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
        throw unsupported('GIF decoding -- the shim decodes PNG and baseline JPEG only');
    }
    if (bytes.length >= 5 && bytes[0] === 0x3c) {
        throw unsupported('SVG decoding -- the shim decodes PNG and baseline JPEG only');
    }
    if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
        throw unsupported('WebP decoding -- the shim decodes PNG and baseline JPEG only');
    }
    throw unsupported('image decoding -- the bytes are not a PNG or a baseline JPEG the shim can decode');
}

/* ------------------------------------------------------------------ gradient and pattern */

export class CanvasGradient {
    constructor(readonly paint: LinearGradient | RadialGradient) {}

    addColorStop(offset: number, color: string): void {
        const at = Number(offset);
        if (!isFinite(at) || at < 0 || at > 1) return;
        const parsed = parseColor(String(color));
        if (parsed === null) throw new TypeError('parse color failed');
        this.paint.add(at, parsed);
    }
}

export class CanvasPattern {
    constructor(readonly paint: PatternPaint) {}

    setTransform(transform?: unknown): void {
        this.paint.transform = transform === undefined || transform === null ? null : matFrom(transform);
    }
}

/* ------------------------------------------------------------------ the 2D context */

interface State {
    ctm: Mat;
    fill: Paint;
    stroke: Paint;
    globalAlpha: number;
    globalCompositeOperation: string;
    lineWidth: number;
    lineCap: string;
    lineJoin: string;
    miterLimit: number;
    dash: number[];
    dashOffset: number;
    font: ReturnType<typeof defaultFont>;
    textAlign: string;
    textBaseline: string;
    direction: string;
    lang: string;
    shadowColor: string;
    shadowColorRGBA: RGBA;
    shadowBlur: number;
    shadowOffsetX: number;
    shadowOffsetY: number;
    imageSmoothingEnabled: boolean;
    antialias: string;
    clip: Float32Array | null;
    /** True while the clip mask is shared with a state pushed by save(), so clip() must copy it first. */
    clipShared: boolean;
}

const COMPOSITE_OPS = [
    'clear', 'copy', 'destination', 'source-over', 'destination-over', 'source-in', 'destination-in',
    'source-out', 'destination-out', 'source-atop', 'destination-atop', 'xor', 'lighter', 'normal',
    'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light',
    'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity', 'saturate'
];

export class CanvasRenderingContext2d {
    canvas: Canvas;

    private path = new PathBuilder();
    private state: State = freshState();
    private stack: State[] = [];
    private cov: Float32Array | null = null;
    private rowBuf: Float32Array | null = null;
    private shadowBuf: Float32Array | null = null;

    constructor(canvas: Canvas) {
        this.canvas = canvas;
    }

    /* -------------------------------------------------- state */

    save(): void {
        const s = this.state;
        this.stack.push({ ...s, ctm: cloneMat(s.ctm), dash: s.dash.slice(), clip: s.clip });
        s.clipShared = true;
    }

    restore(): void {
        const prev = this.stack.pop();
        if (prev) this.state = prev;
    }

    get currentTransform(): unknown {
        return this.domMatrix(this.state.ctm);
    }

    set currentTransform(value: unknown) {
        const m = matFrom(value);
        if (m) this.state.ctm = m;
    }

    getTransform(): unknown {
        return this.domMatrix(this.state.ctm);
    }

    private domMatrix(m: Mat): unknown {
        const Ctor = SESSION.DOMMatrix;
        return Ctor ? new Ctor([m.a, m.b, m.c, m.d, m.e, m.f]) : cloneMat(m);
    }

    resetTransform(): void {
        this.state.ctm = identity();
    }

    setTransform(a?: unknown, b?: number, c?: number, d?: number, e?: number, f?: number): void {
        if (typeof a === 'number' && typeof b === 'number' && typeof c === 'number'
            && typeof d === 'number' && typeof e === 'number' && typeof f === 'number') {
            this.state.ctm = mat(a, b, c, d, e, f);
            return;
        }
        if (a === undefined || a === null) {
            this.state.ctm = identity();
            return;
        }
        const m = matFrom(a);
        if (m) this.state.ctm = m;
    }

    transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
        if (!finite6(a, b, c, d, e, f)) return;
        this.state.ctm = multiply(mat(a, b, c, d, e, f), this.state.ctm);
    }

    translate(x: number, y: number): void {
        if (!isFinite(x) || !isFinite(y)) return;
        this.state.ctm = multiply(mat(1, 0, 0, 1, x, y), this.state.ctm);
    }

    scale(x: number, y: number): void {
        if (!isFinite(x) || !isFinite(y)) return;
        this.state.ctm = multiply(mat(x, 0, 0, y, 0, 0), this.state.ctm);
    }

    rotate(angle: number): void {
        if (!isFinite(angle)) return;
        const cos = Math.cos(angle), sin = Math.sin(angle);
        this.state.ctm = multiply(mat(cos, sin, -sin, cos, 0, 0), this.state.ctm);
    }

    /* -------------------------------------------------- appearance */

    get fillStyle(): unknown {
        return this.styleOf(this.state.fill);
    }

    set fillStyle(value: unknown) {
        const set = this.setStyle(value);
        if (set) this.state.fill = set;
    }

    get strokeStyle(): unknown {
        return this.styleOf(this.state.stroke);
    }

    set strokeStyle(value: unknown) {
        const set = this.setStyle(value);
        if (set) this.state.stroke = set;
    }

    private styleOf(paint: Paint): unknown {
        return paint instanceof SolidPaint ? formatColor(paint.color) : paint;
    }

    /** A colour string becomes a SolidPaint, a gradient or pattern is used as it is, anything else is ignored. */
    private setStyle(value: unknown): Paint | null {
        if (typeof value === 'string') {
            const parsed = parseColor(value);
            return parsed === null ? null : new SolidPaint(parsed);
        }
        if (value instanceof CanvasGradient) return value.paint;
        if (value instanceof CanvasPattern) return value.paint;
        return null;
    }

    get globalAlpha(): number {
        return this.state.globalAlpha;
    }

    set globalAlpha(value: number) {
        const n = Number(value);
        if (!isFinite(n) || n < 0 || n > 1) return;
        this.state.globalAlpha = n;
    }

    get globalCompositeOperation(): string {
        return this.state.globalCompositeOperation;
    }

    set globalCompositeOperation(value: string) {
        if (typeof value !== 'string' || COMPOSITE_OPS.indexOf(value) < 0) return;
        this.state.globalCompositeOperation = value;
    }

    get lineWidth(): number {
        return this.state.lineWidth;
    }

    set lineWidth(value: number) {
        const n = Number(value);
        if (!isFinite(n) || n <= 0) return;
        this.state.lineWidth = n;
    }

    get lineCap(): string {
        return this.state.lineCap;
    }

    set lineCap(value: string) {
        if (value === 'butt' || value === 'round' || value === 'square') this.state.lineCap = value;
    }

    get lineJoin(): string {
        return this.state.lineJoin;
    }

    set lineJoin(value: string) {
        if (value === 'miter' || value === 'round' || value === 'bevel') this.state.lineJoin = value;
    }

    get miterLimit(): number {
        return this.state.miterLimit;
    }

    set miterLimit(value: number) {
        const n = Number(value);
        if (!isFinite(n) || n <= 0) return;
        this.state.miterLimit = n;
    }

    get lineDashOffset(): number {
        return this.state.dashOffset;
    }

    set lineDashOffset(value: number) {
        const n = Number(value);
        if (!isFinite(n)) return;
        this.state.dashOffset = n;
    }

    setLineDash(segments: readonly number[]): void {
        const out: number[] = [];
        if (Array.isArray(segments)) {
            for (let i = 0; i < segments.length; i++) {
                const n = Number(segments[i]);
                if (!isFinite(n) || n < 0) {
                    this.state.dash = [];
                    return;
                }
                out.push(n);
            }
        }
        // An odd-length pattern is repeated, which is what getLineDash() then reports.
        this.state.dash = out.length % 2 === 1 ? out.concat(out) : out;
    }

    getLineDash(): number[] {
        return this.state.dash.slice();
    }

    get font(): string {
        return this.state.font.text;
    }

    set font(value: string) {
        const parsed = parseFont(value);
        if (parsed) this.state.font = parsed;
    }

    get textAlign(): string {
        return this.state.textAlign;
    }

    set textAlign(value: string) {
        const allowed = ['start', 'end', 'left', 'right', 'center'];
        if (typeof value === 'string' && allowed.indexOf(value) >= 0) this.state.textAlign = value;
    }

    get textBaseline(): string {
        return this.state.textBaseline;
    }

    set textBaseline(value: string) {
        const allowed = ['top', 'hanging', 'middle', 'alphabetic', 'ideographic', 'bottom'];
        if (typeof value === 'string' && allowed.indexOf(value) >= 0) this.state.textBaseline = value;
    }

    get direction(): string {
        return this.state.direction;
    }

    set direction(value: string) {
        if (value === 'ltr' || value === 'rtl') this.state.direction = value;
    }

    get lang(): string {
        return this.state.lang;
    }

    set lang(value: string) {
        this.state.lang = String(value);
    }

    get shadowColor(): string {
        return this.state.shadowColor;
    }

    set shadowColor(value: string) {
        const parsed = parseColor(String(value));
        if (parsed === null) return;
        this.state.shadowColorRGBA = parsed;
        this.state.shadowColor = formatColor(parsed);
    }

    get shadowBlur(): number {
        return this.state.shadowBlur;
    }

    set shadowBlur(value: number) {
        const n = Number(value);
        if (!isFinite(n) || n < 0) return;
        this.state.shadowBlur = n;
    }

    get shadowOffsetX(): number {
        return this.state.shadowOffsetX;
    }

    set shadowOffsetX(value: number) {
        const n = Number(value);
        if (!isFinite(n)) return;
        this.state.shadowOffsetX = n;
    }

    get shadowOffsetY(): number {
        return this.state.shadowOffsetY;
    }

    set shadowOffsetY(value: number) {
        const n = Number(value);
        if (!isFinite(n)) return;
        this.state.shadowOffsetY = n;
    }

    get imageSmoothingEnabled(): boolean {
        return this.state.imageSmoothingEnabled;
    }

    set imageSmoothingEnabled(value: boolean) {
        this.state.imageSmoothingEnabled = !!value;
    }

    get antialias(): string {
        return this.state.antialias;
    }

    set antialias(value: string) {
        if (value === 'default' || value === 'gray' || value === 'none' || value === 'subpixel') this.state.antialias = value;
    }

    /** Accepted and ignored; the shim has one sampling quality, which MANIFEST.md records. */
    get quality(): string {
        return 'good';
    }

    set quality(value: string) {
        void value;
    }

    get patternQuality(): string {
        return 'good';
    }

    set patternQuality(value: string) {
        void value;
    }

    get textDrawingMode(): string {
        return 'path';
    }

    set textDrawingMode(value: string) {
        void value;
    }

    readonly pixelFormat = 'RGBA32';

    /* -------------------------------------------------- path */

    beginPath(): void {
        this.path = new PathBuilder();
    }

    closePath(): void {
        this.path.closePath();
    }

    moveTo(x: number, y: number): void {
        if (!isFinite(x) || !isFinite(y)) return;
        this.path.moveTo(x, y);
    }

    lineTo(x: number, y: number): void {
        if (!isFinite(x) || !isFinite(y)) return;
        this.path.lineTo(x, y);
    }

    bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void {
        if (!finite6(c1x, c1y, c2x, c2y, x, y)) return;
        this.path.bezierCurveTo(c1x, c1y, c2x, c2y, x, y);
    }

    quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
        if (!isFinite(cx) || !isFinite(cy) || !isFinite(x) || !isFinite(y)) return;
        this.path.quadraticCurveTo(cx, cy, x, y);
    }

    arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, counterclockwise?: boolean): void {
        if (!isFinite(x) || !isFinite(y) || !isFinite(radius) || !isFinite(startAngle) || !isFinite(endAngle)) return;
        if (radius < 0) throw new RangeError('The radius provided is negative.');
        this.path.arc(x, y, radius, startAngle, endAngle, !!counterclockwise);
    }

    arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void {
        if (!isFinite(x1) || !isFinite(y1) || !isFinite(x2) || !isFinite(y2) || !isFinite(radius)) return;
        // Unlike arc(), the add-on accepts a negative radius here (measured) and so does the shim.
        this.path.arcTo(x1, y1, x2, y2, radius);
    }

    ellipse(
        x: number, y: number, radiusX: number, radiusY: number, rotation: number,
        startAngle: number, endAngle: number, counterclockwise?: boolean
    ): void {
        if (!isFinite(x) || !isFinite(y) || !isFinite(radiusX) || !isFinite(radiusY)
            || !isFinite(rotation) || !isFinite(startAngle) || !isFinite(endAngle)) return;
        // The add-on accepts negative radii here too (measured).
        this.path.ellipse(x, y, radiusX, radiusY, rotation, startAngle, endAngle, !!counterclockwise);
    }

    rect(x: number, y: number, w: number, h: number): void {
        if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h)) return;
        this.path.rect(x, y, w, h);
    }

    roundRect(x: number, y: number, w: number, h: number, radii?: number | readonly number[]): void {
        if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h)) return;
        const list: number[] = typeof radii === 'number' ? [radii] : Array.isArray(radii) ? (radii as number[]).slice() : [];
        for (const r of list) {
            if (typeof r !== 'number' || !isFinite(r) || r < 0) throw new RangeError('radii must be positive.');
        }
        this.path.roundRect(x, y, w, h, list);
    }

    /* -------------------------------------------------- drawing */

    fill(fillRule?: string): void {
        const device = transformPath(this.path.subpaths, this.state.ctm);
        this.paintDevice(device, fillRule === 'evenodd' ? 'evenodd' : 'nonzero', this.state.fill);
    }

    stroke(): void {
        const device = transformPath(this.path.subpaths, this.state.ctm);
        this.paintDevice(strokeOutline(device, this.strokeSettings()), 'nonzero', this.state.stroke);
    }

    clip(fillRule?: string): void {
        const device = transformPath(this.path.subpaths, this.state.ctm);
        const surface = this.canvas.pixels();
        const buf = this.buffers();
        buf.cov.fill(0);
        rasterize(device, fillRule === 'evenodd' ? 'evenodd' : 'nonzero', surface.width, surface.height, buf.cov, buf.row);
        let clip = this.state.clip;
        if (clip === null) {
            clip = new Float32Array(buf.cov.length);
            clip.set(buf.cov);
        } else {
            if (this.state.clipShared) {
                clip = clip.slice();
                this.state.clipShared = false;
            }
            for (let i = 0; i < clip.length; i++) {
                const c = buf.cov[i];
                clip[i] = c <= 0 ? 0 : clip[i] * c;
            }
        }
        this.state.clip = clip;
    }

    fillRect(x: number, y: number, w: number, h: number): void {
        if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h)) return;
        this.paintDevice(transformPath([subRect(x, y, w, h)], this.state.ctm), 'nonzero', this.state.fill);
    }

    strokeRect(x: number, y: number, w: number, h: number): void {
        if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h)) return;
        this.paintDevice(strokeOutline(transformPath([subRect(x, y, w, h)], this.state.ctm), this.strokeSettings()), 'nonzero', this.state.stroke);
    }

    clearRect(x: number, y: number, w: number, h: number): void {
        if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h)) return;
        const saved = this.state.globalCompositeOperation;
        this.state.globalCompositeOperation = 'clear';
        this.paintDevice(transformPath([subRect(x, y, w, h)], this.state.ctm), 'nonzero', this.state.fill);
        this.state.globalCompositeOperation = saved;
    }

    private strokeSettings(): StrokeStyle {
        const s = this.state;
        return {
            width: this.strokeWidth(s.lineWidth),
            cap: s.lineCap as StrokeStyle['cap'],
            join: s.lineJoin as StrokeStyle['join'],
            miterLimit: s.miterLimit,
            dash: s.dash,
            dashOffset: s.dashOffset
        };
    }

    /**
     * A user-space length as a device length: exact under a uniform scale or a rotation, the geometric
     * mean of the two axis scales otherwise, where cairo's stroke would be sheared.
     */
    private strokeWidth(width: number): number {
        return width * scaleOf(this.state.ctm);
    }

    /* -------------------------------------------------- text */

    fillText(text: string, x: number, y: number, maxWidth?: number): void {
        this.drawText(String(text), x, y, maxWidth, this.state.fill, true);
    }

    strokeText(text: string, x: number, y: number, maxWidth?: number): void {
        this.drawText(String(text), x, y, maxWidth, this.state.stroke, false);
    }

    private drawText(text: string, x: number, y: number, maxWidth: number | undefined, paint: Paint, fill: boolean): void {
        if (!isFinite(x) || !isFinite(y)) return;
        const font = this.state.font;
        const family = font.family.toLowerCase().replace(/["']/g, '').split(',')[0].trim();
        if (family !== '' && SESSION.registered[family]) {
            throw unsupported(
                'FONT ' + JSON.stringify(font.family) + ' -- registerFont() cannot load a font into the guest, so ' +
                'text in a registered family is refused rather than drawn with the built-in font'
            );
        }
        const max = typeof maxWidth === 'number' && isFinite(maxWidth) ? maxWidth : undefined;
        const laid = layoutText(text, font, max);
        const dx = alignOffset(this.state.textAlign, laid.metrics.width, this.state.direction);
        const dy = baselineOffset(this.state.textBaseline, laid.metrics);
        const subpaths: SubPath[] = [];
        for (const stroke of laid.strokes) {
            const pts = stroke.slice();
            for (let i = 0; i < pts.length; i += 2) {
                pts[i] = pts[i] + x + dx;
                pts[i + 1] = y + dy - pts[i + 1];
            }
            subpaths.push({ pts: pts, closed: false });
        }
        if (subpaths.length === 0) return;
        const device = transformPath(subpaths, this.state.ctm);
        const style: StrokeStyle = {
            width: this.strokeWidth(fill ? stemWidth(font) : this.state.lineWidth),
            cap: 'round',
            join: 'round',
            miterLimit: this.state.miterLimit,
            dash: [],
            dashOffset: 0
        };
        this.paintDevice(strokeOutline(device, style), 'nonzero', paint);
    }

    measureText(text: string): TextMetrics {
        const size = this.state.font.size;
        const laid = layoutText(String(text), this.state.font);
        return {
            width: laid.metrics.width,
            actualBoundingBoxAscent: laid.metrics.actualBoundingBoxAscent,
            actualBoundingBoxDescent: laid.metrics.actualBoundingBoxDescent,
            actualBoundingBoxLeft: laid.metrics.actualBoundingBoxLeft,
            actualBoundingBoxRight: laid.metrics.actualBoundingBoxRight,
            emHeightAscent: laid.metrics.emHeightAscent,
            emHeightDescent: laid.metrics.emHeightDescent,
            alphabeticBaseline: size * 0.03
        };
    }

    /* -------------------------------------------------- images */

    createImageData(a: number | ArrayBufferView, b?: number, c?: number): ImageData {
        return new ImageData(a, b, c);
    }

    getImageData(sx: number, sy: number, sw: number, sh: number): ImageData {
        const w = Math.floor(Number(sw));
        const h = Math.floor(Number(sh));
        if (!isFinite(w) || !isFinite(h)) throw new RangeError('IndexSizeError');
        const out = new ImageData(Math.max(0, w), Math.max(0, h));
        const surface = this.canvas.pixels();
        const x0 = Math.floor(Number(sx));
        const y0 = Math.floor(Number(sy));
        for (let y = 0; y < out.height; y++) {
            const src = y0 + y;
            if (src < 0 || src >= surface.height) continue;
            for (let x = 0; x < out.width; x++) {
                const sxp = x0 + x;
                if (sxp < 0 || sxp >= surface.width) continue;
                const from = (src * surface.width + sxp) * 4;
                const to = (y * out.width + x) * 4;
                out.data[to] = surface.data[from];
                out.data[to + 1] = surface.data[from + 1];
                out.data[to + 2] = surface.data[from + 2];
                out.data[to + 3] = surface.data[from + 3];
            }
        }
        return out;
    }

    /** A direct write, as the spec has it: no transform, no alpha or composite, but the clip does apply. */
    putImageData(imageData: ImageData, dx: number, dy: number, dirtyX?: number, dirtyY?: number, dirtyWidth?: number, dirtyHeight?: number): void {
        // The add-on checks the instance: a plain {width, height, data} is refused (measured).
        if (!(imageData instanceof ImageData)) throw new TypeError('ImageData expected');
        const surface = this.canvas.pixels();
        let x0 = dirtyX === undefined ? 0 : Math.floor(Number(dirtyX));
        let y0 = dirtyY === undefined ? 0 : Math.floor(Number(dirtyY));
        let w = dirtyWidth === undefined ? imageData.width : Math.floor(Number(dirtyWidth));
        let h = dirtyHeight === undefined ? imageData.height : Math.floor(Number(dirtyHeight));
        if (x0 < 0) { w += x0; x0 = 0; }
        if (y0 < 0) { h += y0; y0 = 0; }
        w = Math.min(w, imageData.width - x0);
        h = Math.min(h, imageData.height - y0);
        const tx = Math.floor(Number(dx)) + x0;
        const ty = Math.floor(Number(dy)) + y0;
        const clip = this.state.clip;
        for (let y = 0; y < h; y++) {
            const dstY = ty + y;
            if (dstY < 0 || dstY >= surface.height) continue;
            for (let x = 0; x < w; x++) {
                const dstX = tx + x;
                if (dstX < 0 || dstX >= surface.width) continue;
                const at = dstY * surface.width + dstX;
                if (clip && clip[at] <= 0) continue;
                const from = ((y0 + y) * imageData.width + (x0 + x)) * 4;
                const to = at * 4;
                surface.data[to] = imageData.data[from];
                surface.data[to + 1] = imageData.data[from + 1];
                surface.data[to + 2] = imageData.data[from + 2];
                surface.data[to + 3] = imageData.data[from + 3];
            }
        }
    }

    /**
     * drawImage of a Canvas or an Image. All three argument forms become the same thing: the destination
     * rectangle, filled with a sampler that reads the source rectangle.
     */
    drawImage(image: unknown, a: number, b: number, c?: number, d?: number, e?: number, f?: number, g?: number, h?: number): void {
        const source = sourceSurface(image);
        if (source === null) {
            throw unsupported(
                'DRAWIMAGE: the source is neither a Canvas nor an Image with a decoded bitmap'
                + (image instanceof Image ? ' (its bytes were not a PNG or baseline JPEG the shim can decode)' : '')
            );
        }
        let sx = 0, sy = 0, sw = source.width, sh = source.height;
        let dx = 0, dy = 0, dw = sw, dh = sh;
        if (e !== undefined && g !== undefined) {
            sx = Number(a); sy = Number(b); sw = Number(c as number); sh = Number(d as number);
            dx = Number(e); dy = Number(f); dw = Number(g); dh = Number(h);
        } else if (c !== undefined && d !== undefined) {
            dx = Number(a); dy = Number(b); dw = Number(c); dh = Number(d);
        } else {
            dx = Number(a); dy = Number(b);
        }
        if (!finite8(sx, sy, sw, sh, dx, dy, dw, dh)) return;
        if (sw === 0 || sh === 0 || dw === 0 || dh === 0) return;
        const device = transformPath([subRect(dx, dy, dw, dh)], this.state.ctm);
        const smooth = this.state.imageSmoothingEnabled;
        const paint: Paint = {
            uniform: false,
            colorAt: (ux: number, uy: number): RGBA => {
                const u = sx + ((ux - dx) / dw) * sw;
                const v = sy + ((uy - dy) / dh) * sh;
                const c = sampleSurface(source, u, v, smooth);
                return rgba(c[0], c[1], c[2], c[3] * 255);
            }
        };
        this.paintDevice(device, 'nonzero', paint);
    }

    createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradient {
        return new CanvasGradient(new LinearGradient(Number(x0), Number(y0), Number(x1), Number(y1)));
    }

    createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): CanvasGradient {
        // The add-on accepts negative radii here (measured), and the cone equation is defined for them.
        return new CanvasGradient(new RadialGradient(Number(x0), Number(y0), Number(r0), Number(x1), Number(y1), Number(r1)));
    }

    createPattern(image: unknown, repetition?: string): CanvasPattern {
        const source = sourceSurface(image);
        if (source === null) throw unsupported('CREATEPATTERN: the source is neither a Canvas nor an Image with a decoded bitmap');
        const r = String(repetition === undefined || repetition === null ? 'repeat' : repetition);
        const rep: Repetition = r === 'repeat-x' || r === 'repeat-y' || r === 'no-repeat' ? r : 'repeat';
        return new CanvasPattern(new PatternPaint(source, rep, this.state.imageSmoothingEnabled));
    }

    isPointInPath(x: number, y: number, fillRule?: string): boolean {
        const device = transformPath(this.path.subpaths, this.state.ctm);
        return pointInPath(device, Number(x), Number(y), fillRule === 'evenodd' ? 'evenodd' : 'nonzero');
    }

    addPage(): void {
        throw new Error('only PDF canvases support .addPage()');
    }

    beginTag(): void {
        /* A tagged-PDF and SVG hook; an image canvas has nothing to tag. */
    }

    endTag(): void {
        /* See beginTag(). */
    }

    /* -------------------------------------------------- the pipeline */

    private buffers(): { cov: Float32Array; row: Float32Array } {
        const surface = this.canvas.pixels();
        const n = surface.width * surface.height;
        if (this.cov === null || this.cov.length !== n) this.cov = new Float32Array(n);
        if (this.rowBuf === null || this.rowBuf.length !== surface.width) this.rowBuf = new Float32Array(surface.width);
        this.cov.fill(0);
        return { cov: this.cov, row: this.rowBuf };
    }

    /**
     * Rasterises a device path and composites it. With a shadow set, the coverage is first offset,
     * blurred and composited in the shadow colour -- cairo does the same, with a Gaussian rather than
     * the three box passes the shim uses.
     */
    private paintDevice(device: DevicePath, rule: FillRule, paint: Paint): void {
        const surface = this.canvas.pixels();
        const w = surface.width, h = surface.height;
        if (w === 0 || h === 0 || device.length === 0) return;
        const buf = this.buffers();
        const cov = buf.cov;
        const box = rasterize(device, rule, w, h, cov, buf.row);
        if (box === null) return;
        const s = this.state;
        const clip = s.clip;
        const alpha = s.globalAlpha;
        const mode = s.globalCompositeOperation;
        const inv = invert(s.ctm);
        const flat = paint.uniform ? paint.colorAt(0, 0) : null;
        if (this.shadowWanted()) this.paintShadow(cov, w, h, clip);
        const x0 = Math.max(0, box.x0), x1 = Math.min(w, box.x1);
        const y0 = Math.max(0, box.y0), y1 = Math.min(h, box.y1);
        const none = s.antialias === 'none';
        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                const i = y * w + x;
                let c = cov[i];
                if (c <= 0) continue;
                if (none) c = c >= 0.5 ? 1 : 0;
                if (clip !== null) {
                    const k = clip[i];
                    if (k <= 0) continue;
                    c *= k;
                }
                if (c <= 0) continue;
                let color: RGBA;
                if (flat !== null) {
                    color = flat;
                } else if (inv !== null) {
                    const px = x + 0.5, py = y + 0.5;
                    color = paint.colorAt(inv.a * px + inv.c * py + inv.e, inv.b * px + inv.d * py + inv.f);
                } else {
                    color = paint.colorAt(x + 0.5, y + 0.5);
                }
                const sa = (color.a / 255) * c * alpha;
                if (sa <= 0 && mode !== 'clear' && mode !== 'copy') continue;
                compositePixel(surface.data, i * 4, color.r, color.g, color.b, sa, mode);
            }
        }
    }

    private shadowWanted(): boolean {
        const s = this.state;
        return s.shadowColorRGBA.a > 0 && (s.shadowBlur > 0 || s.shadowOffsetX !== 0 || s.shadowOffsetY !== 0);
    }

    private paintShadow(cov: Float32Array, w: number, h: number, clip: Float32Array | null): void {
        const s = this.state;
        const surface = this.canvas.pixels();
        if (this.shadowBuf === null || this.shadowBuf.length !== cov.length) this.shadowBuf = new Float32Array(cov.length);
        const shadow = this.shadowBuf;
        const ox = Math.round(s.shadowOffsetX);
        const oy = Math.round(s.shadowOffsetY);
        shadow.fill(0);
        for (let y = 0; y < h; y++) {
            const ty = y + oy;
            if (ty < 0 || ty >= h) continue;
            for (let x = 0; x < w; x++) {
                const tx = x + ox;
                if (tx < 0 || tx >= w) continue;
                shadow[ty * w + tx] = cov[y * w + x];
            }
        }
        const blurred = s.shadowBlur > 0 ? gaussianBlur(shadow, w, h, s.shadowBlur) : shadow;
        const color = s.shadowColorRGBA;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const i = y * w + x;
                let c = blurred[i];
                if (c <= 0) continue;
                if (clip !== null) {
                    const k = clip[i];
                    if (k <= 0) continue;
                    c *= k;
                }
                compositePixel(surface.data, i * 4, color.r, color.g, color.b, (color.a / 255) * c * s.globalAlpha, s.globalCompositeOperation);
            }
        }
    }
}

function finite6(a: number, b: number, c: number, d: number, e: number, f: number): boolean {
    return isFinite(a) && isFinite(b) && isFinite(c) && isFinite(d) && isFinite(e) && isFinite(f);
}

function finite8(a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number): boolean {
    return finite6(a, b, c, d, e, f) && isFinite(g) && isFinite(h);
}

function freshState(): State {
    return {
        ctm: identity(),
        fill: new SolidPaint(rgba(0, 0, 0, 255)),
        stroke: new SolidPaint(rgba(0, 0, 0, 255)),
        globalAlpha: 1,
        globalCompositeOperation: 'source-over',
        lineWidth: 1,
        lineCap: 'butt',
        lineJoin: 'miter',
        miterLimit: 10,
        dash: [],
        dashOffset: 0,
        font: defaultFont(),
        textAlign: 'start',
        textBaseline: 'alphabetic',
        direction: 'ltr',
        lang: '',
        shadowColor: 'rgba(255, 255, 255, 0.00)',
        shadowColorRGBA: rgba(255, 255, 255, 0),
        shadowBlur: 0,
        shadowOffsetX: 0,
        shadowOffsetY: 0,
        imageSmoothingEnabled: true,
        antialias: 'default',
        clip: null,
        clipShared: false
    };
}

function subRect(x: number, y: number, w: number, h: number): SubPath {
    return { pts: [x, y, x + w, y, x + w, y + h, x, y + h], closed: true };
}

/** The bitmap behind a drawImage or createPattern source. */
function sourceSurface(image: unknown): Surface | null {
    if (image instanceof Canvas) return image.pixels();
    if (image instanceof Image) return image.surface();
    return null;
}

/** Nonzero or even-odd point-in-polygon over the device-space path. */
function pointInPath(subpaths: readonly SubPath[], x: number, y: number, rule: FillRule): boolean {
    if (!isFinite(x) || !isFinite(y)) return false;
    let inside = false;
    let winding = 0;
    for (const sp of subpaths) {
        const pts = sp.pts;
        const n = pts.length >> 1;
        if (n < 2) continue;
        const count = sp.closed ? n : n - 1;
        for (let i = 0; i < count; i++) {
            const j = (i + 1) % n;
            const ax = pts[i * 2], ay = pts[i * 2 + 1];
            const bx = pts[j * 2], by = pts[j * 2 + 1];
            if (ay === by) continue;
            if (y < Math.min(ay, by) || y >= Math.max(ay, by)) continue;
            const t = (y - ay) / (by - ay);
            if (x < ax + t * (bx - ax)) continue;
            if (rule === 'evenodd') inside = !inside;
            else winding += by > ay ? 1 : -1;
        }
    }
    return rule === 'evenodd' ? inside : winding !== 0;
}

export { SESSION };
