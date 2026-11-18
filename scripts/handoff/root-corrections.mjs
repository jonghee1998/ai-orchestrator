// Issue #161 (T6) — durable ROOT-level correction counter. Pure, read-only.
// A "correction" is one completed review-failure correction execution against a root request. It is NOT new feature
// work and NOT a blocked pre-code launch. Counts are root-scoped (not per PR chain), so two separate chains for the
// same root (e.g. #150->PR153 and #157->PR160) accumulate. Nothing here is authenticated authority: only trusted-PM
// authored structured markers count, contradictions fail closed, and a count can never be lowered by a new
// Issue / PR / chain.
import { isTrustedPm, pmReviseMarkers } from "./core.mjs";

import { MAX_CORRECTIONS, CORRECTION_CEILING, ROOT_CEILING_EXCEPTIONS, ceilingFor } from "./correction-policy.mjs";
export { MAX_CORRECTIONS, CORRECTION_CEILING, ROOT_CEILING_EXCEPTIONS, ceilingFor };
const LIMIT_ANY = /<!--\s*orch-root-correction-limit:v1\b[^>]*-->/g;
const LIMIT_RE = /^<!--\s*orch-root-correction-limit:v1\s+root(\d+)\s+max=(\d+)\s*-->$/;

/**
 * Issue #166/#172: explicit, trusted, ROOT-SPECIFIC correction-limit POLICY HISTORY: `<!-- orch-root-correction-limit:v1 root<R> max=<k> -->`
 * from the trusted PM. Default 3 for everyone else; each value bounded by ceilingFor(root). Untrusted authors are ignored (=> default).
 * Authorizations form an ordered, authenticated history: when several exist they must be orderable (every marker-bearing
 * item has a `created_at`) and NON-DECREASING (max5 then later max7 coexist; the effective limit is the latest value and the
 * earlier approvals stay in `history`). A decrease, an unorderable disagreement, malformed / other-root / out-of-range
 * markers fail closed. Policy evidence only, never merge authority. Consumption (resolveRootCorrections) never depends on it.
 * @returns {{max:number, history:object[]} | {error:string, detail?:object}}
 */
export function resolveCorrectionLimit(items = [], root) {
  const hist = [];
  items.forEach((it, idx) => {
    if (!isTrustedPm(it?.user)) return;
    for (const raw of (it.body ?? "").match(LIMIT_ANY) ?? []) hist.push({ raw, at: it.created_at ?? null, id: it.id ?? null, idx });
  });
  const values = [];
  for (const h of hist) {
    const m = LIMIT_RE.exec(h.raw);
    if (!m) return { error: "correction_limit_marker_malformed", detail: { marker: h.raw.slice(0, 120) } };
    if (Number(m[1]) !== root) return { error: "correction_limit_other_root", detail: { expected: root, found: Number(m[1]) } };
    const max = Number(m[2]);
    if (max < MAX_CORRECTIONS || max > ceilingFor(root)) return { error: "correction_limit_out_of_range", detail: { max } };
    values.push({ max, at: h.at, id: h.id, idx: h.idx });
  }
  const distinct = [...new Set(values.map((v) => v.max))].sort((a, b) => a - b);
  if (distinct.length > 1) {
    if (values.some((v) => !Number.isFinite(Date.parse(v.at ?? "")))) return { error: "correction_limit_conflict", detail: { values: distinct, why: "unorderable" } };
    const ordered = [...values].sort((x, y) => Date.parse(x.at) - Date.parse(y.at) || String(x.id).localeCompare(String(y.id), undefined, { numeric: true }));
    for (let i = 1; i < ordered.length; i++) {
      if (ordered[i].max < ordered[i - 1].max) return { error: "correction_limit_non_monotonic", detail: { from: ordered[i - 1].max, to: ordered[i].max } };
      if (ordered[i].max !== ordered[i - 1].max && ordered[i].at === ordered[i - 1].at) return { error: "correction_limit_conflict", detail: { values: distinct, why: "same_timestamp" } };
    }
    return { max: ordered.at(-1).max, history: ordered.map((v) => ({ max: v.max, at: v.at, id: v.id })) };
  }
  return { max: distinct.length === 1 ? distinct[0] : MAX_CORRECTIONS, history: values.map((v) => ({ max: v.max, at: v.at, id: v.id })) };
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
export function resolveRootCorrections(items = [], root, _limit = MAX_CORRECTIONS, { request = null, derived = [], destination = null } = {}) {
  const recs = [];
  for (const it of items) {
    if (!isTrustedPm(it?.user)) continue;
    for (const raw of (it.body ?? "").match(CORR_ANY) ?? []) {
      const m = CORR_RE.exec(raw);
      if (!m) return { error: "root_correction_marker_malformed", detail: { marker: raw.slice(0, 120) } };
      const r = { root: Number(m[1]), n: Number(m[2]), pr: Number(m[3]), sha: m[4] };
      if (r.root !== root) return { error: "root_correction_marker_other_root", detail: { expected: root, found: r.root } };
      // Bounded by the hard CEILING, NOT the current (possibly lowered) limit: past usage is never discarded.
      if (r.n < 1 || r.n > ceilingFor(root)) return { error: "root_correction_n_out_of_range", detail: { n: r.n } };
      recs.push(r);
    }
  }
  // Issue #172: records DERIVED (not marker-recorded) by root-evidence.deriveChainCorrection after proof; same conflict/gap/range checks apply.
  for (const r of derived) { if (r.n < 1 || r.n > ceilingFor(root)) return { error: "root_correction_n_out_of_range", detail: { n: r.n } }; recs.push({ root, n: r.n, pr: r.pr, sha: r.sha }); }
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
  // Legacy trusted-PM revise rounds are a lower bound regardless of the current limit (default 3 must still see revise:4).
  // A round beyond the hard ceiling is not a valid history => fail closed rather than silently dropping it.
  // Issue #172: `request` = {pr, sha} of the superseded PR whose review FAIL spawned the PR under evaluation. A revise:N marker bound to
  // exactly that PR+SHA is the REQUEST for the current correction (N must be its own ordinal), not already-consumed history.
  const marks = items.flatMap((it) => pmReviseMarkers(it)).filter((m) => m.sha && SHA.test(m.sha) && m.round >= 1);
  const isReq = (m) => request && m.pr === request.pr && m.sha === request.sha;
  const requested = marks.filter(isReq).map((m) => m.round);
  const legacyRounds = marks.filter((m) => !isReq(m)).map((m) => m.round);
  if (legacyRounds.some((r) => r > ceilingFor(root))) return { error: "root_correction_legacy_out_of_range", detail: { max: Math.max(...legacyRounds) } };
  const legacy = Math.max(0, ...legacyRounds);
  const count = Math.max(max, legacy);
  // Issue #178: the destination's OWN recorded SHA -> live head is validated UNCONDITIONALLY (with or without a PM revise request).
  // Missing/diverged/behind/forged proof => reject; the count is preserved by the caller (never lowered), the ordinal is never reused.
  const own = destination ? byPr.get(destination.pr) : null;
  const proofBinds = !!own && destination.recordedSha === own.sha && destination.liveSha === destination.sha;
  const destProven = !!own && SHA.test(destination.sha ?? "") && (own.sha === destination.sha || (destination.ancestryOk === true && proofBinds));
  if (destination && own && !destProven) return { error: "root_correction_destination_unproven", detail: { pr: destination.pr, n: own.n } };
  if (requested.length) {
    // Issue #174: two distinct phases. (a) BEFORE the destination PR executed: the request must name the next ordinal (count+1).
    // (b) RE-EVALUATION after the destination PR's own durable n marker: the request must equal that OWN n, and only when the marker is
    // bound to the destination PR with the destination head SHA verified identical/descendant (`destination.ancestryOk`). A marker
    // of another PR/chain can never satisfy (b), so duplicates/historical replays cannot lower or re-use a count.
    const ownProven = !!own && own.n === count && destProven;
    const okReq = (r) => r === count + 1 || (ownProven && r === own.n);
    if (!requested.every(okReq)) return { error: "root_correction_request_mismatch", detail: { requested: [...new Set(requested)], expected: ownProven ? [count, count + 1] : count + 1 } };
  }
  return { count, records: [...byN.values()].sort((a, b) => a.n - b.n) };
}

/**
 * Issue #176 — DESTINATION proof. `records` are the durable (marker-recorded) correction records of the root; `own` is the one recorded
 * for destination PR `pr`. The question is: is the live destination head still the recorded execution (same SHA) or a proven descendant of it?
 * `cmp` is the result of compare(recordedSha, liveHead) already normalized with ancestryFrom ({baseSha, headSha, status}) or null when the
 * compare was unavailable (API error / removed commit / missing). Source->destination ancestry is a SEPARATE proof and is never used here.
 * @returns {{recordedSha:string|null, liveSha:string|undefined, ancestryOk:boolean}}
 */
export function destinationProof({ records = [], pr, liveSha, cmp = null }) {
  const own = records.find((r) => r.pr === pr) ?? null;
  const recordedSha = own?.sha ?? null;
  const ancestryOk = !!own && SHA.test(liveSha ?? "") && (own.sha === liveSha || (!!cmp && cmp.baseSha === own.sha && cmp.headSha === liveSha && ["ahead", "identical"].includes(cmp.status)));
  return { recordedSha, liveSha, ancestryOk };
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
