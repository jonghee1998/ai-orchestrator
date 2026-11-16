import assert from "node:assert/strict";
import test from "node:test";
import { classify, parseCompletionType, rollup, pickPull } from "./lifecycle";
import { workspace } from "../github/mobile-workspace";
import type { WorkQueueTask } from "../github/work-queue";
import type { IssueEvidence, PullEvidence } from "../github/evidence";

const task = (o: Partial<WorkQueueTask> = {}): WorkQueueTask => ({ id: "1", title: "t", agent: "claude", status: "review", dependsOn: [], url: "", issueState: "open", description: "Completion type: integration", ...o });
const pull = (o: Partial<PullEvidence> = {}): PullEvidence => ({ number: 5, url: "", title: "", state: "merged", draft: false, base: "feature", head: "h", headSha: "a".repeat(40), linkedBy: ["body"], commits: { count: 1, truncated: false }, reviews: [], comments: [], revisions: 0, detail: "loaded", ...o });
const proof = (pulls: PullEvidence[], acks = 0): IssueEvidence => ({ number: 1, title: "t", url: "", state: "open", agent: "claude", status: "review", acks: Array(acks).fill({ id: 1, url: "", at: "", login: "x", bot: false, kind: "ack", headline: "" }), completions: [], comments: 0, pulls, nextAction: { code: "triage", label: "", actor: "" } });
const run = (t: WorkQueueTask, p?: IssueEvidence) => classify(t, p, () => false);

test("completion type parsing is explicit; missing/invalid/conflicting → unknown", () => {
  assert.equal(parseCompletionType("x\nCompletion type: deploy"), "deploy");
  assert.equal(parseCompletionType("Completion type: Nondeploy"), "nondeploy");
  assert.equal(parseCompletionType("no type"), "unknown");
  assert.equal(parseCompletionType("Completion type: bogus"), "unknown");
  assert.equal(parseCompletionType("Completion type: deploy\nCompletion type: integration"), "unknown");
});
test("R1: open issue + status:review + feature-merged PR without explicit type is not done", () => {
  const l = run(task({ description: "plain" }), proof([pull()]));
  assert.notEqual(l.phase, "done"); assert.equal(l.completion, "unknown"); assert.ok(l.missingEvidence.includes("completion_type"));
});
test("integration: feature-branch merge completes", () => {
  assert.equal(run(task(), proof([pull()])).phase, "done");
  assert.equal(run(task(), proof([pull({ state: "open" })])).completion, "incomplete");
});
test("deploy: main merge without deployment evidence is deployment pending; feature merge is not", () => {
  const t = task({ description: "Completion type: deploy" });
  const m = run(t, proof([pull({ base: "main" })]));
  assert.equal(m.completion, "deployment_pending"); assert.notEqual(m.phase, "done"); assert.ok(m.missingEvidence.includes("deployment"));
  const f = run(t, proof([pull({ base: "feature" })]));
  assert.equal(f.completion, "incomplete"); assert.ok(f.missingEvidence.includes("main_merge"));
});
test("nondeploy completes on closed issue", () => {
  assert.equal(run(task({ description: "Completion type: nondeploy", issueState: "closed" })).phase, "done");
});
test("unknown type: closed issue is not done", () => {
  const l = run(task({ description: undefined, issueState: "closed", status: "done" }));
  assert.equal(l.phase, "unknown"); assert.equal(l.completion, "unknown");
});
test("ACK alone = receipt reported, execution unverified, no work proven", () => {
  const l = run(task({ status: "in-progress" }), proof([], 1));
  assert.equal(l.receipt, "reported"); assert.equal(l.execution, "unverified"); assert.equal(l.workOccurred, false);
});
test("PR proves work occurred, not that it is running", () => {
  const l = run(task({ status: "ready" }), proof([pull({ state: "open" })]));
  assert.equal(l.workOccurred, true); assert.equal(l.execution, "unverified");
});
test("stale review SHA is never verified; exact is; unknown SHA is unverified", () => {
  const d = (headMatch: "exact" | "stale" | "unknown") => run(task(), proof([pull({ state: "open", decision: { kind: "approve", at: "", source: "review", by: "x", commitsAfter: 0, headMatch, headMoved: headMatch === "stale", stackedPulls: [] } })])).review;
  assert.equal(d("exact"), "verified"); assert.equal(d("stale"), "stale"); assert.equal(d("unknown"), "unverified");
});
test("multiple PRs: open beats historical merged; ambiguous association is unknown", () => {
  const open = pull({ number: 7, state: "open" }), merged = pull({ number: 3 });
  const pick = pickPull([merged, open]);
  assert.ok(pick.kind === "pr" && pick.pull.number === 7);
  assert.equal(run(task(), proof([merged, open])).completion, "incomplete");
  const amb = run(task(), proof([pull({ number: 8 }), pull({ number: 9 })]));
  assert.equal(amb.completion, "unknown"); assert.ok(amb.missingEvidence.includes("pr_association"));
  assert.equal(run(task(), proof([open, pull({ number: 10, state: "open" })])).phase, "review");
});
test("project completes only when all tasks meet explicit criteria", () => {
  const c = { phase: "done", completion: "complete" } as const, u = { phase: "unknown", completion: "unknown" } as const;
  assert.equal(rollup([c, c]).stage, "업무 완료");
  assert.notEqual(rollup([c, u]).stage, "업무 완료");
  assert.equal(rollup([c, u]).done, 1);
  assert.notEqual(rollup([]).stage, "업무 완료");
});
test("workspace integration: R1 project is not complete; integration task is", () => {
  const ev = (pulls: PullEvidence[]) => ({ source: "github", repo: "", generatedAt: "", runtimeProof: "not_included", identityNote: "", limits: {} as never, issues: [proof(pulls)] }) as never;
  assert.notEqual(workspace([task({ description: "x" })], ev([pull()])).projects[0].stage, "업무 완료");
  assert.equal(workspace([task()], ev([pull()])).projects[0].stage, "업무 완료");
});
