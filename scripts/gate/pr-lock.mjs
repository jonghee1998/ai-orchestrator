// Issue #180 — per-PR writer exclusion. ONE lock domain per PR number that must span the WHOLE status lifecycle
// (pending invalidation -> collect -> final re-read -> publish) for EVERY writer path (PR workflow, issue/root events, dispatch, CLI).
// In CI the cross-process equivalent is the job-level concurrency group `quality-gate-pr-<N>` (see LOCK_GROUP + workflows); this in-process
// mutex gives the same semantics inside one process and is what the deterministic race tests exercise.
// Semantics: FIFO, at most one holder per key, different keys never block each other, a failing holder never wedges the queue.
export const LOCK_GROUP = (pr) => `quality-gate-pr-${pr}`;

export function createPrLock() {
  const tails = new Map();
  return {
    run(key, fn) {
      const prev = tails.get(key) ?? Promise.resolve();
      const p = prev.then(fn); // prev never rejects (tail swallows), so a failed holder cannot poison the queue
      const tail = p.then(() => {}, () => {});
      tails.set(key, tail);
      tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
      return p;
    },
    pending: () => tails.size,
  };
}
export const defaultPrLock = createPrLock();
