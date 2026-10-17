/**
 * The PNG encoder. There is no zlib in the guest, so the IDAT stream is a zlib wrapper around deflate
 * **stored** blocks: a 2-byte zlib header, one or more uncompressed blocks of at most 65535 bytes, and
 * an Adler-32 of the filtered scanlines. That is a legal PNG that every decoder reads; it is simply not
 * compressed, so the shim's PNGs are larger than the add-on's for the same image. libpng's adaptive
 * row filtering is not reproduced either -- every scanline is written with filter type 0 (None), so a
 * `filters` option in PngConfig is accepted and ignored, and `palette` is refused outright.
 */

const CRC_TABLE = (function (): Uint32Array {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(bytes: Uint8Array, from: number, to: number): number {
    let c = 0xffffffff;
    for (let i = from; i < to; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array, from: number, to: number): number {
    let a = 1, b = 0;
    for (let i = from; i < to; i++) {
        a = (a + bytes[i]) % 65521;
        b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
}

/** A chunk type and its payload, appended with its length and CRC-32. */
function pushChunk(out: number[], type: string, payload: Uint8Array): void {
    out.push((payload.length >>> 24) & 0xff, (payload.length >>> 16) & 0xff, (payload.length >>> 8) & 0xff, payload.length & 0xff);
    for (let i = 0; i < 4; i++) out.push(type.charCodeAt(i));
    for (let i = 0; i < payload.length; i++) out.push(payload[i]);
    const body = new Uint8Array(4 + payload.length);
    for (let i = 0; i < 4; i++) body[i] = type.charCodeAt(i);
    body.set(payload, 4);
    const crc = crc32(body, 0, body.length);
    out.push((crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff);
}

/** The zlib stream: 0x78 0x01, then `raw` as stored deflate blocks, then Adler-32. */
function deflateStored(raw: Uint8Array): Uint8Array {
    const out: number[] = [0x78, 0x01];
    let at = 0;
    while (true) {
        const last = at + 65535 >= raw.length;
        const n = Math.min(65535, raw.length - at);
        out.push(last ? 1 : 0);
        out.push(n & 0xff, (n >>> 8) & 0xff);
        out.push((~n) & 0xff, ((~n) >>> 8) & 0xff);
        for (let i = 0; i < n; i++) out.push(raw[at + i]);
        at += n;
        if (last) break;
    }
    const sum = adler32(raw, 0, raw.length);
    out.push((sum >>> 24) & 0xff, (sum >>> 16) & 0xff, (sum >>> 8) & 0xff, sum & 0xff);
    return new Uint8Array(out);
}

/**
 * Encodes straight RGBA bytes, row 0 first, as an 8-bit RGBA PNG (colour type 6, no interlace).
 * `resolution`, when given, becomes a pHYs chunk in pixels per metre.
 */
export function encodePNG(rgba: Uint8Array, width: number, height: number, resolution?: number): Uint8Array {
    const stride = width * 4;
    const raw = new Uint8Array((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (stride + 1)] = 0;
        const from = y * stride;
        for (let i = 0; i < stride; i++) raw[y * (stride + 1) + 1 + i] = rgba[from + i];
    }
    const ihdr = new Uint8Array(13);
    ihdr[0] = (width >>> 24) & 0xff;
    ihdr[1] = (width >>> 16) & 0xff;
    ihdr[2] = (width >>> 8) & 0xff;
    ihdr[3] = width & 0xff;
    ihdr[4] = (height >>> 24) & 0xff;
    ihdr[5] = (height >>> 16) & 0xff;
    ihdr[6] = (height >>> 8) & 0xff;
    ihdr[7] = height & 0xff;
    ihdr[8] = 8;
    ihdr[9] = 6;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;
    const out: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    pushChunk(out, 'IHDR', ihdr);
    if (typeof resolution === 'number' && resolution > 0) {
        const ppm = Math.round(resolution / 0.0254);
        const phys = new Uint8Array(9);
        phys[0] = (ppm >>> 24) & 0xff;
        phys[1] = (ppm >>> 16) & 0xff;
        phys[2] = (ppm >>> 8) & 0xff;
        phys[3] = ppm & 0xff;
        phys[4] = (ppm >>> 24) & 0xff;
        phys[5] = (ppm >>> 16) & 0xff;
        phys[6] = (ppm >>> 8) & 0xff;
        phys[7] = ppm & 0xff;
        phys[8] = 1;
        pushChunk(out, 'pHYs', phys);
    }
    pushChunk(out, 'IDAT', deflateStored(raw));
    pushChunk(out, 'IEND', new Uint8Array(0));
    return new Uint8Array(out);
}
