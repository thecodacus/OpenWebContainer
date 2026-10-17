/**
 * Baseline sequential JPEG encoder, pure JavaScript.
 *
 * Target: a QuickJS guest. No imports, no `require`, no Node built-ins, no
 * `Buffer`, no `zlib`, no WebAssembly. Only ES2017 language features and
 * `Math` / typed arrays.
 *
 * Format produced: JFIF v1.1, baseline DCT, Huffman, 8x8 blocks, 3 components,
 * 4:4:4 (no chroma subsampling), standard Annex K quantisation and Huffman
 * tables.
 *
 * `encodeJPEG` is a pure function of its arguments: identical inputs yield
 * byte-identical output.
 */

/* ------------------------------------------------------------------ *
 * Annex K quantisation tables, natural (row-major) order.
 * ------------------------------------------------------------------ */

const STD_LUMA_QT: number[] = [
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
];

const STD_CHROMA_QT: number[] = [
  17, 18, 24, 47, 99, 99, 99, 99,
  18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
];

/* ZIGZAG[k] = natural (row-major) index of the k-th coefficient in zig-zag
 * scan order. Natural index = v * 8 + u (v = vertical frequency row). */
const ZIGZAG: number[] = [
  0, 1, 8, 16, 9, 2, 3, 10,
  17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34,
  27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63,
];

/* ------------------------------------------------------------------ *
 * Annex K Huffman tables: 16 code-length counts followed by symbols.
 * ------------------------------------------------------------------ */

const STD_DC_LUMA_BITS: number[] = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const STD_DC_LUMA_VALS: number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

const STD_DC_CHROMA_BITS: number[] = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const STD_DC_CHROMA_VALS: number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

const STD_AC_LUMA_BITS: number[] = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const STD_AC_LUMA_VALS: number[] = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12,
  0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
  0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16,
  0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39,
  0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
  0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79,
  0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98,
  0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
  0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4,
  0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea,
  0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

const STD_AC_CHROMA_BITS: number[] = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const STD_AC_CHROMA_VALS: number[] = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21,
  0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
  0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91,
  0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
  0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34,
  0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38,
  0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
  0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
  0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
  0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78,
  0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96,
  0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
  0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4,
  0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
  0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2,
  0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9,
  0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

/* ------------------------------------------------------------------ *
 * Forward DCT cosine kernel. DCTK[u * 8 + x] carries the 1-D orthonormal
 * scaling factor C(u) so F(u,v) = 0.25 * sum_x sum_y f(y,x) * DCTK[u,x] *
 * DCTK[v,y].
 * ------------------------------------------------------------------ */

const DCTK: Float64Array = new Float64Array(64);
for (let u = 0; u < 8; u++) {
  const cu = u === 0 ? Math.SQRT1_2 : 1;
  for (let x = 0; x < 8; x++) {
    DCTK[u * 8 + x] = cu * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  }
}

/* Scratch for the separable DCT (row pass). Single-threaded use only; it does
 * not escape `fdct8x8` and does not affect purity of `encodeJPEG`. */
const DCT_TMP: Float64Array = new Float64Array(64);

function fdct8x8(block: Float64Array, out: Float64Array): void {
  /* Rows: DCT_TMP[y * 8 + u] = sum_x f(y,x) * DCTK[u,x] */
  for (let y = 0; y < 8; y++) {
    const o = y * 8;
    const f0 = block[o];
    const f1 = block[o + 1];
    const f2 = block[o + 2];
    const f3 = block[o + 3];
    const f4 = block[o + 4];
    const f5 = block[o + 5];
    const f6 = block[o + 6];
    const f7 = block[o + 7];
    for (let u = 0; u < 8; u++) {
      const k = u * 8;
      DCT_TMP[o + u] =
        f0 * DCTK[k] +
        f1 * DCTK[k + 1] +
        f2 * DCTK[k + 2] +
        f3 * DCTK[k + 3] +
        f4 * DCTK[k + 4] +
        f5 * DCTK[k + 5] +
        f6 * DCTK[k + 6] +
        f7 * DCTK[k + 7];
    }
  }
  /* Columns: out[v * 8 + u] = 0.25 * sum_y tmp(y,u) * DCTK[v,y] */
  for (let u = 0; u < 8; u++) {
    const t0 = DCT_TMP[u];
    const t1 = DCT_TMP[8 + u];
    const t2 = DCT_TMP[16 + u];
    const t3 = DCT_TMP[24 + u];
    const t4 = DCT_TMP[32 + u];
    const t5 = DCT_TMP[40 + u];
    const t6 = DCT_TMP[48 + u];
    const t7 = DCT_TMP[56 + u];
    for (let v = 0; v < 8; v++) {
      const k = v * 8;
      out[v * 8 + u] =
        0.25 *
        (t0 * DCTK[k] +
          t1 * DCTK[k + 1] +
          t2 * DCTK[k + 2] +
          t3 * DCTK[k + 3] +
          t4 * DCTK[k + 4] +
          t5 * DCTK[k + 5] +
          t6 * DCTK[k + 6] +
          t7 * DCTK[k + 7]);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Huffman tables (canonical codes).
 * ------------------------------------------------------------------ */

interface HuffTable {
  code: Int32Array;
  length: Int32Array;
}

function buildHuffTable(bits: number[], vals: number[]): HuffTable {
  const code = new Int32Array(256);
  const length = new Int32Array(256);
  let k = 0;
  let c = 0;
  for (let l = 1; l <= 16; l++) {
    const n = bits[l - 1];
    for (let i = 0; i < n; i++) {
      const sym = vals[k++];
      code[sym] = c;
      length[sym] = l;
      c++;
    }
    c = c << 1;
  }
  return { code: code, length: length };
}

const HUFF_DC_LUMA: HuffTable = buildHuffTable(STD_DC_LUMA_BITS, STD_DC_LUMA_VALS);
const HUFF_AC_LUMA: HuffTable = buildHuffTable(STD_AC_LUMA_BITS, STD_AC_LUMA_VALS);
const HUFF_DC_CHROMA: HuffTable = buildHuffTable(STD_DC_CHROMA_BITS, STD_DC_CHROMA_VALS);
const HUFF_AC_CHROMA: HuffTable = buildHuffTable(STD_AC_CHROMA_BITS, STD_AC_CHROMA_VALS);

/* ------------------------------------------------------------------ *
 * Bit-level output with 0xFF byte stuffing for entropy-coded data.
 * ------------------------------------------------------------------ */

class BitWriter {
  private buf: Uint8Array;
  private len: number;
  private acc: number;
  private nbits: number;

  constructor(capacity: number) {
    this.buf = new Uint8Array(capacity <= 0 ? 256 : capacity);
    this.len = 0;
    this.acc = 0;
    this.nbits = 0;
  }

  private reserve(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length === 0 ? 256 : this.buf.length * 2;
    while (cap < this.len + n) cap = cap * 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  /** Marker/header byte: emitted verbatim, never stuffed. */
  raw(b: number): void {
    this.reserve(1);
    this.buf[this.len++] = b & 0xff;
  }

  /** Entropy-coded byte: a 0xFF is followed by a stuffed 0x00. */
  private stuffed(b: number): void {
    this.reserve(2);
    this.buf[this.len++] = b & 0xff;
    if ((b & 0xff) === 0xff) this.buf[this.len++] = 0x00;
  }

  /** Append the low `n` bits of `code`, MSB first. */
  bits(code: number, n: number): void {
    if (n <= 0) return;
    this.acc = (this.acc << n) | (code & ((1 << n) - 1));
    this.nbits += n;
    while (this.nbits >= 8) {
      this.nbits -= 8;
      const b = (this.acc >>> this.nbits) & 0xff;
      this.acc = this.acc & ((1 << this.nbits) - 1);
      this.stuffed(b);
    }
  }

  /** Pad the final byte with 1 bits. */
  flush(): void {
    while (this.nbits > 0) this.bits(1, 1);
  }

  toBytes(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

function writeSegment(bw: BitWriter, marker: number, payload: number[]): void {
  bw.raw(0xff);
  bw.raw(marker);
  const len = payload.length + 2;
  bw.raw((len >>> 8) & 0xff);
  bw.raw(len & 0xff);
  for (let i = 0; i < payload.length; i++) bw.raw(payload[i] & 0xff);
}

/* ------------------------------------------------------------------ *
 * Block encoding.
 * ------------------------------------------------------------------ */

/** Number of bits needed to carry `v` in the JPEG sign-magnitude coding. */
function magnitudeCategory(v: number): number {
  let m = v < 0 ? -v : v;
  let c = 0;
  while (m !== 0) {
    c++;
    m = m >> 1;
  }
  return c;
}

function encodeBlock(
  bw: BitWriter,
  src: Float64Array,
  w: number,
  h: number,
  bx: number,
  by: number,
  quant: Int32Array,
  dcPred: number,
  dcTab: HuffTable,
  acTab: HuffTable,
  block: Float64Array,
  coef: Float64Array,
  qcoef: Int32Array,
): number {
  /* Gather the 8x8 sample block, replicating the edge column/row past the
   * right and bottom image borders. */
  for (let y = 0; y < 8; y++) {
    let sy = by + y;
    if (sy >= h) sy = h - 1;
    const srcRow = sy * w;
    const dstRow = y * 8;
    for (let x = 0; x < 8; x++) {
      let sx = bx + x;
      if (sx >= w) sx = w - 1;
      block[dstRow + x] = src[srcRow + sx];
    }
  }

  fdct8x8(block, coef);

  for (let i = 0; i < 64; i++) {
    const c = coef[i] / quant[i];
    /* Round half away from zero, as libjpeg's fixed-point path does. */
    let v = c < 0 ? -Math.round(-c) : Math.round(c);
    /* Keep the magnitude inside the range the Annex K tables can encode. */
    const lim = i === 0 ? 2047 : 1023;
    if (v > lim) v = lim;
    else if (v < -lim) v = -lim;
    qcoef[i] = v;
  }

  /* DC coefficient, differential against the previous block of this component. */
  const diff = qcoef[0] - dcPred;
  const dcCat = magnitudeCategory(diff);
  bw.bits(dcTab.code[dcCat], dcTab.length[dcCat]);
  if (dcCat !== 0) {
    bw.bits(diff < 0 ? diff + (1 << dcCat) - 1 : diff, dcCat);
  }

  /* AC coefficients in zig-zag order, run-length coded. */
  let run = 0;
  for (let k = 1; k < 64; k++) {
    const v = qcoef[ZIGZAG[k]];
    if (v === 0) {
      run++;
      continue;
    }
    while (run > 15) {
      bw.bits(acTab.code[0xf0], acTab.length[0xf0]);
      run -= 16;
    }
    const cat = magnitudeCategory(v);
    const sym = (run << 4) | cat;
    bw.bits(acTab.code[sym], acTab.length[sym]);
    bw.bits(v < 0 ? v + (1 << cat) - 1 : v, cat);
    run = 0;
  }
  if (run > 0) {
    bw.bits(acTab.code[0x00], acTab.length[0x00]); /* EOB */
  }

  return qcoef[0];
}

/* ------------------------------------------------------------------ *
 * Public API.
 * ------------------------------------------------------------------ */

/**
 * Encode straight (non-premultiplied) 8-bit RGBA pixels as a baseline JPEG.
 *
 * @param rgba   length `width * height * 4`, channel order R,G,B,A, row 0 top.
 * @param width  image width in pixels.
 * @param height image height in pixels.
 * @param quality clamped to [0, 1]; 1 is the finest quantisation.
 */
export function encodeJPEG(
  rgba: Uint8Array,
  width: number,
  height: number,
  quality: number,
): Uint8Array {
  const w = width | 0;
  const h = height | 0;

  let q = quality;
  if (!(q >= 0)) q = 0; /* also maps NaN to 0 */
  if (q > 1) q = 1;

  /* libjpeg's quality-to-scale rule, on the 0..1 scale (libjpeg takes 0..100):
   *   quality >= 50 ? 200 - 2*quality : 5000/quality
   * so a quality of 0.5 gives 100 either way. The q === 0 branch is degenerate;
   * any huge finite factor drives every table entry to 255, which is the limit. */
  const scale = q >= 0.5 ? 200 - 200 * q : q > 0 ? 50 / q : 1e12;

  const quantLuma = new Int32Array(64);
  const quantChroma = new Int32Array(64);
  for (let i = 0; i < 64; i++) {
    const lv = Math.round((STD_LUMA_QT[i] * scale) / 100);
    const cv = Math.round((STD_CHROMA_QT[i] * scale) / 100);
    quantLuma[i] = lv < 1 ? 1 : lv > 255 ? 255 : lv;
    quantChroma[i] = cv < 1 ? 1 : cv > 255 ? 255 : cv;
  }

  /* RGB -> YCbCr (JFIF full range). Fully transparent pixels composite onto
   * black; every other alpha is ignored, since JPEG carries no alpha. */
  const n = w * h;
  const planeY = new Float64Array(n);
  const planeCb = new Float64Array(n);
  const planeCr = new Float64Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    let r = rgba[p];
    let g = rgba[p + 1];
    let b = rgba[p + 2];
    if (rgba[p + 3] === 0) {
      r = 0;
      g = 0;
      b = 0;
    }
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const cb = -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
    const cr = 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
    planeY[i] = (y < 0 ? 0 : y > 255 ? 255 : y) - 128;
    planeCb[i] = (cb < 0 ? 0 : cb > 255 ? 255 : cb) - 128;
    planeCr[i] = (cr < 0 ? 0 : cr > 255 ? 255 : cr) - 128;
  }

  const bw = new BitWriter(1024 + n);

  /* SOI */
  bw.raw(0xff);
  bw.raw(0xd8);

  /* APP0, JFIF v1.1, units 0, density 1x1, no thumbnail */
  writeSegment(bw, 0xe0, [
    0x4a, 0x46, 0x49, 0x46, 0x00, /* "JFIF\0" */
    0x01, 0x01, /* version 1.1 */
    0x00, /* units: none */
    0x00, 0x01, /* Xdensity 1 */
    0x00, 0x01, /* Ydensity 1 */
    0x00, 0x00, /* no thumbnail */
  ]);

  /* DQT, two 8-bit tables, values in zig-zag order */
  const dqtLuma: number[] = [0x00];
  const dqtChroma: number[] = [0x01];
  for (let k = 0; k < 64; k++) {
    dqtLuma.push(quantLuma[ZIGZAG[k]]);
    dqtChroma.push(quantChroma[ZIGZAG[k]]);
  }
  writeSegment(bw, 0xdb, dqtLuma);
  writeSegment(bw, 0xdb, dqtChroma);

  /* SOF0: baseline, 8-bit precision, 3 components, all sampled 1x1 */
  writeSegment(bw, 0xc0, [
    0x08,
    (h >>> 8) & 0xff,
    h & 0xff,
    (w >>> 8) & 0xff,
    w & 0xff,
    0x03,
    0x01, 0x11, 0x00, /* Y  */
    0x02, 0x11, 0x01, /* Cb */
    0x03, 0x11, 0x01, /* Cr */
  ]);

  /* DHT: DC luma, AC luma, DC chroma, AC chroma */
  const dht: Array<[number, number[], number[]]> = [
    [0x00, STD_DC_LUMA_BITS, STD_DC_LUMA_VALS],
    [0x10, STD_AC_LUMA_BITS, STD_AC_LUMA_VALS],
    [0x01, STD_DC_CHROMA_BITS, STD_DC_CHROMA_VALS],
    [0x11, STD_AC_CHROMA_BITS, STD_AC_CHROMA_VALS],
  ];
  for (let t = 0; t < dht.length; t++) {
    const entry = dht[t];
    const payload: number[] = [entry[0]];
    for (let i = 0; i < 16; i++) payload.push(entry[1][i]);
    for (let i = 0; i < entry[2].length; i++) payload.push(entry[2][i]);
    writeSegment(bw, 0xc4, payload);
  }

  /* SOS: 3 components, full spectral range, no successive approximation */
  writeSegment(bw, 0xda, [
    0x03,
    0x01, 0x00,
    0x02, 0x11,
    0x03, 0x11,
    0x00, /* Ss */
    0x3f, /* Se */
    0x00, /* Ah / Al */
  ]);

  /* Entropy-coded scan, one MCU per 8x8 block (4:4:4). */
  const block = new Float64Array(64);
  const coef = new Float64Array(64);
  const qcoef = new Int32Array(64);
  const mcuW = (w + 7) >> 3;
  const mcuH = (h + 7) >> 3;
  let predY = 0;
  let predCb = 0;
  let predCr = 0;
  for (let my = 0; my < mcuH; my++) {
    const by = my * 8;
    for (let mx = 0; mx < mcuW; mx++) {
      const bx = mx * 8;
      predY = encodeBlock(
        bw, planeY, w, h, bx, by, quantLuma, predY,
        HUFF_DC_LUMA, HUFF_AC_LUMA, block, coef, qcoef,
      );
      predCb = encodeBlock(
        bw, planeCb, w, h, bx, by, quantChroma, predCb,
        HUFF_DC_CHROMA, HUFF_AC_CHROMA, block, coef, qcoef,
      );
      predCr = encodeBlock(
        bw, planeCr, w, h, bx, by, quantChroma, predCr,
        HUFF_DC_CHROMA, HUFF_AC_CHROMA, block, coef, qcoef,
      );
    }
  }
  bw.flush();

  /* EOI */
  bw.raw(0xff);
  bw.raw(0xd9);

  return bw.toBytes();
}
