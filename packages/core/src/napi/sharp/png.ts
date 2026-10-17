// Pure-JavaScript PNG codec (decode + encode) for the sharp native-addon
// reimplementation: no wasm, no Node built-ins, no dynamic imports, no eval.

import { unzlibSync, zlibSync } from 'fflate';

export interface Image {
  width: number;
  height: number;
  channels: 1 | 2 | 3 | 4; // 1 grey, 2 grey+alpha, 3 rgb, 4 rgba
  data: Uint8Array; // length === width*height*channels, row-major top-to-bottom, interleaved, 8-bit, non-premultiplied
}

export interface PngInfo {
  isProgressive: boolean; // IHDR interlace method 1 (Adam7)
  hasProfile: boolean; // iCCP present
  hasAlpha: boolean;
  paletteBitDepth?: number; // colour type 3 only
  density?: number; // pHYs, pixels per resolutionUnit
  resolutionUnit?: 'inch' | 'cm'; // pHYs unit specifier 1 => 'inch', 0 => undefined
  background?: { r: number; g: number; b: number }; // bKGD, 8-bit values
  comments?: Array<[string, string]>; // tEXt/zTXt/iTXt [keyword, text]
}

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];

export function isPng(bytes: Uint8Array): boolean {
  if (!bytes || bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== SIG[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------- CRC-32 ----

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  crcTable = t;
  return t;
}

function crc32(buf: Uint8Array, start: number, end: number): number {
  const t = getCrcTable();
  let c = 0xffffffff;
  for (let i = start; i < end; i++) {
    c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ------------------------------------------------------------- utilities ----

function readU32(b: Uint8Array, p: number): number {
  return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
}

function chunkType(b: Uint8Array, p: number): string {
  return (
    String.fromCharCode(b[p]) +
    String.fromCharCode(b[p + 1]) +
    String.fromCharCode(b[p + 2]) +
    String.fromCharCode(b[p + 3])
  );
}

function latin1(b: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(b[i]);
  return s;
}

function bytesToStr(b: Uint8Array): string {
  return latin1(b, 0, b.length);
}

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const len = data.length;
  const out = new Uint8Array(12 + len);
  out[0] = (len >>> 24) & 0xff;
  out[1] = (len >>> 16) & 0xff;
  out[2] = (len >>> 8) & 0xff;
  out[3] = len & 0xff;
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  const c = crc32(out, 4, 8 + len);
  out[8 + len] = (c >>> 24) & 0xff;
  out[9 + len] = (c >>> 16) & 0xff;
  out[10 + len] = (c >>> 8) & 0xff;
  out[11 + len] = c & 0xff;
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// --------------------------------------------------------------- decoding ----

export function decodePng(bytes: Uint8Array): { image: Image; info: PngInfo } {
  if (!isPng(bytes)) throw new Error('bad PNG signature');

  let p = 8;
  let sawIHDR = false;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;

  const idat: Uint8Array[] = [];
  let idatLen = 0;
  let palette: Uint8Array | null = null;
  let paletteLen = 0;
  let trns: Uint8Array | null = null;
  let hasProfile = false;
  let density: number | undefined = undefined;
  let resolutionUnit: 'inch' | 'cm' | undefined = undefined;
  let background: { r: number; g: number; b: number } | undefined = undefined;
  let comments: Array<[string, string]> | null = null;

  while (p + 8 <= bytes.length) {
    const len = readU32(bytes, p);
    const type = chunkType(bytes, p + 4);
    const ds = p + 8;
    const de = ds + len;
    if (len > 0x7fffffff || de + 4 > bytes.length) {
      throw new Error('truncated PNG chunk');
    }
    if (crc32(bytes, p + 4, de) !== readU32(bytes, de)) {
      throw new Error('PNG chunk CRC mismatch');
    }
    const data = bytes.subarray(ds, de);

    switch (type) {
      case 'IHDR': {
        if (len !== 13) throw new Error('bad IHDR length');
        width = readU32(data, 0);
        height = readU32(data, 4);
        bitDepth = data[8];
        colorType = data[9];
        if (data[10] !== 0) throw new Error('unsupported PNG compression method');
        if (data[11] !== 0) throw new Error('unsupported PNG filter method');
        interlace = data[12];
        sawIHDR = true;
        break;
      }
      case 'IDAT':
        idat.push(data);
        idatLen += len;
        break;
      case 'PLTE':
        palette = new Uint8Array(len);
        palette.set(data);
        paletteLen = len / 3;
        break;
      case 'tRNS':
        trns = new Uint8Array(len);
        trns.set(data);
        break;
      case 'iCCP':
        hasProfile = true;
        break;
      case 'pHYs': {
        if (len >= 9) {
          const px = readU32(data, 0);
          if (data[8] === 1) {
            // pHYs unit 1 is pixels per metre; report pixels per inch (dpi),
            // the unit sharp's own metadata uses, so density and
            // resolutionUnit stay mutually consistent.
            density = Math.round(px * 0.0254);
            resolutionUnit = 'inch';
          } else {
            density = px;
          }
        }
        break;
      }
      case 'bKGD': {
        if (bitDepth === 16) {
          if (colorType === 0 || colorType === 4) {
            if (len >= 2) {
              const g = data[0];
              background = { r: g, g: g, b: g };
            }
          } else if (len >= 6) {
            background = { r: data[0], g: data[2], b: data[4] };
          }
        } else if (colorType === 0 || colorType === 4) {
          if (len >= 2) {
            const g = data[1];
            background = { r: g, g: g, b: g };
          }
        } else if (len >= 6) {
          background = { r: data[1], g: data[3], b: data[5] };
        }
        break;
      }
      case 'tEXt': {
        const nul = data.indexOf(0);
        if (nul >= 0) {
          if (!comments) comments = [];
          comments.push([latin1(data, 0, nul), latin1(data, nul + 1, len)]);
        }
        break;
      }
      case 'zTXt': {
        const nul = data.indexOf(0);
        if (nul >= 1 && nul + 1 < len && data[nul + 1] === 0) {
          if (!comments) comments = [];
          comments.push([latin1(data, 0, nul), bytesToStr(inflateLatin1(data, nul + 2))]);
        }
        break;
      }
      case 'iTXt': {
        const nul = data.indexOf(0);
        if (nul >= 0 && nul + 2 < len) {
          const compressed = data[nul + 1] === 1;
          let q = nul + 3;
          let langNul = -1;
          for (let i = q; i < len; i++) {
            if (data[i] === 0) {
              langNul = i;
              break;
            }
          }
          if (langNul >= 0) {
            let kwNul = -1;
            for (let i = langNul + 1; i < len; i++) {
              if (data[i] === 0) {
                kwNul = i;
                break;
              }
            }
            if (kwNul >= 0) {
              const body = data.subarray(kwNul + 1);
              let text: string;
              if (compressed && data[nul + 2] === 0) {
                text = bytesToStr(inflateLatin1(data, kwNul + 1));
              } else {
                text = latin1(body, 0, body.length);
              }
              if (!comments) comments = [];
              comments.push([latin1(data, 0, nul), text]);
            }
          }
        }
        break;
      }
      case 'IEND':
        break;
      default:
        break;
    }

    p = de + 4;
    if (type === 'IEND') break;
  }

  if (!sawIHDR) throw new Error('missing IHDR');
  if (interlace === 1) {
    throw new Error('interlaced PNG images (Adam7) are not supported');
  }
  if (interlace !== 0) throw new Error('unknown PNG interlace method: ' + interlace);
  if (bitDepth !== 8 && bitDepth !== 16) {
    throw new Error('unsupported PNG bit depth: ' + bitDepth);
  }
  if (colorType !== 0 && colorType !== 2 && colorType !== 3 && colorType !== 4 && colorType !== 6) {
    throw new Error('unsupported PNG colour type: ' + colorType);
  }
  if (colorType === 3 && bitDepth === 16) {
    throw new Error('unsupported PNG bit depth: 16 for palette image');
  }
  if (width === 0 || height === 0) throw new Error('bad PNG dimensions');
  if (colorType === 3 && !palette) throw new Error('missing PLTE chunk for palette PNG');
  if (idat.length === 0) throw new Error('missing IDAT chunk');

  const bytesPerSample = bitDepth === 16 ? 2 : 1;
  const samples =
    colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : 4;
  const bpp = samples * bytesPerSample;
  const stride = width * bpp;

  // Concatenate every IDAT chunk, then inflate.
  let zsrc: Uint8Array;
  if (idat.length === 1) {
    zsrc = idat[0];
  } else {
    zsrc = new Uint8Array(idatLen);
    let o = 0;
    for (let i = 0; i < idat.length; i++) {
      zsrc.set(idat[i], o);
      o += idat[i].length;
    }
  }
  let raw: Uint8Array;
  try {
    raw = unzlibSync(zsrc);
  } catch (e) {
    throw new Error('invalid PNG zlib stream');
  }

  const needed = (stride + 1) * height;
  if (raw.length < needed) throw new Error('truncated PNG data');

  // Which output channel count?
  let outChannels: 1 | 2 | 3 | 4;
  if (colorType === 0) outChannels = trns ? 2 : 1;
  else if (colorType === 2) outChannels = trns ? 4 : 3;
  else if (colorType === 3) outChannels = trns ? 4 : 3;
  else if (colorType === 4) outChannels = 2;
  else outChannels = 4;

  const out = new Uint8Array(width * height * outChannels);
  const cur = new Uint8Array(stride);
  const prev = new Uint8Array(stride);

  // Transparency key, normalised to the file's sample width.
  let keyGrey = -1;
  let keyR = -1;
  let keyG = -1;
  let keyB = -1;
  let palAlpha: Uint8Array | null = null;
  if (trns) {
    if (colorType === 3) {
      palAlpha = new Uint8Array(256).fill(255);
      const n = trns.length < 256 ? trns.length : 256;
      for (let i = 0; i < n; i++) palAlpha[i] = trns[i];
    } else if (colorType === 0) {
      if (trns.length >= 2) {
        keyGrey = bytesPerSample === 2 ? (trns[0] << 8) | trns[1] : trns[1];
      }
    } else if (colorType === 2) {
      if (trns.length >= 6) {
        if (bytesPerSample === 2) {
          keyR = (trns[0] << 8) | trns[1];
          keyG = (trns[2] << 8) | trns[3];
          keyB = (trns[4] << 8) | trns[5];
        } else {
          keyR = trns[1];
          keyG = trns[3];
          keyB = trns[5];
        }
      }
    }
  }

  let rp = 0;
  let op = 0;
  for (let y = 0; y < height; y++) {
    const ft = raw[rp++];
    if (ft > 4) throw new Error('unknown PNG filter type: ' + ft);
    if (ft === 0) {
      for (let i = 0; i < stride; i++) cur[i] = raw[rp + i];
    } else if (ft === 1) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0;
        cur[i] = (raw[rp + i] + a) & 0xff;
      }
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) cur[i] = (raw[rp + i] + prev[i]) & 0xff;
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0;
        cur[i] = (raw[rp + i] + ((a + prev[i]) >> 1)) & 0xff;
      }
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0;
        cur[i] = (raw[rp + i] + paeth(a, prev[i], i >= bpp ? prev[i - bpp] : 0)) & 0xff;
      }
    }
    rp += stride;

    // Expand this row into the output buffer.
    if (colorType === 0) {
      if (bytesPerSample === 2) {
        for (let x = 0; x < width; x++) {
          const s = x * 2;
          const v = (cur[s] << 8) | cur[s + 1];
          out[op++] = cur[s];
          if (outChannels === 2) out[op++] = v === keyGrey ? 0 : 255;
        }
      } else {
        for (let x = 0; x < width; x++) {
          const v = cur[x];
          out[op++] = v;
          if (outChannels === 2) out[op++] = v === keyGrey ? 0 : 255;
        }
      }
    } else if (colorType === 2) {
      if (bytesPerSample === 2) {
        for (let x = 0; x < width; x++) {
          const s = x * 6;
          const r = (cur[s] << 8) | cur[s + 1];
          const g = (cur[s + 2] << 8) | cur[s + 3];
          const b = (cur[s + 4] << 8) | cur[s + 5];
          out[op++] = cur[s];
          out[op++] = cur[s + 2];
          out[op++] = cur[s + 4];
          if (outChannels === 4) out[op++] = r === keyR && g === keyG && b === keyB ? 0 : 255;
        }
      } else {
        for (let x = 0; x < width; x++) {
          const s = x * 3;
          const r = cur[s];
          const g = cur[s + 1];
          const b = cur[s + 2];
          out[op++] = r;
          out[op++] = g;
          out[op++] = b;
          if (outChannels === 4) out[op++] = r === keyR && g === keyG && b === keyB ? 0 : 255;
        }
      }
    } else if (colorType === 3) {
      const pal = palette as Uint8Array;
      for (let x = 0; x < width; x++) {
        let idx = cur[x];
        if (idx >= paletteLen) idx = 0;
        const s = idx * 3;
        out[op++] = pal[s];
        out[op++] = pal[s + 1];
        out[op++] = pal[s + 2];
        if (outChannels === 4) out[op++] = (palAlpha as Uint8Array)[idx];
      }
    } else if (colorType === 4) {
      if (bytesPerSample === 2) {
        for (let x = 0; x < width; x++) {
          const s = x * 4;
          out[op++] = cur[s];
          out[op++] = cur[s + 2];
        }
      } else {
        for (let x = 0; x < width; x++) {
          const s = x * 2;
          out[op++] = cur[s];
          out[op++] = cur[s + 1];
        }
      }
    } else {
      if (bytesPerSample === 2) {
        for (let x = 0; x < width; x++) {
          const s = x * 8;
          out[op++] = cur[s];
          out[op++] = cur[s + 2];
          out[op++] = cur[s + 4];
          out[op++] = cur[s + 6];
        }
      } else {
        for (let x = 0; x < width; x++) {
          const s = x * 4;
          out[op++] = cur[s];
          out[op++] = cur[s + 1];
          out[op++] = cur[s + 2];
          out[op++] = cur[s + 3];
        }
      }
    }

    prev.set(cur);
  }

  const info: PngInfo = {
    isProgressive: false,
    hasProfile: hasProfile,
    hasAlpha: outChannels === 2 || outChannels === 4,
  };
  if (colorType === 3) info.paletteBitDepth = 8;
  if (density !== undefined) info.density = density;
  if (resolutionUnit !== undefined) info.resolutionUnit = resolutionUnit;
  if (background !== undefined) info.background = background;
  if (comments !== null) info.comments = comments;

  return { image: { width, height, channels: outChannels, data: out }, info };
}

// Inflate a slice of `src` starting at `from`, returning the bytes (empty on error).
function inflateLatin1(src: Uint8Array, from: number): Uint8Array {
  try {
    return unzlibSync(src.subarray(from));
  } catch (e) {
    return new Uint8Array(0);
  }
}

// --------------------------------------------------------------- encoding ----

export function encodePng(image: Image): Uint8Array {
  const width = image.width | 0;
  const height = image.height | 0;
  const channels = image.channels;
  if (channels !== 1 && channels !== 2 && channels !== 3 && channels !== 4) {
    throw new Error('unsupported channel count: ' + channels);
  }
  if (width <= 0 || height <= 0) throw new Error('bad image dimensions');
  const data = image.data;
  const stride = width * channels;
  if (data.length !== stride * height) throw new Error('image data length mismatch');

  const colorType = channels === 1 ? 0 : channels === 2 ? 4 : channels === 3 ? 2 : 6;

  const ihdr = new Uint8Array(13);
  ihdr[0] = (width >>> 24) & 0xff;
  ihdr[1] = (width >>> 16) & 0xff;
  ihdr[2] = (width >>> 8) & 0xff;
  ihdr[3] = width & 0xff;
  ihdr[4] = (height >>> 24) & 0xff;
  ihdr[5] = (height >>> 16) & 0xff;
  ihdr[6] = (height >>> 8) & 0xff;
  ihdr[7] = height & 0xff;
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType; // colour type
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Every row is stored unfiltered (filter type 0).
  const rawAll = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1);
    rawAll[o] = 0;
    rawAll.set(data.subarray(y * stride, y * stride + stride), o + 1);
  }
  const deflated = zlibSync(rawAll, { level: 6 });

  const ihdrChunk = makeChunk('IHDR', ihdr);
  const idatChunk = makeChunk('IDAT', deflated);
  const iendChunk = makeChunk('IEND', new Uint8Array(0));

  const out = new Uint8Array(8 + ihdrChunk.length + idatChunk.length + iendChunk.length);
  for (let i = 0; i < 8; i++) out[i] = SIG[i];
  let o = 8;
  out.set(ihdrChunk, o);
  o += ihdrChunk.length;
  out.set(idatChunk, o);
  o += idatChunk.length;
  out.set(iendChunk, o);
  return out;
}
