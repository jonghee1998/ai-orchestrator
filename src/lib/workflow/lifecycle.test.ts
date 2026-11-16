import assert from "node:assert/strict";
import test from "node:test";
import { classify, parseCompletionType, parseIntegrationTarget, rollup, pickPull } from "./lifecycle";
import { workspace, PHASE_LABEL } from "../github/mobile-workspace";
import type { WorkQueueTask } from "../github/work-queue";
import type { IssueEvidence, PullEvidence } from "../github/evidence";

const task = (o: Partial<WorkQueueTask> = {}): WorkQueueTask => ({ id: "1", title: "t", agent: "claude", status: "review", dependsOn: [], url: "", issueState: "open", description: "Completion type: integration\nIntegration target: feature", ...o });
const pull = (o: Partial<PullEvidence> = {}): PullEvidence => ({ number: 5, url: "", title: "", state: "merged", draft: false, base: "feature", head: "h", headSha: "a".repeat(40), linkedBy: ["body"], commits: { count: 1, truncated: false }, reviews: [], comments: [], revisions: 0, detail: "loaded", ...o });
const proof = (pulls: PullEvidence[], acks = 0): IssueEvidence => ({ number: 1, title: "t", url: "", state: "open", agent: "claude", status: "review", acks: Array(acks).fill({ id: 1, url: "", at: "", login: "x", bot: false, kind: "ack", headline: "" }), completions: [], comments: 0, pulls, nextAction: { code: "triage", label: "", actor: "" } });
const approve = (headMatch: "exact" | "stale" | "unknown"): PullEvidence["decision"] => ({ kind: "approve", at: "", source: "review", by: "x", commitsAfter: 0, headMatch, headMoved: headMatch === "stale", stackedPulls: [] });
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
test("integration: needs explicit target, merge into it, and a current-head approval", () => {
  assert.equal(run(task(), proof([pull({ decision: approve("exact") })])).phase, "done");
  assert.equal(run(task(), proof([pull({ state: "open" })])).completion, "incomplete");
  assert.equal(parseIntegrationTarget("Integration target: feature"), "feature");
  assert.equal(parseIntegrationTarget("Integration target: a\nIntegration target: b"), undefined);
  // no explicit target → fail closed
  const nt = run(task({ description: "Completion type: integration" }), proof([pull({ decision: approve("exact") })]));
  assert.equal(nt.completion, "unknown"); assert.notEqual(nt.phase, "done"); assert.ok(nt.missingEvidence.includes("integration_target"));
  // merged into a different branch than the intended target
  assert.notEqual(run(task(), proof([pull({ base: "other", decision: approve("exact") })])).phase, "done");
});
test("stale-review merged PR is not final-complete; missing review also fails closed", () => {
  const stale = run(task(), proof([pull({ decision: approve("stale") })]));
  assert.equal(stale.completion, "incomplete"); assert.equal(stale.review, "stale"); assert.ok(stale.missingEvidence.includes("review_current")); assert.notEqual(stale.phase, "done");
  assert.notEqual(run(task(), proof([pull({ decision: approve("unknown") })])).phase, "done");
  const none = run(task(), proof([pull()]));
  assert.notEqual(none.phase, "done"); assert.ok(none.missingEvidence.includes("review_current"));
});
test("deploy: main merge without deployment evidence is deployment pending; feature merge is not", () => {
  const t = task({ description: "Completion type: deploy" });
  const m = run(t, proof([pull({ base: "main" })]));
  assert.equal(m.completion, "deployment_pending"); assert.notEqual(m.phase, "done"); assert.ok(m.missingEvidence.includes("deployment"));
  const f = run(t, proof([pull({ base: "feature" })]));
  assert.equal(f.completion, "incomplete"); assert.ok(f.missingEvidence.includes("main_merge"));
});
test("nondeploy: closed alone is not acceptance; needs completed reason and no open PR", () => {
  const nd = (o: Partial<WorkQueueTask>, ps: PullEvidence[] = []) => run(task({ description: "Completion type: nondeploy", issueState: "closed", ...o }), proof(ps));
  assert.equal(nd({ stateReason: "completed" }).phase, "done");
  const np = nd({ stateReason: "not_planned" });
  assert.notEqual(np.phase, "done"); assert.equal(np.completion, "incomplete");
  const none = nd({});
  assert.notEqual(none.phase, "done"); assert.equal(none.completion, "unknown"); assert.ok(none.missingEvidence.includes("close_reason"));
  const open = nd({ stateReason: "completed" }, [pull({ state: "open" })]);
  assert.notEqual(open.phase, "done"); assert.ok(open.missingEvidence.includes("open_pr"));
  // merged PR on an open issue is integration fact only, not nondeploy acceptance
  assert.notEqual(run(task({ description: "Completion type: nondeploy" }), proof([pull()])).phase, "done");
});
test("unknown type: closed issue is not done", () => {
  const l = run(task({ description: undefined, issueState: "closed", status: "done" }));
  assert.equal(l.phase, "unknown"); assert.equal(l.completion, "unknown");
});
test("ACK alone = receipt reported, execution unverified, no work proven", () => {
  const l = run(task({ status: "in-progress" }), proof([], 1));
  assert.equal(l.receipt, "reported"); assert.equal(l.execution, "unverified"); assert.equal(l.workOccurred, false);
});
test("visible phase: status:in-progress or ACK alone is never active/진행 중", () => {
  for (const l of [run(task({ status: "in-progress" })), run(task({ status: "in-progress" }), proof([], 1)), run(task({ status: "ready" }), proof([], 1)),
    run(task({ status: "in-progress" }), proof([pull({ state: "merged" })]))]) assert.notEqual(l.phase, "active");
  const r = run(task({ status: "in-progress" }), proof([], 1));
  assert.equal(r.phase, "reported"); assert.equal(PHASE_LABEL[r.phase], "접수 보고됨 · 실행 미확인"); assert.notEqual(PHASE_LABEL[r.phase], "진행 중");
  assert.equal(run(task({ status: "ready" })).phase, "remaining");
  const w = workspace([task({ status: "status:in-progress", description: "Completion type: deploy" })]);
  assert.equal(w.tasks[0].phase, "reported"); assert.ok(!/진행 소식/.test(w.tasks[0].waiting + w.tasks[0].next));
  assert.equal(w.projects[0].stage, "접수 보고됨 · 실행 미확인"); assert.equal(w.projects[0].reported, 1); assert.equal(w.projects[0].active, 0);
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
  assert.equal(run(task(), proof([open, pull({ number: 10, state: "open" })])).completion, "unknown");
});
test("stacked chain: current tip chosen by base/head linkage, not latest number; explicit link breaks ties", () => {
  const a = pull({ number: 20, head: "a", base: "main" }), b = pull({ number: 10, head: "b", base: "a" });
  const chain = pickPull([a, b]);
  assert.ok(chain.kind === "pr" && chain.pull.number === 10, "stack tip (#10) beats higher-numbered base PR");
  const hist = pickPull([a, b, pull({ number: 30, head: "c", base: "b", state: "closed" })]);
  assert.ok(hist.kind === "pr" && hist.pull.number === 10, "closed-unmerged ignored; historical merged chain not ambiguous");
  const x = pull({ number: 41, head: "x", base: "main", linkedBy: ["body"] }), y = pull({ number: 42, head: "y", base: "main", linkedBy: ["issue-comment"] });
  const t = pickPull([x, y]);
  assert.ok(t.kind === "pr" && t.pull.number === 41);
  assert.equal(pickPull([pull({ number: 51, head: "p", base: "main" }), pull({ number: 52, head: "q", base: "main" })]).kind, "ambiguous");
  assert.equal(pickPull([pull({ number: 53, head: "p", base: "main", linkedBy: ["body"] }), pull({ number: 54, head: "q", base: "main", linkedBy: ["title"] })]).kind, "ambiguous");
  const open = pickPull([pull({ number: 60, head: "o", base: "main", state: "open" }), a, b]);
  assert.ok(open.kind === "pr" && open.pull.number === 60, "open current work beats merged history");
});
test("historical merged stack with current-head approval completes via chain tip", () => {
  const a = pull({ number: 20, head: "a", base: "main" }), b = pull({ number: 10, head: "b", base: "a", decision: approve("exact") });
  const l = run(task({ description: "Completion type: integration\nIntegration target: a" }), proof([a, b]));
  assert.equal(l.pr?.number, 10); assert.equal(l.completion, "complete");
});
test("project completes only when all tasks meet explicit criteria", () => {
  const c = { phase: "done", completion: "complete" } as const, u = { phase: "unknown", completion: "unknown" } as const;
  assert.equal(rollup([c, c]).stage, "업무 완료");
  assert.notEqual(rollup([c, u]).stage, "업무 완료");
  assert.equal(rollup([c, u]).done, 1);
  assert.notEqual(rollup([]).stage, "업무 완료");
  const r = { phase: "reported", completion: "incomplete" } as const;
  assert.equal(rollup([r]).stage, "접수 보고됨 · 실행 미확인"); assert.equal(rollup([r]).active, 0); assert.equal(rollup([r]).reported, 1);
});
test("workspace integration: R1 project is not complete; integration task is", () => {
  const ev = (pulls: PullEvidence[]) => ({ source: "github", repo: "", generatedAt: "", runtimeProof: "not_included", identityNote: "", limits: {} as never, issues: [proof(pulls)] }) as never;
  assert.notEqual(workspace([task({ description: "x" })], ev([pull()])).projects[0].stage, "업무 완료");
  assert.notEqual(workspace([task()], ev([pull()])).projects[0].stage, "업무 완료"); // merged but no current approval
  assert.equal(workspace([task()], ev([pull({ decision: approve("exact") })])).projects[0].stage, "업무 완료");
  const stale = workspace([task()], ev([pull({ decision: approve("stale") })])).projects[0];
  assert.notEqual(stale.stage, "업무 완료"); assert.equal(stale.done, 0);
  const closedOpenPr = workspace([task({ description: "Completion type: nondeploy", issueState: "closed", stateReason: "completed" })], ev([pull({ state: "open" })])).projects[0];
  assert.notEqual(closedOpenPr.stage, "업무 완료");
});
