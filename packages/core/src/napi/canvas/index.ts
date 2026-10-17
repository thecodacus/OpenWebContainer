/**
 * The native binding of the canvas package (canvas.node; src/*.cc of canvas 3.2.3) in JavaScript.
 *
 * createAddon(host?) returns the add-on's exports -- Canvas, CanvasRenderingContext2d, CanvasGradient,
 * CanvasPattern, Image, ImageData, GetSource, SetSource, setDOMMatrix, setParseFont and the library
 * version strings -- which is everything index.js, lib/canvas.js, lib/context2d.js and lib/image.js
 * reach for. There is no Cairo here: the 2D context is a scanline rasteriser written for this file's
 * neighbours, PNG and JPEG are encoded and decoded in JavaScript, and text comes from the built-in
 * monoline font in glyphs.ts. MANIFEST.md lists what is faithful, what is approximated and what is
 * refused with a named error.
 *
 * `host` is the guest's facilities, the way src/napi/leveldown takes them: `Buffer` (the guest's buffer
 * constructor, so toBuffer() hands back something with toString('base64')) and `fs` (so an Image src
 * that is a file path can be read). Both are optional; without them the operations that need them
 * refuse with a named error instead of failing obscurely.
 */

import type { BufferConstructorLike, CanvasAddonOptions, NapiFileSystem } from './canvas';
import {
    Canvas, CanvasGradient, CanvasPattern, CanvasRenderingContext2d, Image, ImageData, SESSION
} from './canvas';

export { Canvas, CanvasGradient, CanvasPattern, CanvasRenderingContext2d, Image, ImageData };
export type { CanvasAddonOptions, NapiFileSystem, BufferConstructorLike };

/** SetSource.call(img, src) and GetSource.call(img) of lib/image.js. */
function SetSource(this: unknown, src: unknown): void {
    (this as Image).setSource(src);
}

function GetSource(this: unknown): unknown {
    return (this as Image).getSource();
}

/** The DOMMatrix class index.js registers, so getTransform() can return the page's own type. */
function setDOMMatrix(ctor: unknown): void {
    SESSION.DOMMatrix = (ctor as typeof SESSION.DOMMatrix) || null;
}

/** A font-shorthand parser the browser build installs; the shim parses fonts itself and ignores it. */
function setParseFont(parser: unknown): void {
    void parser;
}

/**
 * Library versions. The add-on reports the shared libraries it was built against; the shim reports
 * what it actually is, so a caller that reads them is not told Cairo is present.
 */
export const cairoVersion = 'none';
export const freetypeVersion = 'none';
export const jpegVersion = 'owc-baseline-encoder';
export const pangoVersion = 'none';
export const rsvgVersion = undefined;
export const gifVersion = undefined;

export function createAddon(host?: CanvasAddonOptions): object {
    const options = host || {};
    SESSION.Buffer = options.Buffer || (globalThis as { Buffer?: BufferConstructorLike }).Buffer;
    SESSION.fs = options.fs;
    return {
        Canvas: Canvas,
        CanvasGradient: CanvasGradient,
        CanvasPattern: CanvasPattern,
        CanvasRenderingContext2d: CanvasRenderingContext2d,
        GetSource: GetSource,
        Image: Image,
        ImageData: ImageData,
        SetSource: SetSource,
        cairoVersion: cairoVersion,
        freetypeVersion: freetypeVersion,
        gifVersion: gifVersion,
        jpegVersion: jpegVersion,
        pangoVersion: pangoVersion,
        rsvgVersion: rsvgVersion,
        setDOMMatrix: setDOMMatrix,
        setParseFont: setParseFont
    };
}
