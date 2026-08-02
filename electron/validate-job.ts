// Runtime validation for the `cove:enqueue` payload.
//
// The enqueue handler reaches child-process spawning, output-path
// construction, directory creation and file writes, so the compile-time
// `UpscaleJob` type is not enough: the payload crosses the renderer/main
// trust boundary. A batch is accepted whole or rejected whole - never
// partially enqueued.
//
// Paths are deliberately not normalized, character-filtered, or constrained
// to a directory: `outputDir` is user selected, and valid paths legitimately
// contain spaces, Unicode, and either separator style.

import { AI_SCALES, PIXEL_SCALES } from "./types";
import type { UpscaleJob } from "./types";

/** A validation failure attributable to a specific, addressable job ID. */
export interface JobValidationIssue {
  id: string;
  message: string;
}

export type EnqueueValidationResult =
  | { ok: true; jobs: UpscaleJob[] }
  | { ok: false; batchError: string; issues: JobValidationIssue[] };

const MODES = ["photo", "anime", "pixel"] as const;

// A job ID is an opaque token, not a path fragment, but the upscaler
// interpolates it into a temp filename under os.tmpdir(). Constraining it to
// this charset keeps `../` and separators out of that path. The renderer's own
// IDs (`job-<imageId>-<timestamp>`) already fit.
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function isValidJobId(value: unknown): value is string {
  return typeof value === "string" && JOB_ID_PATTERN.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function readOwn(source: object, key: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(source, key)) return undefined;
  return Reflect.get(source, key);
}

// Returns the entry's failure message, or null when the entry is valid.
// `id` is validated by the caller, which owns duplicate detection.
function entryError(entry: object): string | null {
  if (!isNonEmptyString(readOwn(entry, "inputPath"))) {
    return "Invalid job: inputPath must be a non-empty string.";
  }

  const outputDir = readOwn(entry, "outputDir");
  if (outputDir !== null && !isNonEmptyString(outputDir)) {
    return "Invalid job: outputDir must be a non-empty string or null.";
  }

  const mode = readOwn(entry, "mode");
  if (!MODES.some((candidate) => candidate === mode)) {
    return `Invalid job: mode must be one of ${MODES.join(", ")}.`;
  }

  const scale = readOwn(entry, "scale");
  const allowed: readonly number[] = mode === "pixel" ? PIXEL_SCALES : AI_SCALES;
  if (typeof scale !== "number" || !allowed.some((candidate) => candidate === scale)) {
    return `Invalid job: scale for ${String(mode)} must be one of ${allowed.join(", ")}.`;
  }

  return null;
}

export function validateEnqueueBatch(payload: unknown): EnqueueValidationResult {
  if (!Array.isArray(payload)) {
    return { ok: false, batchError: "Invalid enqueue payload: expected an array of jobs.", issues: [] };
  }

  const issues: JobValidationIssue[] = [];
  let unaddressable = 0;
  const seen = new Set<string>();

  for (const entry of payload) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      unaddressable += 1;
      continue;
    }
    const id = readOwn(entry, "id");
    if (!isValidJobId(id)) {
      unaddressable += 1;
      continue;
    }
    if (seen.has(id)) {
      issues.push({ id, message: "Invalid job: duplicate job id in the same batch." });
      continue;
    }
    seen.add(id);
    const message = entryError(entry);
    if (message !== null) issues.push({ id, message });
  }

  if (issues.length === 0 && unaddressable === 0) {
    return { ok: true, jobs: payload as UpscaleJob[] };
  }

  const rejected = issues.length + unaddressable;
  return {
    ok: false,
    batchError: `Invalid enqueue payload: ${rejected} of ${payload.length} job(s) failed validation.`,
    issues,
  };
}
