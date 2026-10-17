/**
 * Self-contained baseline JPEG decoder: Huffman entropy decoding, inverse
 * quantisation, separable AAN inverse DCT, chroma upsampling, YCbCr -> RGB.
 *
 * Target runtime: a QuickJS guest. Constraints honoured here:
 *   - no imports / require / module boundaries
 *   - no Node built-ins, no Buffer, no zlib, no WebAssembly
 *   - only ES2017 language features and library globals (typed arrays, Math)
 *
 * Supported: baseline sequential DCT (SOF0, and SOF1 which is bit-identical in
 * its entropy coding), Huffman entropy coding, 8-bit samples, 1 component
 * (greyscale) or 3 components (YCbCr), sampling factors 1x1 / 2x1 / 2x2,
 * restart markers (DRI / RSTn), up to 4 quantisation tables, 4 DC and 4 AC
 * Huffman tables, JFIF and Adobe APP14, arbitrary APPn / COM skipping.
 * Missing tables fall back to the ITU-T T.81 Annex K defaults.
 *
 * Not supported (all raise `OWC_CANVAS_UNSUPPORTED_JPEG`): progressive
 * (SOF2), arithmetic coding, hierarchical / differential / lossless modes,
 * sample precisions other than 8, CMYK / YCCK, and any corrupt or truncated
 * stream. Nothing is ever returned as a blank image.
 *
 * Output: RGBA8, not premultiplied, alpha 255, row 0 = top. Decoding is a pure
 * function of the input bytes: no state is shared between calls.
 */

export interface JpegDecodeResult {
  /** Image width in pixels. */
  width: number;
  /** Image height in pixels. */
  height: number;
  /** RGBA8 pixel data, length width * height * 4, row 0 = top, not premultiplied. */
  data: Uint8Array;
}

const ERR_PREFIX = 'OWC_CANVAS_UNSUPPORTED_JPEG: ';

function fail(message: string): never {
  throw new Error(ERR_PREFIX + message);
}

/* ------------------------------------------------------------------ *
 * Annex K quantisation tables (T.81 K.1 / K.2), natural row-major order.
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
 * Annex K Huffman tables (T.81 K.3).
 * BITS[l-1] = number of codes of length l; HUFFVAL in canonical order.
 * ------------------------------------------------------------------ */

const STD_DC_LUMA_BITS: number[] = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const STD_DC_LUMA_VAL: number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const STD_DC_CHROMA_BITS: number[] = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const STD_DC_CHROMA_VAL: number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

const STD_AC_LUMA_BITS: number[] = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const STD_AC_LUMA_VAL: number[] = [
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
const STD_AC_CHROMA_VAL: number[] = [
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
 * Huffman table: canonical code book in the mincode/maxcode/valptr form
 * of the IJG reference decoder.
 * ------------------------------------------------------------------ */

interface HuffTable {
  /** symbols, canonical order */
  huffval: Uint8Array;
  /** first code of length l, index 1..16 */
  mincode: Int32Array;
  /** last code of length l, or -1 when length l is unused */
  maxcode: Int32Array;
  /** index into huffval of the first symbol of length l */
  valptr: Int32Array;
}

function buildHuffTable(bits: Uint8Array, huffval: Uint8Array): HuffTable {
  let total = 0;
  for (let i = 0; i < 16; i++) total += bits[i];
  if (total === 0) fail('Huffman table with no codes');
  if (total > huffval.length) fail('Huffman BITS/HUFFVAL mismatch');
  const mincode = new Int32Array(17);
  const maxcode = new Int32Array(17);
  const valptr = new Int32Array(17);
  let code = 0;
  let k = 0;
  for (let l = 1; l <= 16; l++) {
    const count = bits[l - 1];
    if (count !== 0) {
      mincode[l] = code;
      valptr[l] = k;
      k += count;
      code += count;
      maxcode[l] = code - 1;
      if (code > (1 << l)) fail('over-subscribed Huffman table');
    } else {
      mincode[l] = 0;
      valptr[l] = -1;
      maxcode[l] = -1;
    }
    code <<= 1;
  }
  return { huffval: huffval, mincode: mincode, maxcode: maxcode, valptr: valptr };
}

/* ------------------------------------------------------------------ *
 * Bit reader over the entropy-coded segment.
 *
 * `mark` is 0 while bytes are available, -1 on end of data, and otherwise
 * the second byte of the marker that terminated the segment. Any bit read
 * attempted after a marker was seen is a corrupt stream.
 * ------------------------------------------------------------------ */

class BitReader {
  private readonly data: Uint8Array;
  private p: number;
  private bitBuf: number;
  private bitCnt: number;
  mark: number;

  constructor(data: Uint8Array, pos: number) {
    this.data = data;
    this.p = pos;
    this.bitBuf = 0;
    this.bitCnt = 0;
    this.mark = 0;
  }

  get pos(): number {
    return this.p;
  }

  private nextByte(): number {
    const d = this.data;
    if (this.p >= d.length) {
      this.mark = -1;
      return 0;
    }
    const v = d[this.p++];
    if (v !== 0xff) return v;
    /* 0xFF introduces either a stuffed zero (FF 00) or a marker. */
    for (;;) {
      if (this.p >= d.length) {
        this.mark = -1;
        return 0;
      }
      const v2 = d[this.p++];
      if (v2 === 0x00) return 0xff;
      if (v2 === 0xff) continue;
      this.mark = v2;
      return 0;
    }
  }

  peek(n: number): number {
    let bc = this.bitCnt;
    let bb = this.bitBuf;
    while (bc < n) {
      const v = this.nextByte();
      if (this.mark !== 0) fail('truncated or corrupt entropy-coded data');
      bb = (bb << 8) | v;
      bc += 8;
    }
    this.bitCnt = bc;
    this.bitBuf = bb;
    return (bb >> (bc - n)) & ((1 << n) - 1);
  }

  readBits(n: number): number {
    const v = this.peek(n);
    this.bitCnt -= n;
    this.bitBuf = this.bitBuf & ((1 << this.bitCnt) - 1);
    return v;
  }

  readBit(): number {
    return this.readBits(1);
  }

  /** Drop buffered bits and any pending marker (used at restart points). */
  reset(): void {
    this.bitBuf = 0;
    this.bitCnt = 0;
    this.mark = 0;
  }

  /** Advance to the next marker byte; leaves its code in `mark`. */
  skipToMarker(): void {
    const d = this.data;
    while (this.mark === 0) {
      if (this.p >= d.length) fail('truncated JPEG data (marker expected)');
      const v = d[this.p++];
      if (v !== 0xff) continue;
      if (this.p >= d.length) fail('truncated JPEG data (marker expected)');
      const v2 = d[this.p];
      if (v2 === 0x00) {
        this.p++;
        continue;
      }
      if (v2 === 0xff) continue;
      this.p++;
      this.mark = v2;
    }
  }
}

function huffDecode(br: BitReader, h: HuffTable): number {
  let code = br.readBit();
  let l = 1;
  while (code > h.maxcode[l]) {
    if (l >= 16) fail('corrupt Huffman code');
    code = (code << 1) | br.readBit();
    l++;
  }
  const idx = h.valptr[l] + code - h.mincode[l];
  if (idx < 0 || idx >= h.huffval.length) fail('corrupt Huffman code');
  return h.huffval[idx];
}

/** Sign-extend an s-bit magnitude-coded value. */
function receiveExtend(br: BitReader, s: number): number {
  if (s === 0) return 0;
  const v = br.readBits(s);
  return v < (1 << (s - 1)) ? v - (1 << s) + 1 : v;
}

/* ------------------------------------------------------------------ *
 * Separable AAN inverse DCT (accurate; float64 arithmetic).
 *
 * The one-dimensional kernel is the IJG `jpeg_idct_float` butterfly with the
 * scale factors folded into the constants, so each pass returns the true
 * 1-D inverse DCT with unit gain and no descale is needed between passes.
 * ------------------------------------------------------------------ */

const IDCT_WS: Float64Array = new Float64Array(64);

function idct1d(
  src: Float64Array,
  sOff: number,
  sStep: number,
  dst: Float64Array,
  dOff: number,
  dStep: number,
): void {
  const a0 = src[sOff];
  const a1 = src[sOff + sStep];
  const a2 = src[sOff + 2 * sStep];
  const a3 = src[sOff + 3 * sStep];
  const a4 = src[sOff + 4 * sStep];
  const a5 = src[sOff + 5 * sStep];
  const a6 = src[sOff + 6 * sStep];
  const a7 = src[sOff + 7 * sStep];

  /* even part */
  const z1 = (a2 + a6) * 0.541196100;
  const t2 = z1 + a6 * -1.847759065;
  const t3 = z1 + a2 * 0.765366865;
  const t0 = a0 + a4;
  const t1 = a0 - a4;
  const t10 = t0 + t3;
  const t13 = t0 - t3;
  const t11 = t1 + t2;
  const t12 = t1 - t2;

  /* odd part */
  let p0 = a7;
  let p1 = a5;
  let p2 = a3;
  let p3 = a1;
  let z1b = p0 + p3;
  let z2 = p1 + p2;
  let z3 = p0 + p2;
  let z4 = p1 + p3;
  const z5 = (z3 + z4) * 1.175875602;
  p0 = p0 * 0.298631336;
  p1 = p1 * 2.053119869;
  p2 = p2 * 3.072711026;
  p3 = p3 * 1.501321110;
  z1b = z1b * -0.899976223;
  z2 = z2 * -2.562915447;
  z3 = z3 * -1.961570560;
  z4 = z4 * -0.390180644;
  z3 += z5;
  z4 += z5;
  p0 += z1b + z3;
  p1 += z2 + z4;
  p2 += z2 + z3;
  p3 += z1b + z4;

  dst[dOff] = t10 + p3;
  dst[dOff + 7 * dStep] = t10 - p3;
  dst[dOff + dStep] = t11 + p2;
  dst[dOff + 6 * dStep] = t11 - p2;
  dst[dOff + 2 * dStep] = t12 + p1;
  dst[dOff + 5 * dStep] = t12 - p1;
  dst[dOff + 3 * dStep] = t13 + p0;
  dst[dOff + 4 * dStep] = t13 - p0;
}

/** In-place-capable 2-D IDCT: reads `coef` (natural order), writes `out`. */
function idct2d(coef: Float64Array, out: Float64Array): void {
  /* pass 1: columns (fixed u, varying v) */
  for (let u = 0; u < 8; u++) idct1d(coef, u, 8, IDCT_WS, u, 8);
  /* pass 2: rows (fixed y, varying u) */
  for (let y = 0; y < 8; y++) idct1d(IDCT_WS, y * 8, 1, out, y * 8, 1);
  /* The butterfly carries a gain of sqrt(8) per pass; remove it. The factor
   * is a power of two, so this costs no precision. */
  for (let i = 0; i < 64; i++) out[i] *= 0.125;
}

/* ------------------------------------------------------------------ *
 * Component bookkeeping
 * ------------------------------------------------------------------ */

interface Component {
  id: number;
  h: number;
  v: number;
  tq: number;
  td: number;
  ta: number;
  dcPred: number;
  /** sample plane, padded to whole blocks */
  plane: Uint8Array;
  planeWidth: number;
  planeHeight: number;
  /** meaningful (non-padding) sample count */
  samplesX: number;
  samplesY: number;
}

function defaultQuant(kind: number): Uint16Array {
  const nat = kind === 0 ? STD_LUMA_QT : STD_CHROMA_QT;
  const z = new Uint16Array(64);
  for (let i = 0; i < 64; i++) z[i] = nat[ZIGZAG[i]];
  return z;
}

function stdHuff(dc: boolean, chroma: boolean): HuffTable {
  let bits: number[];
  let vals: number[];
  if (dc) {
    bits = chroma ? STD_DC_CHROMA_BITS : STD_DC_LUMA_BITS;
    vals = chroma ? STD_DC_CHROMA_VAL : STD_DC_LUMA_VAL;
  } else {
    bits = chroma ? STD_AC_CHROMA_BITS : STD_AC_LUMA_BITS;
    vals = chroma ? STD_AC_CHROMA_VAL : STD_AC_LUMA_VAL;
  }
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = bits[i];
  const v = new Uint8Array(vals.length);
  for (let i = 0; i < vals.length; i++) v[i] = vals[i];
  return buildHuffTable(b, v);
}

/* ------------------------------------------------------------------ *
 * Decoder
 * ------------------------------------------------------------------ */

const M_SOI = 0xd8;
const M_EOI = 0xd9;
const M_SOS = 0xda;
const M_DRI = 0xdd;
const M_DHT = 0xc4;
const M_DQT = 0xdb;
const M_DAC = 0xcc;
const M_DNL = 0xdc;
const M_TEM = 0x01;

class Decoder {
  private readonly bytes: Uint8Array;
  private pos: number = 0;
  private width: number = 0;
  private height: number = 0;
  private ncomp: number = 0;
  private comps: Component[] = [];
  private maxH: number = 1;
  private maxV: number = 1;
  private mcux: number = 0;
  private mcuy: number = 0;
  private restartInterval: number = 0;
  private adobeTransform: number = -1;
  private scanDone: boolean = false;
  private readonly quantTables: (Uint16Array | null)[] = [null, null, null, null];
  private readonly dcTables: (HuffTable | null)[] = [null, null, null, null];
  private readonly acTables: (HuffTable | null)[] = [null, null, null, null];
  private readonly coef: Float64Array = new Float64Array(64);
  private readonly oblk: Float64Array = new Float64Array(64);

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  /* -- primitive readers ------------------------------------------- */

  private read16(): number {
    const d = this.bytes;
    if (this.pos + 2 > d.length) fail('truncated JPEG (short segment header)');
    const v = (d[this.pos] << 8) | d[this.pos + 1];
    this.pos += 2;
    return v;
  }

  private read8(): number {
    if (this.pos >= this.bytes.length) fail('truncated JPEG');
    return this.bytes[this.pos++];
  }

  /** Returns the marker code, or -1 at end of data. */
  private nextMarker(): number {
    const d = this.bytes;
    if (this.pos >= d.length) return -1;
    if (d[this.pos] !== 0xff) fail('corrupt JPEG (marker expected)');
    this.pos++;
    /* tolerate fill bytes */
    while (this.pos < d.length && d[this.pos] === 0xff) this.pos++;
    if (this.pos >= d.length) return -1;
    const m = d[this.pos++];
    if (m === 0x00) fail('corrupt JPEG (stuffed byte outside entropy data)');
    return m;
  }

  /** Skip a length-prefixed marker segment. */
  private skipSegment(): void {
    const len = this.read16();
    if (len < 2) fail('corrupt JPEG (bad segment length)');
    const end = this.pos + len - 2;
    if (end > this.bytes.length) fail('truncated JPEG (segment overruns data)');
    this.pos = end;
  }

  /* -- marker handlers --------------------------------------------- */

  private parseSOF(marker: number): void {
    const d = this.bytes;
    const len = this.read16();
    if (len < 8) fail('corrupt JPEG (short SOF)');
    const precision = this.read8();
    if (precision !== 8) fail('only 8-bit sample precision is supported (got ' + precision + ')');
    this.height = this.read16();
    this.width = this.read16();
    const n = this.read8();
    if (len !== 8 + 3 * n) fail('corrupt JPEG (SOF length/component count mismatch)');
    if (n === 0 || n > 4) fail('unsupported component count ' + n);
    if (this.height === 0 || this.width === 0) fail('corrupt JPEG (zero image dimension)');
    const pixels = this.width * this.height;
    if (pixels > 0x4000000) fail('image too large (' + this.width + 'x' + this.height + ')');
    this.ncomp = n;
    this.maxH = 1;
    this.maxV = 1;
    for (let i = 0; i < n; i++) {
      const id = this.read8();
      const hv = this.read8();
      const tq = this.read8();
      const h = hv >> 4;
      const v = hv & 0x0f;
      if (h === 0 || v === 0 || h > 4 || v > 4) {
        fail('unsupported sampling factors ' + h + 'x' + v);
      }
      if (tq > 3) fail('unsupported quantisation table selector ' + tq);
      if (h > this.maxH) this.maxH = h;
      if (v > this.maxV) this.maxV = v;
      this.comps.push({
        id: id,
        h: h,
        v: v,
        tq: tq,
        td: 0,
        ta: 0,
        dcPred: 0,
        plane: new Uint8Array(0),
        planeWidth: 0,
        planeHeight: 0,
        samplesX: 0,
        samplesY: 0,
      });
    }
    if (this.pos > d.length) fail('truncated JPEG (SOF overruns data)');
    this.mcux = Math.ceil(this.width / (8 * this.maxH));
    this.mcuy = Math.ceil(this.height / (8 * this.maxV));
    /* marker 0xc1 is extended sequential: identical entropy coding to baseline */
    if (marker !== 0xc0 && marker !== 0xc1) fail('unsupported SOF marker');
  }

  private parseDQT(): void {
    const d = this.bytes;
    const len = this.read16();
    const end = this.pos + len - 2;
    if (len < 2 || end > d.length) fail('truncated JPEG (DQT)');
    while (this.pos < end) {
      const pq = this.read8();
      const tq = pq & 0x0f;
      const prec = pq >> 4;
      if (tq > 3) fail('unsupported quantisation table selector ' + tq);
      if (prec > 1) fail('corrupt JPEG (bad DQT precision)');
      const q = new Uint16Array(64);
      if (prec === 0) {
        if (this.pos + 64 > end) fail('truncated JPEG (DQT)');
        for (let i = 0; i < 64; i++) q[i] = d[this.pos++];
      } else {
        if (this.pos + 128 > end) fail('truncated JPEG (DQT)');
        for (let i = 0; i < 64; i++) {
          q[i] = (d[this.pos] << 8) | d[this.pos + 1];
          this.pos += 2;
        }
      }
      for (let i = 0; i < 64; i++) {
        if (q[i] === 0) fail('corrupt JPEG (zero quantisation value)');
      }
      this.quantTables[tq] = q;
    }
    if (this.pos !== end) fail('corrupt JPEG (DQT length)');
  }

  private parseDHT(): void {
    const d = this.bytes;
    const len = this.read16();
    const end = this.pos + len - 2;
    if (len < 2 || end > d.length) fail('truncated JPEG (DHT)');
    while (this.pos < end) {
      const tcv = this.read8();
      const tc = tcv >> 4;
      const th = tcv & 0x0f;
      if (tc > 1) fail('corrupt JPEG (bad Huffman table class)');
      if (th > 3) fail('unsupported Huffman table selector ' + th);
      const bits = new Uint8Array(16);
      if (this.pos + 16 > end) fail('truncated JPEG (DHT)');
      let total = 0;
      for (let i = 0; i < 16; i++) {
        bits[i] = d[this.pos++];
        total += bits[i];
      }
      if (total === 0) fail('corrupt JPEG (empty Huffman table)');
      if (total > 256) fail('corrupt JPEG (Huffman table too large)');
      if (this.pos + total > end) fail('truncated JPEG (DHT)');
      const vals = new Uint8Array(total);
      for (let i = 0; i < total; i++) vals[i] = d[this.pos++];
      const table = buildHuffTable(bits, vals);
      if (tc === 0) this.dcTables[th] = table;
      else this.acTables[th] = table;
    }
    if (this.pos !== end) fail('corrupt JPEG (DHT length)');
  }

  private parseDRI(): void {
    const len = this.read16();
    if (len !== 4) fail('corrupt JPEG (DRI length)');
    this.restartInterval = this.read16();
  }

  private parseAPPn(marker: number): void {
    const d = this.bytes;
    const len = this.read16();
    if (len < 2) fail('corrupt JPEG (bad APPn length)');
    const end = this.pos + len - 2;
    if (end > d.length) fail('truncated JPEG (APPn overruns data)');
    const start = this.pos;
    if (marker === 0xe0 && this.pos + 5 <= end) {
      /* "JFIF\0" - nothing to read, YCbCr is the default interpretation */
      if (
        d[start] === 0x4a && d[start + 1] === 0x46 && d[start + 2] === 0x49 &&
        d[start + 3] === 0x46 && d[start + 4] === 0x00
      ) {
        this.pos = end;
        return;
      }
    }
    if (marker === 0xee && this.pos + 12 <= end) {
      /* Adobe APP14: "Adobe" + version + flags0 + flags1 + transform */
      if (
        d[start] === 0x41 && d[start + 1] === 0x64 && d[start + 2] === 0x6f &&
        d[start + 3] === 0x62 && d[start + 4] === 0x65
      ) {
        this.adobeTransform = d[start + 11];
        this.pos = end;
        return;
      }
    }
    this.pos = end;
  }

  private parseSOS(): void {
    const d = this.bytes;
    const len = this.read16();
    if (len < 6) fail('corrupt JPEG (short SOS)');
    const ns = this.read8();
    if (ns === 0 || ns > 4) fail('unsupported scan component count ' + ns);
    if (ns > this.ncomp) fail('corrupt JPEG (scan has more components than the frame)');
    const scan: Component[] = [];
    for (let i = 0; i < ns; i++) {
      const cs = this.read8();
      const tda = this.read8();
      const td = tda >> 4;
      const ta = tda & 0x0f;
      if (td > 3 || ta > 3) fail('unsupported Huffman table selector in scan');
      let found: Component | null = null;
      for (let j = 0; j < this.comps.length; j++) {
        if (this.comps[j].id === cs) found = this.comps[j];
      }
      if (found === null) fail('corrupt JPEG (scan references unknown component)');
      const c = found as Component;
      c.td = td;
      c.ta = ta;
      scan.push(c);
    }
    /* Ss, Se, Ah/Al: non-zero means anything other than a baseline scan */
    const ss = this.read8();
    const se = this.read8();
    const ahAl = this.read8();
    if (ss !== 0 || se !== 63 || ahAl !== 0) {
      fail('non-baseline scan (progressive or successive approximation)');
    }
    if (this.pos > d.length) fail('truncated JPEG (SOS)');
    for (let i = 0; i < scan.length; i++) {
      for (let j = 0; j < scan.length; j++) {
        if (i !== j && scan[i].id === scan[j].id) {
          fail('corrupt JPEG (duplicate component in scan)');
        }
      }
    }
    this.decodeScan(scan);
  }

  /* -- scan --------------------------------------------------------- */

  private quantFor(tq: number): Uint16Array {
    let q = this.quantTables[tq];
    if (q === null) {
      q = defaultQuant(tq === 0 ? 0 : 1);
      this.quantTables[tq] = q;
    }
    return q;
  }

  private dcTableFor(sel: number): HuffTable {
    let t = this.dcTables[sel];
    if (t === null) {
      t = stdHuff(true, sel !== 0);
      this.dcTables[sel] = t;
    }
    return t;
  }

  private acTableFor(sel: number): HuffTable {
    let t = this.acTables[sel];
    if (t === null) {
      t = stdHuff(false, sel !== 0);
      this.acTables[sel] = t;
    }
    return t;
  }

  private decodeBlock(c: Component, by: number, bx: number, br: BitReader): void {
    const coef = this.coef;
    for (let i = 0; i < 64; i++) coef[i] = 0;
    const qz = this.quantFor(c.tq);
    const dc = this.dcTableFor(c.td);
    const ac = this.acTableFor(c.ta);

    const t = huffDecode(br, dc);
    const diff = t === 0 ? 0 : receiveExtend(br, t);
    c.dcPred += diff;
    coef[0] = c.dcPred * qz[0];

    let k = 1;
    while (k < 64) {
      const rs = huffDecode(br, ac);
      const s = rs & 0x0f;
      const r = rs >> 4;
      if (s === 0) {
        if (r === 15) {
          /* ZRL: skip 16 zero coefficients */
          k += 16;
          continue;
        }
        /* EOB */
        break;
      }
      k += r;
      if (k > 63) fail('corrupt JPEG (coefficient run past end of block)');
      coef[ZIGZAG[k]] = receiveExtend(br, s) * qz[k];
      k++;
    }

    idct2d(coef, this.oblk);

    const plane = c.plane;
    const pw = c.planeWidth;
    const ox = bx * 8;
    const oy = by * 8;
    const out = this.oblk;
    for (let y = 0; y < 8; y++) {
      let pi = (oy + y) * pw + ox;
      let si = y * 8;
      for (let x = 0; x < 8; x++) {
        let v = Math.round(out[si++]) + 128;
        if (v < 0) v = 0;
        else if (v > 255) v = 255;
        plane[pi++] = v;
      }
    }
  }

  private decodeScan(scan: Component[]): void {
    if (this.comps.length === 0) fail('corrupt JPEG (scan before SOF)');
    /* Adobe APP14 transform: 0 = CMYK/RGB, 1 = YCbCr, 2 = YCCK (4 channels,
     * inverted K) which this decoder does not implement. */
    if (this.adobeTransform === 2) fail('YCCK JPEG (Adobe transform 2) is not supported');
    if (this.ncomp === 4) fail('4-component (CMYK) JPEG is not supported');
    if (this.ncomp !== 1 && this.ncomp !== 3) fail('unsupported component count ' + this.ncomp);
    if (scan.length !== this.ncomp) {
      /* a baseline JPEG never splits a frame across several scans */
      fail('multi-scan (non-baseline) JPEG is not supported');
    }

    for (let i = 0; i < this.comps.length; i++) {
      const c = this.comps[i];
      const bx = this.mcux * c.h;
      const by = this.mcuy * c.v;
      c.planeWidth = bx * 8;
      c.planeHeight = by * 8;
      c.plane = new Uint8Array(c.planeWidth * c.planeHeight);
      c.samplesX = Math.ceil((this.width * c.h) / this.maxH);
      c.samplesY = Math.ceil((this.height * c.v) / this.maxV);
      c.dcPred = 0;
    }

    const br = new BitReader(this.bytes, this.pos);
    const ri = this.restartInterval;
    let toGo = ri;
    let rstIndex = 0;

    for (let my = 0; my < this.mcuy; my++) {
      for (let mx = 0; mx < this.mcux; mx++) {
        if (ri !== 0 && toGo === 0) {
          br.reset();
          br.skipToMarker();
          const m = br.mark;
          if (m !== 0xd0 + (rstIndex & 7)) {
            fail('corrupt JPEG (expected RST' + (rstIndex & 7) + ' restart marker)');
          }
          br.reset();
          rstIndex++;
          toGo = ri;
          for (let i = 0; i < this.comps.length; i++) this.comps[i].dcPred = 0;
        }
        for (let ci = 0; ci < scan.length; ci++) {
          const c = scan[ci];
          for (let by = 0; by < c.v; by++) {
            for (let bx = 0; bx < c.h; bx++) {
              this.decodeBlock(c, my * c.v + by, mx * c.h + bx, br);
            }
          }
        }
        toGo--;
      }
    }

    this.scanDone = true;
    /* leave this.pos on the next marker so the outer loop can continue */
    const d = this.bytes;
    let p = br.pos;
    while (p < d.length - 1) {
      if (d[p] === 0xff && d[p + 1] !== 0x00 && d[p + 1] !== 0xff) break;
      p++;
    }
    this.pos = p;
  }

  /* -- output ------------------------------------------------------- */

  private buildOutput(): JpegDecodeResult {
    const w = this.width;
    const h = this.height;
    const n = this.ncomp;
    const data = new Uint8Array(w * h * 4);

    /* Per-component bilinear resampling tables, weights in 1/256 units. */
    const xs0: Int32Array[] = [];
    const xs1: Int32Array[] = [];
    const xsw: Int32Array[] = [];
    const ys0: Int32Array[] = [];
    const ys1: Int32Array[] = [];
    const ysw: Int32Array[] = [];
    for (let ci = 0; ci < n; ci++) {
      const c = this.comps[ci];
      const t0x = new Int32Array(w);
      const t1x = new Int32Array(w);
      const twx = new Int32Array(w);
      const limX = c.samplesX - 1;
      for (let x = 0; x < w; x++) {
        const u = ((x + 0.5) * c.h) / this.maxH - 0.5;
        let i0 = Math.floor(u);
        const frac = u - i0;
        let i1 = i0 + 1;
        if (i0 < 0) i0 = 0;
        if (i0 > limX) i0 = limX;
        if (i1 < 0) i1 = 0;
        if (i1 > limX) i1 = limX;
        t0x[x] = i0;
        t1x[x] = i1;
        twx[x] = Math.round(frac * 256);
      }
      const t0y = new Int32Array(h);
      const t1y = new Int32Array(h);
      const twy = new Int32Array(h);
      const limY = c.samplesY - 1;
      for (let y = 0; y < h; y++) {
        const u = ((y + 0.5) * c.v) / this.maxV - 0.5;
        let i0 = Math.floor(u);
        const frac = u - i0;
        let i1 = i0 + 1;
        if (i0 < 0) i0 = 0;
        if (i0 > limY) i0 = limY;
        if (i1 < 0) i1 = 0;
        if (i1 > limY) i1 = limY;
        t0y[y] = i0;
        t1y[y] = i1;
        twy[y] = Math.round(frac * 256);
      }
      xs0.push(t0x);
      xs1.push(t1x);
      xsw.push(twx);
      ys0.push(t0y);
      ys1.push(t1y);
      ysw.push(twy);
    }

    const planes: Uint8Array[] = [];
    const pws: number[] = [];
    for (let ci = 0; ci < n; ci++) {
      planes.push(this.comps[ci].plane);
      pws.push(this.comps[ci].planeWidth);
    }

    const rowA = new Int32Array(n);
    const rowB = new Int32Array(n);
    const wVert = new Int32Array(n);
    const samp = new Int32Array(n);

    /* 3-component RGB passthrough only when the components say so. */
    let rgbPass = false;
    if (n === 3) {
      rgbPass =
        this.comps[0].id === 0x52 && this.comps[1].id === 0x47 && this.comps[2].id === 0x42;
    }

    let o = 0;
    for (let y = 0; y < h; y++) {
      for (let ci = 0; ci < n; ci++) {
        rowA[ci] = ys0[ci][y] * pws[ci];
        rowB[ci] = ys1[ci][y] * pws[ci];
        wVert[ci] = ysw[ci][y];
      }
      for (let x = 0; x < w; x++) {
        for (let ci = 0; ci < n; ci++) {
          const pl = planes[ci];
          const xa = xs0[ci][x];
          const xb = xs1[ci][x];
          const wx = xsw[ci][x];
          const ra = rowA[ci];
          const a = (pl[ra + xa] * (256 - wx) + pl[ra + xb] * wx + 128) >> 8;
          const wv = wVert[ci];
          if (wv === 0) {
            samp[ci] = a;
          } else {
            const rb = rowB[ci];
            const b = (pl[rb + xa] * (256 - wx) + pl[rb + xb] * wx + 128) >> 8;
            samp[ci] = (a * (256 - wv) + b * wv + 128) >> 8;
          }
        }
        let r: number;
        let g: number;
        let b: number;
        if (n === 1) {
          r = samp[0];
          g = r;
          b = r;
        } else if (rgbPass) {
          r = samp[0];
          g = samp[1];
          b = samp[2];
        } else {
          const yy = samp[0];
          const cb = samp[1] - 128;
          const cr = samp[2] - 128;
          let rr = yy + 1.402 * cr;
          let gg = yy - 0.344136 * cb - 0.714136 * cr;
          let bb = yy + 1.772 * cb;
          rr = rr < 0 ? 0 : rr > 255 ? 255 : Math.round(rr);
          gg = gg < 0 ? 0 : gg > 255 ? 255 : Math.round(gg);
          bb = bb < 0 ? 0 : bb > 255 ? 255 : Math.round(bb);
          r = rr | 0;
          g = gg | 0;
          b = bb | 0;
        }
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = b;
        data[o + 3] = 255;
        o += 4;
      }
    }
    return { width: w, height: h, data: data };
  }

  /* -- driver ------------------------------------------------------- */

  decode(): JpegDecodeResult {
    const d = this.bytes;
    if (d.length < 4) fail('not a JPEG (too short)');
    if (d[0] !== 0xff || d[1] !== 0xd8) fail('not a JPEG (missing SOI)');
    this.pos = 2;

    let guard = 0;
    for (;;) {
      if (++guard > 4096) fail('corrupt JPEG (marker loop)');
      const m = this.nextMarker();
      if (m === -1) {
        if (this.scanDone) return this.buildOutput();
        fail('truncated JPEG (no scan data)');
      }
      if (m === M_SOI || m === M_TEM || (m >= 0xd0 && m <= 0xd7)) continue;
      if (m === M_EOI) {
        if (!this.scanDone) fail('corrupt JPEG (EOI before scan)');
        return this.buildOutput();
      }
      if (m === 0xc0 || m === 0xc1) {
        if (this.comps.length !== 0) fail('multi-scan (non-baseline) JPEG is not supported');
        this.parseSOF(m);
        continue;
      }
      if (m === 0xc2) fail('progressive JPEG (SOF2) is not supported');
      if (m === 0xc3) fail('lossless JPEG is not supported');
      if (m === 0xc5 || m === 0xc6 || m === 0xc7) {
        fail('differential / hierarchical JPEG is not supported');
      }
      if (m === 0xc8) fail('reserved JPEG marker JPG is not supported');
      if (m === 0xc9 || m === 0xca || m === 0xcb) {
        fail('arithmetic-coded JPEG is not supported');
      }
      if (m === M_DAC) fail('arithmetic-coded JPEG is not supported');
      if (m === M_DQT) {
        this.parseDQT();
        continue;
      }
      if (m === M_DHT) {
        this.parseDHT();
        continue;
      }
      if (m === M_DRI) {
        this.parseDRI();
        continue;
      }
      if (m === M_SOS) {
        if (this.scanDone) fail('multi-scan (non-baseline) JPEG is not supported');
        this.parseSOS();
        continue;
      }
      if (m === M_DNL) {
        this.skipSegment();
        continue;
      }
      if ((m >= 0xe0 && m <= 0xef) || m === 0xfe) {
        if (m >= 0xe0 && m <= 0xef) this.parseAPPn(m);
        else this.skipSegment();
        continue;
      }
      fail('unknown or unsupported JPEG marker 0x' + m.toString(16));
    }
  }
}

/**
 * Decode a baseline JPEG into RGBA8.
 *
 * @param bytes the complete JPEG file (or JFIF stream), including SOI and EOI.
 * @throws Error with the `OWC_CANVAS_UNSUPPORTED_JPEG: ` prefix for anything
 *         this decoder cannot handle. Never returns a blank image.
 */
export function decodeJPEG(bytes: Uint8Array): JpegDecodeResult {
  if (bytes === null || bytes === undefined || typeof bytes.length !== 'number') {
    fail('not a JPEG (no byte data)');
  }
  return new Decoder(bytes).decode();
}
