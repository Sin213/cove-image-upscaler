// Single source of truth for "which queue entries does Upscale N act on?".
//
// The button label and the click handler both read this helper, so the count
// shown can never diverge from the set actually enqueued. Completed entries
// are excluded; error and cancelled entries stay retryable.

export interface EligibleQueueEntry {
  status: string;
}

export function selectEligibleEntries<T extends EligibleQueueEntry>(
  queue: readonly T[],
): T[] {
  return queue.filter((entry) => entry.status !== "done");
}
