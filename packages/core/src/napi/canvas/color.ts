/**
 * CSS colour parsing and serialising, the way node-canvas 3.2.3 reads and writes fillStyle, strokeStyle,
 * shadowColor and CanvasGradient.addColorStop(). Measured on Node 24.15 with the real add-on:
 *
 *   ctx.fillStyle = 'red'                 -> '#ff0000'
 *   ctx.fillStyle = 'rgba(1,2,3,0.5)'     -> 'rgba(1, 2, 3, 0.50)'
 *   ctx.fillStyle = 'hsl(120,100%,50%)'   -> '#00ff00'
 *   ctx.fillStyle = 'transparent'         -> 'rgba(255, 255, 255, 0.00)'
 *   ctx.fillStyle = 'zzz'                 -> unchanged (the setter ignores what it cannot parse)
 *   gradient.addColorStop(0, 'zzz')       -> TypeError('parse color failed')
 *
 * so parsing reports failure instead of throwing, and only addColorStop turns it into an error.
 */

/** A colour: straight (non-premultiplied) 8-bit RGBA. */
export interface RGBA {
    r: number;
    g: number;
    b: number;
    a: number;
}

export const TRANSPARENT_BLACK: RGBA = { r: 0, g: 0, b: 0, a: 0 };

/** 'transparent' is rgba(0,0,0,0), but cairo reports it back as white with zero alpha, so it is kept apart. */
export const TRANSPARENT_WHITE: RGBA = { r: 255, g: 255, b: 255, a: 0 };

export function rgba(r: number, g: number, b: number, a: number): RGBA {
    return { r: r, g: g, b: b, a: a };
}

export function cloneColor(c: RGBA): RGBA {
    return { r: c.r, g: c.g, b: c.b, a: c.a };
}

const NAMED: { readonly [name: string]: string } = {
    aliceblue: 'f0f8ff', antiquewhite: 'faebd7', aqua: '00ffff', aquamarine: '7fffd4', azure: 'f0ffff',
    beige: 'f5f5dc', bisque: 'ffe4c4', black: '000000', blanchedalmond: 'ffebcd', blue: '0000ff',
    blueviolet: '8a2be2', brown: 'a52a2a', burlywood: 'deb887', cadetblue: '5f9ea0', chartreuse: '7fff00',
    chocolate: 'd2691e', coral: 'ff7f50', cornflowerblue: '6495ed', cornsilk: 'fff8dc', crimson: 'dc143c',
    cyan: '00ffff', darkblue: '00008b', darkcyan: '008b8b', darkgoldenrod: 'b8860b', darkgray: 'a9a9a9',
    darkgreen: '006400', darkgrey: 'a9a9a9', darkkhaki: 'bdb76b', darkmagenta: '8b008b',
    darkolivegreen: '556b2f', darkorange: 'ff8c00', darkorchid: '9932cc', darkred: '8b0000',
    darksalmon: 'e9967a', darkseagreen: '8fbc8f', darkslateblue: '483d8b', darkslategray: '2f4f4f',
    darkslategrey: '2f4f4f', darkturquoise: '00ced1', darkviolet: '9400d3', deeppink: 'ff1493',
    deepskyblue: '00bfff', dimgray: '696969', dimgrey: '696969', dodgerblue: '1e90ff',
    firebrick: 'b22222', floralwhite: 'fffaf0', forestgreen: '228b22', fuchsia: 'ff00ff',
    gainsboro: 'dcdcdc', ghostwhite: 'f8f8ff', gold: 'ffd700', goldenrod: 'daa520', gray: '808080',
    green: '008000', greenyellow: 'adff2f', grey: '808080', honeydew: 'f0fff0', hotpink: 'ff69b4',
    indianred: 'cd5c5c', indigo: '4b0082', ivory: 'fffff0', khaki: 'f0e68c', lavender: 'e6e6fa',
    lavenderblush: 'fff0f5', lawngreen: '7cfc00', lemonchiffon: 'fffacd', lightblue: 'add8e6',
    lightcoral: 'f08080', lightcyan: 'e0ffff', lightgoldenrodyellow: 'fafad2', lightgray: 'd3d3d3',
    lightgreen: '90ee90', lightgrey: 'd3d3d3', lightpink: 'ffb6c1', lightsalmon: 'ffa07a',
    lightseagreen: '20b2aa', lightskyblue: '87cefa', lightslategray: '778899', lightslategrey: '778899',
    lightsteelblue: 'b0c4de', lightyellow: 'ffffe0', lime: '00ff00', limegreen: '32cd32',
    linen: 'faf0e6', magenta: 'ff00ff', maroon: '800000', mediumaquamarine: '66cdaa',
    mediumblue: '0000cd', mediumorchid: 'ba55d3', mediumpurple: '9370db', mediumseagreen: '3cb371',
    mediumslateblue: '7b68ee', mediumspringgreen: '00fa9a', mediumturquoise: '48d1cc',
    mediumvioletred: 'c71585', midnightblue: '191970', mintcream: 'f5fffa', mistyrose: 'ffe4e1',
    moccasin: 'ffe4b5', navajowhite: 'ffdead', navy: '000080', oldlace: 'fdf5e6', olive: '808000',
    olivedrab: '6b8e23', orange: 'ffa500', orangered: 'ff4500', orchid: 'da70d6',
    palegoldenrod: 'eee8aa', palegreen: '98fb98', paleturquoise: 'afeeee', palevioletred: 'db7093',
    papayawhip: 'ffefd5', peachpuff: 'ffdab9', peru: 'cd853f', pink: 'ffc0cb', plum: 'dda0dd',
    powderblue: 'b0e0e6', purple: '800080', rebeccapurple: '663399', red: 'ff0000',
    rosybrown: 'bc8f8f', royalblue: '4169e1', saddlebrown: '8b4513', salmon: 'fa8072',
    sandybrown: 'f4a460', seagreen: '2e8b57', seashell: 'fff5ee', sienna: 'a0522d',
    silver: 'c0c0c0', skyblue: '87ceeb', slateblue: '6a5acd', slategray: '708090',
    slategrey: '708090', snow: 'fffafa', springgreen: '00ff7f', steelblue: '4682b4',
    tan: 'd2b48c', teal: '008080', thistle: 'd8bfd8', tomato: 'ff6347', turquoise: '40e0d0',
    violet: 'ee82ee', wheat: 'f5deb3', white: 'ffffff', whitesmoke: 'f5f5f5', yellow: 'ffff00',
    yellowgreen: '9acd32'
};

function hex2(text: string): number {
    return parseInt(text, 16);
}

function clamp255(value: number): number {
    return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
}

/**
 * One alpha byte. node-canvas keeps 8-bit alpha as cairo does, and cairo truncates: 'rgba(0,0,255,0.5)'
 * over opaque red measures back as (128, 0, 127), which is alpha 127/255, not 128/255. Rounding here
 * instead of truncating puts that pixel one unit off on both channels.
 */
function alpha255(value: number): number {
    return value < 0 ? 0 : value > 255 ? 255 : Math.floor(value);
}

/** One channel of rgb()/rgba(): a number, or a percentage of 255. */
function channel(token: string): number | null {
    const t = token.trim();
    if (t === '') return null;
    if (t.charCodeAt(t.length - 1) === 37) {
        const pct = Number(t.slice(0, -1));
        if (!isFinite(pct)) return null;
        return (pct / 100) * 255;
    }
    const n = Number(t);
    return isFinite(n) ? n : null;
}

/** The alpha argument of rgb()/rgba()/hsl()/hsla(): a number, a percentage, or none at all. */
function alphaOf(tokens: string[]): number | null {
    if (tokens.length === 0) return 255;
    const t = tokens[0].trim();
    if (t.charCodeAt(t.length - 1) === 37) {
        const pct = Number(t.slice(0, -1));
        if (!isFinite(pct)) return null;
        return (pct / 100) * 255;
    }
    const n = Number(t);
    return isFinite(n) ? n * 255 : null;
}

/** CSS hsl() to sRGB, the standard conversion. */
function hslToRgb(h: number, s: number, l: number): RGBA {
    const hh = ((h % 360) + 360) % 360;
    const ss = s < 0 ? 0 : s > 1 ? 1 : s;
    const ll = l < 0 ? 0 : l > 1 ? 1 : l;
    const c = (1 - Math.abs(2 * ll - 1)) * ss;
    const hp = hh / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    let r = 0, g = 0, b = 0;
    if (hp < 1) { r = c; g = x; } else if (hp < 2) { r = x; g = c; }
    else if (hp < 3) { g = c; b = x; } else if (hp < 4) { g = x; b = c; }
    else if (hp < 5) { r = x; b = c; } else { r = c; b = x; }
    const m = ll - c / 2;
    return rgba(clamp255((r + m) * 255), clamp255((g + m) * 255), clamp255((b + m) * 255), 255);
}

/**
 * Parses a CSS colour the way node-canvas does: '#rgb', '#rgba', '#rrggbb', '#rrggbbaa',
 * rgb()/rgba()/hsl()/hsla() with either comma or space separators and an optional '/ <alpha>',
 * and the CSS named colours. Returns null for anything else; the caller decides whether that is
 * ignored (a property setter) or an error (addColorStop).
 */
export function parseColor(text: string): RGBA | null {
    if (typeof text !== 'string') return null;
    const s = text.trim().toLowerCase();
    if (s === '') return null;
    if (s === 'transparent') return cloneColor(TRANSPARENT_WHITE);
    if (s.charCodeAt(0) === 35) {
        const hex = s.slice(1);
        if (hex.length === 3 || hex.length === 4) {
            if (!/^[0-9a-f]+$/.test(hex)) return null;
            const r = hex2(hex[0]) * 17, g = hex2(hex[1]) * 17, b = hex2(hex[2]) * 17;
            const a = hex.length === 4 ? hex2(hex[3]) * 17 : 255;
            return rgba(r, g, b, a);
        }
        if (hex.length === 6 || hex.length === 8) {
            if (!/^[0-9a-f]+$/.test(hex)) return null;
            const r = hex2(hex.slice(0, 2)), g = hex2(hex.slice(2, 4)), b = hex2(hex.slice(4, 6));
            const a = hex.length === 8 ? hex2(hex.slice(6, 8)) : 255;
            return rgba(r, g, b, a);
        }
        return null;
    }
    const named = NAMED[s];
    if (named !== undefined) {
        return rgba(hex2(named.slice(0, 2)), hex2(named.slice(2, 4)), hex2(named.slice(4, 6)), 255);
    }
    const open = s.indexOf('(');
    if (open < 0 || s.charCodeAt(s.length - 1) !== 41) return null;
    const fn = s.slice(0, open);
    const body = s.slice(open + 1, s.length - 1).replace(/\//g, ' ').replace(/,/g, ' ');
    const tokens = body.split(/\s+/).filter((t) => t !== '');
    if (fn === 'rgb' || fn === 'rgba') {
        if (tokens.length < 3 || tokens.length > 4) return null;
        const r = channel(tokens[0]), g = channel(tokens[1]), b = channel(tokens[2]);
        if (r === null || g === null || b === null) return null;
        const a = alphaOf(tokens.slice(3));
        if (a === null) return null;
        return rgba(clamp255(r), clamp255(g), clamp255(b), alpha255(a));
    }
    if (fn === 'hsl' || fn === 'hsla') {
        if (tokens.length < 3 || tokens.length > 4) return null;
        let h = Number(tokens[0].replace(/deg$/, ''));
        if (!isFinite(h)) {
            const turn = /^(-?[\d.]+)turn$/.exec(tokens[0]);
            const grad = /^(-?[\d.]+)grad$/.exec(tokens[0]);
            const rad = /^(-?[\d.]+)rad$/.exec(tokens[0]);
            if (turn) h = Number(turn[1]) * 360;
            else if (grad) h = (Number(grad[1]) * 360) / 400;
            else if (rad) h = (Number(rad[1]) * 180) / Math.PI;
            else return null;
        }
        const sPct = tokens[1], lPct = tokens[2];
        if (sPct.charCodeAt(sPct.length - 1) !== 37 || lPct.charCodeAt(lPct.length - 1) !== 37) return null;
        const sv = Number(sPct.slice(0, -1)), lv = Number(lPct.slice(0, -1));
        if (!isFinite(sv) || !isFinite(lv)) return null;
        const a = alphaOf(tokens.slice(3));
        if (a === null) return null;
        const c = hslToRgb(h, sv / 100, lv / 100);
        return rgba(c.r, c.g, c.b, alpha255(a));
    }
    return null;
}

function hexDigits(value: number): string {
    const text = (value & 0xff).toString(16);
    return text.length === 1 ? '0' + text : text;
}

/** How the add-on writes a colour back: '#rrggbb' when opaque, 'rgba(r, g, b, a)' with two decimals otherwise. */
export function formatColor(c: RGBA): string {
    if (c.a >= 255) return '#' + hexDigits(c.r) + hexDigits(c.g) + hexDigits(c.b);
    const a = Math.round((c.a / 255) * 100) / 100;
    return 'rgba(' + (c.r & 0xff) + ', ' + (c.g & 0xff) + ', ' + (c.b & 0xff) + ', ' + a.toFixed(2) + ')';
}

/** Linear interpolation in premultiplied space, which is what the canvas gradient spec asks for. */
export function mixColor(from: RGBA, to: RGBA, t: number): RGBA {
    const fa = from.a / 255, ta = to.a / 255;
    const a = fa + (ta - fa) * t;
    if (a <= 0) return rgba(0, 0, 0, 0);
    const fr = from.r * fa, fg = from.g * fa, fb = from.b * fa;
    const tr = to.r * ta, tg = to.g * ta, tb = to.b * ta;
    return rgba(
        Math.round((fr + (tr - fr) * t) / a),
        Math.round((fg + (tg - fg) * t) / a),
        Math.round((fb + (tb - fb) * t) / a),
        Math.round(a * 255)
    );
}
