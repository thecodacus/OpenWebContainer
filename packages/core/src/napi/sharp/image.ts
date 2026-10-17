/*
 * The pixel operations of the sharp shim: an image is 8-bit unsigned, interleaved, row-major from the top
 * left, of 1 (grey), 2 (grey and alpha), 3 (sRGB) or 4 (sRGB and alpha) channels, never premultiplied.
 *
 * This is the part libvips does with SIMD and a thread pool; here it is plain JavaScript, and the numbers
 * are the ones vips_shrink/vips_reduce produce: an integer box average for the whole part of a reduction,
 * then the named kernel for what is left, with the kernel widened by the reduce factor. A resample is
 * separable, so a resize runs across rows and then down columns.
 */
/** The only band counts an image can have, which is also what the codecs' own Image type allows. */
export type ChannelCount = 1 | 2 | 3 | 4;

export interface Image {
    width: number;
    height: number;
    /** 1 grey, 2 grey and alpha, 3 sRGB, 4 sRGB and alpha. */
    channels: ChannelCount;
    data: Uint8Array;
}

export function createImage(width: number, height: number, channels: ChannelCount, fill?: number): Image {
    const data = new Uint8Array(width * height * channels);
    if (fill !== undefined) data.fill(fill);
    return { width, height, channels, data };
}

export function cloneImage(image: Image): Image {
    return { width: image.width, height: image.height, channels: image.channels, data: image.data.slice() };
}

/** Copy `src` into `dst` at (left, top); the parts of `src` outside `dst` are dropped. */
export function blit(dst: Image, src: Image, left: number, top: number): void {
    const w = Math.min(src.width, dst.width - left);
    const h = Math.min(src.height, dst.height - top);
    for (let y = 0; y < h; y++) {
        const from = (y * src.width) * src.channels;
        const to = ((y + top) * dst.width + left) * dst.channels;
        dst.data.set(src.data.subarray(from, from + w * src.channels), to);
    }
}

/* ------------------------------------------------------------------ kernels */

interface Kernel {
    /** Half the width of the filter before it is widened by the reduce factor. */
    support: number;
    weight: (x: number) => number;
}

const sinc = (x: number): number => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));

function lanczos(a: number): Kernel {
    return { support: a, weight: (x) => (Math.abs(x) < a ? sinc(x) * sinc(x / a) : 0) };
}

/** Catmull-Rom, the two-lobe cubic libvips calls VIPS_KERNEL_CUBIC. */
const cubic: Kernel = {
    support: 2,
    weight: (x) => {
        const t = Math.abs(x);
        if (t < 1) return 1.5 * t * t * t - 2.5 * t * t + 1;
        if (t < 2) return -0.5 * t * t * t + 2.5 * t * t - 4 * t + 2;
        return 0;
    }
};

/** Mitchell-Netravali with b = c = 1/3. */
const mitchell: Kernel = {
    support: 2,
    weight: (x) => {
        const t = Math.abs(x);
        const b = 1 / 3;
        const c = 1 / 3;
        if (t < 1) return ((12 - 9 * b - 6 * c) * t * t * t + (-18 + 12 * b + 6 * c) * t * t + (6 - 2 * b)) / 6;
        if (t < 2) {
            return ((-b - 6 * c) * t * t * t + (6 * b + 30 * c) * t * t + (-12 * b - 48 * c) * t + (8 * b + 24 * c)) / 6;
        }
        return 0;
    }
};

const linear: Kernel = { support: 1, weight: (x) => (Math.abs(x) < 1 ? 1 - Math.abs(x) : 0) };

const KERNELS: Record<string, Kernel> = {
    nearest: { support: 0.5, weight: () => 1 },
    linear,
    cubic,
    mitchell,
    lanczos2: lanczos(2),
    lanczos3: lanczos(3)
};

export function kernelNames(): string[] {
    return Object.keys(KERNELS);
}

/* ----------------------------------------------------------------- resample */

/** Reduce `size` to `dst` by averaging blocks of `n`, as vips_shrink does. */
function boxShrink(image: Image, n: number, horizontal: boolean): Image {
    const srcSize = horizontal ? image.width : image.height;
    const other = horizontal ? image.height : image.width;
    const dstSize = Math.max(1, Math.round(srcSize / n));
    const ch = image.channels;
    const out = createImage(horizontal ? dstSize : other, horizontal ? other : dstSize, ch);
    for (let o = 0; o < other; o++) {
        for (let d = 0; d < dstSize; d++) {
            const start = Math.min(d * n, srcSize - 1);
            const end = Math.min(start + n, srcSize);
            for (let c = 0; c < ch; c++) {
                let sum = 0;
                for (let s = start; s < end; s++) {
                    const i = horizontal ? (o * srcSize + s) * ch + c : (s * other + o) * ch + c;
                    sum += image.data[i];
                }
                const v = Math.round(sum / (end - start));
                const j = horizontal ? (o * dstSize + d) * ch + c : (d * other + o) * ch + c;
                out.data[j] = v;
            }
        }
    }
    return out;
}

function kernelPass(image: Image, dstSize: number, horizontal: boolean, kernel: Kernel, scale: number): Image {
    const srcSize = horizontal ? image.width : image.height;
    const other = horizontal ? image.height : image.width;
    const ch = image.channels;
    const out = createImage(horizontal ? dstSize : other, horizontal ? other : dstSize, ch);
    /**
     * Where output pixel `d` samples the source, in source pixels.
     *
     * A reduction and an enlargement are not the same mapping, and mixing them up shifts every
     * upscaled image by half a source pixel. Measured against sharp 0.33.5 on a 64x64 ramp whose red
     * channel is 4*x (lanczos3 reproduces a ramp exactly, so out/4 reads the sampled position back):
     * shrinking 64->32/48/24 lands on (d + 0.5) * scale - 0.5, while enlarging 64->128/256 lands on
     * d * scale - 0.5 and 64->96/192/80/100 within one byte of it.
     */
    const centreOf = (d: number): number => (d + (scale >= 1 ? 0.5 : 0)) * scale - 0.5;
    const support = kernel.support * Math.max(1, scale);
    for (let o = 0; o < other; o++) {
        for (let d = 0; d < dstSize; d++) {
            const center = centreOf(d);
            const lo = Math.ceil(center - support);
            const hi = Math.floor(center + support);
            let wsum = 0;
            const weights: number[] = [];
            for (let s = lo; s <= hi; s++) {
                const w = kernel.weight((s - center) / Math.max(1, scale));
                if (w === 0) continue;
                weights.push(w);
                wsum += w;
            }
            if (wsum === 0) wsum = 1;
            for (let c = 0; c < ch; c++) {
                let acc = 0;
                let k = 0;
                for (let s = lo; s <= hi; s++) {
                    const w = kernel.weight((s - center) / Math.max(1, scale));
                    if (w === 0) continue;
                    const si = s < 0 ? 0 : s >= srcSize ? srcSize - 1 : s;
                    const i = horizontal ? (o * srcSize + si) * ch + c : (si * other + o) * ch + c;
                    acc += image.data[i] * w;
                    k++;
                }
                const j = horizontal ? (o * dstSize + d) * ch + c : (d * other + o) * ch + c;
                out.data[j] = Math.max(0, Math.min(255, Math.round(acc / wsum)));
            }
        }
    }
    return out;
}

function resampleAxis(image: Image, dstSize: number, horizontal: boolean, kernelName: string, fastShrink: boolean): Image {
    const srcSize = horizontal ? image.width : image.height;
    if (dstSize === srcSize) return image;
    const kernel = KERNELS[kernelName] ?? KERNELS.lanczos3;
    if (kernelName === 'nearest') {
        const other = horizontal ? image.height : image.width;
        const ch = image.channels;
        const out = createImage(horizontal ? dstSize : other, horizontal ? other : dstSize, ch);
        for (let o = 0; o < other; o++) {
            for (let d = 0; d < dstSize; d++) {
                const s = Math.min(srcSize - 1, Math.floor(((d + 0.5) * srcSize) / dstSize));
                for (let c = 0; c < ch; c++) {
                    const i = horizontal ? (o * srcSize + s) * ch + c : (s * other + o) * ch + c;
                    const j = horizontal ? (o * dstSize + d) * ch + c : (d * other + o) * ch + c;
                    out.data[j] = image.data[i];
                }
            }
        }
        return out;
    }
    const scale = srcSize / dstSize;
    let work = image;
    let residual = scale;
    if (scale > 1 && fastShrink) {
        const n = Math.floor(scale);
        if (n > 1) {
            work = boxShrink(work, n, horizontal);
            residual = (horizontal ? work.width : work.height) / dstSize;
        }
    }
    if (Math.abs(residual - 1) > 1e-9 || work !== image) {
        work = kernelPass(work, dstSize, horizontal, kernel, residual);
    }
    return work;
}

export function resample(image: Image, width: number, height: number, kernel: string, fastShrink: boolean): Image {
    let out = resampleAxis(image, width, true, kernel, fastShrink);
    out = resampleAxis(out, height, false, kernel, fastShrink);
    return out;
}

/* -------------------------------------------------------------------- resize */

export interface ResizeSpec {
    /** Requested width, or -1 for "whatever the height asks for". */
    width: number;
    height: number;
    /** sharp's canvas: crop (cover), embed (contain), max (inside), min (outside), ignore_aspect (fill). */
    canvas: string;
    withoutEnlargement: boolean;
    withoutReduction: boolean;
    fastShrinkOnLoad: boolean;
    kernel: string;
    /** 0 centre, 1 north, 2 east, 3 south, 4 west, 5 north-east, 6 south-east, 7 south-west, 8 north-west. */
    position: number;
    background: number[];
}

/**
 * Where a window of `inner` sits inside `outer` for a compass position, measured against sharp 0.33.5 at
 * 40x30: a crop centres on Math.round of the spare room (5 -> 3, 7 -> 4, 3 -> 2 all minimise the
 * difference from libvips), an embed on Math.floor (room 1/3/5/7 -> 0/1/2/3, read off the padding
 * columns of a contain resize with withoutEnlargement).
 */
function offsetOf(position: number, outer: number, inner: number, crop: boolean): number {
    if (outer <= inner) return 0;
    const room = outer - inner;
    switch (position) {
        case 1:
        case 5:
        case 8:
            return 0; // north
        case 3:
        case 6:
        case 7:
            return room; // south
        default:
            return crop ? Math.round(room / 2) : Math.floor(room / 2);
    }
}

/** The horizontal half of `offsetOf`: 4/7/8 west, 2/5/6 east, else centred. */
function offsetXOf(position: number, outer: number, inner: number, crop: boolean): number {
    if (outer <= inner) return 0;
    const room = outer - inner;
    if (position === 4 || position === 7 || position === 8) return 0;
    if (position === 2 || position === 5 || position === 6) return room;
    return crop ? Math.round(room / 2) : Math.floor(room / 2);
}

/**
 * The dimensions and the crop or pad that sharp's resize produces, measured against sharp 0.33.5 at
 * 40x30: cover/contain/inside/outside/fill over (20,10), (20,-1), (-1,10), (60,40), (60,-1), (-1,60), (40,30)
 * and (10,10), with and without withoutEnlargement.
 */
export function resizeImage(image: Image, spec: ResizeSpec): Image {
    const W = image.width;
    const H = image.height;
    if (spec.width < 0 && spec.height < 0) return image;
    if (spec.canvas === 'ignore_aspect') {
        let sx = spec.width > 0 ? spec.width / W : 1;
        let sy = spec.height > 0 ? spec.height / H : 1;
        if (spec.withoutEnlargement) {
            sx = Math.min(sx, 1);
            sy = Math.min(sy, 1);
        }
        if (spec.withoutReduction) {
            sx = Math.max(sx, 1);
            sy = Math.max(sy, 1);
        }
        const w = Math.max(1, Math.round(W * sx));
        const h = Math.max(1, Math.round(H * sy));
        return resample(image, w, h, spec.kernel, spec.fastShrinkOnLoad);
    }
    let scale: number;
    if (spec.width > 0 && spec.height > 0) {
        const x = spec.width / W;
        const y = spec.height / H;
        scale = spec.canvas === 'crop' || spec.canvas === 'min' ? Math.max(x, y) : Math.min(x, y);
    } else if (spec.width > 0) {
        scale = spec.width / W;
    } else if (spec.height > 0) {
        scale = spec.height / H;
    } else {
        scale = 1;
    }
    if (spec.withoutEnlargement) scale = Math.min(scale, 1);
    if (spec.withoutReduction) scale = Math.max(scale, 1);
    const sw = Math.max(1, Math.round(W * scale));
    const sh = Math.max(1, Math.round(H * scale));
    const scaled = sw === W && sh === H ? image : resample(image, sw, sh, spec.kernel, spec.fastShrinkOnLoad);
    if (spec.canvas === 'crop') {
        const w = spec.width > 0 ? Math.min(spec.width, scaled.width) : scaled.width;
        const h = spec.height > 0 ? Math.min(spec.height, scaled.height) : scaled.height;
        if (w === scaled.width && h === scaled.height) return scaled;
        return extractImage(
            scaled,
            offsetXOf(spec.position, scaled.width, w, true),
            offsetOf(spec.position, scaled.height, h, true),
            w,
            h
        );
    }
    if (spec.canvas === 'embed') {
        const w = spec.width > 0 ? spec.width : scaled.width;
        const h = spec.height > 0 ? spec.height : scaled.height;
        if (w === scaled.width && h === scaled.height) return scaled;
        return embedImage(
            scaled,
            w,
            h,
            offsetXOf(spec.position, w, scaled.width, false),
            offsetOf(spec.position, h, scaled.height, false),
            spec.background
        );
    }
    return scaled;
}

/* ------------------------------------------------------- geometry operations */

/**
 * The region of `width` x `height` at (left, top). sharp clamps the region to the image, so a region
 * hanging off the edge is shorter, never padded.
 */
export function extractImage(image: Image, left: number, top: number, width: number, height: number): Image {
    const l = Math.max(0, Math.min(Math.floor(left), image.width));
    const t = Math.max(0, Math.min(Math.floor(top), image.height));
    const w = Math.max(0, Math.min(Math.floor(width), image.width - l));
    const h = Math.max(0, Math.min(Math.floor(height), image.height - t));
    const out = createImage(w, h, image.channels);
    const rowBytes = w * image.channels;
    for (let y = 0; y < h; y++) {
        const from = ((y + t) * image.width + l) * image.channels;
        out.data.set(image.data.subarray(from, from + rowBytes), y * rowBytes);
    }
    return out;
}

/** Place the image in a `width` x `height` canvas filled with `background`. */
export function embedImage(image: Image, width: number, height: number, left: number, top: number, background: number[]): Image {
    const channels = image.channels;
    const out = createImage(width, height, channels);
    const bg = padBackground(background, channels);
    for (let i = 0; i < out.data.length; i += channels) {
        for (let c = 0; c < channels; c++) out.data[i + c] = bg[c];
    }
    blit(out, image, left, top);
    return out;
}

/** sharp's background is [r, g, b, alpha]; a grey image takes the first value, alpha the last. */
export function padBackground(background: number[], channels: ChannelCount): number[] {
    const b = background ?? [0, 0, 0, 255];
    if (channels === 1) return [b[0] ?? 0];
    if (channels === 2) return [b[0] ?? 0, b[3] ?? 255];
    if (channels === 3) return [b[0] ?? 0, b[1] ?? 0, b[2] ?? 0];
    return [b[0] ?? 0, b[1] ?? 0, b[2] ?? 0, b[3] ?? 255];
}

/**
 * `angle` quarter turns, counter-clockwise in libvips' sense: sharp 0.33.5 rotate(90) on a 40x30 image
 * puts the source bottom-left pixel at the output top-left, rotate(270) the top-right.
 */
export function rotateQuarters(image: Image, quarters: number, background: number[]): Image {
    const q = ((quarters % 4) + 4) % 4;
    if (q === 0) return image;
    const swap = q === 1 || q === 3;
    const w = swap ? image.height : image.width;
    const h = swap ? image.width : image.height;
    const out = createImage(w, h, image.channels);
    const ch = image.channels;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let sx: number;
            let sy: number;
            if (q === 2) {
                sx = image.width - 1 - x;
                sy = image.height - 1 - y;
            } else if (q === 1) {
                sx = y;
                sy = image.height - 1 - x;
            } else {
                sx = image.width - 1 - y;
                sy = x;
            }
            const from = (sy * image.width + sx) * ch;
            const to = (y * w + x) * ch;
            for (let c = 0; c < ch; c++) out.data[to + c] = image.data[from + c];
        }
    }
    return out;
}

/** flip(): top becomes bottom. */
export function flipImage(image: Image): Image {
    const out = createImage(image.width, image.height, image.channels);
    const ch = image.channels;
    const rowBytes = image.width * ch;
    for (let y = 0; y < image.height; y++) {
        const from = y * rowBytes;
        const to = (image.height - 1 - y) * rowBytes;
        out.data.set(image.data.subarray(from, from + rowBytes), to);
    }
    return out;
}

/** flop(): left becomes right. */
export function flopImage(image: Image): Image {
    const out = createImage(image.width, image.height, image.channels);
    const ch = image.channels;
    for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
            const from = (y * image.width + x) * ch;
            const to = (y * image.width + (image.width - 1 - x)) * ch;
            for (let c = 0; c < ch; c++) out.data[to + c] = image.data[from + c];
        }
    }
    return out;
}

/** Drop or add an alpha channel, and go to or from grey, so an encoder gets the bands it needs. */
export function toChannels(image: Image, channels: ChannelCount): Image {
    if (channels === image.channels) return image;
    const out = createImage(image.width, image.height, channels);
    const n = image.width * image.height;
    for (let i = 0; i < n; i++) {
        const s = i * image.channels;
        const d = i * channels;
        if (channels === 1) {
            out.data[d] = image.channels === 2 ? image.data[s] : greyOf(image.data[s], image.data[s + 1], image.data[s + 2]);
        } else if (channels === 2) {
            out.data[d] = image.channels === 1 ? image.data[s] : greyOf(image.data[s], image.data[s + 1], image.data[s + 2]);
            out.data[d + 1] = image.channels === 4 ? image.data[s + 3] : 255;
        } else if (channels === 3) {
            if (image.channels === 4) {
                out.data[d] = image.data[s];
                out.data[d + 1] = image.data[s + 1];
                out.data[d + 2] = image.data[s + 2];
            } else {
                out.data[d] = image.data[s];
                out.data[d + 1] = image.data[s + 1] ?? image.data[s];
                out.data[d + 2] = image.data[s + 2] ?? image.data[s];
            }
        } else {
            out.data[d] = image.channels === 3 ? image.data[s] : image.data[s];
            out.data[d + 1] = image.channels === 3 ? image.data[s + 1] : image.data[s];
            out.data[d + 2] = image.channels === 3 ? image.data[s + 2] : image.data[s];
            out.data[d + 3] = image.channels === 2 ? image.data[s + 1] : 255;
        }
    }
    return out;
}

/** Rec. 601 luma, the conversion sharp uses when it drops to one band. */
export function greyOf(r: number, g: number, b: number): number {
    return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
}

/** The number of bands sharp's metadata reports for an image. */
export function spaceOf(channels: number): string {
    return channels <= 2 ? 'b-w' : 'srgb';
}
