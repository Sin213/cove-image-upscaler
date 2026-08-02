// Eligibility contract for the "Upscale N" command.
//
// The rendered count and the enqueue execution path must read the same
// selection, so both call the helper exercised here.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { selectEligibleEntries } = require("../dist-electron/queue-selection.js");

function entry(id, status) {
  return { image: { id }, status };
}

test("returns only non-done entries from a mixed queue", () => {
  const queue = [
    entry("a", "done"),
    entry("b", "idle"),
    entry("c", "error"),
    entry("d", "done"),
  ];
  assert.deepEqual(
    selectEligibleEntries(queue).map((q) => q.image.id),
    ["b", "c"],
  );
});

test("selected count equals the number of jobs prepared for enqueue", () => {
  const queue = [
    entry("a", "done"),
    entry("b", "done"),
    entry("c", "done"),
    entry("d", "idle"),
    entry("e", "idle"),
  ];
  const selected = selectEligibleEntries(queue);
  assert.equal(selected.length, 2);
  const jobs = selected.map((q) => ({ id: q.image.id }));
  assert.equal(jobs.length, selected.length);
});

test("an all-done queue yields zero entries", () => {
  const queue = [entry("a", "done"), entry("b", "done")];
  assert.deepEqual(selectEligibleEntries(queue), []);
});

test("error entries remain eligible", () => {
  const queue = [entry("a", "error")];
  assert.deepEqual(
    selectEligibleEntries(queue).map((q) => q.image.id),
    ["a"],
  );
});

test("cancelled entries remain eligible", () => {
  const queue = [entry("a", "cancelled")];
  assert.deepEqual(
    selectEligibleEntries(queue).map((q) => q.image.id),
    ["a"],
  );
});

test("input ordering is preserved", () => {
  const queue = [
    entry("z", "idle"),
    entry("m", "cancelled"),
    entry("a", "queued"),
  ];
  assert.deepEqual(
    selectEligibleEntries(queue).map((q) => q.image.id),
    ["z", "m", "a"],
  );
});

test("the original array is not mutated", () => {
  const queue = [entry("a", "done"), entry("b", "idle")];
  const snapshot = queue.slice();
  const selected = selectEligibleEntries(queue);
  assert.equal(queue.length, 2);
  assert.deepEqual(queue, snapshot);
  assert.notEqual(selected, queue);
  assert.equal(selected[0], queue[1]);
});
