// Runtime validation contract for the `cove:enqueue` payload.
//
// The handler reaches child-process spawning, output-path construction and
// file writes, so a malformed batch must be rejected whole, before any of it.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { validateEnqueueBatch } = require("../dist-electron/validate-job.js");

function job(over = {}) {
  return { id: "job-1", inputPath: "/in/a.png", outputDir: "/out", mode: "photo", scale: 2, ...over };
}

test("a valid photo batch is accepted", () => {
  const result = validateEnqueueBatch([job({ mode: "photo", scale: 4 })]);
  assert.equal(result.ok, true);
  assert.equal(result.jobs.length, 1);
});

test("a valid anime batch is accepted", () => {
  const result = validateEnqueueBatch([job({ mode: "anime", scale: 3 })]);
  assert.equal(result.ok, true);
});

test("a valid pixel batch is accepted", () => {
  const result = validateEnqueueBatch([job({ mode: "pixel", scale: 6 })]);
  assert.equal(result.ok, true);
});

test("a non-array payload is rejected without per-entry issues", () => {
  for (const payload of [null, undefined, "jobs", 5, { id: "job-1" }]) {
    const result = validateEnqueueBatch(payload);
    assert.equal(result.ok, false);
    assert.deepEqual(result.issues, []);
    assert.equal(typeof result.batchError, "string");
    assert.ok(result.batchError.length > 0);
  }
});

test("a missing or empty inputPath is rejected", () => {
  for (const inputPath of [undefined, "", "   ", 5, null]) {
    const result = validateEnqueueBatch([job({ inputPath })]);
    assert.equal(result.ok, false);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].id, "job-1");
    assert.match(result.issues[0].message, /inputPath/);
  }
});

test("an unsupported mode is rejected", () => {
  const result = validateEnqueueBatch([job({ mode: "sharpen" })]);
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].id, "job-1");
  assert.match(result.issues[0].message, /mode/);
});

test("scale 8 is rejected for photo", () => {
  const result = validateEnqueueBatch([job({ mode: "photo", scale: 8 })]);
  assert.equal(result.ok, false);
  assert.match(result.issues[0].message, /scale/);
});

test("scale 8 is accepted for pixel", () => {
  const result = validateEnqueueBatch([job({ mode: "pixel", scale: 8 })]);
  assert.equal(result.ok, true);
});

test("duplicate job IDs are rejected", () => {
  const result = validateEnqueueBatch([job({ id: "dup" }), job({ id: "dup" })]);
  assert.equal(result.ok, false);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].id, "dup");
  assert.match(result.issues[0].message, /[Dd]uplicate/);
});

test("an empty ID is rejected and yields no addressable issue", () => {
  const result = validateEnqueueBatch([job({ id: "" })]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.issues, []);
  assert.equal(typeof result.batchError, "string");
});

// The upscaler interpolates the job ID into a temp path under os.tmpdir()
// (electron/upscaler.ts runAiJob), so an ID is an opaque token, never a path
// fragment. IDs the renderer generates are already `job-<imageId>-<ts>`.
test("job IDs containing path separators or traversal are rejected", () => {
  for (const id of ["../../etc/passwd", "a/b", "a\\b", "..", ".", "a.b", "a b", "a\u0000b", "a\tb"]) {
    const result = validateEnqueueBatch([job({ id })]);
    assert.equal(result.ok, false, `expected rejection for id ${JSON.stringify(id)}`);
    assert.deepEqual(result.issues, []);
  }
});

test("a renderer-shaped job ID is accepted", () => {
  const result = validateEnqueueBatch([job({ id: "job-1754160000000-a1b2c3-1754160000001" })]);
  assert.equal(result.ok, true);
});

test("an excessively long job ID is rejected", () => {
  const result = validateEnqueueBatch([job({ id: "a".repeat(200) })]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.issues, []);
});

test("an empty-string outputDir is rejected", () => {
  const result = validateEnqueueBatch([job({ outputDir: "" })]);
  assert.equal(result.ok, false);
  assert.match(result.issues[0].message, /outputDir/);
});

test("a null outputDir is accepted", () => {
  const result = validateEnqueueBatch([job({ outputDir: null })]);
  assert.equal(result.ok, true);
});

test("paths containing spaces are accepted", () => {
  const result = validateEnqueueBatch([
    job({ inputPath: "C:\\My Pictures\\a b.png", outputDir: "/home/me/My Output" }),
  ]);
  assert.equal(result.ok, true);
});

test("paths containing non-ASCII characters are accepted", () => {
  const result = validateEnqueueBatch([
    job({ inputPath: "/home/me/写真/ünïcode 🐟.png", outputDir: "/home/me/выход" }),
  ]);
  assert.equal(result.ok, true);
});

test("validation does not mutate the payload", () => {
  const payload = [job(), job({ id: "job-2", mode: "pixel", scale: 5 })];
  const snapshot = JSON.parse(JSON.stringify(payload));
  validateEnqueueBatch(payload);
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), snapshot);
});

test("an invalid entry rejects the whole batch, valid siblings included", () => {
  const result = validateEnqueueBatch([job({ id: "ok-1" }), job({ id: "bad-1", mode: "sharpen" })]);
  assert.equal(result.ok, false);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].id, "bad-1");
});
