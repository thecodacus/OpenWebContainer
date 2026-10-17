/* ------------------------------------------------------------------------- *
 * Pure JavaScript baseline/sequential JPEG codec.
 *
 *  - no imports, no node built-ins, no WebAssembly, no Buffer
 *  - ES2020, platform neutral
 *  - decode: SOF0 / SOF1, Huffman, 1 or 3 components, arbitrary sampling
 *            factors, restart markers, APP0/APP1/APP2 metadata extraction
 *  - encode: baseline JFIF (SOI APP0 DQT SOF0 DHT SOS data EOI)
 *
 * Accuracy notes: the forward/inverse DCT is a separable float DCT built from
 * the exact JPEG basis matrix A[u][x] = (C(u)/2) * cos((2x+1)u*pi/16) with
 * C(0) = 1/sqrt(2), C(u>0) = 1.  The same matrix inverts it, so encode and
 * decode are mutually exact and both agree with libjpeg's integer islow
 * implementation to well under one 8 bit step.  Chroma upsampling reproduces
 * libjpeg's "fancy" (triangle filter) upsamplers for the 4:2:0 and 4:2:2
 * cases and falls back to clamped bilinear for the exotic ones.
 * ------------------------------------------------------------------------- */

export interface Image {
  width: number;
  height: number;
  channels: 1 | 2 | 3 | 4; /* 1 grey, 2 grey+alpha, 3 rgb, 4 rgba */
  data: Uint8Array; /* length === width*height*channels, row major, interleaved, 8 bit, non premultiplied */
}

export interface JpegInfo {
  chromaSubsampling: string;
  isProgressive: boolean;
  density?: number;
  hasProfile: boolean;
  orientation?: number;
  exif?: Uint8Array;
  icc?: Uint8Array;
  xmp?: Uint8Array;
}

export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 1 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

/* ------------------------------------------------------------------ tables */

/* zigzag position -> natural (row major) index */
const ZIG2NAT = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40,
  48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29,
  22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54,
  47, 55, 62, 63,
]);

/* natural index -> zigzag position */
const NAT2ZIG = new Uint8Array(64);
for (let k = 0; k < 64; k++) NAT2ZIG[ZIG2NAT[k]] = k;

/* DCT basis, shared by the forward and the inverse transform */
const DCT_A = new Float32Array(64);
for (let u = 0; u < 8; u++) {
  const c = (u === 0 ? Math.SQRT1_2 : 1) * 0.5;
  for (let x = 0; x < 8; x++) {
    DCT_A[u * 8 + x] = c * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  }
}

/* one dimensional forward DCT:
 *   dst[dstOff + u*dstStep] = sum_x A[u][x] * src[srcOff + x*srcStep]      */
function dct1d(
  src: Float32Array,
  srcOff: number,
  srcStep: number,
  dst: Float32Array,
  dstOff: number,
  dstStep: number
): void {
  for (let u = 0; u < 8; u++) {
    const b = u * 8;
    let s = 0;
    for (let x = 0; x < 8; x++) s += DCT_A[b + x] * src[srcOff + x * srcStep];
    dst[dstOff + u * dstStep] = s;
  }
}

/* one dimensional inverse DCT (A is not symmetric, so this is A transposed):
 *   dst[dstOff + x*dstStep] = sum_u A[u][x] * src[srcOff + u*srcStep]      */
function idct1d(
  src: Float32Array,
  srcOff: number,
  srcStep: number,
  dst: Float32Array,
  dstOff: number,
  dstStep: number
): void {
  for (let x = 0; x < 8; x++) {
    let s = 0;
    for (let u = 0; u < 8; u++) s += DCT_A[u * 8 + x] * src[srcOff + u * srcStep];
    dst[dstOff + x * dstStep] = s;
  }
}

/* Annex K quantisation tables, zigzag order */
const STD_LUMA_Q = new Uint8Array([
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16,
  24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109,
  103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
]);

const STD_CHROMA_Q = new Uint8Array([
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56,
  99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99,
]);

/* Annex K Huffman tables: 16 code counts followed by the symbol values */
const STD_DC_LUMA_BITS = new Uint8Array([
  0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0,
]);
const STD_DC_CHROMA_BITS = new Uint8Array([
  0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0,
]);
const STD_DC_VALS = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

const STD_AC_LUMA_BITS = new Uint8Array([
  0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d,
]);
const STD_AC_CHROMA_BITS = new Uint8Array([
  0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77,
]);

const STD_AC_LUMA_VALS = new Uint8Array([
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13,
  0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42,
  0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a,
  0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35,
  0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a,
  0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67,
  0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84,
  0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98,
  0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3,
  0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7,
  0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4,
  0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
]);

const STD_AC_CHROMA_VALS = new Uint8Array([
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51,
  0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1,
  0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24,
  0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a,
  0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66,
  0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82,
  0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96,
  0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa,
  0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9,
  0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4,
  0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
]);

/* ------------------------------------------------------------- huffman ---- */

interface HuffTable {
  maxcode: Int32Array; /* index 1..16, -1 when the length is unused */
  mincode: Int32Array;
  valptr: Int32Array;
  values: Uint8Array;
}

function buildHuffTable(bits: Uint8Array, huffval: Uint8Array): HuffTable {
  const maxcode = new Int32Array(17);
  const mincode = new Int32Array(17);
  const valptr = new Int32Array(17);
  let code = 0;
  let k = 0;
  for (let l = 1; l <= 16; l++) {
    const n = bits[l - 1];
    if (n > 0) {
      valptr[l] = k;
      mincode[l] = code;
      k += n;
      code += n;
      maxcode[l] = code - 1;
    } else {
      maxcode[l] = -1;
      mincode[l] = 0;
      valptr[l] = 0;
    }
    /* the code space doubles at every length, empty ones included */
    code <<= 1;
  }
  return { maxcode, mincode, valptr, values: huffval };
}

interface EncTable {
  code: Int32Array; /* indexed by symbol value */
  length: Uint8Array;
}

function buildEncTable(bits: Uint8Array, huffval: Uint8Array): EncTable {
  const code = new Int32Array(256);
  const length = new Uint8Array(256);
  let c = 0;
  let k = 0;
  for (let l = 1; l <= 16; l++) {
    const n = bits[l - 1];
    for (let i = 0; i < n; i++) {
      code[huffval[k]] = c;
      length[huffval[k]] = l;
      k++;
      c++;
    }
    c <<= 1;
  }
  return { code, length };
}

/* ------------------------------------------------------------ bit reader -- */

class BitReader {
  data: Uint8Array;
  pos: number;
  buf = 0;
  cnt = 0;

  constructor(data: Uint8Array, pos: number) {
    this.data = data;
    this.pos = pos;
  }

  readBit(): number {
    if (this.cnt === 0) {
      if (this.pos >= this.data.length) throw new Error('truncated JPEG data');
      let b = this.data[this.pos++];
      if (b === 0xff) {
        if (this.pos >= this.data.length) {
          throw new Error('truncated JPEG data');
        }
        const nb = this.data[this.pos];
        if (nb !== 0) {
          /* a real marker: wrong place, treat the scan as over / broken */
          this.pos--;
          throw new Error('truncated JPEG data');
        }
        this.pos++;
      }
      this.buf = b;
      this.cnt = 8;
    }
    this.cnt--;
    return (this.buf >> this.cnt) & 1;
  }

  align(): void {
    this.cnt = 0;
  }
}

function decodeHuff(br: BitReader, h: HuffTable): number {
  let code = br.readBit();
  let l = 1;
  while (code > h.maxcode[l]) {
    if (l >= 16) throw new Error('bad JPEG Huffman code');
    code = (code << 1) | br.readBit();
    l++;
  }
  return h.values[h.valptr[l] + code - h.mincode[l]];
}

function receiveExtend(br: BitReader, s: number): number {
  if (s === 0) return 0;
  let v = 0;
  for (let i = 0; i < s; i++) v = (v << 1) | br.readBit();
  if (v < 1 << (s - 1)) v -= (1 << s) - 1;
  return v;
}

/* ------------------------------------------------------------ bit writer -- */

class BitWriter {
  private buf: Uint8Array;
  private len = 0;
  private acc = 0;
  private nbits = 0;

  constructor(cap: number) {
    this.buf = new Uint8Array(cap < 64 ? 64 : cap);
  }

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  }

  byte(b: number): void {
    this.ensure(1);
    this.buf[this.len++] = b & 0xff;
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  writeBits(code: number, n: number): void {
    for (let i = n - 1; i >= 0; i--) this.writeBit((code >> i) & 1);
  }

  writeBit(b: number): void {
    this.acc = (this.acc << 1) | (b & 1);
    this.nbits++;
    if (this.nbits === 8) {
      const v = this.acc & 0xff;
      this.byte(v);
      if (v === 0xff) this.byte(0); /* byte stuffing */
      this.acc = 0;
      this.nbits = 0;
    }
  }

  flush(): void {
    while (this.nbits !== 0) this.writeBit(1);
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

/* --------------------------------------------------------------- helpers -- */

function clamp255f(v: number): number {
  const r = v + 0.5;
  return r < 0 ? 0 : r > 255 ? 255 : r | 0;
}

function readU16BE(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1];
}

function asciiAt(b: Uint8Array, o: number, s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (o + i >= b.length || b[o + i] !== s.charCodeAt(i)) return false;
  }
  return true;
}

/* EXIF Orientation (tag 0x0112) out of a raw TIFF block */
function exifOrientation(tiff: Uint8Array): number | undefined {
  if (tiff.length < 8) return undefined;
  let le = false;
  if (tiff[0] === 0x49 && tiff[1] === 0x49) le = true;
  else if (tiff[0] === 0x4d && tiff[1] === 0x4d) le = false;
  else return undefined;

  const u16 = (o: number): number =>
    le ? tiff[o] | (tiff[o + 1] << 8) : (tiff[o] << 8) | tiff[o + 1];
  const u32 = (o: number): number =>
    le
      ? ((tiff[o] |
          (tiff[o + 1] << 8) |
          (tiff[o + 2] << 16) |
          (tiff[o + 3] << 24)) >>>
        0)
      : (((tiff[o] << 24) |
          (tiff[o + 1] << 16) |
          (tiff[o + 2] << 8) |
          tiff[o + 3]) >>>
        0);

  if (u16(2) !== 0x002a) return undefined;
  const ifd = u32(4);
  if (ifd < 8 || ifd + 2 > tiff.length) return undefined;
  const n = u16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > tiff.length) break;
    if (u16(e) === 0x0112 && u16(e + 2) === 3) return u16(e + 8);
  }
  return undefined;
}

/* sharp/libvips style chroma subsampling label */
function chromaLabel(h0: number, v0: number, h1: number, v1: number): string {
  if (h1 <= 0 || v1 <= 0 || h0 <= 0 || v0 <= 0) return '4:2:0';
  const hr = h0 / h1;
  const vr = v0 / v1;
  if (hr === 1 && vr === 1) return '4:4:4';
  if (hr === 2 && vr === 2) return '4:2:0';
  if (hr === 2 && vr === 1) return '4:2:2';
  if (hr === 4 && vr === 1) return '4:1:1';
  if (hr === 4 && vr === 2) return '4:1:0';
  if (hr === 1 && vr === 2) return '4:4:0';
  if (hr === 2 && vr === 4) return '4:2:4';
  return '4:2:0';
}

/* ------------------------------------------------------------ upsampling -- */

/**
 * Expand a decoded component plane to full image resolution.
 * hRatio/vRatio are hmax/h and vmax/v for this component.
 */
function upsampleComponent(
  plane: Uint8Array,
  planeW: number,
  compW: number,
  compH: number,
  outW: number,
  outH: number,
  hRatio: number,
  vRatio: number
): Uint8Array {
  const out = new Uint8Array(outW * outH);
  const maxI = compW - 1;
  const maxJ = compH - 1;

  /**
   * libjpeg int_upsample: each sample is repeated hRatio times across and vRatio times down. This is
   * what a component gets when no fancy upsampler takes it.
   */
  const replicate = (): Uint8Array => {
    for (let y = 0; y < outH; y++) {
      const row = Math.min(maxJ, (y / vRatio) | 0);
      const o = row * planeW;
      const d = y * outW;
      for (let x = 0; x < outW; x++) {
        out[d + x] = plane[o + Math.min(maxI, (x / hRatio) | 0)];
      }
    }
    return out;
  };

  /*
   * jdsample.c picks the fancy upsampler only while the component is more than two samples wide
   * (`do_fancy && compptr->downsampled_width > 2`), and falls back to replication below that. A 4x4
   * 4:2:0 image has a 2x2 chroma plane, so it replicates, while an 8x8 one has a 4x4 plane and
   * blends: measured against sharp 0.33.5, a chroma checkerboard decodes identically from 8x8 up
   * (max delta 0) and differs by up to 97 at 4x4, where only the four corners agree.
   */
  const fancy = compW > 2;

  if (hRatio === 1 && vRatio === 1) {
    for (let y = 0; y < outH; y++) {
      const s = y * planeW;
      const d = y * outW;
      for (let x = 0; x < outW; x++) out[d + x] = plane[s + x];
    }
    return out;
  }

  if (hRatio === 2 && vRatio === 2) {
    if (!fancy) return replicate();
    /* libjpeg h2v2_fancy_upsample: separable 3/4 - 1/4 triangle filter */
    for (let y = 0; y < outH; y++) {
      const r0 = y >> 1;
      const r1 = (y & 1) === 0 ? r0 - 1 : r0 + 1;
      const o0 = (r0 > maxJ ? maxJ : r0) * planeW;
      const o1 = (r1 < 0 ? 0 : r1 > maxJ ? maxJ : r1) * planeW;
      const d = y * outW;
      for (let x = 0; x < outW; x++) {
        const i = x >> 1;
        const t = 3 * plane[o0 + i] + plane[o1 + i];
        let n: number;
        if ((x & 1) === 0) {
          const p = i > 0 ? i - 1 : 0;
          n = 3 * t + (3 * plane[o0 + p] + plane[o1 + p]) + 8;
        } else {
          const q = i < maxI ? i + 1 : maxI;
          n = 3 * t + (3 * plane[o0 + q] + plane[o1 + q]) + 7;
        }
        out[d + x] = n >> 4;
      }
    }
    return out;
  }

  if (hRatio === 2 && vRatio === 1) {
    if (!fancy) return replicate();
    /* libjpeg h2v1_fancy_upsample */
    for (let y = 0; y < outH; y++) {
      const o0 = (y > maxJ ? maxJ : y) * planeW;
      const d = y * outW;
      for (let x = 0; x < outW; x++) {
        const i = x >> 1;
        const t = 4 * plane[o0 + i];
        let n: number;
        if ((x & 1) === 0) {
          const p = i > 0 ? i - 1 : 0;
          n = 3 * t + 4 * plane[o0 + p] + 4;
        } else {
          const q = i < maxI ? i + 1 : maxI;
          n = 3 * t + 4 * plane[o0 + q] + 8;
        }
        out[d + x] = n >> 4;
      }
    }
    return out;
  }

  /* Every other ratio (4:1:1, 4:2:4, ...) has no fancy upsampler in libjpeg: int_upsample repeats. */
  return replicate();
}

/* ----------------------------------------------------------------- decode -- */

interface DecodeComp {
  id: number;
  h: number;
  v: number;
  tq: number;
  td: number;
  ta: number;
  pred: number;
  plane: Uint8Array;
  planeW: number;
  planeH: number;
  compW: number;
  compH: number;
}

export function decodeJpeg(
  bytes: Uint8Array
): { image: Image; info: JpegInfo } {
  if (!isJpeg(bytes)) throw new Error('bad JPEG signature');

  const len = bytes.length;
  const quant: Array<Float32Array | undefined> = [
    undefined,
    undefined,
    undefined,
    undefined,
  ];
  const huffDC: Array<HuffTable | undefined> = [
    undefined,
    undefined,
    undefined,
    undefined,
  ];
  const huffAC: Array<HuffTable | undefined> = [
    undefined,
    undefined,
    undefined,
    undefined,
  ];

  let width = 0;
  let height = 0;
  let ncomp = 0;
  let adobeTransform = -1;
  let restartInterval = 0;
  const comps: DecodeComp[] = [];

  let density: number | undefined;
  let orientation: number | undefined;
  let exif: Uint8Array | undefined;
  let iccChunks: Uint8Array[] | undefined;
  let xmp: Uint8Array | undefined;

  let scanStart = -1;
  let sawSOF = false;

  let p = 2;
  while (p + 1 < len) {
    if (bytes[p] !== 0xff) {
      p++;
      continue;
    }
    let m = bytes[p + 1];
    if (m === 0xff) {
      p++;
      continue; /* fill byte */
    }
    if (m === 0x00) {
      p += 2;
      continue;
    }
    p += 2;

    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue; /* standalone */
    if (m === 0xd9) break; /* EOI */

    if (p + 2 > len) break;
    const segLen = readU16BE(bytes, p);
    const s = p + 2;
    const e = p + segLen;
    if (segLen < 2 || e > len) break;
    p = e;

    if (m >= 0xe0 && m <= 0xef) {
      /* APPn */
      if (m === 0xe0 && asciiAt(bytes, s, 'JFIF\0') && s + 14 <= e) {
        const units = bytes[s + 7];
        const xd = readU16BE(bytes, s + 8);
        if (units === 1) density = xd;
        else if (units === 2) density = Math.round(xd * 2.54);
      } else if (m === 0xe1) {
        if (asciiAt(bytes, s, 'Exif\0\0')) {
          exif = bytes.slice(s + 6, e);
          const o = exifOrientation(exif);
          if (o !== undefined) orientation = o;
        } else if (asciiAt(bytes, s, 'http://ns.adobe.com/xap/1.0/\0')) {
          xmp = bytes.slice(s + 29, e);
        }
      } else if (m === 0xe2 && asciiAt(bytes, s, 'ICC_PROFILE\0') && s + 14 <= e) {
        const chunk = bytes.slice(s + 14, e);
        if (iccChunks === undefined) iccChunks = [];
        iccChunks.push(chunk);
      } else if (m === 0xee && asciiAt(bytes, s, 'Adobe') && s + 12 <= e) {
        adobeTransform = bytes[s + 11];
      }
      continue;
    }

    if (m === 0xdb) {
      /* DQT */
      let q = s;
      while (q < e) {
        const pq = bytes[q] >> 4;
        const tq = bytes[q] & 15;
        q++;
        const nat = new Float32Array(64);
        if (pq === 0) {
          if (q + 64 > e) break;
          for (let k = 0; k < 64; k++) nat[ZIG2NAT[k]] = bytes[q + k];
          q += 64;
        } else {
          if (q + 128 > e) break;
          for (let k = 0; k < 64; k++) {
            nat[ZIG2NAT[k]] = readU16BE(bytes, q + k * 2);
          }
          q += 128;
        }
        if (tq < 4) quant[tq] = nat;
      }
      continue;
    }

    if (m === 0xc4) {
      /* DHT */
      let q = s;
      while (q < e) {
        const tc = bytes[q] >> 4;
        const th = bytes[q] & 15;
        q++;
        if (q + 16 > e) break;
        const bits = new Uint8Array(16);
        let total = 0;
        for (let i = 0; i < 16; i++) {
          bits[i] = bytes[q + i];
          total += bits[i];
        }
        q += 16;
        if (q + total > e) break;
        const vals = new Uint8Array(total);
        vals.set(bytes.subarray(q, q + total));
        q += total;
        const t = buildHuffTable(bits, vals);
        if (tc === 0) {
          if (th < 4) huffDC[th] = t;
        } else if (th < 4) huffAC[th] = t;
      }
      continue;
    }

    if (m === 0xdd) {
      /* DRI */
      if (s + 2 <= e) restartInterval = readU16BE(bytes, s);
      continue;
    }

    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      /* SOFn */
      if (s + 6 > e) throw new Error('bad JPEG frame header');
      if (m === 0xc2 || m === 0xca) {
        throw new Error('unsupported JPEG: progressive coding (SOF2)');
      }
      if (
        m === 0xc9 ||
        m === 0xca ||
        m === 0xcd ||
        m === 0xcb ||
        m === 0xcf ||
        m === 0xce
      ) {
        throw new Error('unsupported JPEG: arithmetic coding');
      }
      if (m !== 0xc0 && m !== 0xc1) {
        throw new Error('unsupported JPEG: SOF' + (m - 0xc0));
      }
      height = readU16BE(bytes, s + 1);
      width = readU16BE(bytes, s + 3);
      ncomp = bytes[s + 5];
      if (ncomp !== 1 && ncomp !== 3) {
        throw new Error('unsupported JPEG: ' + ncomp + ' components');
      }
      let q = s + 6;
      for (let i = 0; i < ncomp; i++) {
        if (q + 3 > e) throw new Error('bad JPEG frame header');
        comps.push({
          id: bytes[q],
          h: bytes[q + 1] >> 4,
          v: bytes[q + 1] & 15,
          tq: bytes[q + 2],
          td: 0,
          ta: 0,
          pred: 0,
          plane: new Uint8Array(0),
          planeW: 0,
          planeH: 0,
          compW: 0,
          compH: 0,
        });
        q += 3;
      }
      if (ncomp === 3 && adobeTransform === 2) {
        throw new Error('unsupported JPEG: Adobe YCCK transform');
      }
      sawSOF = true;
      continue;
    }

    if (m === 0xda) {
      /* SOS */
      if (!sawSOF) throw new Error('bad JPEG: missing SOF');
      const ns = bytes[s];
      let q = s + 1;
      for (let i = 0; i < ns; i++) {
        if (q + 2 > e) throw new Error('bad JPEG scan header');
        const id = bytes[q];
        const td = bytes[q + 1] >> 4;
        const ta = bytes[q + 1] & 15;
        q += 2;
        for (let c = 0; c < comps.length; c++) {
          if (comps[c].id === id) {
            comps[c].td = td;
            comps[c].ta = ta;
          }
        }
      }
      q += 3;
      scanStart = q;
      break;
    }
  }

  if (!sawSOF) throw new Error('bad JPEG: no SOF marker found');
  if (scanStart < 0) throw new Error('bad JPEG: no SOS marker found');
  if (width <= 0 || height <= 0) throw new Error('bad JPEG: zero image size');
  if (comps.length === 0) throw new Error('bad JPEG: no components');

  let hmax = 1;
  let vmax = 1;
  for (let i = 0; i < comps.length; i++) {
    if (comps[i].h > hmax) hmax = comps[i].h;
    if (comps[i].v > vmax) vmax = comps[i].v;
    if (comps[i].h < 1 || comps[i].v < 1) {
      throw new Error('bad JPEG: invalid sampling factor');
    }
  }

  const mcusX = Math.ceil(width / (hmax * 8));
  const mcusY = Math.ceil(height / (vmax * 8));

  for (let i = 0; i < comps.length; i++) {
    const c = comps[i];
    const bw = mcusX * c.h * 8;
    const bh = mcusY * c.v * 8;
    c.planeW = bw;
    c.planeH = bh;
    c.plane = new Uint8Array(bw * bh);
    c.compW = Math.ceil((width * c.h) / hmax);
    c.compH = Math.ceil((height * c.v) / vmax);
    if (c.compW > bw) c.compW = bw;
    if (c.compH > bh) c.compH = bh;
    if (quant[c.tq] === undefined) c.pred = 0;
  }

  const br = new BitReader(bytes, scanStart);
  const coef = new Float32Array(64);
  const tmp = new Float32Array(64);
  const outb = new Float32Array(64);

  let mcusDone = 0;
  let rstExpect = 0;
  let stop = false;

  for (let my = 0; my < mcusY && !stop; my++) {
    for (let mx = 0; mx < mcusX && !stop; mx++) {
      if (restartInterval > 0 && mcusDone > 0 && mcusDone % restartInterval === 0) {
        br.align();
        /* look for RSTn / EOI */
        let found = false;
        while (br.pos + 1 < len) {
          if (bytes[br.pos] === 0xff) {
            const mk = bytes[br.pos + 1];
            if (mk >= 0xd0 && mk <= 0xd7) {
              br.pos += 2;
              rstExpect = (rstExpect + 1) & 7;
              found = true;
              break;
            }
            if (mk === 0xd9) {
              br.pos += 2;
              stop = true;
              found = true;
              break;
            }
            if (mk === 0xff) {
              br.pos++;
              continue;
            }
          }
          br.pos++;
        }
        if (!found) stop = true;
        for (let i = 0; i < comps.length; i++) comps[i].pred = 0;
      }
      if (stop) break;

      for (let ci = 0; ci < comps.length; ci++) {
        const c = comps[ci];
        const qt = quant[c.tq];
        const hdc = huffDC[c.td];
        const hac = huffAC[c.ta];
        if (qt === undefined) throw new Error('bad JPEG: missing quant table');
        if (hdc === undefined || hac === undefined) {
          throw new Error('bad JPEG: missing Huffman table');
        }
        for (let by = 0; by < c.v; by++) {
          for (let bx = 0; bx < c.h; bx++) {
            coef.fill(0);
            const t = decodeHuff(br, hdc);
            const diff = t === 0 ? 0 : receiveExtend(br, t);
            c.pred += diff;
            coef[0] = c.pred * qt[0];
            let k = 1;
            while (k < 64) {
              const rs = decodeHuff(br, hac);
              const s = rs & 15;
              const r = rs >> 4;
              if (s === 0) {
                if (r === 15) {
                  k += 16;
                  continue;
                }
                break; /* EOB */
              }
              k += r;
              if (k > 63) break;
              const ni = ZIG2NAT[k];
              coef[ni] = receiveExtend(br, s) * qt[ni];
              k++;
            }

            /* inverse DCT: coef[v*8+u] -> outb[y*8+x] */
            for (let u = 0; u < 8; u++) {
              idct1d(coef, u, 8, tmp, u * 8, 1);
            }
            for (let yy = 0; yy < 8; yy++) {
              idct1d(tmp, yy, 8, outb, yy * 8, 1);
            }

            const blockX = (mx * c.h + bx) * 8;
            const blockY = (my * c.v + by) * 8;
            for (let yy = 0; yy < 8; yy++) {
              let o = (blockY + yy) * c.planeW + blockX;
              const src = yy * 8;
              for (let xx = 0; xx < 8; xx++) {
                const v = outb[src + xx] + 128.5;
                c.plane[o++] = v < 0 ? 0 : v > 255 ? 255 : v | 0;
              }
            }
          }
        }
      }
      mcusDone++;
    }
  }

  /* upsample every component to full resolution */
  const planes: Uint8Array[] = [];
  for (let i = 0; i < comps.length; i++) {
    const c = comps[i];
    planes.push(
      upsampleComponent(
        c.plane,
        c.planeW,
        c.compW,
        c.compH,
        width,
        height,
        hmax / c.h,
        vmax / c.v
      )
    );
  }

  /* assemble */
  const npx = width * height;
  let channels: 1 | 2 | 3 | 4;
  const data = new Uint8Array(npx * (comps.length === 1 ? 1 : 3));

  if (comps.length === 1) {
    channels = 1;
    data.set(planes[0]);
  } else {
    channels = 3;
    const y = planes[0];
    const cb = planes[1];
    const cr = planes[2];
    const noConv = adobeTransform === 0;
    for (let i = 0; i < npx; i++) {
      const yy = y[i];
      if (noConv) {
        data[i * 3] = yy;
        data[i * 3 + 1] = cb[i];
        data[i * 3 + 2] = cr[i];
        continue;
      }
      const db = cb[i] - 128;
      const dr = cr[i] - 128;
      data[i * 3] = clamp255f(yy + 1.402 * dr);
      data[i * 3 + 1] = clamp255f(yy - 0.344136 * db - 0.714136 * dr);
      data[i * 3 + 2] = clamp255f(yy + 1.772 * db);
    }
  }

  let icc: Uint8Array | undefined;
  if (iccChunks !== undefined && iccChunks.length > 0) {
    let total = 0;
    for (let i = 0; i < iccChunks.length; i++) total += iccChunks[i].length;
    icc = new Uint8Array(total);
    let o = 0;
    for (let i = 0; i < iccChunks.length; i++) {
      icc.set(iccChunks[i], o);
      o += iccChunks[i].length;
    }
  }

  const info: JpegInfo = {
    chromaSubsampling:
      comps.length === 1
        ? '4:4:4'
        : chromaLabel(comps[0].h, comps[0].v, comps[1].h, comps[1].v),
    isProgressive: false,
    hasProfile: icc !== undefined,
  };
  if (density !== undefined) info.density = density;
  if (orientation !== undefined) info.orientation = orientation;
  if (exif !== undefined) info.exif = exif;
  if (icc !== undefined) info.icc = icc;
  if (xmp !== undefined) info.xmp = xmp;

  return { image: { width, height, channels, data }, info };
}

/* ----------------------------------------------------------------- encode -- */

function scaleQuant(base: Uint8Array, quality: number): Uint8Array {
  const q = quality < 1 ? 1 : quality > 100 ? 100 : quality;
  const sf = q < 50 ? Math.floor(5000 / q) : 200 - q * 2;
  const out = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    let v = Math.floor((base[i] * sf + 50) / 100);
    if (v < 1) v = 1;
    if (v > 255) v = 255;
    out[i] = v;
  }
  return out;
}

interface EncComp {
  id: number;
  h: number;
  v: number;
  tq: number;
  td: number;
  ta: number;
  plane: Uint8Array;
  planeW: number;
  planeH: number;
  pred: number;
}

function padPlane(
  plane: Uint8Array,
  planeW: number,
  planeH: number,
  compW: number,
  compH: number
): void {
  if (compW < 1 || compH < 1) return;
  for (let y = 0; y < planeH; y++) {
    const o = y * planeW;
    const last = plane[o + compW - 1];
    for (let x = compW; x < planeW; x++) plane[o + x] = last;
  }
  for (let y = compH; y < planeH; y++) {
    plane.copyWithin(y * planeW, (compH - 1) * planeW, compH * planeW);
  }
}

export function encodeJpeg(
  image: Image,
  quality: number,
  chromaSubsampling: string
): Uint8Array {
  const w = image.width | 0;
  const h = image.height | 0;
  const src = image.data;
  const nch = image.channels;
  if (w <= 0 || h <= 0) throw new Error('bad image: zero size');

  const grey = nch === 1 || nch === 2;
  let hy = 1;
  let vy = 1;
  if (!grey) {
    if (chromaSubsampling === '4:4:4') {
      hy = 1;
      vy = 1;
    } else if (chromaSubsampling === '4:2:2') {
      hy = 2;
      vy = 1;
    } else {
      hy = 2;
      vy = 2;
    }
  }
  const hmax = grey ? 1 : hy;
  const vmax = grey ? 1 : vy;
  const mcusX = Math.ceil(w / (hmax * 8));
  const mcusY = Math.ceil(h / (vmax * 8));

  const ncomp = grey ? 1 : 3;
  const comps: EncComp[] = [];

  const qLumaZig = scaleQuant(STD_LUMA_Q, quality);
  const qChromaZig = scaleQuant(STD_CHROMA_Q, quality);
  const qLumaNat = new Float32Array(64);
  const qChromaNat = new Float32Array(64);
  for (let i = 0; i < 64; i++) {
    qLumaNat[i] = qLumaZig[NAT2ZIG[i]];
    qChromaNat[i] = qChromaZig[NAT2ZIG[i]];
  }

  /* full resolution YCbCr (or grey) */
  const npx = w * h;
  const ycc = new Uint8Array(npx * (grey ? 1 : 3));
  for (let i = 0; i < npx; i++) {
    const o = i * nch;
    if (grey) {
      ycc[i] = src[o];
    } else {
      const r = src[o];
      const g = src[o + 1];
      const b = src[o + 2];
      ycc[i * 3] = clamp255f(0.299 * r + 0.587 * g + 0.114 * b);
      ycc[i * 3 + 1] = clamp255f(
        -0.16874 * r - 0.33126 * g + 0.5 * b + 128
      );
      ycc[i * 3 + 2] = clamp255f(
        0.5 * r - 0.41869 * g - 0.08131 * b + 128
      );
    }
  }

  /* luma / grey plane: full resolution, padded to MCU blocks */
  {
    const planeW = mcusX * hy * 8;
    const planeH = mcusY * vy * 8;
    const plane = new Uint8Array(planeW * planeH);
    for (let y = 0; y < h; y++) {
      const d = y * planeW;
      const s = y * w;
      for (let x = 0; x < w; x++) {
        plane[d + x] = grey ? ycc[s + x] : ycc[(s + x) * 3];
      }
    }
    padPlane(plane, planeW, planeH, w, h);
    comps.push({
      id: 1,
      h: hy,
      v: vy,
      tq: 0,
      td: 0,
      ta: 0,
      plane,
      planeW,
      planeH,
      pred: 0,
    });
  }

  if (!grey) {
    const cw = Math.ceil(w / hmax);
    const chh = Math.ceil(h / vmax);
    const planeW = mcusX * 8;
    const planeH = mcusY * 8;
    const n = hy * vy;
    const half = n >> 1;
    for (let c = 0; c < 2; c++) {
      const plane = new Uint8Array(planeW * planeH);
      for (let j = 0; j < chh; j++) {
        const sy0 = j * vy;
        for (let i = 0; i < cw; i++) {
          const sx0 = i * hy;
          let sum = 0;
          for (let dy = 0; dy < vy; dy++) {
            let y = sy0 + dy;
            if (y >= h) y = h - 1;
            const row = y * w;
            for (let dx = 0; dx < hy; dx++) {
              let x = sx0 + dx;
              if (x >= w) x = w - 1;
              sum += ycc[(row + x) * 3 + 1 + c];
            }
          }
          plane[j * planeW + i] = (sum + half) / n;
        }
      }
      padPlane(plane, planeW, planeH, cw, chh);
      comps.push({
        id: 2 + c,
        h: 1,
        v: 1,
        tq: 1,
        td: 1,
        ta: 1,
        plane,
        planeW,
        planeH,
        pred: 0,
      });
    }
  }

  /* marker stream */
  const bw = new BitWriter(Math.max(1024, npx * 3));
  const seg = (marker: number, payload: number[]): void => {
    bw.byte(0xff);
    bw.byte(marker);
    bw.byte(((payload.length + 2) >> 8) & 0xff);
    bw.byte((payload.length + 2) & 0xff);
    for (let i = 0; i < payload.length; i++) bw.byte(payload[i]);
  };

  bw.byte(0xff);
  bw.byte(0xd8); /* SOI */

  /* APP0 JFIF, density 72 dpi */
  seg(0xe0, [
    0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48, 0x00, 0x48, 0x00,
    0x00,
  ]);

  /* DQT */
  {
    const payload: number[] = [0x00];
    for (let i = 0; i < 64; i++) payload.push(qLumaZig[i]);
    if (!grey) {
      payload.push(0x01);
      for (let i = 0; i < 64; i++) payload.push(qChromaZig[i]);
    }
    seg(0xdb, payload);
  }

  /* SOF0 */
  {
    const payload: number[] = [0x08, (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff, ncomp];
    for (let i = 0; i < ncomp; i++) {
      const c = comps[i];
      payload.push(c.id, (c.h << 4) | c.v, c.tq);
    }
    seg(0xc0, payload);
  }

  /* DHT */
  const dht = (cls: number, id: number, bits: Uint8Array, vals: Uint8Array): void => {
    const payload: number[] = [(cls << 4) | id];
    for (let i = 0; i < 16; i++) payload.push(bits[i]);
    for (let i = 0; i < vals.length; i++) payload.push(vals[i]);
    seg(0xc4, payload);
  };
  dht(0, 0, STD_DC_LUMA_BITS, STD_DC_VALS);
  dht(1, 0, STD_AC_LUMA_BITS, STD_AC_LUMA_VALS);
  if (!grey) {
    dht(0, 1, STD_DC_CHROMA_BITS, STD_DC_VALS);
    dht(1, 1, STD_AC_CHROMA_BITS, STD_AC_CHROMA_VALS);
  }

  /* SOS */
  {
    const payload: number[] = [ncomp];
    for (let i = 0; i < ncomp; i++) {
      payload.push(comps[i].id, (comps[i].td << 4) | comps[i].ta);
    }
    payload.push(0x00, 0x3f, 0x00);
    seg(0xda, payload);
  }

  /* entropy coded data */
  const dcEnc = [
    buildEncTable(STD_DC_LUMA_BITS, STD_DC_VALS),
    buildEncTable(STD_DC_CHROMA_BITS, STD_DC_VALS),
  ];
  const acEnc = [
    buildEncTable(STD_AC_LUMA_BITS, STD_AC_LUMA_VALS),
    buildEncTable(STD_AC_CHROMA_BITS, STD_AC_CHROMA_VALS),
  ];

  const samples = new Float32Array(64);
  const tmp = new Float32Array(64);
  const coef = new Float32Array(64);
  const qc = new Int32Array(64);

  const magnitude = (v: number): number => {
    let a = v < 0 ? -v : v;
    let s = 0;
    while (a !== 0) {
      s++;
      a >>= 1;
    }
    return s;
  };

  for (let my = 0; my < mcusY; my++) {
    for (let mx = 0; mx < mcusX; mx++) {
      for (let ci = 0; ci < ncomp; ci++) {
        const c = comps[ci];
        const qn = c.tq === 0 ? qLumaNat : qChromaNat;
        const dcT = dcEnc[c.td];
        const acT = acEnc[c.ta];
        for (let by = 0; by < c.v; by++) {
          for (let bx = 0; bx < c.h; bx++) {
            const blockX = (mx * c.h + bx) * 8;
            const blockY = (my * c.v + by) * 8;
            for (let yy = 0; yy < 8; yy++) {
              const o = (blockY + yy) * c.planeW + blockX;
              const d = yy * 8;
              for (let xx = 0; xx < 8; xx++) {
                samples[d + xx] = c.plane[o + xx] - 128;
              }
            }
            /* forward DCT: samples[y*8+x] -> coef[v*8+u] */
            for (let yy = 0; yy < 8; yy++) {
              dct1d(samples, yy * 8, 1, tmp, yy, 8);
            }
            for (let u = 0; u < 8; u++) {
              dct1d(tmp, u * 8, 1, coef, u, 8);
            }
            for (let i = 0; i < 64; i++) {
              const v = coef[i] / qn[i];
              qc[i] = v < 0 ? -Math.round(-v) : Math.round(v);
            }

            /* DC */
            const diff = qc[0] - c.pred;
            c.pred = qc[0];
            const ds = magnitude(diff);
            bw.writeBits(dcT.code[ds], dcT.length[ds]);
            if (ds > 0) {
              bw.writeBits(diff < 0 ? diff + (1 << ds) - 1 : diff, ds);
            }

            /* AC */
            let run = 0;
            for (let k = 1; k < 64; k++) {
              const v = qc[ZIG2NAT[k]];
              if (v === 0) {
                run++;
                continue;
              }
              while (run > 15) {
                bw.writeBits(acT.code[0xf0], acT.length[0xf0]);
                run -= 16;
              }
              const s = magnitude(v);
              const sym = (run << 4) | s;
              bw.writeBits(acT.code[sym], acT.length[sym]);
              bw.writeBits(v < 0 ? v + (1 << s) - 1 : v, s);
              run = 0;
            }
            if (run > 0) bw.writeBits(acT.code[0x00], acT.length[0x00]);
          }
        }
      }
    }
  }

  bw.flush();
  bw.byte(0xff);
  bw.byte(0xd9); /* EOI */

  return bw.finish();
}
