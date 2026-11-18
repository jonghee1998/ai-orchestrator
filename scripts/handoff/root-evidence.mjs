// Issue #172 — bounded, complete, ROOT-WIDE correction evidence (read-only). Pure helpers + a collector over a read-only gh facade.
// Sources (each tagged with an explicit `kind`; an Issue BODY is `issue`, never conflated with its `comment`s):
//   issue         body of the root issue and of EVERY issue carrying a trusted `orch-root-request:v1 #<root>` marker (revision issues of any chain)
//   comment       comments of those issues
//   pr            body of every PR carrying that trusted root marker, plus every verified ancestry-chain PR (historical + current)
//   pr-comment    comments of those PRs
// Completeness is never inferred from the current chain. If an authoritative source cannot be enumerated or read (API error,
// non-array page, pagination bound exceeded) the collector THROWS and runLifecycle fails closed as `evidence_load_failed`.
// Items are deduplicated by stable identity `kind:id`; semantic duplicates (same root/n/pr/sha) are merged by resolveRootCorrections.
import { rootMarker, supersedesMarker, normalizeCodexReviews } from "./lifecycle-evidence.mjs";
import { isTrustedPm } from "./core.mjs";

const SHA = /^[a-f0-9]{40}$/;
const item = (kind, o) => ({ kind, id: o.id ?? o.number, user: o.user, body: o.body ?? "", created_at: o.created_at ?? null, number: o.number });
export const itemKey = (it) => `${it.kind}:${it.id}`;
export function dedupeItems(list) {
  const seen = new Set();
  return list.filter((it) => { const k = itemKey(it); if (seen.has(k)) return false; seen.add(k); return true; });
}

/** Root-marked issues + PRs (any chain), their comments. `rootIssue` is always included. Throws on any enumeration/read failure. */
export async function collectRootEvidence(gh, root, { rootIssue, rootComments = [], pr, prComments = [] }) {
  const out = [item("issue", rootIssue), ...rootComments.map((c) => item("comment", c)), item("pr", pr), ...prComments.map((c) => item("pr-comment", c))];
  const sources = { issues: [root], prs: [pr.number] };
  const issues = await gh.listIssues();
  const prs = await gh.listPulls();
  if (!Array.isArray(issues) || !Array.isArray(prs)) throw new Error("root evidence enumeration returned a non-array");
  for (const i of issues) {
    if (i?.pull_request || i.number === root) continue;
    const m = rootMarker(i);
    if (m === "ambiguous") return { error: "root_request_ambiguous", detail: { issue: i.number } };
    if (m !== root) continue;
    out.push(item("issue", i));
    sources.issues.push(i.number);
    out.push(...(await gh.listIssueComments(i.number)).map((c) => item("comment", c)));
  }
  for (const p of prs) {
    if (p.number === pr.number) continue;
    const m = rootMarker(p);
    if (m === "ambiguous") return { error: "root_request_ambiguous", detail: { pr: p.number } };
    if (m !== root) continue;
    out.push(item("pr", p));
    sources.prs.push(p.number);
    out.push(...(await gh.listIssueComments(p.number)).map((c) => item("pr-comment", c)));
  }
  return { items: out, sources };
}

/** Add verified ancestry-chain PRs (bodies + comments) that the root-marker scan did not already cover. */
export async function addChainEvidence(gh, base, chain) {
  const items = [...base.items];
  const have = new Set(base.sources.prs);
  for (const p of chain) {
    if (have.has(p.number)) continue;
    have.add(p.number);
    items.push(item("pr", p), ...(await gh.listIssueComments(p.number)).map((c) => item("pr-comment", c)));
  }
  return { items: dedupeItems(items), sources: { ...base.sources, prs: [...have] } };
}

/**
 * Derive correction record for chain[1] (the PR directly superseded by the PR under evaluation) when it has no recorded marker yet
 * (markers are written when the NEXT execution is requested). All proofs are required, otherwise fail closed (never invent a record):
 *  - chain[1] is a trusted-PM PR whose supersedes marker names chain[2], which HAS a recorded correction n;
 *  - chain[1].head.sha is a full SHA, ancestor of (or identical to) the current PR head (exact-SHA ancestry link verified by compare);
 *  - a trusted Codex receipt bound to exactly chain[1].head.sha exists (the PR existed and was reviewed at that SHA).
 * No derivation (returns {}) when chain[1] already has a marker, is the original PR, or its predecessor has no recorded n (legacy chains).
 * @returns {{derived?:{n,pr,sha}, error?:string, detail?:object}}
 */
export function deriveChainCorrection({ chain, chainLinks, records, commentsByPr }) {
  const q = chain[1], r = chain[2];
  if (!q || !r) return {};
  if (supersedesMarker(q) !== r.number || !isTrustedPm(q.user)) return {};
  if (records.some((x) => x.pr === q.number)) return {};
  const pred = records.find((x) => x.pr === r.number);
  if (!pred) return {};
  const missing = [];
  if (!SHA.test(q.head?.sha ?? "")) missing.push("head_sha");
  const link = chainLinks?.[0]?.ancestry;
  if (!link || link.baseSha !== q.head?.sha || !["ahead", "identical"].includes(link.status)) missing.push("ancestry_to_current_head");
  const bound = normalizeCodexReviews(commentsByPr?.[q.number] ?? []).some((x) => !x.ambiguous && x.commit_sha === q.head?.sha);
  if (!bound) missing.push("trusted_codex_receipt_on_exact_sha");
  if (missing.length) return { error: "root_correction_underivable", detail: { pr: q.number, missing } };
  return { derived: { n: pred.n + 1, pr: q.number, sha: q.head.sha } };
}
