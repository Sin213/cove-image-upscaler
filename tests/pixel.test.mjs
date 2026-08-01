// Pixel mode exactness contract.
//
// Fixtures are generated here with zlib + a hand-rolled CRC32 (tests/lib-png.mjs)
// so that "sharp decodes exactly" is never asserted against a sharp-made file.

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

import {
  ALPHAS,
  RGBS,
  WIDTH,
  HEIGHT,
  buildMatrix,
  writePng,
  parsePng,
  bufToPixels,
  pixelsToBuf,
  diff,
  nearestNeighbor,
  injectExifOrientation,
  forgeIhdrDimensions,
} from "./lib-png.mjs";

const require = createRequire(import.meta.url);
const pixel = require("../dist-electron/pixel.js");
const sharp = require("sharp");

const {
  MAX_OUTPUT_PIXELS,
  MAX_OUTPUT_DIMENSION,
  PixelValidationError,
  PixelCancelledError,
  validatePixelExpansion,
  preflightPixelSource,
  expandNearestNeighbor,
  decodeStraightRgba,
  processPixelImage,
} = pixel;

const MATRIX = buildMatrix();
const MATRIX_BUF = pixelsToBuf(MATRIX);

let tmpDir;
test.before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cove-pixel-test-"));
});
test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const tmp = (name) => path.join(tmpDir, name);

function writeMatrixPng(name) {
  const p = tmp(name);
  fs.writeFileSync(p, writePng(MATRIX, WIDTH, HEIGHT));
  return p;
}

// ------------------------------------------------------- fixture integrity

test("1. generated fixture self-parses to all 66 exact RGBA pixels", () => {
  const parsed = parsePng(writePng(MATRIX, WIDTH, HEIGHT));
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.ihdr.width, WIDTH);
  assert.equal(parsed.ihdr.height, HEIGHT);
  assert.equal(parsed.rgba.length, ALPHAS.length * RGBS.length);
  assert.equal(parsed.rgba.length, 66);
  assert.deepEqual(diff(parsed.rgba, MATRIX), []);
});

// --------------------------------------------------------- decode boundary

test("2. sharp decode equals the independently generated RGBA matrix", async () => {
  const decoded = await decodeStraightRgba(writeMatrixPng("decode.png"));
  assert.equal(decoded.width, WIDTH);
  assert.equal(decoded.height, HEIGHT);
  assert.equal(decoded.data.length, WIDTH * HEIGHT * 4);
  assert.deepEqual(diff(bufToPixels(decoded.data, WIDTH * HEIGHT), MATRIX), []);
});

test("3. hidden nonzero RGB under alpha zero survives decode", async () => {
  const decoded = await decodeStraightRgba(writeMatrixPng("hidden.png"));
  const px = bufToPixels(decoded.data, WIDTH * HEIGHT);
  const alphaZeroIdx = ALPHAS.indexOf(0);
  assert.notEqual(alphaZeroIdx, -1);
  for (let row = 0; row < RGBS.length; row++) {
    const p = px[row * WIDTH + alphaZeroIdx];
    assert.deepEqual(p, [...RGBS[row], 0]);
  }
});

test("4. all tested semi-transparent RGBA values survive decode", async () => {
  const decoded = await decodeStraightRgba(writeMatrixPng("semi.png"));
  const px = bufToPixels(decoded.data, WIDTH * HEIGHT);
  for (let row = 0; row < RGBS.length; row++) {
    for (let col = 0; col < ALPHAS.length; col++) {
      assert.deepEqual(px[row * WIDTH + col], [...RGBS[row], ALPHAS[col]]);
    }
  }
});

// --------------------------------------------------- nearest-neighbor core

async function expand(scale) {
  return expandNearestNeighbor(MATRIX_BUF, WIDTH, HEIGHT, scale);
}

for (const scale of [2, 3, 4]) {
  test(`${scale + 3}. ${scale}x nearest neighbor produces exact ${scale}x${scale} blocks`, async () => {
    const out = await expand(scale);
    assert.equal(out.width, WIDTH * scale);
    assert.equal(out.height, HEIGHT * scale);
    const px = bufToPixels(out.data, out.width * out.height);
    for (let y = 0; y < out.height; y++) {
      for (let x = 0; x < out.width; x++) {
        const src = MATRIX[Math.floor(y / scale) * WIDTH + Math.floor(x / scale)];
        assert.deepEqual(px[y * out.width + x], src, `mismatch at ${x},${y}`);
      }
    }
  });
}

test("8. 5x, 6x and 8x are accepted and dimensionally exact", async () => {
  for (const scale of [5, 6, 8]) {
    const out = await expand(scale);
    assert.equal(out.width, WIDTH * scale);
    assert.equal(out.height, HEIGHT * scale);
    assert.equal(out.data.length, WIDTH * scale * HEIGHT * scale * 4);
    const expected = pixelsToBuf(nearestNeighbor(MATRIX, WIDTH, HEIGHT, scale));
    assert.ok(out.data.equals(expected), `${scale}x differs from reference NN`);
  }
});

test("9. every output RGBA value exists in the source RGBA set", async () => {
  const out = await expand(4);
  const sourceSet = new Set(MATRIX.map((p) => p.join(",")));
  const px = bufToPixels(out.data, out.width * out.height);
  for (const p of px) {
    assert.ok(sourceSet.has(p.join(",")), `unknown output pixel ${p.join(",")}`);
  }
});

test("10. output dimensions are exact integer multiples", async () => {
  for (const scale of [2, 3, 4, 5, 6, 8]) {
    const out = await expand(scale);
    assert.equal(out.width % WIDTH, 0);
    assert.equal(out.height % HEIGHT, 0);
    assert.equal(out.width / WIDTH, scale);
    assert.equal(out.height / HEIGHT, scale);
  }
});

test("11. input buffer is not mutated", async () => {
  const input = Buffer.from(MATRIX_BUF);
  const before = Buffer.from(input);
  await expandNearestNeighbor(input, WIDTH, HEIGHT, 4);
  assert.ok(input.equals(before), "source buffer was mutated");
});

test("12. every replicated row in a source-row block is byte-identical", async () => {
  const scale = 6;
  const out = await expand(scale);
  const stride = out.width * 4;
  for (let sy = 0; sy < HEIGHT; sy++) {
    const first = out.data.subarray(sy * scale * stride, (sy * scale + 1) * stride);
    for (let k = 1; k < scale; k++) {
      const row = out.data.subarray((sy * scale + k) * stride, (sy * scale + k + 1) * stride);
      assert.ok(row.equals(first), `row ${sy * scale + k} differs from block head`);
    }
  }
});

// ------------------------------------------------------------ memory guard

test("13. invalid scales are rejected", async () => {
  for (const scale of [0, 1, -2, 2.5, 7, 9, NaN, Infinity, "4", null, undefined]) {
    await assert.rejects(
      () => expandNearestNeighbor(MATRIX_BUF, WIDTH, HEIGHT, scale),
      PixelValidationError,
      `scale ${String(scale)} should be rejected`,
    );
  }
});

test("14. invalid dimensions are rejected", async () => {
  const bad = [
    [0, HEIGHT],
    [WIDTH, 0],
    [-1, HEIGHT],
    [WIDTH, -1],
    [1.5, HEIGHT],
    [WIDTH, 1.5],
    [Number.NaN, HEIGHT],
    [Number.MAX_SAFE_INTEGER, HEIGHT],
  ];
  for (const [w, h] of bad) {
    await assert.rejects(
      () => expandNearestNeighbor(MATRIX_BUF, w, h, 2),
      PixelValidationError,
      `dims ${w}x${h} should be rejected`,
    );
  }
  // A buffer that does not match the declared dimensions is also invalid.
  await assert.rejects(
    () => expandNearestNeighbor(Buffer.alloc(8), WIDTH, HEIGHT, 2),
    PixelValidationError,
  );
});

test("15. oversized output is rejected before allocation", async () => {
  assert.equal(MAX_OUTPUT_PIXELS, 67_108_864);

  // Validation must not touch the source buffer, so an empty buffer with huge
  // declared dimensions still fails on the budget rather than allocating.
  await assert.rejects(
    () => expandNearestNeighbor(Buffer.alloc(0), 20000, 20000, 8),
    (err) => {
      assert.ok(err instanceof PixelValidationError);
      assert.match(err.message, /too large|lower scale/i);
      assert.equal(err.outputWidth, 160000);
      assert.equal(err.outputHeight, 160000);
      assert.equal(err.scale, 8);
      assert.ok(typeof err.outputBytes === "number");
      return true;
    },
  );

  // 67,108,864 px is 256 MiB of raw RGBA, i.e. an 8192x8192 output. That is
  // exactly the ceiling; one source pixel more is not.
  assert.throws(() => validatePixelExpansion(4097, 4096, 2), PixelValidationError);
  const ok = validatePixelExpansion(4096, 4096, 2);
  assert.equal(ok.outputWidth, 8192);
  assert.equal(ok.outputHeight, 8192);
  assert.equal(ok.outputBytes, MAX_OUTPUT_PIXELS * 4);
  assert.ok(MAX_OUTPUT_DIMENSION >= 8192);
});

// ----------------------------------------------------------- encode + e2e

test("16. PNG encode parsed RGBA equals the expanded RGBA exactly", async () => {
  const input = writeMatrixPng("encode.png");
  const output = tmp("encode-4x.png");
  await processPixelImage(input, output, 4);

  const parsed = parsePng(fs.readFileSync(output));
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.ihdr.colorType, 6);
  assert.equal(parsed.ihdr.bitDepth, 8);
  assert.equal(parsed.ihdr.width, WIDTH * 4);
  assert.equal(parsed.ihdr.height, HEIGHT * 4);
  assert.deepEqual(diff(parsed.rgba, nearestNeighbor(MATRIX, WIDTH, HEIGHT, 4)), []);
});

test("17. encode followed by sharp re-decode remains exact", async () => {
  const input = writeMatrixPng("redecode.png");
  const output = tmp("redecode-3x.png");
  await processPixelImage(input, output, 3);

  const decoded = await decodeStraightRgba(output);
  assert.equal(decoded.width, WIDTH * 3);
  assert.equal(decoded.height, HEIGHT * 3);
  const expected = nearestNeighbor(MATRIX, WIDTH, HEIGHT, 3);
  assert.deepEqual(diff(bufToPixels(decoded.data, decoded.width * decoded.height), expected), []);
});

test("18. hidden RGB at alpha zero survives decode -> NN -> PNG -> decode", async () => {
  const input = writeMatrixPng("hidden-e2e.png");
  const output = tmp("hidden-e2e-2x.png");
  await processPixelImage(input, output, 2);

  const parsed = parsePng(fs.readFileSync(output));
  const alphaZeroIdx = ALPHAS.indexOf(0);
  for (let row = 0; row < RGBS.length; row++) {
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const x = alphaZeroIdx * 2 + dx;
        const y = row * 2 + dy;
        assert.deepEqual(parsed.rgba[y * parsed.ihdr.width + x], [...RGBS[row], 0]);
      }
    }
  }
});

// ------------------------------------------------------- EXIF orientation

// Stored 4x2: left two columns black, right two columns white.
// Orientation 6 means "rotate 90 CW to display", so the displayed image is
// 2x4 with a black top half and a white bottom half.
async function writeOrientedJpeg(name, orientation) {
  const w = 4;
  const h = 2;
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = x < 2 ? 0 : 255;
      const o = (y * w + x) * 3;
      raw[o] = v;
      raw[o + 1] = v;
      raw[o + 2] = v;
    }
  }
  const jpeg = await sharp(raw, { raw: { width: w, height: h, channels: 3 } })
    .jpeg({ quality: 100, chromaSubsampling: "4:4:4" })
    .toBuffer();
  const p = tmp(name);
  fs.writeFileSync(p, injectExifOrientation(jpeg, orientation));
  return p;
}

test("19. EXIF-oriented JPEG is normalized using .rotate()", async () => {
  const input = await writeOrientedJpeg("orient6.jpg", 6);
  const decoded = await decodeStraightRgba(input);

  // Axes swapped by the orientation tag.
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 4);

  const px = bufToPixels(decoded.data, decoded.width * decoded.height);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 2; x++) {
      const p = px[y * 2 + x];
      assert.equal(p[3], 255, "ensureAlpha must produce opaque alpha for JPEG");
      if (y < 2) assert.ok(p[0] < 40, `expected dark at ${x},${y}, got ${p[0]}`);
      else assert.ok(p[0] > 215, `expected light at ${x},${y}, got ${p[0]}`);
    }
  }
});

test("20. an orientation that swaps axes returns the normalized width and height", async () => {
  const input = await writeOrientedJpeg("orient6-scaled.jpg", 6);
  const output = tmp("orient6-3x.png");
  await processPixelImage(input, output, 3);

  const parsed = parsePng(fs.readFileSync(output));
  assert.equal(parsed.error, undefined);
  // Normalized 2x4 source, not the stored 4x2.
  assert.equal(parsed.ihdr.width, 6);
  assert.equal(parsed.ihdr.height, 12);
});

// -------------------------------------------------- cancellation + failure

test("21. cancellation during row processing exits without publishing output", async () => {
  // Large enough that row expansion runs across several yield chunks.
  const w = 512;
  const h = 512;
  const px = [];
  for (let i = 0; i < w * h; i++) px.push([i & 0xff, (i >> 8) & 0xff, 7, 128]);
  const input = tmp("cancel-src.png");
  fs.writeFileSync(input, writePng(px, w, h));
  const output = tmp("cancel-out.png");

  let checks = 0;
  const cancellation = {
    isCancelled() {
      checks++;
      // Allow decode to complete, then cancel mid row-expansion.
      return checks > 2;
    },
  };

  await assert.rejects(
    () => processPixelImage(input, output, 8, { cancellation }),
    PixelCancelledError,
  );
  assert.ok(checks > 2, "cancellation was never polled");
  assert.equal(fs.existsSync(output), false, "cancelled job published output");
  assert.deepEqual(
    fs.readdirSync(tmpDir).filter((f) => f.startsWith("cancel-out")),
    [],
    "cancelled job left a temp artefact",
  );
});

test("24. the output budget is enforced from header metadata, before any raw decode", async () => {
  // Declares 40000x40000 but carries the 11x6 matrix's IDAT: only a
  // header-driven guard can reject this. A guard that decoded first would
  // fail with a decode error instead (and would try to allocate first).
  const forged = tmp("forged-huge.png");
  fs.writeFileSync(forged, forgeIhdrDimensions(writePng(MATRIX, WIDTH, HEIGHT), 40000, 40000));

  await assert.rejects(
    () => processPixelImage(forged, tmp("forged-out.png"), 8),
    (err) => {
      assert.ok(
        err instanceof PixelValidationError,
        `expected a pre-decode budget rejection, got ${err.name}: ${err.message}`,
      );
      assert.match(err.message, /too large|lower scale/i);
      assert.equal(err.outputWidth, 320000);
      assert.equal(err.outputHeight, 320000);
      return true;
    },
  );
  assert.equal(fs.existsSync(tmp("forged-out.png")), false);
});

test("25. header preflight reports EXIF-normalized dimensions", async () => {
  const input = await writeOrientedJpeg("orient6-preflight.jpg", 6);
  // Stored 4x2, orientation 6 swaps the axes.
  const dims = await preflightPixelSource(input, 3);
  assert.equal(dims.width, 2);
  assert.equal(dims.height, 4);
  assert.equal(dims.outputWidth, 6);
  assert.equal(dims.outputHeight, 12);
});

test("23. cancelling a pixel job never deletes a file it did not publish", async () => {
  const { Upscaler } = require("../dist-electron/upscaler.js");

  // Large enough that the job is still expanding rows when the cancel lands.
  const w = 900;
  const h = 900;
  const px = [];
  for (let i = 0; i < w * h; i++) px.push([i & 0xff, 90, 7, 255]);
  const dir = fs.mkdtempSync(path.join(tmpDir, "race-"));
  const input = path.join(dir, "race.png");
  fs.writeFileSync(input, writePng(px, w, h));

  // The path resolveOutputPath() picks at enqueue time.
  const resolved = path.join(dir, "race_8x_pixel.png");
  const sentinel = "pre-existing output that must survive";

  const up = new Upscaler();
  const events = [];
  const settled = new Promise((resolve) => {
    up.on("progress", (p) => {
      events.push(p);
      if (["done", "error", "cancelled"].includes(p.status)) resolve(p);
    });
  });

  up.enqueue([{ id: "race", mode: "pixel", scale: 8, inputPath: input, outputDir: dir }]);
  // Another writer creates the resolved path after resolution: the race the
  // cancellation cleanup must not turn into data loss.
  fs.writeFileSync(resolved, sentinel);
  setTimeout(() => up.cancelAll(), 40);

  const terminal = await settled;
  assert.equal(terminal.status, "cancelled");
  assert.equal(fs.existsSync(resolved), true, "cancellation deleted a file this job never published");
  assert.equal(fs.readFileSync(resolved, "utf8"), sentinel);
});

test("22. a processing failure does not leave a partial final PNG", async () => {
  const input = tmp("corrupt.png");
  fs.writeFileSync(input, Buffer.from("not an image at all"));
  const output = tmp("corrupt-out.png");

  await assert.rejects(() => processPixelImage(input, output, 2));
  assert.equal(fs.existsSync(output), false, "failed job published output");
  assert.deepEqual(
    fs.readdirSync(tmpDir).filter((f) => f.startsWith("corrupt-out")),
    [],
    "failed job left a temp artefact",
  );
});

// 26. cancelAll() cancellation scope.
//
// cancelAll() must only affect work that is active or queued when it is called.
// A cancellation latch left set while the queue is idle leaks into the next
// enqueued job and cancels it.

const TERMINAL_STATUSES = ["done", "error", "cancelled"];

function pixelSource(name, w, h) {
  const px = [];
  for (let i = 0; i < w * h; i++) px.push([i & 0xff, 90, 7, 255]);
  const dir = fs.mkdtempSync(path.join(tmpDir, `${name}-`));
  const input = path.join(dir, `${name}.png`);
  fs.writeFileSync(input, writePng(px, w, h));
  return { dir, input };
}

// The path resolveOutputPath() picks at enqueue time.
const resolvedOutput = (dir, name, scale) => path.join(dir, `${name}_${scale}x_pixel.png`);

function queueHarness() {
  const { Upscaler } = require("../dist-electron/upscaler.js");
  const up = new Upscaler();
  const events = [];
  const terminals = new Map();
  const waiters = new Map();
  up.on("progress", (p) => {
    events.push(p);
    if (!TERMINAL_STATUSES.includes(p.status)) return;
    if (!terminals.has(p.id)) terminals.set(p.id, p);
    const waiter = waiters.get(p.id);
    if (waiter) {
      waiters.delete(p.id);
      waiter(p);
    }
  });
  const settled = (id) =>
    terminals.has(id)
      ? Promise.resolve(terminals.get(id))
      : new Promise((resolve) => waiters.set(id, resolve));
  const terminalCount = (id) =>
    events.filter((p) => p.id === id && TERMINAL_STATUSES.includes(p.status)).length;
  // Settle order, not "running" order: pixel jobs emit throttled running
  // updates, so a running-status filter counts progress ticks, not starts.
  const settleOrder = () => [...terminals.keys()];
  return { up, events, settled, terminalCount, settleOrder };
}

test("26a. an idle cancelAll does not cancel the next enqueued pixel job", async () => {
  const { dir, input } = pixelSource("idle-latch", 8, 8);
  const { up, settled, events } = queueHarness();

  up.cancelAll();
  up.enqueue([{ id: "after-idle", mode: "pixel", scale: 2, inputPath: input, outputDir: dir }]);

  const terminal = await settled("after-idle");
  assert.equal(terminal.status, "done", "an idle cancelAll leaked into a later job");
  assert.equal(fs.existsSync(resolvedOutput(dir, "idle-latch", 2)), true);
  assert.equal(
    events.some((p) => p.id === "after-idle" && p.status === "cancelled"),
    false,
    "a job enqueued after cancelAll emitted a cancellation",
  );
});

test("26b. repeated idle cancelAll calls leave no persistent cancellation state", async () => {
  const { dir, input } = pixelSource("idle-repeat", 8, 8);
  const { up, settled, events } = queueHarness();

  up.cancelAll();
  up.cancelAll();
  up.cancelAll();
  up.enqueue([{ id: "after-repeat", mode: "pixel", scale: 2, inputPath: input, outputDir: dir }]);

  const terminal = await settled("after-repeat");
  assert.equal(terminal.status, "done");
  assert.equal(
    events.some((p) => p.id === "after-repeat" && p.status === "cancelled"),
    false,
  );
});

test("26c. cancelAll during an active pixel job still cancels it, and a later job succeeds", async () => {
  // Large enough that the job is still expanding rows when the cancel lands.
  const { dir, input } = pixelSource("active-cancel", 900, 900);
  const { up, settled, terminalCount } = queueHarness();

  up.enqueue([{ id: "active", mode: "pixel", scale: 8, inputPath: input, outputDir: dir }]);
  setTimeout(() => up.cancelAll(), 40);

  const cancelled = await settled("active");
  assert.equal(cancelled.status, "cancelled", "active pixel cancellation regressed");
  assert.equal(
    fs.existsSync(resolvedOutput(dir, "active-cancel", 8)),
    false,
    "cancelled pixel job left a final output",
  );
  assert.equal(terminalCount("active"), 1, "cancelled job settled more than once");

  const small = pixelSource("after-active", 8, 8);
  up.enqueue([
    { id: "after-active", mode: "pixel", scale: 2, inputPath: small.input, outputDir: small.dir },
  ]);
  const terminal = await settled("after-active");
  assert.equal(terminal.status, "done", "a job enqueued after an active cancel was cancelled");
});

test("26d. queued jobs present at cancelAll are cancelled and the queue empties", async () => {
  const big = pixelSource("batch-a", 900, 900);
  const b = pixelSource("batch-b", 8, 8);
  const c = pixelSource("batch-c", 8, 8);
  const { up, settled } = queueHarness();

  up.enqueue([
    { id: "A", mode: "pixel", scale: 8, inputPath: big.input, outputDir: big.dir },
    { id: "B", mode: "pixel", scale: 2, inputPath: b.input, outputDir: b.dir },
    { id: "C", mode: "pixel", scale: 2, inputPath: c.input, outputDir: c.dir },
  ]);
  setTimeout(() => up.cancelAll(), 40);

  const [ta, tb, tc] = await Promise.all([settled("A"), settled("B"), settled("C")]);
  assert.equal(ta.status, "cancelled");
  assert.equal(tb.status, "cancelled");
  assert.equal(tc.status, "cancelled");
  assert.equal(up.queue.length, 0, "queue did not drain to zero");
  assert.equal(up.active, null, "queue left an active job after cancellation");

  const d = pixelSource("batch-d", 8, 8);
  up.enqueue([{ id: "D", mode: "pixel", scale: 2, inputPath: d.input, outputDir: d.dir }]);
  const td = await settled("D");
  assert.equal(td.status, "done", "a job enqueued after a batch cancel was cancelled");
});

test("26e. cancelAll in the deferred-drain window does not cancel the next job", async () => {
  const first = pixelSource("window-first", 8, 8);
  const second = pixelSource("window-second", 8, 8);
  const { up, settled, terminalCount } = queueHarness();

  up.enqueue([
    { id: "first", mode: "pixel", scale: 2, inputPath: first.input, outputDir: first.dir },
  ]);
  const done = await settled("first");
  assert.equal(done.status, "done");

  // finishJob has cleared active and deferred drain through setImmediate; that
  // deferred drain has not run yet on this microtask turn.
  up.cancelAll();
  up.enqueue([
    { id: "second", mode: "pixel", scale: 2, inputPath: second.input, outputDir: second.dir },
  ]);

  const terminal = await settled("second");
  assert.equal(terminal.status, "done", "cancelAll in the deferred-drain window cancelled a later job");
  assert.equal(terminalCount("first"), 1, "duplicate terminal event for the settled job");
  assert.equal(terminalCount("second"), 1, "duplicate terminal event for the following job");
  assert.equal(up.active, null);
  assert.equal(up.queue.length, 0);
});

test("26f. FIFO ordering survives an idle cancelAll", async () => {
  const a = pixelSource("fifo-a", 8, 8);
  const b = pixelSource("fifo-b", 8, 8);
  const c = pixelSource("fifo-c", 8, 8);
  const { up, settled, events, settleOrder } = queueHarness();

  up.cancelAll();
  up.enqueue([
    { id: "f1", mode: "pixel", scale: 2, inputPath: a.input, outputDir: a.dir },
    { id: "f2", mode: "pixel", scale: 2, inputPath: b.input, outputDir: b.dir },
    { id: "f3", mode: "pixel", scale: 2, inputPath: c.input, outputDir: c.dir },
  ]);

  const terminals = await Promise.all([settled("f1"), settled("f2"), settled("f3")]);
  assert.deepEqual(terminals.map((t) => t.status), ["done", "done", "done"]);
  assert.deepEqual(settleOrder(), ["f1", "f2", "f3"], "FIFO ordering changed");
  assert.equal(
    events.some((p) => p.status === "cancelled"),
    false,
    "an idle cancelAll cancelled a later job",
  );
});
