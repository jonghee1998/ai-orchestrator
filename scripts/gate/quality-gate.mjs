// Issue #172 — shared, default-ON development quality gate for ALL AI Orchestrator tasks. Pure + read-only.
// It does NOT prove a developer "thought carefully": it machine-checks that the REQUIRED RECEIPTS exist, are authored by trusted
// identities, are bound to the exact head SHA and are in the right order. Anything missing/unverifiable => `blocked` (hard) or
// `unknown` (cannot be determined). The only way to `pass` is every stage evidenced. A markdown checklist alone proves nothing.
import { isTrustedPm, isTrustedCodex } from "../handoff/core.mjs";
import { selectReviewVerdict } from "../handoff/review-verdict.mjs";
import { normalizeCodexReviews } from "../handoff/lifecycle-evidence.mjs";

export const GATE_STAGES = Object.freeze(["pm_scope", "dev_analysis", "self_test", "codex_review", "codex_impact_review", "pm_compare"]);
const SHA = /^[a-f0-9]{40}$/;
const attrs = (s) => Object.fromEntries([...s.matchAll(/(\w+)=([^\s>]+)/g)].map((m) => [m[1], m[2]]));
const find = (items, name) => items.flatMap((it) => [...(it.body ?? "").matchAll(new RegExp(`<!--\\s*gate:${name}:v1\\s+([^>]*?)-->`, "g"))].map((m) => ({ it, a: attrs(m[1]) })));
const when = (it) => Date.parse(it.created_at ?? "");

/**
 * @param {{issue:number, pr?:number, head?:string, items:object[], firstCodeCommitAt?:string, failHistory?:string[]}} i
 *   items: issue/PR bodies+comments with {user, body, created_at}. failHistory: classes of prior review FAILs on this root.
 * @returns {{status:'pass'|'blocked'|'unknown', stages:Record<string,{status:string,reason?:string}>, unmet:string[]}}
 */
export function evaluateGate({ issue, pr, head, items = [], firstCodeCommitAt, failHistory = [], stage = "final" }) {
  const st = {};
  const set = (k, status, reason) => { st[k] = reason ? { status, reason } : { status }; };
  const pmItems = items.filter((x) => isTrustedPm(x?.user));
  const bound = (a) => Number(a.issue) === issue && (a.pr === undefined || Number(a.pr) === pr);
  // 1. PM scope/acceptance receipt
  set("pm_scope", find(pmItems, "pm-scope").some((x) => bound(x.a)) ? "pass" : "blocked", "pm_scope_receipt_missing");
  if (st.pm_scope.status === "pass") delete st.pm_scope.reason;
  // 2. developer pre-code analysis, BEFORE the first code commit
  const an = find(pmItems.concat(items.filter((x) => !isTrustedPm(x?.user) && x?.trustedWriter)), "dev-analysis").filter((x) => bound(x.a));
  // Issue #174: created_at alone is NOT proof for an editable body/comment. The LAST modification (updated_at) must also precede the first
  // code commit; a missing/malformed timestamp (no accessible revision history) is UNKNOWN, an edit at/after the commit is BLOCKED.
  const code = Date.parse(firstCodeCommitAt ?? "");
  const lastTouch = (it) => { const c = Date.parse(it.created_at ?? ""), u = Date.parse(it.updated_at ?? ""); return Number.isFinite(c) && Number.isFinite(u) && u >= c ? u : NaN; };
  if (!an.length) set("dev_analysis", "blocked", "dev_analysis_receipt_missing");
  else if (!Number.isFinite(code)) set("dev_analysis", "unknown", "first_code_commit_time_unknown");
  else if (an.some((x) => Number.isFinite(lastTouch(x.it)) && lastTouch(x.it) < code)) set("dev_analysis", "pass");
  else if (an.some((x) => !Number.isFinite(lastTouch(x.it)))) set("dev_analysis", "unknown", "analysis_revision_history_unavailable");
  else set("dev_analysis", "blocked", Date.parse(an[0].it.created_at) < code ? "analysis_edited_after_code" : "analysis_not_before_code");
  // 3. self-test / impact check on the exact head
  const stt = find(items.filter((x) => x?.trustedWriter || isTrustedPm(x?.user)), "self-test").filter((x) => bound(x.a));
  if (!SHA.test(head ?? "")) set("self_test", "unknown", "head_unknown");
  else if (!stt.length) set("self_test", "blocked", "self_test_receipt_missing");
  else if (!stt.some((x) => x.a.sha === head && x.a.typecheck === "pass" && x.a.test === "pass" && x.a.build === "pass")) set("self_test", "blocked", "self_test_not_pass_on_exact_head");
  else set("self_test", "pass");
  // 4. independent Codex review (code + SECURITY) on the exact head
  // Issue #174: the SAME selector the lifecycle uses; contradictory/ambiguous/duplicated evidence => blocked, never pass.
  const rv = selectReviewVerdict({ sha: head, reviews: normalizeCodexReviews(items) });
  if (!SHA.test(head ?? "")) set("codex_review", "unknown", "head_unknown");
  else if (rv.verdict === "pass" && !rv.duplicate) set("codex_review", "pass");
  else if (rv.verdict === "pass") set("codex_review", "blocked", "duplicate_receipts_on_exact_head");
  else set("codex_review", "blocked", (rv.reasons[0] === "findings_unresolved" ? "codex_findings_unresolved" : rv.reasons[0]) ?? "codex_review_not_pass");
  // 5. Codex review of IMPACT / TEST OMISSIONS (recorded by the PM against the exact head)
  const im = find(pmItems, "codex-impact").filter((x) => bound(x.a) && x.a.sha === head);
  if (!im.length) set("codex_impact_review", "unknown", "impact_review_not_recorded");
  else if (new Set(im.map((x) => x.a.verdict)).size > 1 || !im.every((x) => ["pass", "fail"].includes(x.a.verdict))) set("codex_impact_review", "blocked", "impact_review_conflicting_or_malformed");
  else set("codex_impact_review", im[0].a.verdict === "pass" ? "pass" : "blocked", im[0].a.verdict === "pass" ? undefined : "impact_review_failed");
  // 6. PM compares the verdict to the ORIGINAL acceptance criteria
  const cp = find(pmItems, "pm-compare").filter((x) => bound(x.a) && x.a.sha === head);
  if (!cp.length) set("pm_compare", "unknown", "pm_comparison_not_recorded");
  else set("pm_compare", cp.some((x) => x.a.verdict === "pass") && cp.every((x) => x.a.verdict === "pass") ? "pass" : "blocked", cp.every((x) => x.a.verdict === "pass") ? undefined : "pm_comparison_not_pass");
  // Repeated same-class FAIL => root-cause analysis receipt required BEFORE another correction.
  const counts = failHistory.reduce((m, c) => (m.set(c, (m.get(c) ?? 0) + 1), m), new Map());
  const rca = find(pmItems, "rca");
  for (const [cls, n] of counts) if (n >= 2 && !rca.some((x) => x.a.class === cls && Number(x.a.issue) === issue)) { set("rca", "blocked", `rca_required_for_repeated_class:${cls}`); break; }
  // Issue #174: `pre-pr` (before the PR exists / before its post-open Codex review) only requires stages 1-3; `final` requires everything.
  // Splitting avoids a deadlock where the final gate would wait on a review that can only start after the PR is opened.
  if (stage === "pre-pr") for (const k of ["codex_review", "codex_impact_review", "pm_compare", "rca"]) delete st[k];
  else if (stage !== "final") return { status: "blocked", stages: {}, unmet: [`unknown_stage:${String(stage).slice(0, 20)}`] };
  const unmet = Object.entries(st).filter(([, v]) => v.status !== "pass").map(([k, v]) => `${k}:${v.reason ?? v.status}`);
  const status = Object.values(st).some((v) => v.status === "blocked") ? "blocked" : Object.values(st).some((v) => v.status === "unknown") ? "unknown" : "pass";
  return { status, stages: st, unmet };
}

/**
 * Feature-vs-defect classification can never evade the root cap: the correction counter (root-corrections) is derived from
 * evidence (supersedes ancestry + review FAIL), NOT from this label. A claimed `feature` for a PR that supersedes a PR
 * with unresolved findings is still counted; the relabel is reported as a conflict instead of being honored.
 */
export function classifyChange({ claimed, supersedesFailedPr }) {
  if (claimed === "feature" && supersedesFailedPr) return { kind: "correction", conflict: "relabel_ignored", countsTowardCap: true };
  return { kind: claimed === "feature" && !supersedesFailedPr ? "feature" : "correction", countsTowardCap: claimed !== "feature" || supersedesFailedPr };
}
