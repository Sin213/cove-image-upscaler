import { constants as bufferConstants } from "node:buffer";
import * as fs from "node:fs";
import * as path from "node:path";
import sharp from "sharp";
import { PIXEL_SCALES, type PixelScale } from "./types";

// Practical output ceiling: 8192x8192 = 67,108,864 px = 256 MiB of raw RGBA.
// The codec decision spike measured this case at 399 MB RSS / 566 ms encode -
// the raw buffer is only part of the cost once decode, encode, temporary
// buffers and Electron overhead are counted, so the ceiling stays here.
export const MAX_OUTPUT_PIXELS = 67_108_864;

// PNG allows 2^31-1 per axis; this is the practical decoder/encoder limit we
// are willing to hand to libvips.
export const MAX_OUTPUT_DIMENSION = 65_535;

const BYTES_PER_PIXEL = 4;

// Rows expanded between cancellation polls / event-loop yields. Keeps the main
// process responsive without making the copy loop allocation-heavy.
const ROWS_PER_YIELD = 64;

// Progress phase boundaries. Row expansion is the only phase we can report
// honestly at sub-phase granularity; decode and encode are opaque sharp calls.
const PROGRESS_DECODED = 15;
const PROGRESS_EXPANDED = 85;
const PROGRESS_ENCODED = 95;

export interface PixelCancellation {
  isCancelled(): boolean;
}

export interface PixelProcessOptions {
  cancellation?: PixelCancellation;
  onProgress?: (percent: number) => void;
}

export interface RgbaImage {
  data: Buffer;
  width: number;
  height: number;
}

export interface PixelExpansion {
  outputWidth: number;
  outputHeight: number;
  outputBytes: number;
}

/** Input, scale or output-budget rejection. Never surfaced as a raw RangeError. */
export class PixelValidationError extends Error {
  readonly scale: unknown;
  readonly sourceWidth: unknown;
  readonly sourceHeight: unknown;
  readonly outputWidth: number | null;
  readonly outputHeight: number | null;
  readonly outputBytes: number | null;

  constructor(
    message: string,
    detail: {
      scale?: unknown;
      sourceWidth?: unknown;
      sourceHeight?: unknown;
      outputWidth?: number | null;
      outputHeight?: number | null;
      outputBytes?: number | null;
    } = {},
  ) {
    super(message);
    this.name = "PixelValidationError";
    this.scale = detail.scale;
    this.sourceWidth = detail.sourceWidth;
    this.sourceHeight = detail.sourceHeight;
    this.outputWidth = detail.outputWidth ?? null;
    this.outputHeight = detail.outputHeight ?? null;
    this.outputBytes = detail.outputBytes ?? null;
  }
}

export class PixelCancelledError extends Error {
  constructor(message = "Pixel job cancelled.") {
    super(message);
    this.name = "PixelCancelledError";
  }
}

function isPixelScale(scale: unknown): scale is PixelScale {
  return (PIXEL_SCALES as readonly number[]).includes(scale as number);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function approxSize(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return mib >= 1024 ? `${(mib / 1024).toFixed(1)} GiB` : `${Math.round(mib)} MiB`;
}

/**
 * Rejects unsafe expansions *before* anything is allocated. Deliberately does
 * not look at the source buffer, so an oversized request fails on the budget
 * rather than on a length mismatch.
 */
export function validatePixelExpansion(
  sourceWidth: number,
  sourceHeight: number,
  scale: PixelScale,
): PixelExpansion {
  if (!isPositiveSafeInteger(sourceWidth) || !isPositiveSafeInteger(sourceHeight)) {
    throw new PixelValidationError(
      `Invalid source dimensions ${String(sourceWidth)}x${String(sourceHeight)}: expected positive whole numbers.`,
      { sourceWidth, sourceHeight, scale },
    );
  }
  if (!isPixelScale(scale)) {
    throw new PixelValidationError(
      `Invalid pixel scale ${String(scale)}: expected one of ${PIXEL_SCALES.join(", ")}.`,
      { sourceWidth, sourceHeight, scale },
    );
  }

  const outputWidth = sourceWidth * scale;
  const outputHeight = sourceHeight * scale;
  if (!Number.isSafeInteger(outputWidth) || !Number.isSafeInteger(outputHeight)) {
    throw new PixelValidationError(
      `Output dimensions overflow at ${scale}x. Use a lower scale or a smaller source image.`,
      { sourceWidth, sourceHeight, scale },
    );
  }

  const outputPixels = outputWidth * outputHeight;
  const outputBytes = outputPixels * BYTES_PER_PIXEL;
  const tooBig =
    outputWidth > MAX_OUTPUT_DIMENSION ||
    outputHeight > MAX_OUTPUT_DIMENSION ||
    !Number.isSafeInteger(outputPixels) ||
    !Number.isSafeInteger(outputBytes) ||
    outputPixels > MAX_OUTPUT_PIXELS ||
    outputBytes > bufferConstants.MAX_LENGTH;

  if (tooBig) {
    throw new PixelValidationError(
      `Output is too large: ${sourceWidth}x${sourceHeight} at ${scale}x becomes ` +
        `${outputWidth}x${outputHeight} (about ${approxSize(outputBytes)} of raw pixels). ` +
        `Use a lower scale or a smaller source image.`,
      { sourceWidth, sourceHeight, scale, outputWidth, outputHeight, outputBytes },
    );
  }

  return { outputWidth, outputHeight, outputBytes };
}

export interface PixelExpandOptions {
  cancellation?: PixelCancellation;
  onProgress?: (rowsDone: number, totalRows: number) => void;
}

/**
 * Exact integer nearest-neighbor enlargement over straight RGBA bytes.
 *
 * Every output pixel is a verbatim 4-byte copy of one source pixel: no
 * interpolation, no channel arithmetic, no (un)premultiplication. Independent
 * of Electron, sharp, the filesystem and image metadata.
 */
export async function expandNearestNeighbor(
  source: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  scale: PixelScale,
  options: PixelExpandOptions = {},
): Promise<RgbaImage> {
  const { outputWidth, outputHeight, outputBytes } = validatePixelExpansion(
    sourceWidth,
    sourceHeight,
    scale,
  );

  const expectedSourceBytes = sourceWidth * sourceHeight * BYTES_PER_PIXEL;
  if (!source || source.length !== expectedSourceBytes) {
    throw new PixelValidationError(
      `Source buffer is ${source ? source.length : 0} bytes but ` +
        `${sourceWidth}x${sourceHeight} RGBA needs ${expectedSourceBytes}.`,
      { sourceWidth, sourceHeight, scale },
    );
  }

  const { cancellation, onProgress } = options;
  const throwIfCancelled = () => {
    if (cancellation?.isCancelled()) throw new PixelCancelledError();
  };

  const outputStride = outputWidth * BYTES_PER_PIXEL;
  const output = Buffer.allocUnsafe(outputBytes);
  const row = Buffer.allocUnsafe(outputStride);

  for (let sy = 0; sy < sourceHeight; sy++) {
    // Expand one source row horizontally...
    const rowBase = sy * sourceWidth * BYTES_PER_PIXEL;
    let o = 0;
    for (let sx = 0; sx < sourceWidth; sx++) {
      const i = rowBase + sx * BYTES_PER_PIXEL;
      const r = source[i];
      const g = source[i + 1];
      const b = source[i + 2];
      const a = source[i + 3];
      for (let k = 0; k < scale; k++) {
        row[o] = r;
        row[o + 1] = g;
        row[o + 2] = b;
        row[o + 3] = a;
        o += BYTES_PER_PIXEL;
      }
    }
    // ...then copy it down verbatim `scale` times.
    for (let k = 0; k < scale; k++) {
      row.copy(output, (sy * scale + k) * outputStride);
    }

    if ((sy + 1) % ROWS_PER_YIELD === 0 && sy + 1 < sourceHeight) {
      throwIfCancelled();
      onProgress?.(sy + 1, sourceHeight);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  throwIfCancelled();
  onProgress?.(sourceHeight, sourceHeight);
  return { data: output, width: outputWidth, height: outputHeight };
}

export interface PixelSourcePreflight extends PixelExpansion {
  width: number;
  height: number;
}

/**
 * Header-only check: reads image metadata (no raw decode, no pixel buffer) and
 * validates the output budget against the EXIF-normalized dimensions.
 *
 * This runs before `decodeStraightRgba()` so an oversized request is rejected
 * before the decoder allocates the source raster.
 */
export async function preflightPixelSource(
  inputPath: string,
  scale: PixelScale,
): Promise<PixelSourcePreflight> {
  // Header read only, so sharp's own input-pixel limit is not the right gate
  // here: our budget error is more actionable, and it has to be the one the
  // caller sees. The decode call below keeps sharp's default limit.
  const meta = await sharp(inputPath, { limitInputPixels: false }).metadata();
  if (!isPositiveSafeInteger(meta.width) || !isPositiveSafeInteger(meta.height)) {
    throw new PixelValidationError(
      `Could not read image dimensions from ${path.basename(inputPath)}.`,
      { sourceWidth: meta.width, sourceHeight: meta.height, scale },
    );
  }

  // EXIF orientations 5-8 rotate by 90 degrees, so the oriented raster that
  // `.rotate()` produces has its axes swapped.
  const swapsAxes = typeof meta.orientation === "number" && meta.orientation >= 5;
  const width = swapsAxes ? meta.height : meta.width;
  const height = swapsAxes ? meta.width : meta.height;

  return { width, height, ...validatePixelExpansion(width, height, scale) };
}

/**
 * Straight (non-premultiplied) 8-bit RGBA decode.
 *
 * `.rotate()` with no argument applies the EXIF orientation tag and nothing
 * else: the oriented raster is the authoritative Pixel input.
 */
export async function decodeStraightRgba(inputPath: string): Promise<RgbaImage> {
  const { data, info } = await sharp(inputPath)
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (!isPositiveSafeInteger(info.width) || !isPositiveSafeInteger(info.height)) {
    throw new PixelValidationError(
      `Decoder returned invalid dimensions ${String(info.width)}x${String(info.height)}.`,
      { sourceWidth: info.width, sourceHeight: info.height },
    );
  }
  if (info.channels !== 4) {
    throw new PixelValidationError(
      `Decoder returned ${info.channels} channels; Pixel mode needs 4 (RGBA).`,
      { sourceWidth: info.width, sourceHeight: info.height },
    );
  }
  const expected = info.width * info.height * BYTES_PER_PIXEL;
  if (data.length !== expected) {
    throw new PixelValidationError(
      `Decoded buffer is ${data.length} bytes but ${info.width}x${info.height} RGBA needs ${expected}.`,
      { sourceWidth: info.width, sourceHeight: info.height },
    );
  }

  return { data, width: info.width, height: info.height };
}

async function encodePng(image: RgbaImage): Promise<Buffer> {
  return sharp(image.data, {
    raw: { width: image.width, height: image.height, channels: 4 },
  })
    .png()
    .toBuffer();
}

/**
 * Full Pixel pipeline: decode -> orient -> nearest-neighbor -> PNG -> publish.
 *
 * The PNG is written to a sibling temp path and renamed, so a failed or
 * cancelled job never leaves a partial file at `outputPath`.
 */
export async function processPixelImage(
  inputPath: string,
  outputPath: string,
  scale: PixelScale,
  options: PixelProcessOptions = {},
): Promise<void> {
  const { cancellation, onProgress } = options;
  const throwIfCancelled = () => {
    if (cancellation?.isCancelled()) throw new PixelCancelledError();
  };

  if (!isPixelScale(scale)) {
    throw new PixelValidationError(
      `Invalid pixel scale ${String(scale)}: expected one of ${PIXEL_SCALES.join(", ")}.`,
      { scale },
    );
  }

  throwIfCancelled();
  // Budget first, from headers only: the decoder must not allocate a raster we
  // are going to reject anyway.
  await preflightPixelSource(inputPath, scale);
  throwIfCancelled();
  const decoded = await decodeStraightRgba(inputPath);
  throwIfCancelled();
  onProgress?.(PROGRESS_DECODED);

  const expanded = await expandNearestNeighbor(decoded.data, decoded.width, decoded.height, scale, {
    cancellation,
    onProgress: (rowsDone, totalRows) => {
      const span = PROGRESS_EXPANDED - PROGRESS_DECODED;
      onProgress?.(PROGRESS_DECODED + (rowsDone / totalRows) * span);
    },
  });

  throwIfCancelled();
  const png = await encodePng(expanded);
  throwIfCancelled();
  onProgress?.(PROGRESS_ENCODED);

  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  const tempPath = `${outputPath}.cove-partial`;
  try {
    await fs.promises.writeFile(tempPath, png);
    throwIfCancelled();
    await fs.promises.rename(tempPath, outputPath);
  } catch (err) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
  onProgress?.(100);
}
