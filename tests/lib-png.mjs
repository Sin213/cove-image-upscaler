// Independent PNG writer + parser and the exactness test matrix.
// No image library is used here: zlib + a hand-rolled CRC32 only. Fixtures for
// the Pixel exactness tests must not come from the codec under test.

import zlib from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

// ------------------------------------------------------------ test matrix

export const ALPHAS = [0, 1, 2, 16, 64, 127, 128, 129, 192, 254, 255];

// RGB triples chosen so c*a/255 does not divide cleanly for most alphas, which
// makes accidental premultiplication visible.
export const RGBS = [
  [255, 0, 0],
  [0, 0, 255],
  [200, 100, 50],
  [173, 29, 241],
  [7, 251, 133],
  [255, 128, 0],
];

export const WIDTH = ALPHAS.length; // 11
export const HEIGHT = RGBS.length; // 6

export function buildMatrix() {
  const px = [];
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const [r, g, b] = RGBS[y];
      px.push([r, g, b, ALPHAS[x]]);
    }
  }
  return px;
}

// ---------------------------------------------------------------- writer

export function writePng(pixels, width, height) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc(height * (1 + width * 4));
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const p = pixels[y * width + x];
      raw[o++] = p[0];
      raw[o++] = p[1];
      raw[o++] = p[2];
      raw[o++] = p[3];
    }
  }
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- parser

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function parsePng(buf) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) return { error: "bad signature" };

  let off = 8;
  let ihdr = null;
  const idat = [];
  const extraChunks = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === "IDAT") idat.push(Buffer.from(data));
    else if (type === "IEND") break;
    else extraChunks.push(type);
    off += 12 + len;
  }

  if (!ihdr) return { error: "no IHDR" };
  if (ihdr.bitDepth !== 8) return { error: `unsupported bitDepth ${ihdr.bitDepth}`, ihdr, extraChunks };
  if (ihdr.interlace !== 0) return { error: `unsupported interlace ${ihdr.interlace}`, ihdr, extraChunks };
  if (ihdr.colorType !== 6 && ihdr.colorType !== 2) {
    return { error: `unsupported colorType ${ihdr.colorType}`, ihdr, extraChunks };
  }

  const bpp = ihdr.colorType === 6 ? 4 : 3;
  const stride = ihdr.width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length !== ihdr.height * (stride + 1)) {
    return { error: `inflate size ${raw.length}`, ihdr, extraChunks };
  }

  const out = Buffer.alloc(ihdr.height * stride);
  let p = 0;
  for (let y = 0; y < ihdr.height; y++) {
    const ft = raw[p++];
    const rs = y * stride;
    const ps = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const rb = raw[p++];
      const a = x >= bpp ? out[rs + x - bpp] : 0;
      const b = y > 0 ? out[ps + x] : 0;
      const c = x >= bpp && y > 0 ? out[ps + x - bpp] : 0;
      let v;
      switch (ft) {
        case 0: v = rb; break;
        case 1: v = rb + a; break;
        case 2: v = rb + b; break;
        case 3: v = rb + ((a + b) >> 1); break;
        case 4: v = rb + paeth(a, b, c); break;
        default: return { error: `filter ${ft}`, ihdr, extraChunks };
      }
      out[rs + x] = v & 0xff;
    }
  }

  const rgba = [];
  for (let i = 0; i < ihdr.width * ihdr.height; i++) {
    if (bpp === 4) rgba.push([out[i * 4], out[i * 4 + 1], out[i * 4 + 2], out[i * 4 + 3]]);
    else rgba.push([out[i * 3], out[i * 3 + 1], out[i * 3 + 2], 255]);
  }
  return { ihdr, rgba, extraChunks };
}

// ----------------------------------------------------------- comparisons

export function bufToPixels(buf, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push([buf[i * 4], buf[i * 4 + 1], buf[i * 4 + 2], buf[i * 4 + 3]]);
  }
  return out;
}

export function pixelsToBuf(pixels) {
  const b = Buffer.alloc(pixels.length * 4);
  pixels.forEach((p, i) => {
    b[i * 4] = p[0];
    b[i * 4 + 1] = p[1];
    b[i * 4 + 2] = p[2];
    b[i * 4 + 3] = p[3];
  });
  return b;
}

export function diff(actual, expected) {
  const d = [];
  const n = Math.max(actual.length, expected.length);
  for (let i = 0; i < n; i++) {
    const a = actual[i];
    const e = expected[i];
    if (!a || !e) {
      d.push({ i, expected: e ?? null, actual: a ?? null });
      continue;
    }
    if (a[0] !== e[0] || a[1] !== e[1] || a[2] !== e[2] || a[3] !== e[3]) {
      d.push({ i, expected: e, actual: a });
    }
  }
  return d;
}

// Reference nearest-neighbor enlargement, written independently of the
// production implementation so the two can be compared.
export function nearestNeighbor(pixels, w, h, scale) {
  const out = [];
  for (let y = 0; y < h * scale; y++) {
    for (let x = 0; x < w * scale; x++) {
      out.push(pixels[Math.floor(y / scale) * w + Math.floor(x / scale)]);
    }
  }
  return out;
}

// Rewrites IHDR width/height (and its CRC) without touching IDAT, producing a
// PNG that *declares* huge dimensions but carries almost no data. Used to prove
// the output budget is checked from header metadata, before any raw decode.
export function forgeIhdrDimensions(png, width, height) {
  const out = Buffer.from(png);
  // 8-byte signature, then IHDR: 4 len + 4 type + 13 data + 4 crc.
  const dataStart = 16;
  out.writeUInt32BE(width, dataStart);
  out.writeUInt32BE(height, dataStart + 4);
  const typeAndData = out.subarray(12, dataStart + 13);
  out.writeUInt32BE(crc32(typeAndData), dataStart + 13);
  return out;
}

// ------------------------------------------------------------ JPEG helper

// Inserts an APP1/Exif segment carrying only an Orientation tag. Hand-built so
// the orientation under test does not come from the library under test.
export function injectExifOrientation(jpeg, orientation) {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("not a JPEG (missing SOI)");

  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write("MM", 0, "ascii"); // big-endian
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4); // offset of IFD0
  tiff.writeUInt16BE(1, 8); // one entry
  tiff.writeUInt16BE(0x0112, 10); // Orientation
  tiff.writeUInt16BE(3, 12); // SHORT
  tiff.writeUInt32BE(1, 14); // count
  tiff.writeUInt16BE(orientation, 18); // value, left-justified
  tiff.writeUInt16BE(0, 20);
  tiff.writeUInt32BE(0, 22); // no next IFD

  const payload = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0xffe1, 0);
  header.writeUInt16BE(payload.length + 2, 2);

  return Buffer.concat([jpeg.subarray(0, 2), header, payload, jpeg.subarray(2)]);
}
