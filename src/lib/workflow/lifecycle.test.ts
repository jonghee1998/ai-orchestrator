import assert from "node:assert/strict";
import test from "node:test";
import { lifecycleOf, completionTypeOf, projectComplete, type LifecycleInput } from "./lifecycle";
import type { IssueEvidence, PullEvidence } from "../github/evidence";
import { workspace } from "../github/mobile-workspace";

const SHA_A = "a".repeat(40), SHA_B = "b".repeat(40);
const pr = (o: Partial<PullEvidence> = {}): PullEvidence => ({ number: 1, url: "u", title: "t", state: "open", draft: false, base: "main", head: "f", headSha: SHA_A, linkedBy: ["body"], commits: { count: 1, truncated: false }, reviews: [], comments: [], revisions: 0, detail: "loaded", ...o });
const cm = (kind: "ack" | "completion") => ({ id: 1, url: "u", at: "2026-01-01T00:00:00Z", login: "x", bot: false, kind, headline: "h" });
const ev = (o: Partial<IssueEvidence> = {}): IssueEvidence => ({ number: 1, title: "t", url: "u", state: "open", agent: "claude", status: "in-progress", acks: [], completions: [], comments: 0, pulls: [], nextAction: { code: "triage", label: "", actor: "" }, ...o });
const life = (o: Partial<LifecycleInput> & { evidence?: IssueEvidence } = {}) => lifecycleOf({ status: "status:in-progress", ...o });
const decision = (headMatch: "exact" | "stale" | "unknown"): PullEvidence["decision"] => ({ kind: "approve", at: "t", source: "review", by: "pm", commitsAfter: 0, headMatch, headMoved: headMatch === "stale", stackedPulls: [] });

test("completion type parsing: explicit only, conflicts/absence → unknown", () => {
  assert.equal(completionTypeOf("완료유형: deploy"), "deploy");
  assert.equal(completionTypeOf("x", ["completion:integration"]), "integration");
  assert.equal(completionTypeOf("completion type: nondeploy"), "nondeploy");
  assert.equal(completionTypeOf("완료유형: deploy", ["completion:integration"]), "unknown");
  assert.equal(completionTypeOf("nothing"), "unknown");
});
test("feature-branch merge is integration complete only, never production complete", () => {
  const e = ev({ pulls: [pr({ state: "merged", base: "codex/feature" })] });
  const i = life({ description: "완료유형: integration", evidence: e });
  assert.equal(i.phase, "integrated"); assert.equal(i.complete, true);
  const d = life({ description: "완료유형: deploy", evidence: e });
  assert.equal(d.phase, "integrated"); assert.equal(d.complete, false); assert.ok(d.missingEvidence.length);
});
test("deploy merged to main without deploy evidence → deploy pending; with proof → completed", () => {
  const e = ev({ pulls: [pr({ state: "merged", base: "main" })] });
  const w = life({ description: "완료유형: deploy", evidence: e });
  assert.equal(w.phase, "deploy_pending"); assert.equal(w.complete, false); assert.deepEqual(w.missingEvidence, ["배포 확인 증거"]);
  assert.equal(life({ description: "완료유형: deploy", evidence: e, deployVerified: true }).phase, "completed");
});
test("closed / unknown completion type → closed_unverified, not done", () => {
  const c = life({ issueState: "closed", evidence: ev({ state: "closed" }) });
  assert.equal(c.phase, "closed_unverified"); assert.equal(c.complete, false); assert.equal(c.completionType, "unknown");
  assert.equal(life({ issueState: "closed", description: "완료유형: deploy" }).phase, "unverifiable");
});
test("nondeploy requires explicit criteria + closed + completion report", () => {
  const desc = "완료유형: nondeploy\n완료 조건: 문서 제출";
  const done = ev({ state: "closed", completions: [cm("completion")] });
  assert.equal(life({ description: desc, issueState: "closed", evidence: done }).phase, "completed");
  assert.equal(life({ description: "완료유형: nondeploy", issueState: "closed", evidence: done }).phase, "unverifiable");
  const noReport = life({ description: desc, issueState: "closed", evidence: ev({ state: "closed" }) });
  assert.equal(noReport.phase, "unverifiable"); assert.deepEqual(noReport.missingEvidence, ["완료 기준 충족 보고"]);
  assert.equal(life({ description: desc, evidence: ev({ completions: [cm("completion")] }) }).complete, false);
});
test("ACK only → received (execution unverified); commit/PR is past work, not running evidence", () => {
  const a = life({ status: "status:ready", evidence: ev({ acks: [cm("ack")] }) });
  assert.equal(a.phase, "received"); assert.match(a.label, /실행 미확인/);
  const d = life({ evidence: ev({ pulls: [pr({ draft: true })] }) });
  assert.equal(d.phase, "in_progress"); assert.ok(d.missingEvidence[0].includes("현재 실행 증거")); assert.equal(d.complete, false);
});
test("stale / unknown-SHA review is incomplete; exact head approval is review awaiting merge", () => {
  assert.equal(life({ evidence: ev({ pulls: [pr({ decision: decision("stale") })] }) }).phase, "stale_review");
  assert.equal(life({ evidence: ev({ pulls: [pr({ decision: decision("unknown") })] }) }).phase, "stale_review");
  const ok = life({ evidence: ev({ pulls: [pr({ decision: decision("exact") })] }) });
  assert.equal(ok.phase, "review"); assert.equal(ok.complete, false);
});
test("multiple PRs: open/explicit link wins, ambiguity → unverifiable, past merge is history", () => {
  const open = pr({ number: 2 }), merged = pr({ number: 1, state: "merged", base: "feat" });
  assert.equal(life({ description: "완료유형: integration", evidence: ev({ pulls: [merged, open] }) }).phase, "review");
  const two = life({ evidence: ev({ pulls: [pr({ number: 3 }), pr({ number: 4 })] }) });
  assert.equal(two.phase, "unverifiable"); assert.equal(two.complete, false);
  const explicit = life({ evidence: ev({ pulls: [pr({ number: 3, linkedBy: ["issue-body"] }), pr({ number: 4 })] }) });
  assert.notEqual(explicit.phase, "unverifiable");
  const m2 = life({ description: "완료유형: integration", evidence: ev({ pulls: [merged, pr({ number: 5, state: "merged", base: "feat" })] }) });
  assert.equal(m2.phase, "unverifiable");
});
test("CI/deploy data absent → unverifiable/pending, never completed", () => {
  assert.equal(life({ status: "status:review", description: "완료유형: deploy" }).complete, false);
  assert.equal(life({ status: "weird" }).phase, "unverifiable");
});
test("project complete only when every task meets its criterion", () => {
  const ok = life({ description: "완료유형: integration", evidence: ev({ pulls: [pr({ state: "merged", base: "f" })] }) });
  const no = life({ issueState: "closed" });
  assert.equal(projectComplete([ok]), true);
  assert.equal(projectComplete([ok, no]), false);
  assert.equal(projectComplete([]), false);
});
test("R1 regression: closed issues + feature merge + 'done' label must not make a project 업무 완료", () => {
  const tasks = [
    { id: "1", title: "a", status: "status:done", agent: "claude" as const, url: "", dependsOn: [], issueState: "closed" as const, project: { id: "p", name: "P" } },
    { id: "2", title: "b", status: "status:done", agent: "claude" as const, url: "", dependsOn: [], description: "완료유형: deploy", project: { id: "p", name: "P" } },
  ];
  const evidence = { source: "github", repo: "r", generatedAt: "", runtimeProof: "not_included", identityNote: "", limits: {} as never, issues: [ev({ number: 2, pulls: [pr({ state: "merged", base: "feat" })] })] } as const;
  const m = workspace(tasks, evidence as never);
  assert.equal(m.projects[0].done, 0);
  assert.notEqual(m.projects[0].stage, "업무 완료");
  assert.equal(m.tasks[0].lifecycle.phase, "closed_unverified");
  assert.equal(m.tasks[1].lifecycle.phase, "integrated");
});
