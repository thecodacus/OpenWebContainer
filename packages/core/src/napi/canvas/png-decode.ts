/**
 * Self-contained PNG decoder: zlib inflate + PNG unfilter, pure JavaScript.
 *
 * Target runtime: a QuickJS guest. Constraints honoured here:
 *   - no imports / require / module boundaries
 *   - no Node built-ins, no Buffer, no zlib, no WebAssembly
 *   - only ES2017 library globals (Uint8Array / Int32Array / Math)
 *
 * Supports 8-bit colour types 0/2/3/4/6 (plus bit depths 1/2/4 for colour
 * types 0 and 3), non-interlaced, multiple IDAT chunks, and tRNS for colour
 * types 0, 2 and 3. Output is always RGBA, 8 bits per channel, not
 * premultiplied, row 0 = top.
 */

export interface PngDecodeResult {
  /** Image width in pixels. */
  width: number;
  /** Image height in pixels. */
  height: number;
  /** RGBA8 pixel data, length width * height * 4, row 0 = top, not premultiplied. */
  data: Uint8Array;
}

const ERR_PREFIX = 'OWC_CANVAS_UNSUPPORTED_PNG: ';

function fail(message: string): never {
  throw new Error(ERR_PREFIX + message);
}

/* ------------------------------------------------------------------ */
/* CRC-32 (PNG chunk integrity)                                        */
/* ------------------------------------------------------------------ */

const CRC_TABLE: Uint32Array = (function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array, start: number, end: number): number {
  let a = 1;
  let b = 0;
  for (let i = start; i < end; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/* ------------------------------------------------------------------ */
/* Primitive readers                                                   */
/* ------------------------------------------------------------------ */

function readU32(bytes: Uint8Array, off: number): number {
  return (
    ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0
  );
}

/** Compare four ASCII bytes at `off` against a 4-character chunk type. */
function typeEquals(bytes: Uint8Array, off: number, type: string): boolean {
  return (
    bytes[off] === type.charCodeAt(0) &&
    bytes[off + 1] === type.charCodeAt(1) &&
    bytes[off + 2] === type.charCodeAt(2) &&
    bytes[off + 3] === type.charCodeAt(3)
  );
}

function typeName(bytes: Uint8Array, off: number): string {
  let s = '';
  for (let i = 0; i < 4; i++) {
    const c = bytes[off + i];
    s += String.fromCharCode(c >= 32 && c < 127 ? c : 63);
  }
  return s;
}

function isPlausibleTypeByte(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

/* ------------------------------------------------------------------ */
/* Bit reader                                                          */
/* ------------------------------------------------------------------ */

class BitReader {
  private readonly src: Uint8Array;
  private pos: number;
  private bitBuf = 0;
  private bitCnt = 0;

  constructor(src: Uint8Array, pos: number) {
    this.src = src;
    this.pos = pos;
  }

  /** Consume `need` bits, least-significant bit first (deflate order). */
  bits(need: number): number {
    while (this.bitCnt < need) {
      if (this.pos >= this.src.length) return fail('deflate stream ended unexpectedly');
      this.bitBuf |= this.src[this.pos++] << this.bitCnt;
      this.bitCnt += 8;
    }
    const value = need === 0 ? 0 : this.bitBuf & ((1 << need) - 1);
    this.bitBuf >>>= need;
    this.bitCnt -= need;
    return value;
  }

  /** Discard any partial-byte bits (used before a stored block header). */
  alignToByte(): void {
    this.bitBuf = 0;
    this.bitCnt = 0;
  }

  /** Next unconsumed byte offset: where the zlib Adler-32 trailer starts. */
  bytePosition(): number {
    return this.pos;
  }

  /** Copy `count` raw bytes straight out of the source (stored block body). */
  copyBytes(dest: Uint8Array, destOff: number, count: number): void {
    if (this.pos + count > this.src.length) {
      return fail('deflate stored block extends past end of stream');
    }
    for (let i = 0; i < count; i++) {
      dest[destOff + i] = this.src[this.pos + i];
    }
    this.pos += count;
  }
}

/* ------------------------------------------------------------------ */
/* Canonical Huffman decoding                                          */
/* ------------------------------------------------------------------ */

interface Huffman {
  /** counts[len] = number of symbols coded with `len` bits, index 1..15. */
  counts: Int32Array;
  /** Symbols ordered by (code length, symbol value). */
  symbols: Int32Array;
}

function buildHuffman(lengths: ArrayLike<number>, count: number): Huffman {
  const counts = new Int32Array(16);
  for (let i = 0; i < count; i++) {
    const l = lengths[i];
    if (l > 15) return fail('huffman code length out of range');
    counts[l]++;
  }
  let left = 1;
  for (let l = 1; l <= 15; l++) {
    left <<= 1;
    left -= counts[l];
    if (left < 0) return fail('over-subscribed huffman code');
  }
  const offsets = new Int32Array(16);
  for (let l = 1; l < 15; l++) {
    offsets[l + 1] = offsets[l] + counts[l];
  }
  const symbols = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const l = lengths[i];
    if (l !== 0) symbols[offsets[l]++] = i;
  }
  return { counts: counts, symbols: symbols };
}

function decodeSymbol(br: BitReader, h: Huffman): number {
  let code = 0;
  let first = 0;
  let index = 0;
  for (let len = 1; len <= 15; len++) {
    code |= br.bits(1);
    const count = h.counts[len];
    if (code - first < count) return h.symbols[index + (code - first)];
    index += count;
    first = (first + count) << 1;
    code <<= 1;
  }
  return fail('invalid huffman code');
}

const LENGTH_BASE: Int32Array = new Int32Array([
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163,
  195, 227, 258,
]);

const LENGTH_EXTRA: Int32Array = new Int32Array([
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
]);

const DIST_BASE: Int32Array = new Int32Array([
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
]);

const DIST_EXTRA: Int32Array = new Int32Array([
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
]);

const CODE_LENGTH_ORDER: Int32Array = new Int32Array([
  16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
]);

function buildFixedLitHuffman(): Huffman {
  const lengths = new Uint8Array(288);
  for (let i = 0; i < 144; i++) lengths[i] = 8;
  for (let i = 144; i < 256; i++) lengths[i] = 9;
  for (let i = 256; i < 280; i++) lengths[i] = 7;
  for (let i = 280; i < 288; i++) lengths[i] = 8;
  return buildHuffman(lengths, 288);
}

function buildFixedDistHuffman(): Huffman {
  const lengths = new Uint8Array(30);
  for (let i = 0; i < 30; i++) lengths[i] = 5;
  return buildHuffman(lengths, 30);
}

const FIXED_LIT: Huffman = buildFixedLitHuffman();
const FIXED_DIST: Huffman = buildFixedDistHuffman();

/* ------------------------------------------------------------------ */
/* Inflate (RFC 1951)                                                  */
/* ------------------------------------------------------------------ */

class OutputBuffer {
  private buf: Uint8Array;
  len = 0;

  constructor(initial: number) {
    this.buf = new Uint8Array(initial > 0 ? initial : 1);
  }

  reserve(extra: number): void {
    const needed = this.len + extra;
    if (this.buf.length >= needed) return;
    let cap = this.buf.length;
    while (cap < needed) {
      if (cap > 0x40000000) return fail('deflate output too large');
      cap *= 2;
    }
    const grown = new Uint8Array(cap);
    for (let i = 0; i < this.len; i++) grown[i] = this.buf[i];
    this.buf = grown;
  }

  push(byte: number): void {
    this.reserve(1);
    this.buf[this.len++] = byte;
  }

  /** Copy `count` raw bytes out of the source into the output (stored blocks). */
  copyFrom(reader: BitReader, count: number): void {
    this.reserve(count);
    const start = this.len;
    reader.copyBytes(this.buf, start, count);
    this.len = start + count;
  }

  at(index: number): number {
    return this.buf[index];
  }

  toUint8Array(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }
}

function inflateStored(br: BitReader, out: OutputBuffer): void {
  br.alignToByte();
  const len = br.bits(16);
  const nlen = br.bits(16);
  if ((len ^ 0xffff) !== nlen) return fail('deflate stored block length check failed');
  out.copyFrom(br, len);
}

interface InflateResult {
  data: Uint8Array;
  /** Byte offset in the source just past the last byte of the deflate stream. */
  endBytePosition: number;
}

/**
 * Inflate the deflate stream starting at `start`. `expected` is only an
 * allocation hint; the real size comes from the stream itself.
 */
function inflate(src: Uint8Array, start: number, expected: number): InflateResult {
  const br = new BitReader(src, start);
  const out = new OutputBuffer(expected > 0 ? expected : 1024);

  let last = 0;
  do {
    last = br.bits(1);
    const type = br.bits(2);

    if (type === 0) {
      inflateStored(br, out);
      continue;
    }

    if (type !== 1 && type !== 2) {
      return fail('invalid deflate block type');
    }

    let lit: Huffman;
    let dist: Huffman;
    if (type === 1) {
      lit = FIXED_LIT;
      dist = FIXED_DIST;
    } else {
      const hlit = br.bits(5) + 257;
      const hdist = br.bits(5) + 1;
      const hclen = br.bits(4) + 4;
      if (hlit > 288 || hdist > 32) return fail('invalid dynamic huffman header');

      const codeLengths = new Uint8Array(19);
      for (let i = 0; i < hclen; i++) {
        codeLengths[CODE_LENGTH_ORDER[i]] = br.bits(3);
      }
      const clHuff = buildHuffman(codeLengths, 19);

      const lengths = new Uint8Array(hlit + hdist);
      let i = 0;
      while (i < lengths.length) {
        const sym = decodeSymbol(br, clHuff);
        if (sym < 16) {
          lengths[i++] = sym;
        } else if (sym === 16) {
          if (i === 0) return fail('huffman repeat with no previous code length');
          const prev = lengths[i - 1];
          const rep = 3 + br.bits(2);
          if (i + rep > lengths.length) return fail('huffman code length repeat overflow');
          for (let k = 0; k < rep; k++) lengths[i++] = prev;
        } else if (sym === 17) {
          const rep = 3 + br.bits(3);
          if (i + rep > lengths.length) return fail('huffman code length repeat overflow');
          i += rep;
        } else {
          const rep = 11 + br.bits(7);
          if (i + rep > lengths.length) return fail('huffman code length repeat overflow');
          i += rep;
        }
      }
      if (lengths[256] === 0) return fail('dynamic huffman table has no end-of-block code');
      lit = buildHuffman(lengths.subarray(0, hlit), hlit);
      dist = buildHuffman(lengths.subarray(hlit, hlit + hdist), hdist);
    }

    for (;;) {
      const sym = decodeSymbol(br, lit);
      if (sym === 256) break;
      if (sym < 256) {
        out.push(sym);
        continue;
      }
      const li = sym - 257;
      if (li < 0 || li >= 29) return fail('invalid deflate length symbol');
      const length = LENGTH_BASE[li] + br.bits(LENGTH_EXTRA[li]);
      const ds = decodeSymbol(br, dist);
      if (ds < 0 || ds >= 30) return fail('invalid deflate distance symbol');
      const distance = DIST_BASE[ds] + br.bits(DIST_EXTRA[ds]);
      if (distance > out.len) return fail('deflate distance beyond start of output');
      out.reserve(length);
      const from = out.len - distance;
      for (let k = 0; k < length; k++) {
        out.push(out.at(from + k));
      }
    }
  } while (last === 0);

  return { data: out.toUint8Array(), endBytePosition: br.bytePosition() };
}

/* ------------------------------------------------------------------ */
/* zlib wrapper (RFC 1950)                                             */
/* ------------------------------------------------------------------ */

function inflateZlib(src: Uint8Array, start: number, expected: number): Uint8Array {
  if (start + 2 > src.length) return fail('zlib stream is truncated');
  const cmf = src[start];
  const flg = src[start + 1];
  if ((cmf & 0x0f) !== 8) return fail('zlib compression method is not deflate');
  if ((cmf >> 4) > 7) return fail('zlib window size is invalid');
  if (((cmf << 8) + flg) % 31 !== 0) return fail('zlib header check failed');
  if ((flg & 0x20) !== 0) return fail('zlib preset dictionary is not supported');

  const result = inflate(src, start + 2, expected);
  const raw = result.data;

  const trailerAt = result.endBytePosition;
  if (trailerAt + 4 > src.length) return fail('zlib stream is missing its adler32 trailer');
  const expectedAdler = readU32(src, trailerAt);
  const actualAdler = adler32(raw, 0, raw.length);
  if (expectedAdler !== actualAdler) return fail('zlib adler32 checksum mismatch');
  return raw;
}

/* ------------------------------------------------------------------ */
/* PNG chunk walk                                                      */
/* ------------------------------------------------------------------ */

interface Chunk {
  type: string;
  dataOffset: number;
  length: number;
}

const PNG_SIGNATURE: Int32Array = new Int32Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function checkSignature(bytes: Uint8Array): void {
  if (bytes.length < 8) return fail('file is too short to be a PNG');
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return fail('bad PNG signature');
  }
}

function collectChunks(bytes: Uint8Array): Chunk[] {
  const chunks: Chunk[] = [];
  let off = 8;
  const end = bytes.length;
  while (off + 8 <= end) {
    const length = readU32(bytes, off);
    if (length > 0x7fffffff) return fail('chunk length is out of bounds');
    const dataOffset = off + 8;
    if (dataOffset + length + 4 > end) return fail('chunk extends past end of file');
    const typeOff = off + 4;
    for (let i = 0; i < 4; i++) {
      if (!isPlausibleTypeByte(bytes[typeOff + i])) return fail('chunk type is not alphabetic');
    }
    const stored = readU32(bytes, dataOffset + length);
    const actual = crc32(bytes, typeOff, dataOffset + length);
    if (stored !== actual) {
      return fail('CRC mismatch in ' + typeName(bytes, typeOff) + ' chunk');
    }
    chunks.push({ type: typeName(bytes, typeOff), dataOffset: dataOffset, length: length });
    off = dataOffset + length + 4;
    if (chunks.length > 1 && chunks[chunks.length - 1].type === 'IEND') break;
  }
  return chunks;
}

/* ------------------------------------------------------------------ */
/* Unfilter (RFC 2083 section 6)                                       */
/* ------------------------------------------------------------------ */

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilter(raw: Uint8Array, stride: number, height: number, bpp: number): void {
  const rowBytes = stride + 1;
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes + 1;
    const prevStart = rowStart - rowBytes;
    const filterType = raw[rowStart - 1];
    if (filterType === 0) {
      continue;
    } else if (filterType === 1) {
      for (let x = bpp; x < stride; x++) {
        raw[rowStart + x] = (raw[rowStart + x] + raw[rowStart + x - bpp]) & 0xff;
      }
    } else if (filterType === 2) {
      for (let x = 0; x < stride; x++) {
        const up = y > 0 ? raw[prevStart + x] : 0;
        raw[rowStart + x] = (raw[rowStart + x] + up) & 0xff;
      }
    } else if (filterType === 3) {
      for (let x = 0; x < stride; x++) {
        const left = x >= bpp ? raw[rowStart + x - bpp] : 0;
        const up = y > 0 ? raw[prevStart + x] : 0;
        raw[rowStart + x] = (raw[rowStart + x] + ((left + up) >> 1)) & 0xff;
      }
    } else if (filterType === 4) {
      for (let x = 0; x < stride; x++) {
        const left = x >= bpp ? raw[rowStart + x - bpp] : 0;
        const up = y > 0 ? raw[prevStart + x] : 0;
        const upLeft = y > 0 && x >= bpp ? raw[prevStart + x - bpp] : 0;
        raw[rowStart + x] = (raw[rowStart + x] + paethPredictor(left, up, upLeft)) & 0xff;
      }
    } else {
      return fail('unknown PNG row filter type ' + filterType);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Pixel expansion                                                     */
/* ------------------------------------------------------------------ */

function scaleSample(value: number, bitDepth: number): number {
  if (bitDepth === 8) return value;
  const maxValue = (1 << bitDepth) - 1;
  return Math.round((value * 255) / maxValue);
}

/* ------------------------------------------------------------------ */
/* decodePNG                                                           */
/* ------------------------------------------------------------------ */

export function decodePNG(bytes: Uint8Array): PngDecodeResult {
  if (bytes === null || bytes === undefined) return fail('no input bytes');
  if (typeof bytes.length !== 'number') return fail('input is not a byte array');

  checkSignature(bytes);
  const chunks = collectChunks(bytes);
  if (chunks.length === 0) return fail('no chunks found');
  if (chunks[0].type !== 'IHDR') return fail('first chunk is not IHDR');

  let sawIEND = false;
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].type === 'IEND') {
      if (chunks[i].length !== 0) return fail('IEND chunk must be empty');
      sawIEND = true;
    }
  }
  if (!sawIEND) return fail('IEND chunk is missing');

  // ---- IHDR ----
  const ihdr = chunks[0];
  if (ihdr.length !== 13) return fail('IHDR chunk must be 13 bytes');
  const width = readU32(bytes, ihdr.dataOffset);
  const height = readU32(bytes, ihdr.dataOffset + 4);
  const bitDepth = bytes[ihdr.dataOffset + 8];
  const colorType = bytes[ihdr.dataOffset + 9];
  const compression = bytes[ihdr.dataOffset + 10];
  const filterMethod = bytes[ihdr.dataOffset + 11];
  const interlace = bytes[ihdr.dataOffset + 12];

  if (width === 0 || height === 0) return fail('image has a zero dimension');
  if (width > 0x7fffffff || height > 0x7fffffff) return fail('image dimensions are out of bounds');
  if (compression !== 0) return fail('unknown compression method ' + compression);
  if (filterMethod !== 0) return fail('unknown filter method ' + filterMethod);
  if (interlace !== 0) return fail('interlaced (Adam7) PNGs are not supported');

  let channels: number;
  if (colorType === 0) channels = 1;
  else if (colorType === 2) channels = 3;
  else if (colorType === 3) channels = 1;
  else if (colorType === 4) channels = 2;
  else if (colorType === 6) channels = 4;
  else return fail('unsupported colour type ' + colorType);

  if (colorType === 2 || colorType === 4 || colorType === 6) {
    if (bitDepth !== 8) return fail('unsupported bit depth ' + bitDepth + ' for colour type ' + colorType);
  } else if (bitDepth !== 1 && bitDepth !== 2 && bitDepth !== 4 && bitDepth !== 8) {
    return fail('unsupported bit depth ' + bitDepth + ' for colour type ' + colorType);
  }

  // Guard the allocation: reject anything that could not be materialised.
  const pixels = width * height;
  if (pixels > 0x10000000) return fail('image is too large to decode');
  const outBytes = pixels * 4;

  // ---- ancillary chunks: PLTE, tRNS, IDAT ----
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Chunk[] = [];
  let seenIdat = false;

  for (let i = 1; i < chunks.length; i++) {
    const c = chunks[i];
    if (c.type === 'IDAT') {
      seenIdat = true;
      idat.push(c);
    } else if (c.type === 'PLTE') {
      if (colorType === 0 || colorType === 4) return fail('PLTE is not allowed for greyscale PNGs');
      if (seenIdat) return fail('PLTE must appear before IDAT');
      if (c.length === 0 || c.length % 3 !== 0 || c.length > 768) return fail('invalid PLTE chunk');
      const p = new Uint8Array(c.length);
      for (let k = 0; k < c.length; k++) p[k] = bytes[c.dataOffset + k];
      palette = p;
    } else if (c.type === 'tRNS') {
      if (seenIdat) return fail('tRNS must appear before IDAT');
      if (colorType === 4 || colorType === 6) return fail('tRNS is not allowed for colour type ' + colorType);
      const t = new Uint8Array(c.length);
      for (let k = 0; k < c.length; k++) t[k] = bytes[c.dataOffset + k];
      trns = t;
    } else if (c.type === 'IEND') {
      break;
    }
  }

  if (colorType === 3 && palette === null) return fail('palette PNG is missing its PLTE chunk');
  if (palette !== null) {
    const maxEntries = 1 << bitDepth;
    if (palette.length / 3 > maxEntries) return fail('PLTE has more entries than the bit depth allows');
  }
  if (trns !== null) {
    if (colorType === 0 && trns.length !== 2) return fail('invalid tRNS chunk for greyscale');
    if (colorType === 2 && trns.length !== 6) return fail('invalid tRNS chunk for truecolour');
    if (colorType === 3 && trns.length > 256) return fail('invalid tRNS chunk for palette');
  }
  if (idat.length === 0) return fail('no IDAT chunks found');

  // ---- concatenate IDAT and inflate ----
  let idatTotal = 0;
  for (let i = 0; i < idat.length; i++) idatTotal += idat[i].length;
  if (idatTotal === 0) return fail('IDAT data is empty');
  const zdata = new Uint8Array(idatTotal);
  let w = 0;
  for (let i = 0; i < idat.length; i++) {
    const c = idat[i];
    for (let k = 0; k < c.length; k++) zdata[w++] = bytes[c.dataOffset + k];
  }

  const bitsPerPixel = channels * bitDepth;
  const stride = Math.floor((width * bitsPerPixel + 7) / 8);
  const bpp = Math.max(1, Math.floor(bitsPerPixel / 8));
  const expectedRaw = height * (stride + 1);

  const raw = inflateZlib(zdata, 0, expectedRaw);
  if (raw.length < expectedRaw) {
    return fail('inflated image data is shorter than expected');
  }

  unfilter(raw, stride, height, bpp);

  // ---- expand to RGBA ----
  const out = new Uint8Array(outBytes);
  const rowBytes = stride + 1;
  const maxValue = (1 << bitDepth) - 1;

  let trnsGrey = -1;
  let trnsR = -1;
  let trnsG = -1;
  let trnsB = -1;
  if (trns !== null && trns.length > 0) {
    if (colorType === 0) {
      trnsGrey = (trns[0] << 8) | trns[1];
    } else if (colorType === 2) {
      trnsR = (trns[0] << 8) | trns[1];
      trnsG = (trns[2] << 8) | trns[3];
      trnsB = (trns[4] << 8) | trns[5];
    }
  }

  let o = 0;
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes + 1;
    if (bitDepth === 8) {
      if (colorType === 0) {
        for (let x = 0; x < width; x++) {
          const g = raw[rowStart + x];
          out[o++] = g;
          out[o++] = g;
          out[o++] = g;
          out[o++] = g === trnsGrey ? 0 : 255;
        }
      } else if (colorType === 2) {
        for (let x = 0; x < width; x++) {
          const r = raw[rowStart + x * 3];
          const g = raw[rowStart + x * 3 + 1];
          const b = raw[rowStart + x * 3 + 2];
          out[o++] = r;
          out[o++] = g;
          out[o++] = b;
          out[o++] = r === trnsR && g === trnsG && b === trnsB ? 0 : 255;
        }
      } else if (colorType === 3) {
        const pal = palette as Uint8Array;
        const palTrns = trns;
        for (let x = 0; x < width; x++) {
          const idx = raw[rowStart + x];
          const p = idx * 3;
          out[o++] = pal[p];
          out[o++] = pal[p + 1];
          out[o++] = pal[p + 2];
          out[o++] = palTrns !== null && idx < palTrns.length ? palTrns[idx] : 255;
        }
      } else if (colorType === 4) {
        for (let x = 0; x < width; x++) {
          const g = raw[rowStart + x * 2];
          out[o++] = g;
          out[o++] = g;
          out[o++] = g;
          out[o++] = raw[rowStart + x * 2 + 1];
        }
      } else {
        for (let x = 0; x < width; x++) {
          out[o++] = raw[rowStart + x * 4];
          out[o++] = raw[rowStart + x * 4 + 1];
          out[o++] = raw[rowStart + x * 4 + 2];
          out[o++] = raw[rowStart + x * 4 + 3];
        }
      }
    } else {
      // Sub-byte bit depths: colour types 0 and 3 only.
      const mask = maxValue;
      for (let x = 0; x < width; x++) {
        const bitPos = x * bitDepth;
        const byteIndex = rowStart + (bitPos >> 3);
        const shift = 8 - bitDepth - (bitPos & 7);
        const v = (raw[byteIndex] >> shift) & mask;
        if (colorType === 0) {
          const g = scaleSample(v, bitDepth);
          out[o++] = g;
          out[o++] = g;
          out[o++] = g;
          out[o++] = v === trnsGrey ? 0 : 255;
        } else {
          const pal = palette as Uint8Array;
          const palTrns = trns;
          const p = v * 3;
          out[o++] = pal[p];
          out[o++] = pal[p + 1];
          out[o++] = pal[p + 2];
          out[o++] = palTrns !== null && v < palTrns.length ? palTrns[v] : 255;
        }
      }
    }
  }

  return { width: width, height: height, data: out };
}
