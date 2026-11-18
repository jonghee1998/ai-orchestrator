// Issue #174 — ONE fail-closed exact-SHA code+security verdict selector, shared by the lifecycle (reviewEvidence) and the
// quality gate (gate codex_review stage). Pure, no imports. Input = NORMALIZED trusted receipts (lifecycle-evidence.normalizeCodexReviews).
// A clean receipt can never override contradictory evidence; security PASS is never inferred from a code-only review.
/** Security capability of exact-head reviews: absent | blocked | invalid | pending. Never PASS. */
const securityStatusOf = (exact) => {
  const st = new Set(exact.map((r) => r.security_status ?? "not_run"));
  if (st.has("blocked")) return "blocked";
  if (st.has("invalid")) return "invalid";
  if (st.size === 0 || (st.size === 1 && st.has("not_run"))) return "absent";
  return "pending";
};
const bool = (v) => typeof v === "boolean";

/** @returns {{independent,unresolved,security,securityCapability,codeVerdict,stale,conflict,duplicate,verdict:'pass'|'findings'|'blocked',reasons:string[]}} */
export function selectReviewVerdict({ sha, reviews = [], prAuthor = null }) {
  const trusted = reviews.filter((r) => r?.trusted === true);
  // ambiguous trusted receipt (multi/malformed marker) naming this SHA => raw conflict, never dropped, never clean
  const ambiguousExact = trusted.some((r) => r.ambiguous === true && Array.isArray(r.mentioned_shas) && r.mentioned_shas.includes(sha));
  const mine = trusted.filter((r) => r.ambiguous !== true);
  const forSha = mine.filter((r) => r.commit_sha === sha && r.user?.login !== prAuthor);
  const exact = forSha.filter((r) => r.status === "completed");
  // a trusted receipt on this SHA that is not completed/clean-shaped alongside a completed one is opposed evidence
  const codeOpposed = forSha.some((r) => r.status !== "completed" && r.status !== "in_progress" && r.status !== "not_run") && exact.length > 0;
  const verdicts = new Set(exact.map((r) => r.has_unresolved_findings));
  const codeConflict = verdicts.size > 1 || [...verdicts].some((v) => !bool(v)) || codeOpposed;
  const stale = mine.some((r) => r.commit_sha !== sha);
  const secDone = exact.filter((r) => r.security_status === "completed");
  const secVerdicts = new Set(secDone.map((r) => r.security_unresolved));
  const secConflict = secVerdicts.size > 1 || [...secVerdicts].some((v) => !bool(v)) || (secDone.length > 0 && exact.some((r) => r.security_status === "invalid"));
  const securityPass = !secConflict && secVerdicts.size === 1 && secVerdicts.has(false);
  const securityUnresolved = !secConflict && secVerdicts.has(true);
  const security = secConflict ? "conflict" : securityPass ? "pass" : securityUnresolved ? "findings" : "missing";
  const conflict = codeConflict || secConflict || ambiguousExact;
  const duplicate = exact.length > 1 && (new Set(exact.map((r) => r.commentId)).size !== exact.length || new Set(exact.map((r) => `${r.has_unresolved_findings}|${r.security_status}|${r.security_unresolved}`)).size === 1);
  const securityCapability = secConflict || ambiguousExact ? "conflict" : securityPass || securityUnresolved ? "completed" : securityStatusOf(exact);
  const independent = !conflict && exact.length > 0 && verdicts.has(false) && securityPass;
  const unresolved = !conflict && (verdicts.has(true) || securityUnresolved);
  const codeVerdict = codeConflict || ambiguousExact ? "conflict" : verdicts.size === 0 ? "missing" : verdicts.has(true) ? "findings" : "pass";
  const reasons = [];
  if (ambiguousExact) reasons.push("ambiguous_trusted_receipt_on_exact_sha");
  if (codeConflict) reasons.push("code_verdict_conflict");
  if (secConflict) reasons.push("security_verdict_conflict");
  if (!exact.length) reasons.push("codex_review_missing_on_exact_head");
  else if (!conflict && security === "missing") reasons.push("security_review_absent");
  if (unresolved) reasons.push("findings_unresolved");
  const verdict = independent ? "pass" : conflict || !exact.length || security === "missing" ? "blocked" : "findings";
  return { independent, unresolved, security, securityCapability, codeVerdict, stale, conflict, duplicate, verdict, reasons };
}
