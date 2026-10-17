/**
 * Fonts and text. There is no font engine in the guest -- no freetype, no pango, no system fonts -- so
 * text is drawn with the one font the shim carries: the monoline glyph skeleton table in glyphs.ts,
 * scaled to the parsed font size. That is a real approximation, and the largest single divergence from
 * the add-on: glyph shapes, advance widths and metrics are the built-in font's, not the family's that
 * the page asked for, and they will not match cairo's numbers for any real font.
 *
 * fillText() expands each skeleton to a stem width proportional to the font size (bold multiplies it,
 * italic shears it) and fills it; strokeText() strokes the skeleton with lineWidth, which for a
 * monoline font is the natural analogue of stroking a real font's outline.
 *
 * registerFont() cannot be honoured: it is recorded, and drawing text in a registered family throws
 * OWC_CANVAS_UNSUPPORTED_FONT rather than silently substituting the built-in font.
 */

import { ASCENT, DESCENT, STEM, UNITS_PER_EM, FALLBACK_GLYPH, glyphFor } from './glyphs';

export interface FontSpec {
    /** Pixels. */
    size: number;
    family: string;
    weight: string;
    style: string;
    variant: string;
    /** The serialized shorthand, for the font getter. */
    text: string;
}

const ABSOLUTE: { readonly [name: string]: number } = {
    'xx-small': 9, 'x-small': 10, small: 13, medium: 16, large: 18, 'x-large': 24, 'xx-large': 32, 'xxx-large': 48
};

const UNITS: { readonly [name: string]: number } = {
    px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 25.4 / 4
};

const SIZES = ['xx-small', 'x-small', 'small', 'medium', 'large', 'x-large', 'xx-large', 'xxx-large'];
const WEIGHTS = ['normal', 'bold', 'bolder', 'lighter'];
const STYLES = ['normal', 'italic', 'oblique'];
const VARIANTS = ['normal', 'small-caps'];

/**
 * The CSS font shorthand as node-canvas reads it: optional style, variant and weight, then a length
 * (which is the only required part -- '12px' alone is accepted), then an optional family list.
 * Returns null for anything it cannot read, and the caller then leaves font unchanged.
 */
export function parseFont(value: string): FontSpec | null {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (text === '' || text === 'inherit') return null;
    const tokens = tokenize(text);
    let style = 'normal';
    let variant = 'normal';
    let weight = 'normal';
    let size = -1;
    let at = 0;
    for (let pass = 0; pass < 4 && at < tokens.length; pass++) {
        const t = tokens[at].toLowerCase();
        if (STYLES.indexOf(t) >= 0 && style === 'normal') { style = t; at++; continue; }
        if (VARIANTS.indexOf(t) >= 0 && variant === 'normal') { variant = t; at++; continue; }
        if (WEIGHTS.indexOf(t) >= 0 && weight === 'normal') { weight = t; at++; continue; }
        if (/^[1-9]00$/.test(t)) { weight = t; at++; continue; }
        break;
    }
    if (at >= tokens.length) return null;
    const sizeToken = tokens[at];
    const slash = sizeToken.indexOf('/');
    const lengthToken = slash >= 0 ? sizeToken.slice(0, slash) : sizeToken;
    const px = lengthPx(lengthToken);
    if (px === null || !(px > 0)) return null;
    size = px;
    at++;
    const family = tokens.slice(at).join(' ');
    return { size: size, family: family, weight: weight, style: style, variant: variant, text: formatFont({ size: size, family: family, weight: weight, style: style, variant: variant, text: '' }) };
}

/** A font size token: a number with a CSS unit, a percentage, or one of the absolute size keywords. */
function lengthPx(token: string): number | null {
    const t = token.trim().toLowerCase();
    if (ABSOLUTE[t] !== undefined && SIZES.indexOf(t) >= 0) return ABSOLUTE[t];
    if (t.charCodeAt(t.length - 1) === 37) {
        const pct = Number(t.slice(0, -1));
        return isFinite(pct) ? (pct / 100) * 16 : null;
    }
    const m = /^(-?[\d.]+)([a-z%]*)$/.exec(t);
    if (m === null) return null;
    const value = Number(m[1]);
    if (!isFinite(value)) return null;
    const unit = m[2];
    if (unit === '') return value;
    if (unit === 'em' || unit === 'rem') return value * 16;
    if (unit === 'ex' || unit === 'ch') return value * 8;
    if (unit === 'vw' || unit === 'vh' || unit === 'vmin' || unit === 'vmax') return value * 8;
    const scale = UNITS[unit];
    return scale === undefined ? null : value * scale;
}

/** Comma-separated family lists stay one token each, so a list survives the join below. */
function tokenize(text: string): string[] {
    const out: string[] = [];
    let current = '';
    let quote = '';
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote !== '') {
            current += ch;
            if (ch === quote) quote = '';
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            current += ch;
            continue;
        }
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
            if (current !== '') out.push(current);
            current = '';
            continue;
        }
        if (ch === ',') {
            current += ch;
            continue;
        }
        current += ch;
    }
    if (current !== '') out.push(current);
    return out;
}

/** How the add-on writes font back: the size in px, then the family when there is one. */
export function formatFont(f: FontSpec): string {
    const size = String(f.size) + 'px';
    return f.family === '' ? size : size + ' ' + f.family;
}

export function defaultFont(): FontSpec {
    return parseFont('10px sans-serif') as FontSpec;
}

/** The stem width fillText paints with, in px: the font's nominal stem, widened for bold. */
export function stemWidth(f: FontSpec): number {
    const scale = f.size / UNITS_PER_EM;
    const bold = f.weight === 'bold' || f.weight === 'bolder' || (parseInt(f.weight, 10) >= 600 && f.weight !== 'normal');
    return STEM * scale * (bold ? 1.7 : 1);
}

export interface TextMetrics {
    width: number;
    actualBoundingBoxAscent: number;
    actualBoundingBoxDescent: number;
    actualBoundingBoxLeft: number;
    actualBoundingBoxRight: number;
    emHeightAscent: number;
    emHeightDescent: number;
    /**
     * Absent on purpose: node-canvas 3.2.3's TextMetrics has neither (measured: Object.keys() gives
     * exactly the eight above), so the shim reports the same eight and keeps the font box internally.
     */
    fontBoundingBoxAscent?: number;
    fontBoundingBoxDescent?: number;
    alphabeticBaseline: number;
}

export interface LaidOut {
    /** Glyph skeletons in user space, baseline at y = 0, first pen position at x = 0. */
    strokes: number[][];
    metrics: TextMetrics;
}

/** Lays text out along the baseline, before textAlign and textBaseline move it. */
export function layoutText(text: string, font: FontSpec, maxWidth?: number): LaidOut {
    const scale = font.size / UNITS_PER_EM;
    const italic = font.style === 'italic' || font.style === 'oblique';
    let pen = 0;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const strokes: number[][] = [];
    for (let i = 0; i < text.length; i++) {
        const cp = text.charCodeAt(i);
        if (cp === 10 || cp === 13 || cp === 9) {
            pen += (0.25 * UNITS_PER_EM) * scale;
            continue;
        }
        const glyph = glyphFor(cp) || FALLBACK_GLYPH;
        for (const stroke of glyph.strokes) {
            const pts: number[] = [];
            for (let k = 0; k + 1 < stroke.length; k += 2) {
                let x = stroke[k] * scale + pen;
                const y = stroke[k + 1] * scale;
                if (italic) x += 0.22 * y;
                pts.push(x, y);
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
            if (pts.length >= 2) strokes.push(pts);
        }
        pen += glyph.advance * scale;
    }
    let width = pen;
    let squeeze = 1;
    if (typeof maxWidth === 'number' && isFinite(maxWidth) && width > maxWidth && width > 0) {
        squeeze = maxWidth / width;
        for (const pts of strokes) for (let k = 0; k < pts.length; k += 2) pts[k] = pts[k] * squeeze;
        width = maxWidth;
        maxX = maxX * squeeze;
        minX = minX * squeeze;
    }
    if (minX === Infinity) { minX = 0; maxX = 0; minY = 0; maxY = 0; }
    else {
        // The bounding box the add-on reports is the ink's, not the centrelines', so it is half a
        // stem wider on every side.
        const half = stemWidth(font) / 2;
        minX -= half; maxX += half; minY -= half; maxY += half;
    }
    const metrics: TextMetrics = {
        width: width,
        actualBoundingBoxAscent: maxY,
        actualBoundingBoxDescent: -minY,
        actualBoundingBoxLeft: -minX,
        actualBoundingBoxRight: maxX,
        emHeightAscent: font.size * 0.8,
        emHeightDescent: font.size * 0.25,
        fontBoundingBoxAscent: (ASCENT / UNITS_PER_EM) * font.size,
        fontBoundingBoxDescent: (DESCENT / UNITS_PER_EM) * font.size,
        alphabeticBaseline: 0
    };
    return { strokes: strokes, metrics: metrics };
}

/** Where textAlign puts the pen: the offset added to every x. */
export function alignOffset(align: string, width: number, direction: string): number {
    if (align === 'center') return -width / 2;
    if (align === 'right' || align === 'end') return -width;
    if (align === 'left' || align === 'start') return direction === 'rtl' ? -width : 0;
    return 0;
}

/** Where textBaseline puts the baseline: the y offset, positive downwards in user space. */
export function baselineOffset(baseline: string, m: TextMetrics): number {
    const ascent = m.fontBoundingBoxAscent === undefined ? m.emHeightAscent : m.fontBoundingBoxAscent;
    const descent = m.fontBoundingBoxDescent === undefined ? m.emHeightDescent : m.fontBoundingBoxDescent;
    switch (baseline) {
        case 'top': return ascent;
        case 'hanging': return m.emHeightAscent * 0.8;
        case 'middle': return (m.emHeightAscent - m.emHeightDescent) / 2;
        case 'ideographic': return -m.emHeightDescent;
        case 'bottom': return -descent;
        default: return 0;
    }
}
