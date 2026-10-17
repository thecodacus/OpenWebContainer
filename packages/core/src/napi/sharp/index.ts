/*
 * The native binding of sharp 0.33.5 (sharp.node, src/sharp.cc) reimplemented in JavaScript, because
 * libvips cannot run in the guest. createAddon() returns the twelve exports sharp's own JavaScript
 * wrapper reads: lib/constructor.js requires ./sharp for its side effect, lib/input.js calls metadata()
 * and stats(), lib/output.js calls pipeline(), and lib/utility.js reads the rest off the class on load.
 *
 * What it does is decode PNG and JPEG, move pixels around (resize, rotate, flip, flop, extract) and encode
 * PNG, JPEG and raw. Everything else libvips can do is refused: pipeline() and metadata() throw a
 * `sharp: unsupported operation ...` error when an option they do not implement has been changed from the
 * value lib/constructor.js gave it, so a caller gets an error instead of an image with the operation
 * silently missing. See options.ts for the 168 defaults the refusal is measured against.
 *
 * Pure JavaScript: no WebAssembly, no Node built-in. Reading an input file goes through the host
 * filesystem the container hands createAddon (NAPI_HOST.fs), which is the only way out of the guest.
 */
import {
    corruptImage,
    fileUnreadable,
    noHostFileSystem,
    pixelLimit,
    unsupportedFormat,
    unsupportedImageFormat,
    unsupportedOperation,
    unsupportedOperationFor
} from './errors';
import {
    ChannelCount,
    Image,
    createImage,
    embedImage,
    extractImage,
    flipImage,
    flopImage,
    padBackground,
    resizeImage,
    rotateQuarters,
    spaceOf,
    toChannels
} from './image';
import { optionsOf, unsupportedInput, unsupportedOption } from './options';
import { JpegInfo, decodeJpeg, encodeJpeg, isJpeg } from './jpeg';
import { PngInfo, decodePng, encodePng, isPng } from './png';

/** The part of the Buffer constructor the add-on needs: a view on bytes that is also a Buffer. */
interface BufferConstructorLike {
    from(arrayBuffer: ArrayBuffer, byteOffset?: number, length?: number): Uint8Array;
}

/** The filesystem the container gives the add-on; only `read` and `write` are used. */
export interface SharpAddonHost {
    fs?: {
        read?: (path: string) => Uint8Array | undefined;
        write?: (path: string, bytes: Uint8Array) => void;
    };
    /** The guest's Buffer, so output can be handed back as a Buffer rather than a bare Uint8Array. */
    Buffer?: BufferConstructorLike;
}

/** What the shim decoded, and everything sharp's metadata() reports about it. */
interface Decoded {
    image: Image;
    format: string;
    size: number;
    density?: number;
    resolutionUnit?: string;
    chromaSubsampling?: string;
    isProgressive?: boolean;
    paletteBitDepth?: number;
    hasProfile: boolean;
    hasAlpha: boolean;
    orientation?: number;
    background?: { r: number; g: number; b: number };
    comments?: Array<[string, string]>;
}

/** A Buffer, a Uint8Array or any other view: the bytes, without copying when it is already one. */
function bytesOf(value: unknown): Uint8Array {
    if (value instanceof Uint8Array) return value;
    if (ArrayBuffer.isView(value)) {
        const view = value as ArrayBufferView;
        return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    }
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    throw new Error('sharp: input buffer is not a typed array');
}

/**
 * sharp's add-on resolves every buffer output with a Buffer, not a bare Uint8Array: lib/output.js
 * hands the value straight to the caller, so `buf.toString('base64')` has to be a Buffer's, or it
 * returns the bytes as a comma-separated list instead. The view is shared, never copied.
 */
function bufferOf(host: SharpAddonHost | undefined, bytes: Uint8Array): Uint8Array {
    const ctor = host?.Buffer ?? (globalThis as { Buffer?: BufferConstructorLike }).Buffer;
    if (!ctor || typeof ctor.from !== 'function') return bytes;
    return ctor.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
}

function numberOption(options: Record<string, unknown>, key: string, fallback: number): number {
    const value = options[key];
    return typeof value === 'number' && isFinite(value) ? value : fallback;
}

function arrayOption(options: Record<string, unknown>, key: string, fallback: number[]): number[] {
    const value = options[key];
    return Array.isArray(value) ? (value as number[]).map((v) => (typeof v === 'number' ? v : 0)) : fallback;
}

/* -------------------------------------------------------------------- input */

/** The only band counts there are; a pixel buffer of any other stride is not an image this shim has. */
function channelCount(value: number): ChannelCount {
    if (value === 1 || value === 2 || value === 3 || value === 4) return value;
    throw new Error('Expected between 1 and 4 channels');
}

function imageFromCreate(input: Record<string, unknown>): Image {
    const width = Math.floor(Number(input.createWidth));
    const height = Math.floor(Number(input.createHeight));
    const channels = channelCount(Math.floor(Number(input.createChannels)));
    if (!(width > 0 && height > 0 && channels >= 1 && channels <= 4)) {
        throw new Error('Expected valid width, height and channels to create a new input image');
    }
    const background = padBackground(arrayOption(input, 'createBackground', [0, 0, 0, 255]), channels);
    const image = createImage(width, height, channels);
    for (let i = 0; i < image.data.length; i += channels) {
        for (let c = 0; c < channels; c++) image.data[i + c] = background[c];
    }
    return image;
}

function imageFromRaw(input: Record<string, unknown>, bytes: Uint8Array): Image {
    const width = Math.floor(Number(input.rawWidth));
    const height = Math.floor(Number(input.rawHeight));
    const channels = channelCount(Math.floor(Number(input.rawChannels)));
    const want = width * height * channels;
    if (bytes.length < want) {
        throw corruptImage('Input buffer has corrupt header');
    }
    return { width, height, channels, data: bytesOf(bytes.slice(0, want)) };
}

function decodeBytes(bytes: Uint8Array): Decoded {
    if (isPng(bytes)) {
        const { image, info } = decodePng(bytes);
        return decodedFromPng(image, info, bytes.length);
    }
    if (isJpeg(bytes)) {
        const { image, info } = decodeJpeg(bytes);
        return decodedFromJpeg(image, info, bytes.length);
    }
    throw unsupportedImageFormat('buffer');
}

function decodedFromPng(image: Image, info: PngInfo, size: number): Decoded {
    return {
        image,
        format: 'png',
        size,
        density: densityOf(info.density),
        resolutionUnit: info.resolutionUnit,
        isProgressive: info.isProgressive,
        paletteBitDepth: info.paletteBitDepth,
        hasProfile: info.hasProfile,
        hasAlpha: info.hasAlpha,
        background: info.background,
        comments: info.comments
    };
}

/**
 * libvips gives every image it has loaded a resolution, defaulting to 72 dpi when the file carries
 * none, so sharp's metadata() always has a density for a PNG or JPEG input and never for one it
 * built itself (create, raw). Measured against sharp 0.33.5: a PNG and a JPEG with no pHYs and a
 * JFIF with units 0 both report 72, while sharp({create:...}) and a raw buffer report none.
 */
function densityOf(density: number | undefined): number {
    return typeof density === 'number' && isFinite(density) && density > 0 ? density : 72;
}

function decodedFromJpeg(image: Image, info: JpegInfo, size: number): Decoded {
    return {
        image,
        format: 'jpeg',
        size,
        density: densityOf(info.density),
        chromaSubsampling: info.chromaSubsampling,
        isProgressive: info.isProgressive,
        hasProfile: info.hasProfile,
        hasAlpha: false,
        orientation: info.orientation
    };
}

function readFile(host: SharpAddonHost | undefined, file: string): Uint8Array {
    if (!host || !host.fs || typeof host.fs.read !== 'function') throw noHostFileSystem();
    const bytes = host.fs.read(file);
    if (bytes === undefined) throw fileUnreadable(file);
    return bytesOf(bytes);
}

/** Load the input descriptor sharp built: a created image, raw pixels, a Buffer, or a file. */
function decodeInput(options: Record<string, unknown>, host: SharpAddonHost | undefined): Decoded {
    const input = optionsOf(options.input);
    const unsupported = unsupportedInput(input);
    if (unsupported !== null) throw unsupportedOperationFor('input.' + unsupported);
    if (input.createWidth !== undefined) {
        const image = imageFromCreate(input);
        return {
            image,
            format: 'png',
            size: image.data.length,
            hasProfile: false,
            hasAlpha: image.channels === 2 || image.channels === 4
        };
    }
    if (input.rawWidth !== undefined) {
        const raw = input.buffer !== undefined ? bytesOf(input.buffer) : readFile(host, String(input.file));
        const image = imageFromRaw(input, raw);
        return { image, format: 'raw', size: raw.length, hasProfile: false, hasAlpha: image.channels === 2 || image.channels === 4 };
    }
    if (input.buffer !== undefined) {
        const bytes = bytesOf(input.buffer);
        if (bytes.length === 0) throw new Error('Input Buffer is empty');
        return decodeBytes(bytes);
    }
    if (input.file !== undefined) {
        const bytes = readFile(host, String(input.file));
        if (!isPng(bytes) && !isJpeg(bytes)) throw unsupportedImageFormat('file');
        return decodeBytes(bytes);
    }
    throw new Error('Invalid input');
}

/* ------------------------------------------------------------------ pipeline */

/** Pre-extract, resize, post-extract, then flip, flop and rotate - unless the rotation comes first. */
function applyOperations(image: Image, options: Record<string, unknown>): { image: Image; cropLeft: number; cropTop: number } {
    let out = image;
    const rotationFirst = options.rotateBeforePreExtract === true;
    let cropLeft = 0;
    let cropTop = 0;
    const orient = (): void => {
        if (options.flip === true) out = flipImage(out);
        if (options.flop === true) out = flopImage(out);
        const angle = numberOption(options, 'angle', 0);
        if (angle % 360 !== 0) {
            const quarters = ((Math.round(angle / 90) % 4) + 4) % 4;
            out = rotateQuarters(out, quarters, arrayOption(options, 'rotationBackground', [0, 0, 0, 255]));
        }
    };
    if (rotationFirst) orient();
    if (numberOption(options, 'widthPre', -1) >= 0 || numberOption(options, 'heightPre', -1) >= 0) {
        out = extractImage(
            out,
            numberOption(options, 'leftOffsetPre', 0),
            numberOption(options, 'topOffsetPre', 0),
            numberOption(options, 'widthPre', out.width),
            numberOption(options, 'heightPre', out.height)
        );
    }
    if (numberOption(options, 'width', -1) >= 0 || numberOption(options, 'height', -1) >= 0) {
        const before = out;
        out = resizeImage(out, {
            width: numberOption(options, 'width', -1),
            height: numberOption(options, 'height', -1),
            canvas: String(options.canvas ?? 'crop'),
            withoutEnlargement: options.withoutEnlargement === true,
            withoutReduction: options.withoutReduction === true,
            fastShrinkOnLoad: options.fastShrinkOnLoad !== false,
            kernel: String(options.kernel ?? 'lanczos3'),
            position: numberOption(options, 'position', 0),
            background: arrayOption(options, 'resizeBackground', [0, 0, 0, 255])
        });
        if (String(options.canvas ?? 'crop') === 'crop' && (out.width !== before.width || out.height !== before.height)) {
            cropLeft = Math.round((before.width - out.width) / 2);
            cropTop = Math.round((before.height - out.height) / 2);
        }
    }
    if (numberOption(options, 'widthPost', -1) >= 0 || numberOption(options, 'heightPost', -1) >= 0) {
        out = extractImage(
            out,
            numberOption(options, 'leftOffsetPost', 0),
            numberOption(options, 'topOffsetPost', 0),
            numberOption(options, 'widthPost', out.width),
            numberOption(options, 'heightPost', out.height)
        );
    }
    if (!rotationFirst) orient();
    return { image: out, cropLeft, cropTop };
}

function encodeOutput(image: Image, options: Record<string, unknown>, inputFormat: string): { format: string; data: Uint8Array } {
    let format = String(options.formatOut ?? 'input');
    if (format === 'input') format = inputFormat === 'jpeg' ? 'jpeg' : 'png';
    if (format === 'jpeg') {
        const quality = Math.max(1, Math.min(100, numberOption(options, 'jpegQuality', 80)));
        const chroma = String(options.jpegChromaSubsampling ?? '4:2:0');
        if (chroma !== '4:4:4' && chroma !== '4:2:0' && chroma !== '4:2:2') throw unsupportedFormat('jpeg ' + chroma, 'output');
        const rgb = image.channels === 4 || image.channels === 3 ? toChannels(image, 3) : toChannels(image, 1);
        return { format, data: encodeJpeg(rgb, quality, chroma) };
    }
    if (format === 'png') {
        return { format, data: encodePng(image) };
    }
    if (format === 'raw') {
        return { format, data: image.data };
    }
    throw unsupportedFormat(format, 'output');
}

/* ------------------------------------------------------------------ metadata */

/** sharp reports `size` for Buffer and Stream input only, never for a file it opened itself. */
function metadataOf(decoded: Decoded, fromBuffer: boolean): Record<string, unknown> {
    const meta: Record<string, unknown> = {
        format: decoded.format,
        width: decoded.image.width,
        height: decoded.image.height,
        space: spaceOf(decoded.image.channels),
        channels: decoded.image.channels,
        depth: 'uchar',
        hasProfile: decoded.hasProfile,
        hasAlpha: decoded.hasAlpha
    };
    if (fromBuffer) meta.size = decoded.size;
    if (decoded.density !== undefined) meta.density = decoded.density;
    if (decoded.resolutionUnit !== undefined) meta.resolutionUnit = decoded.resolutionUnit;
    if (decoded.chromaSubsampling !== undefined) meta.chromaSubsampling = decoded.chromaSubsampling;
    if (decoded.isProgressive !== undefined) meta.isProgressive = decoded.isProgressive;
    if (decoded.paletteBitDepth !== undefined) meta.paletteBitDepth = decoded.paletteBitDepth;
    if (decoded.orientation !== undefined) meta.orientation = decoded.orientation;
    if (decoded.background !== undefined) meta.background = decoded.background;
    if (decoded.comments !== undefined) meta.comments = decoded.comments;
    return meta;
}

/* ------------------------------------------------------------------- exports */

/** The formats lib/utility.js hangs aliases off, with what this shim can actually do. */
function formatTable(): Record<string, unknown> {
    const entry = (id: string, input: boolean, output: boolean, file: boolean): Record<string, unknown> => ({
        id,
        input: { file: input && file, buffer: input, stream: input },
        output: { file: output && file, buffer: output, stream: output }
    });
    return {
        jpeg: entry('jpeg', true, true, true),
        png: entry('png', true, true, true),
        raw: { id: 'raw', input: { file: false, buffer: true, stream: true }, output: { file: false, buffer: true, stream: true } },
        webp: entry('webp', false, false, true),
        tiff: entry('tiff', false, false, true),
        gif: entry('gif', false, false, true),
        heif: entry('heif', false, false, true),
        svg: entry('svg', false, false, true),
        jp2k: entry('jp2k', false, false, true),
        jxl: entry('jxl', false, false, true),
        dz: entry('dz', false, false, true),
        vips: entry('vips', false, false, true),
        magick: entry('magick', false, false, true),
        openslide: entry('openslide', false, false, true),
        ppm: entry('ppm', false, false, true),
        fits: entry('fits', false, false, true),
        pdf: entry('pdf', false, false, true)
    };
}

/**
 * The add-on's exports. sharp's wrapper calls metadata, stats and pipeline with (options, callback); the
 * rest it reads once on load.
 */
export function createAddon(host: SharpAddonHost = {}): object {
    function metadata(options: unknown, callback: (err: Error | null, meta?: unknown) => void): void {
        let meta: Record<string, unknown>;
        try {
            const opts = optionsOf(options);
            const bad = unsupportedOption(opts);
            if (bad !== null) throw unsupportedOperationFor(bad);
            meta = metadataOf(decodeInput(opts, host), optionsOf(opts.input).buffer !== undefined);
        } catch (error) {
            callback(error as Error);
            return;
        }
        callback(null, meta);
    }

    function stats(_options: unknown, _callback: (err: Error | null, stats?: unknown) => void): void {
        // stats() needs a full decode plus an entropy, a Laplacian sharpness and a 4096-bin dominant
        // colour that only libvips computes; rather than invent them, refuse.
        _callback(unsupportedOperation('stats()'));
    }

    function pipeline(options: unknown, callback: (err: Error | null, data?: unknown, info?: unknown) => void): void {
        let data: unknown;
        let info: Record<string, unknown>;
        let fileOut = '';
        let bytes = new Uint8Array(0);
        try {
            const opts = optionsOf(options);
            const bad = unsupportedOption(opts);
            if (bad !== null) throw unsupportedOperationFor(bad);
            const decoded = decodeInput(opts, host);
            const input = optionsOf(opts.input);
            const limit = Number(input.limitInputPixels ?? 268402689);
            if (limit > 0 && decoded.image.width * decoded.image.height > limit) {
                throw pixelLimit(decoded.image.width, decoded.image.height, limit);
            }
            const { image, cropLeft, cropTop } = applyOperations(decoded.image, opts);
            const encoded = encodeOutput(image, opts, decoded.format);
            bytes = encoded.data;
            fileOut = String(opts.fileOut ?? '');
            info = {
                format: encoded.format,
                size: bytes.length,
                width: image.width,
                height: image.height,
                channels: image.channels,
                premultiplied: false
            };
            if (String(opts.canvas ?? 'crop') === 'crop' && (cropLeft !== 0 || cropTop !== 0)) {
                info.cropOffsetLeft = cropLeft;
                info.cropOffsetTop = cropTop;
            }
            if (fileOut !== '') {
                if (!host || !host.fs || typeof host.fs.write !== 'function') throw noHostFileSystem();
                host.fs.write(fileOut, bytes);
                // A file write resolves with the info object, not the bytes: lib/output.js passes the
                // add-on's first value to the caller unchanged, so toFile() gets {format,width,...},
                // and a caller destructuring {width, height} off it sees undefined otherwise.
                data = info;
            } else {
                data = bufferOf(host, bytes);
            }
        } catch (error) {
            callback(error as Error);
            return;
        }
        callback(null, data, info);
    }

    return {
        metadata,
        stats,
        pipeline,
        cache: () => ({ memory: { current: 0, high: 0, max: 0 }, files: { current: 0, max: 0 }, items: { current: 0, max: 0 } }),
        concurrency: () => 1,
        counters: () => ({ queue: 0, process: 0 }),
        simd: () => false,
        // libvips 8.15.3 is what sharp 0.33.5's add-on is built against, and what this shim stands in for;
        // no libvips is loaded.
        libvipsVersion: () => ({ semver: '8.15.3', isGlobal: false, isWasm: false }),
        format: formatTable,
        block: () => undefined,
        _maxColourDistance: () => {
            throw unsupportedOperation('_maxColourDistance()');
        },
        _isUsingJemalloc: () => false
    };
}
