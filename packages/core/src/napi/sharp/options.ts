/*
 * The options object the sharp wrapper hands its add-on, and which of them this shim honours.
 *
 * sharp's lib/ builds one flat options object in lib/constructor.js and mutates it from lib/resize.js,
 * lib/operation.js, lib/colour.js and lib/output.js; lib/output.js then calls pipeline(options, callback) with
 * it. Every one of the 168 keys is listed here at the value constructor.js gives it, taken from a live
 * sharp 0.33.5 instance. A key outside IMPLEMENTED that does not still hold its default is an operation
 * the shim has not been written for, and the shim refuses the call rather than return an image that is
 * missing it: the alternative, ignoring the key, is a silently wrong image.
 */

/** The option values a fresh sharp instance starts from (sharp 0.33.5). */
export const SHARP_DEFAULT_OPTIONS: Record<string, unknown> = {
    affineBackground: [0, 0, 0, 255],
    affineIdx: 0,
    affineIdy: 0,
    affineInterpolator: "bilinear",
    affineMatrix: [],
    affineOdx: 0,
    affineOdy: 0,
    angle: 0,
    blurSigma: 0,
    booleanBufferIn: null,
    booleanFileIn: "",
    brightness: 1,
    canvas: "crop",
    claheHeight: 0,
    claheMaxSlope: 3,
    claheWidth: 0,
    colourspace: "srgb",
    colourspacePipeline: "last",
    composite: [],
    debuglog: null,
    ensureAlpha: -1,
    extendBackground: [0, 0, 0, 255],
    extendBottom: 0,
    extendLeft: 0,
    extendRight: 0,
    extendTop: 0,
    extendWith: "background",
    extractChannel: -1,
    fastShrinkOnLoad: true,
    fileOut: "",
    flatten: false,
    flattenBackground: [0, 0, 0],
    flip: false,
    flop: false,
    formatOut: "input",
    gamma: 0,
    gammaOut: 0,
    gifBitdepth: 8,
    gifDither: 1,
    gifEffort: 7,
    gifInterFrameMaxError: 0,
    gifInterPaletteMaxError: 3,
    gifProgressive: false,
    gifReuse: true,
    greyscale: false,
    heifBitdepth: 8,
    heifChromaSubsampling: "4:4:4",
    heifCompression: "av1",
    heifEffort: 4,
    heifLossless: false,
    heifQuality: 50,
    height: -1,
    heightPost: -1,
    heightPre: -1,
    hue: 0,
    input: {"failOn": "warning", "limitInputPixels": 268402689, "ignoreIcc": false, "unlimited": false, "sequentialRead": true, "createWidth": 2, "createHeight": 2, "createChannels": 3, "createBackground": [0, 0, 0, 255]},
    joinChannelIn: [],
    jp2ChromaSubsampling: "4:4:4",
    jp2Lossless: false,
    jp2Quality: 80,
    jp2TileHeight: 512,
    jp2TileWidth: 512,
    jpegChromaSubsampling: "4:2:0",
    jpegOptimiseCoding: true,
    jpegOptimiseScans: false,
    jpegOvershootDeringing: false,
    jpegProgressive: false,
    jpegQuality: 80,
    jpegQuantisationTable: 0,
    jpegTrellisQuantisation: false,
    jxlDecodingTier: 0,
    jxlDistance: 1,
    jxlEffort: 7,
    jxlLossless: false,
    keepMetadata: 0,
    kernel: "lanczos3",
    leftOffsetPost: -1,
    leftOffsetPre: -1,
    lightness: 0,
    linearA: [],
    linearB: [],
    medianSize: 0,
    minAmpl: 0.2,
    negate: false,
    negateAlpha: true,
    normalise: false,
    normaliseLower: 1,
    normaliseUpper: 99,
    pngAdaptiveFiltering: false,
    pngBitdepth: 8,
    pngCompressionLevel: 6,
    pngDither: 1,
    pngEffort: 7,
    pngPalette: false,
    pngProgressive: false,
    pngQuality: 100,
    position: 0,
    precision: "integer",
    queueListener: null,
    rawDepth: "uchar",
    removeAlpha: false,
    resizeBackground: [0, 0, 0, 255],
    resolveWithObject: false,
    rotateBeforePreExtract: false,
    rotationAngle: 0,
    rotationBackground: [0, 0, 0, 255],
    saturation: 1,
    sharpenM1: 1,
    sharpenM2: 2,
    sharpenSigma: 0,
    sharpenX1: 2,
    sharpenY2: 10,
    sharpenY3: 20,
    streamOut: false,
    threshold: 0,
    thresholdGrayscale: true,
    tiffBitdepth: 8,
    tiffCompression: "jpeg",
    tiffMiniswhite: false,
    tiffPredictor: "horizontal",
    tiffPyramid: false,
    tiffQuality: 80,
    tiffResolutionUnit: "inch",
    tiffTile: false,
    tiffTileHeight: 256,
    tiffTileWidth: 256,
    tiffXres: 1,
    tiffYres: 1,
    tileAngle: 0,
    tileBackground: [255, 255, 255, 255],
    tileBasename: "",
    tileCentre: false,
    tileContainer: "fs",
    tileDepth: "last",
    tileFormat: "last",
    tileId: "https://example.com/iiif",
    tileLayout: "dz",
    tileOverlap: 0,
    tileSize: 256,
    tileSkipBlanks: -1,
    timeoutSeconds: 0,
    tint: [-1, 0, 0, 0],
    topOffsetPost: -1,
    topOffsetPre: -1,
    trimBackground: [],
    trimLineArt: false,
    trimThreshold: -1,
    unflatten: false,
    useExifOrientation: false,
    webpAlphaQuality: 100,
    webpEffort: 4,
    webpLossless: false,
    webpMinSize: false,
    webpMixed: false,
    webpNearLossless: false,
    webpPreset: "default",
    webpQuality: 80,
    webpSmartSubsample: false,
    width: -1,
    widthPost: -1,
    widthPre: -1,
    withExif: {},
    withExifMerge: true,
    withIccProfile: "",
    withMetadataDensity: 0,
    withMetadataOrientation: -1,
    withoutEnlargement: false,
    withoutReduction: false,
};

/**
 * Options the shim reads. A change in one of these is honoured, or refused by value when the shim
 * implements only part of the range (a fit it does not have, say).
 */
export const IMPLEMENTED_OPTIONS: readonly string[] = [
    'input', 'width', 'height', 'canvas', 'position', 'kernel', 'withoutEnlargement', 'withoutReduction',
    'fastShrinkOnLoad', 'resizeBackground',
    'widthPre', 'heightPre', 'topOffsetPre', 'leftOffsetPre',
    'widthPost', 'heightPost', 'topOffsetPost', 'leftOffsetPost',
    'angle', 'rotationAngle', 'flip', 'flop', 'rotateBeforePreExtract', 'rotationBackground',
    'formatOut', 'fileOut', 'streamOut', 'resolveWithObject',
    'jpegQuality', 'jpegChromaSubsampling', 'rawDepth',
    'pngCompressionLevel', 'pngEffort', 'pngQuality', 'pngAdaptiveFiltering', 'pngDither', 'pngBitdepth',
    'jpegOptimiseCoding', 'jpegOptimiseScans', 'jpegOvershootDeringing', 'jpegTrellisQuantisation',
    'jpegQuantisationTable'
];

/**
 * Options a change in which cannot alter the pixels or the file the shim writes, either because they are
 * the wrapper's own callbacks or because they steer an encoder setting the shim's encoders do not have.
 */
export const IGNORED_OPTIONS: readonly string[] = ['debuglog', 'queueListener', 'timeoutSeconds'];

/** Canvas values, keyed by the fit name sharp's resize() accepts. */
export const CANVAS_VALUES: readonly string[] = ['crop', 'embed', 'max', 'min', 'ignore_aspect'];

/** Resize kernels libvips has and this shim has. */
export const KERNEL_VALUES: readonly string[] = ['nearest', 'linear', 'cubic', 'mitchell', 'lanczos2', 'lanczos3'];

/** Output formats this shim can write. */
export const OUTPUT_FORMATS: readonly string[] = ['input', 'jpeg', 'png', 'raw'];

/** Input descriptor keys the shim reads. */
export const IMPLEMENTED_INPUT: readonly string[] = [
    'file', 'buffer', 'failOn', 'limitInputPixels', 'unlimited', 'sequentialRead', 'ignoreIcc', 'density',
    'rawWidth', 'rawHeight', 'rawChannels', 'rawDepth', 'rawPremultiplied',
    'createWidth', 'createHeight', 'createChannels', 'createBackground',
    'page', 'pages', 'level', 'subifd'
];

function sameValue(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
        const ka = Object.keys(a as object);
        const kb = Object.keys(b as object);
        if (ka.length !== kb.length) return false;
        return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameValue((a as never)[k], (b as never)[k]));
    }
    return false;
}

/** The pipeline options, read without assuming any of them are present. */
export function optionsOf(value: unknown): Record<string, unknown> {
    return (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
}

/**
 * The first option the shim cannot honour, or null when it can honour them all. Checks the value of the
 * options it does implement before it checks for any it does not, so e.g. an unknown kernel is reported as
 * such rather than as an unimplemented option.
 */
export function unsupportedOption(options: Record<string, unknown>): string | null {
    if (options.canvas !== undefined && CANVAS_VALUES.indexOf(String(options.canvas)) === -1) {
        return 'canvas=' + String(options.canvas);
    }
    if (options.kernel !== undefined && KERNEL_VALUES.indexOf(String(options.kernel)) === -1) return 'kernel=' + String(options.kernel);
    const position = typeof options.position === 'number' ? options.position : 0;
    if (position < 0 || position > 8) return 'position=' + String(options.position);
    if (options.formatOut !== undefined && OUTPUT_FORMATS.indexOf(String(options.formatOut)) === -1) {
        return 'formatOut=' + String(options.formatOut);
    }
    if (typeof options.angle === 'number' && options.angle % 90 !== 0) return 'angle=' + String(options.angle);
    if (options.rotationAngle !== undefined && typeof options.rotationAngle === 'number' && options.rotationAngle !== 0) {
        return 'rotationAngle=' + String(options.rotationAngle);
    }
    if (options.useExifOrientation === true) return 'useExifOrientation';
    if (options.rawDepth !== undefined && options.rawDepth !== 'uchar') return 'rawDepth=' + String(options.rawDepth);
    if (options.pngBitdepth !== undefined && options.pngBitdepth !== 8) return 'pngBitdepth=' + String(options.pngBitdepth);
    for (const key of Object.keys(options)) {
        if (IMPLEMENTED_OPTIONS.indexOf(key) >= 0 || IGNORED_OPTIONS.indexOf(key) >= 0) continue;
        const def = SHARP_DEFAULT_OPTIONS[key];
        if (def === null && typeof options[key] === 'function') continue; // debuglog, queueListener
        if (!Object.prototype.hasOwnProperty.call(SHARP_DEFAULT_OPTIONS, key)) return key;
        if (!sameValue(options[key], def)) return key;
    }
    return null;
}

/** The first input descriptor key the shim cannot honour, or null. */
export function unsupportedInput(input: Record<string, unknown>): string | null {
    if (input.rawDepth !== undefined && input.rawDepth !== 'uchar') return 'rawDepth=' + String(input.rawDepth);
    if (input.rawChannels !== undefined) {
        const channels = Number(input.rawChannels);
        if (!(channels >= 1 && channels <= 4)) return 'rawChannels=' + String(input.rawChannels);
    }
    for (const key of Object.keys(input)) {
        if (IMPLEMENTED_INPUT.indexOf(key) >= 0) continue;
        return key;
    }
    if (input.pages !== undefined && Number(input.pages) !== 1) return 'pages=' + String(input.pages);
    if (input.page !== undefined && Number(input.page) !== 0) return 'page=' + String(input.page);
    if (input.level !== undefined && Number(input.level) !== 0) return 'level=' + String(input.level);
    if (input.subifd !== undefined && Number(input.subifd) !== -1) return 'subifd=' + String(input.subifd);
    return null;
}
