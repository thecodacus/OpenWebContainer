/**
 * The 2x3 affine matrices of the canvas shim: the current transformation matrix (CTM) and the matrices
 * of CanvasPattern.setTransform(). A point (x, y) maps to (a*x + c*y + e, b*x + d*y + f), the same
 * layout DOMMatrix uses, so a matrix built from a DOMMatrix's a,b,c,d,e,f needs no conversion.
 */

export interface Mat {
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
}

export function mat(a: number, b: number, c: number, d: number, e: number, f: number): Mat {
    return { a: a, b: b, c: c, d: d, e: e, f: f };
}

export function identity(): Mat {
    return mat(1, 0, 0, 1, 0, 0);
}

export function clone(m: Mat): Mat {
    return mat(m.a, m.b, m.c, m.d, m.e, m.f);
}

/** The scalar a uniform scale multiplies lengths by: the geometric mean of the two axis scales. */
export function scaleOf(m: Mat): number {
    const det = Math.abs(m.a * m.d - m.b * m.c);
    return det <= 0 ? 0 : Math.sqrt(det);
}

/** n applied after m: apply(n, apply(m, p)). */
export function multiply(m: Mat, n: Mat): Mat {
    return mat(
        n.a * m.a + n.c * m.b,
        n.b * m.a + n.d * m.b,
        n.a * m.c + n.c * m.d,
        n.b * m.c + n.d * m.d,
        n.a * m.e + n.c * m.f + n.e,
        n.b * m.e + n.d * m.f + n.f
    );
}

export function determinant(m: Mat): number {
    return m.a * m.d - m.b * m.c;
}

/** The inverse, or null for a singular matrix -- a singular CTM makes every drawing operation a no-op. */
export function invert(m: Mat): Mat | null {
    const det = determinant(m);
    if (det === 0 || !isFinite(det)) return null;
    const i = 1 / det;
    return mat(m.d * i, -m.b * i, -m.c * i, m.a * i, (m.c * m.f - m.d * m.e) * i, (m.b * m.e - m.a * m.f) * i);
}

export function applyX(m: Mat, x: number, y: number): number {
    return m.a * x + m.c * y + m.e;
}

export function applyY(m: Mat, x: number, y: number): number {
    return m.b * x + m.d * y + m.f;
}

/** A length in user space as a length in device space, the best single number a non-uniform matrix allows. */
export function lengthOf(m: Mat, len: number): number {
    return len * scaleOf(m);
}

/** Any matrix-like object the page hands us (a DOMMatrix, or the result of setTransform). */
export function matFrom(value: unknown): Mat | null {
    if (!value || typeof value !== 'object') return null;
    const o = value as { a?: unknown; b?: unknown; c?: unknown; d?: unknown; e?: unknown; f?: unknown };
    const a = num(o.a), b = num(o.b), c = num(o.c), d = num(o.d), e = num(o.e), f = num(o.f);
    if (a === null || b === null || c === null || d === null || e === null || f === null) return null;
    return mat(a, b, c, d, e, f);
}

function num(value: unknown): number | null {
    return typeof value === 'number' && isFinite(value) ? value : null;
}
