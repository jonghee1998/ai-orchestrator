// Issue #161 (T6) — durable ROOT-level correction counter. Pure, read-only.
// A "correction" is one completed review-failure correction execution against a root request. It is NOT new feature
// work and NOT a blocked pre-code launch. Counts are root-scoped (not per PR chain), so two separate chains for the
// same root (e.g. #150->PR153 and #157->PR160) accumulate. Nothing here is authenticated authority: only trusted-PM
// authored structured markers count, contradictions fail closed, and a count can never be lowered by a new
// Issue / PR / chain.
import { isTrustedPm, pmReviseMarkers } from "./core.mjs";

export const MAX_CORRECTIONS = 3; // default for every root
export const CORRECTION_CEILING = 5; // hard ceiling no override can exceed
const LIMIT_ANY = /<!--\s*orch-root-correction-limit:v1\b[^>]*-->/g;
const LIMIT_RE = /^<!--\s*orch-root-correction-limit:v1\s+root(\d+)\s+max=(\d+)\s*-->$/;

/**
 * Issue #166: explicit, trusted, ROOT-SPECIFIC correction-limit override: `<!-- orch-root-correction-limit:v1 root<R> max=<k> -->`
 * from the trusted PM. Default 3 for everyone else; bounded by CORRECTION_CEILING. Untrusted authors are ignored (=> default);
 * malformed / other-root / out-of-range / conflicting markers fail closed. It is policy evidence only, never merge authority.
 * @returns {{max:number} | {error:string, detail?:object}}
 */
export function resolveCorrectionLimit(items = [], root) {
  const found = new Set();
  for (const it of items) {
    if (!isTrustedPm(it?.user)) continue;
    for (const raw of (it.body ?? "").match(LIMIT_ANY) ?? []) {
      const m = LIMIT_RE.exec(raw);
      if (!m) return { error: "correction_limit_marker_malformed", detail: { marker: raw.slice(0, 120) } };
      if (Number(m[1]) !== root) return { error: "correction_limit_other_root", detail: { expected: root, found: Number(m[1]) } };
      const max = Number(m[2]);
      if (max < MAX_CORRECTIONS || max > CORRECTION_CEILING) return { error: "correction_limit_out_of_range", detail: { max } };
      found.add(max);
    }
  }
  if (found.size > 1) return { error: "correction_limit_conflict", detail: { values: [...found].sort() } };
  return { max: found.size === 1 ? [...found][0] : MAX_CORRECTIONS };
}
const SHA = /^[a-f0-9]{40}$/;
/** `<!-- orch-root-correction:v1 root<R> n=<k> pr<P> sha=<40hex> -->` : correction #k of root R was executed as PR P at SHA. */
const CORR_ANY = /<!--\s*orch-root-correction:v1\b[^>]*-->/g;
const CORR_RE = /^<!--\s*orch-root-correction:v1\s+root(\d+)\s+n=(\d+)\s+pr(\d+)\s+sha=([a-f0-9]{40})\s*-->$/;
export const correctionMarker = ({ root, n, pr, sha }) => `<!-- orch-root-correction:v1 root${root} n=${n} pr${pr} sha=${sha} -->`;

/**
 * Resolve the durable correction count for `root` from root-scoped evidence items (issue bodies/comments).
 * @returns {{count:number, records:object[]} | {error:string, detail?:object}}
 *  - markers from untrusted authors are ignored;
 *  - a malformed marker, a marker for another root, n outside 1..MAX, duplicate n with different PR/SHA, the same PR
 *    under two different n, or gaps in 1..max => error (fail closed, never silently lowered);
 *  - legacy trusted PM `revise:<round>` markers (core.pmReviseMarkers) are a conservative LOWER BOUND only.
 */
export function resolveRootCorrections(items = [], root, limit = MAX_CORRECTIONS) {
  const recs = [];
  for (const it of items) {
    if (!isTrustedPm(it?.user)) continue;
    for (const raw of (it.body ?? "").match(CORR_ANY) ?? []) {
      const m = CORR_RE.exec(raw);
      if (!m) return { error: "root_correction_marker_malformed", detail: { marker: raw.slice(0, 120) } };
      const r = { root: Number(m[1]), n: Number(m[2]), pr: Number(m[3]), sha: m[4] };
      if (r.root !== root) return { error: "root_correction_marker_other_root", detail: { expected: root, found: r.root } };
      if (r.n < 1 || r.n > limit) return { error: "root_correction_n_out_of_range", detail: { n: r.n } };
      recs.push(r);
    }
  }
  const byN = new Map();
  const byPr = new Map();
  for (const r of recs) {
    const a = byN.get(r.n);
    if (a && (a.pr !== r.pr || a.sha !== r.sha)) return { error: "root_correction_conflict", detail: { n: r.n } };
    const b = byPr.get(r.pr);
    if (b && b.n !== r.n) return { error: "root_correction_conflict", detail: { pr: r.pr } };
    byN.set(r.n, r); byPr.set(r.pr, r);
  }
  const max = Math.max(0, ...byN.keys());
  for (let k = 1; k <= max; k++) if (!byN.has(k)) return { error: "root_correction_gap", detail: { missing: k, max } };
  const legacy = Math.max(0, ...items.flatMap((it) => pmReviseMarkers(it)).filter((m) => m.sha && SHA.test(m.sha) && m.round >= 1 && m.round <= limit).map((m) => m.round));
  return { count: Math.max(max, legacy), records: [...byN.values()].sort((a, b) => a.n - b.n) };
}

/**
 * Round (= correction ordinal) for the PR under evaluation. Never below the chain-derived depth or the durable bot
 * count (`floor`), never below the root counter. If the PR already has its own marker the ordinal is at least that marker's n AND at least the root count; an unmarked
 * replacement (chain depth > 0) is the NEXT correction; an unmarked original PR (new feature work) adds nothing.
 */
export function correctionRound({ resolved, prNumber, chainDepth, floor, limit = MAX_CORRECTIONS }) {
  if (resolved.error) return { error: resolved.error, detail: resolved.detail };
  const own = resolved.records.find((r) => r.pr === prNumber);
  const prior = resolved.records.filter((r) => r.pr !== prNumber).reduce((m, r) => Math.max(m, r.n), resolved.count);
  // Root-wide count is a LOWER BOUND on every path, including a PR's own (historical) marker: an old chain can never
  // re-enter at a lower round after the cap was consumed elsewhere.
  const ordinal = own ? Math.max(own.n, resolved.count) : chainDepth > 0 ? prior + 1 : prior;
  return { round: Math.min(Math.max(floor, ordinal, 1), limit + 1), count: resolved.count };
}
