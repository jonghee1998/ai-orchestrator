import assert from "node:assert/strict";
import test from "node:test";
import { classify, SIGNAL_LABEL, parseCompletionType, parseIntegrationTarget, rollup, pickPull } from "./lifecycle";
import { workspace, PHASE_LABEL, phaseLabel } from "../github/mobile-workspace";
import { buildEvidence, pmAcceptances, pullIssueRefs, stackUniverse, type RawComment, type RawIssue, type RawPull, type RawReview } from "../github/evidence";
import type { WorkQueueTask } from "../github/work-queue";
import type { Acceptance, IssueEvidence, PullEvidence, StackRef } from "../github/evidence";

const task = (o: Partial<WorkQueueTask> = {}): WorkQueueTask => ({ id: "1", title: "t", agent: "claude", status: "review", dependsOn: [], url: "", issueState: "open", description: "Completion type: integration\nIntegration target: feature", ...o });
const SHA = "a".repeat(40);
const pull = (o: Partial<PullEvidence> = {}): PullEvidence => ({ number: 5, url: "", title: "", state: "merged", draft: false, base: "feature", head: "h", headSha: SHA, linkedBy: ["body"], commits: { count: 1, truncated: false }, reviews: [], comments: [], revisions: 0, detail: "loaded", mergedAt: "2026-01-01T00:00:10Z", ...o });
/** Builds evidence the way buildEvidence does: stack universe over linked PRs (+ optional unlinked repo PRs). */
const proof = (pulls: PullEvidence[], acks = 0, extra: Partial<IssueEvidence> & { repo?: PullEvidence[] } = {}): IssueEvidence => {
  const { repo = [], ...rest } = extra;
  const ref = (p: PullEvidence, explicit: boolean): StackRef => ({ number: p.number, state: p.state, base: p.base, head: p.head, headSha: p.headSha, mergedAt: p.mergedAt, explicit });
  const seeds = pulls.filter(p => p.linkedBy.some(l => l !== "issue-comment")).map(p => ref(p, true));
  const all = [...pulls.map(p => ref(p, seeds.some(r => r.number === p.number))), ...repo.map(p => ref(p, false))];
  return { number: 1, title: "t", url: "", state: "open", agent: "claude", status: "review", acks: Array(acks).fill({ id: 1, url: "", at: "", login: "x", bot: false, kind: "ack", headline: "" }), completions: [], comments: 0, pulls, nextAction: { code: "triage", label: "", actor: "" }, stack: stackUniverse(seeds, all), acceptances: [], partial: [], ...rest };
};
const approve = (headMatch: "exact" | "stale" | "unknown"): PullEvidence["decision"] => ({ kind: "approve", at: "", source: "comment", by: "x", commitsAfter: 0, headMatch, headMoved: headMatch === "stale", stackedPulls: [] });
const accept = (o: Partial<Acceptance> = {}): Acceptance => ({ issue: 1, pr: 5, sha: SHA, target: "feature", at: "", url: "", by: "owner", ...o });
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
  assert.equal(w.tasks[0].lifecycle.signal, "label"); assert.equal(w.tasks[0].lifecycle.receipt, "none");
  assert.equal(w.projects[0].stage, SIGNAL_LABEL.label); assert.ok(!/^접수 보고됨/.test(w.projects[0].stage)); assert.ok(!/^접수 보고만/.test(w.tasks[0].waiting));
  assert.equal(phaseLabel(w.tasks[0].lifecycle), SIGNAL_LABEL.label); assert.equal(phaseLabel(r), "접수 보고됨 · 실행 미확인");
  assert.equal(r.signal, "ack"); assert.equal(w.projects[0].reported, 1); assert.equal(w.projects[0].active, 0);
});

test("PR proves work occurred, not that it is running", () => {
  const l = run(task({ status: "ready" }), proof([pull({ state: "open" })]));
  assert.equal(l.workOccurred, true); assert.equal(l.execution, "unverified");
});

test("project completes only when all tasks meet explicit criteria", () => {
  const c = { phase: "done", completion: "complete" } as const, u = { phase: "unknown", completion: "unknown" } as const;
  assert.equal(rollup([c, c]).stage, "업무 완료");
  assert.notEqual(rollup([c, u]).stage, "업무 완료");
  assert.equal(rollup([c, u]).done, 1);
  assert.notEqual(rollup([]).stage, "업무 완료");
  const r = { phase: "reported", completion: "incomplete", signal: "ack" } as const;
  assert.equal(rollup([r]).stage, "접수 보고됨 · 실행 미확인"); assert.equal(rollup([{ ...r, signal: "label" }]).stage, SIGNAL_LABEL.label); assert.equal(rollup([r]).active, 0); assert.equal(rollup([r]).reported, 1);
});

// ---- simple integration (target "feature"): acceptance, not comments ----
test("integration: needs explicit target, merge into it, and PM acceptance of the exact head", () => {
  assert.equal(run(task(), proof([pull()], 0, { acceptances: [accept()] })).phase, "done");
  assert.equal(run(task(), proof([pull({ state: "open" })])).completion, "incomplete");
  assert.equal(parseIntegrationTarget("Integration target: feature"), "feature");
  assert.equal(parseIntegrationTarget("Integration target: a\nIntegration target: b"), undefined);
  const nt = run(task({ description: "Completion type: integration" }), proof([pull()], 0, { acceptances: [accept()] }));
  assert.equal(nt.completion, "unknown"); assert.notEqual(nt.phase, "done"); assert.ok(nt.missingEvidence.includes("integration_target"));
  assert.notEqual(run(task(), proof([pull({ base: "other" })], 0, { acceptances: [accept()] })).phase, "done");
});
test("comment/review-looking approval is never acceptance; stale or unknown SHA is not verified", () => {
  const c = run(task(), proof([pull({ decision: approve("exact") })]));
  assert.notEqual(c.phase, "done"); assert.equal(c.review, "comment-only"); assert.ok(c.missingEvidence.includes("acceptance_current"));
  assert.equal(run(task(), proof([pull({ decision: approve("stale") })])).review, "stale");
  assert.equal(run(task(), proof([pull({ decision: approve("unknown") })])).review, "unverified");
  assert.equal(run(task(), proof([pull()], 0, { acceptances: [accept()] })).review, "verified");
  assert.equal(run(task(), proof([pull()])).review, "none");
});
test("multiple PRs: open beats historical merged for display; ambiguous display pick is unknown for non-integration", () => {
  const open = pull({ number: 7, state: "open" }), merged = pull({ number: 3 });
  const pick = pickPull([merged, open]);
  assert.ok(pick.kind === "pr" && pick.pull.number === 7);
  assert.equal(pickPull([pull({ number: 51, head: "p", base: "main" }), pull({ number: 52, head: "q", base: "main" })]).kind, "ambiguous");
  const a = pull({ number: 20, head: "a", base: "main" }), b = pull({ number: 10, head: "b", base: "a" });
  const chain = pickPull([a, b]); assert.ok(chain.kind === "pr" && chain.pull.number === 10);
});
test("workspace: R1 project is not complete; accepted integration task is", () => {
  const ev = (pulls: PullEvidence[], acc: Acceptance[] = []) => ({ source: "github", repo: "", generatedAt: "", runtimeProof: "not_included", identityNote: "", limits: {} as never, issues: [proof(pulls, 0, { acceptances: acc })] }) as never;
  assert.notEqual(workspace([task({ description: "x" })], ev([pull()])).projects[0].stage, "업무 완료");
  assert.notEqual(workspace([task()], ev([pull()])).projects[0].stage, "업무 완료");
  assert.equal(workspace([task()], ev([pull()], [accept()])).projects[0].stage, "업무 완료");
  assert.notEqual(workspace([task()], ev([pull()], [accept({ sha: "b".repeat(40) })])).projects[0].stage, "업무 완료");
});

// ---- Actual topology (#99): T = codex/issue-92-mobile-v2; #100 → T, #103 → #100's head, #105 → #103's head ----
const T = "codex/issue-92-mobile-v2", H100 = "claude/determined-carson-6hfvj7", H103 = "claude/determined-carson-wkv37c", H105 = "claude/determined-carson-b4hwgs";
const S105 = "75cfb11e92851c715d4dc5c227acbbca679d81a6", S103 = "47971ef" + "0".repeat(33), S100_OLD = "85c7548" + "0".repeat(33), M2 = "2".repeat(40);
const t = (n: number) => `2026-11-16T10:0${n}:00Z`;
const p105 = (o: Partial<PullEvidence> = {}) => pull({ number: 105, head: H105, base: H103, headSha: S105, state: "merged", mergedAt: t(1), ...o });
const p103 = (o: Partial<PullEvidence> = {}) => pull({ number: 103, head: H103, base: H100, headSha: S103, state: "merged", mergedAt: t(2), ...o });
const p100 = (o: Partial<PullEvidence> = {}) => pull({ number: 100, head: H100, base: T, headSha: M2, state: "merged", mergedAt: t(3), ...o });
const topo = (o100: Partial<PullEvidence> = {}, o103: Partial<PullEvidence> = {}, o105: Partial<PullEvidence> = {}) => [p100(o100), p103(o103), p105(o105)];
const tgt = task({ description: `Completion type: integration\nIntegration target: ${T}` });
const acc100 = (o: Partial<Acceptance> = {}): Acceptance => accept({ pr: 100, sha: M2, target: T, ...o });
const missing = (pulls: PullEvidence[], extra: Parameters<typeof proof>[2] = {}) => run(tgt, proof(pulls, 0, extra));

test("#19 fixture: target is codex/issue-92-mobile-v2 with all of #100/#103/#105; S3 complete only with acceptance of final head", () => {
  assert.equal(T, "codex/issue-92-mobile-v2");
  const done = missing(topo(), { acceptances: [acc100()] });
  assert.equal(done.completion, "complete"); assert.equal(done.phase, "done"); assert.equal(done.pr?.number, 100); assert.equal(done.pr?.base, T); assert.equal(done.pr?.head, H100); assert.equal(done.pr?.headSha, M2);
  const noAcc = missing(topo());
  assert.equal(noAcc.completion, "incomplete"); assert.deepEqual(noAcc.missingEvidence, ["acceptance_current"]);
});
test("S0/S1/S2: stage table for the real stack", () => {
  const s0 = missing(topo({ state: "open" }, { state: "open" }, { state: "open" }));
  assert.equal(s0.completion, "incomplete"); assert.ok(["merged_pr"].every(m => s0.missingEvidence.includes(m as never)));
  const s2 = missing(topo({ state: "open" }, { state: "merged" }, { state: "merged" }));
  assert.ok(s2.missingEvidence.includes("merged_pr")); assert.notEqual(s2.phase, "done");
  const s1 = missing(topo({ state: "merged" }, { state: "open" }, { state: "merged" }), { acceptances: [acc100()] });
  assert.ok(s1.missingEvidence.includes("open_pr")); assert.notEqual(s1.completion, "complete");
});
test("#1 outgoing T→main PR, merged and accepted, is not integration into T", () => {
  const out = pull({ number: 99, head: T, base: "main", state: "merged" });
  const l = missing([out], { acceptances: [accept({ pr: 99, target: T })] });
  assert.notEqual(l.completion, "complete"); assert.notEqual(l.phase, "done"); assert.deepEqual(l.missingEvidence, ["merged_pr"]);
});
test("#2 head===T outgoing PR next to a real boundary is ignored (neither completes nor blocks)", () => {
  const out = pull({ number: 99, head: T, base: "main", state: "open" });
  assert.equal(missing([...topo(), out], { acceptances: [acc100()] }).completion, "complete");
  assert.notEqual(missing([...topo({ state: "open" }), out], { acceptances: [acc100({ pr: 99 })] }).completion, "complete");
});
test("#3 W1: boundary merged first while the stack is still open → open_pr", () => {
  const l = missing(topo({ headSha: S100_OLD, mergedAt: t(1) }, { state: "open" }, { state: "open" }), { acceptances: [acc100({ sha: S100_OLD })] });
  assert.notEqual(l.completion, "complete"); assert.notEqual(l.phase, "done"); assert.ok(l.missingEvidence.includes("open_pr"));
});
test("#4 up-stack PRs that are NOT linked to the issue still count (A3)", () => {
  const l = missing([p100()], { acceptances: [acc100()], repo: [p103({ state: "open", mergedAt: undefined }), p105({ state: "open", mergedAt: undefined })] });
  assert.equal(l.completion, "incomplete"); assert.ok(l.missingEvidence.includes("open_pr"));
  // closed-unmerged and unrelated repo PRs neither block nor count
  const rep = [p103({ state: "closed", mergedAt: undefined }), pull({ number: 300, head: "x/y", base: "main", state: "open" })];
  assert.equal(missing([p100()], { acceptances: [acc100()], repo: rep }).completion, "complete");
});
test("#5 W3: inner PR merged into its base AFTER that base was delivered is stranded", () => {
  const l = missing(topo({ mergedAt: t(2) }, { mergedAt: t(4) }, { mergedAt: t(1) }), { acceptances: [acc100()] });
  assert.notEqual(l.completion, "complete"); assert.ok(l.missingEvidence.includes("stranded_stack"));
});
test("#6 W2: retargeted inner PR is a second boundary needing its own merge and acceptance", () => {
  const l = missing([p100({ mergedAt: t(1) }), p103({ base: T, state: "open", mergedAt: undefined }), p105({ state: "open", mergedAt: undefined })], { acceptances: [acc100()] });
  assert.notEqual(l.completion, "complete"); assert.ok(l.missingEvidence.includes("merged_pr")); assert.ok(l.missingEvidence.includes("open_pr"));
  const both = missing([p100({ mergedAt: t(1) }), p103({ base: T, mergedAt: t(2) }), p105()], { acceptances: [acc100()] });
  assert.ok(both.missingEvidence.includes("acceptance_current"), "#103 as a boundary needs its own acceptance");
  assert.equal(missing([p100({ mergedAt: t(1) }), p103({ base: T, mergedAt: t(2) }), p105()], { acceptances: [acc100(), acc100({ pr: 103, sha: S103 })] }).completion, "complete");
});
test("#7 acceptance of the inner head (#105) does not accept the boundary", () => {
  const l = missing(topo(), { acceptances: [accept({ pr: 105, sha: S105, target: T })] });
  assert.ok(l.missingEvidence.includes("acceptance_current")); assert.notEqual(l.completion, "complete");
});
test("#8 acceptance of a pre-stack-merge boundary head is stale once the head moved to M2", () => {
  const l = missing(topo(), { acceptances: [acc100({ sha: S100_OLD })] });
  assert.equal(l.review, "stale"); assert.ok(l.missingEvidence.includes("acceptance_current")); assert.notEqual(l.phase, "done");
});
test("#9 plain 'Approved <sha>' comment (comment-only) is not acceptance", () => {
  const l = missing(topo({ decision: approve("exact") }));
  assert.equal(l.review, "comment-only"); assert.notEqual(l.completion, "complete");
});
test("#11 acceptance marker with a wrong target is not accepted; marker for another issue is ignored", () => {
  assert.notEqual(missing(topo(), { acceptances: [acc100({ target: "main" })] }).completion, "complete");
  const c = (body: string): RawComment => ({ id: 1, body, html_url: "u", issue_url: "https://api.github.com/repos/o/r/issues/100", created_at: t(5), user: { login: "owner" } });
  const m = pmAcceptances(c(`<!-- gpt-pm-accept:v1 issue99:pr100:${M2}:target=${T} -->`));
  assert.deepEqual(m.map(a => [a.issue, a.pr, a.sha, a.target]), [[99, 100, M2, T]]);
  assert.deepEqual(pmAcceptances(c("PM 승인 " + M2)), []);
  assert.deepEqual(pmAcceptances(c(`<!-- gpt-pm-accept:v1 issue99:pr100:${M2.slice(0, 7)}:target=${T} -->`)), []);
});
test("#12 multi-ref parsing: `Refs #104 #99 #102` and `Refs #102, #99` link every listed issue", () => {
  assert.deepEqual([...pullIssueRefs({ title: "t", body: "Refs #104 #99 #102" }).body].sort(), [102, 104, 99].sort());
  assert.deepEqual([...pullIssueRefs({ title: "t", body: "Refs #102, #99" }).body].sort(), [102, 99].sort());
  assert.deepEqual([...pullIssueRefs({ title: "t", body: "Closes #1 and #2" }).body].sort(), [1, 2]);
  assert.deepEqual([...pullIssueRefs({ title: "t", body: "see #7 for context" }).body], []);
});
test("#13 #99's real body (type mid-line, no target) → unknown, completion_type missing", () => {
  const body = "Stacked work. Completion type: integration. See #100.";
  assert.equal(parseCompletionType(body), "unknown");
  const l = run(task({ description: body }), proof(topo()));
  assert.equal(l.completion, "unknown"); assert.ok(l.missingEvidence.includes("completion_type")); assert.notEqual(l.phase, "done");
});
test("#14 closed not_planned/duplicate is never complete, for every completion type", () => {
  for (const reason of ["not_planned", "duplicate"] as const) {
    const int = run({ ...tgt, issueState: "closed", stateReason: reason }, proof(topo(), 0, { acceptances: [acc100()], state: "closed" }));
    assert.equal(int.completion, "incomplete"); assert.notEqual(int.phase, "done"); assert.ok(int.missingEvidence.includes("close_reason"));
    const dep = run(task({ description: "Completion type: deploy", issueState: "closed", stateReason: reason }), proof([pull({ base: "main" })]));
    assert.notEqual(dep.completion, "deployment_pending"); assert.notEqual(dep.phase, "done");
    const nd = run(task({ description: "Completion type: nondeploy", issueState: "closed", stateReason: reason }), proof([]));
    assert.notEqual(nd.phase, "done");
  }
});
test("#16 deploy: merged main PR + open linked follow-up is deployment_pending; comment-only inference does not count", () => {
  const dt = task({ description: "Completion type: deploy" });
  const l = run(dt, proof([pull({ number: 8, base: "main", head: "rel" }), pull({ number: 9, base: "feature", head: "next", state: "open" })]));
  assert.equal(l.completion, "deployment_pending"); assert.ok(l.missingEvidence.includes("deployment")); assert.notEqual(l.phase, "done");
  const inferred = run(dt, proof([pull({ number: 8, base: "main", head: "rel", linkedBy: ["issue-comment"] })]));
  assert.notEqual(inferred.completion, "deployment_pending");
});
test("#17 deploy: merged stack whose tip is based on a feature branch does not hide the main merge", () => {
  const dt = task({ description: "Completion type: deploy" });
  const l = run(dt, proof([pull({ number: 20, base: "main", head: "a" }), pull({ number: 21, base: "a", head: "b" }), pull({ number: 22, base: "b", head: "c" })]));
  assert.equal(l.completion, "deployment_pending"); assert.ok(!l.missingEvidence.includes("main_merge"));
});
test("missing/equal merge timestamps fail closed (merge order unknown)", () => {
  const l = missing(topo({}, { mergedAt: undefined }), { acceptances: [acc100()] });
  assert.equal(l.completion, "unknown"); assert.ok(l.missingEvidence.includes("merge_order")); assert.notEqual(l.phase, "done");
  const tie = missing(topo({ mergedAt: t(2) }, { mergedAt: t(2) }), { acceptances: [acc100()] });
  assert.equal(tie.completion, "unknown"); assert.ok(tie.missingEvidence.includes("merge_order"));
  // a definite problem wins over unknown ordering
  const mixed = missing(topo({}, { mergedAt: undefined }, { state: "open", mergedAt: undefined }), { acceptances: [acc100()] });
  assert.equal(mixed.completion, "incomplete"); assert.ok(mixed.missingEvidence.includes("open_pr"));
});
test("conflicting metadata fails closed: conflicting types/targets; unlinked-by-comment-only PRs are not boundaries", () => {
  assert.equal(run(task({ description: "Completion type: integration\nCompletion type: deploy\nIntegration target: feature" }), proof([pull()], 0, { acceptances: [accept()] })).completion, "unknown");
  const two = run(task({ description: `Completion type: integration\nIntegration target: ${T}\nIntegration target: main` }), proof(topo(), 0, { acceptances: [acc100()] }));
  assert.equal(two.completion, "unknown"); assert.ok(two.missingEvidence.includes("integration_target"));
  const inferred = missing(topo({ linkedBy: ["issue-comment"] }, { linkedBy: ["issue-comment"] }, { linkedBy: ["issue-comment"] }), { acceptances: [acc100()] });
  assert.notEqual(inferred.completion, "complete");
});
test("partial evidence with decisive impact is unknown, never incomplete/complete (I6)", () => {
  for (const partial of [["pulls_truncated"], ["pull_detail_skipped:#100"], ["commits_truncated:#103"]]) {
    const l = missing(topo(), { acceptances: [acc100()], partial });
    assert.equal(l.completion, "unknown"); assert.ok(l.missingEvidence.includes("evidence_partial")); assert.notEqual(l.phase, "done");
  }
});

// ---- end-to-end through buildEvidence (real payload shapes, nextAction / official approval / A5, A7, A8) ----
const R = "o/r";
const rawIssue = (n: number, body: string | null, extra: Partial<RawIssue> = {}): RawIssue => ({ number: n, title: `Issue ${n}`, body, html_url: `https://github.com/${R}/issues/${n}`, state: "open", labels: ["agent:claude", "status:review"], ...extra });
const rawPull = (n: number, base: string, head: string, sha: string, extra: Partial<RawPull> = {}): RawPull => ({ number: n, title: `PR ${n}`, body: "Refs #99", html_url: `https://github.com/${R}/pull/${n}`, state: "closed", merged_at: t(({ 100: 3, 103: 2, 105: 1 } as Record<number, number>)[n] ?? 3), head: { ref: head, sha }, base: { ref: base }, user: { login: "owner" }, ...extra });
const rawComment = (id: number, thread: number, body: string): RawComment => ({ id, body, html_url: `https://github.com/${R}/issues/${thread}#c${id}`, issue_url: `https://api.github.com/repos/${R}/issues/${thread}`, created_at: t(6), user: { login: "owner" } });
const rev = (id: number, login: string, state: string, commit: string): RawReview => ({ id, state, submitted_at: t(7), commit_id: commit, user: { login } });
const body99 = `Completion type: integration\nIntegration target: ${T}`;
const e2e = (opts: { issue?: Partial<RawIssue>; pulls?: RawPull[]; comments?: RawComment[]; reviews?: Map<number, RawReview[]>; pullsTruncated?: boolean; detail?: boolean } = {}) => {
  const pulls = opts.pulls ?? [rawPull(100, T, H100, M2, { body: "Refs #99" }), rawPull(103, H100, H103, S103, { body: "Refs #102, #99" }), rawPull(105, H103, H105, S105, { body: "Refs #104 #99 #102" })];
  const detail = new Map(opts.detail === false ? [] : pulls.map(p => [p.number, { reviews: opts.reviews?.get(p.number) ?? [], commits: [], commitsTruncated: false }]));
  return buildEvidence({ repo: R, generatedAt: t(9), issues: [rawIssue(99, body99, opts.issue)], pulls, comments: opts.comments ?? [], pullDetail: detail, commentsTruncated: false, pullsTruncated: opts.pullsTruncated ?? false }).issues[0];
};
const e2eRun = (i: IssueEvidence, issueState: "open" | "closed" = "open", stateReason?: WorkQueueTask["stateReason"]) => classify({ status: "review", dependsOn: [], issueState, stateReason, description: body99 }, i, () => true);
test("e2e: #105-style `Refs #104 #99 #102` links #105 to #99; stack read from ALL repo PRs; acceptance marker on the PR thread completes", () => {
  const i = e2e();
  assert.deepEqual(i.pulls.map(p => p.number), [100, 103, 105]);
  const noAcc = e2eRun(i); assert.equal(noAcc.completion, "incomplete"); assert.deepEqual(noAcc.missingEvidence, ["acceptance_current"]);
  const ok = e2e({ comments: [rawComment(1, 100, `PM 수락 기록\n<!-- gpt-pm-accept:v1 issue99:pr100:${M2}:target=${T} -->`)] });
  const l = e2eRun(ok); assert.equal(l.completion, "complete"); assert.equal(l.review, "verified");
  // marker bound to another issue number is ignored
  assert.equal(e2eRun(e2e({ comments: [rawComment(1, 100, `<!-- gpt-pm-accept:v1 issue98:pr100:${M2}:target=${T} -->`)] })).completion, "incomplete");
  // up-stack PR not linked at all (no Refs) but stacked on #103 is still seen
  const only = e2e({ pulls: [rawPull(100, T, H100, M2), rawPull(103, H100, H103, S103, { body: "no refs", state: "open", merged_at: null }), rawPull(105, H103, H105, S105, { body: null, state: "open", merged_at: null })], comments: [rawComment(1, 100, `<!-- gpt-pm-accept:v1 issue99:pr100:${M2}:target=${T} -->`)] });
  assert.deepEqual(only.pulls.map(p => p.number), [100]);
  const o = e2eRun(only); assert.equal(o.completion, "incomplete"); assert.ok(o.missingEvidence.includes("open_pr"));
});
test("#10 official approval: only a non-author APPROVED review on the exact head; author's own approval and stale commit are ignored", () => {
  const withReview = (login: string, commit: string, state = "APPROVED") => e2e({ reviews: new Map([[100, [rev(1, login, state, commit)]]]) });
  assert.equal(withReview("reviewer", M2).pulls[0].officialApproval?.by, "reviewer");
  assert.equal(e2eRun(withReview("reviewer", M2)).completion, "complete");
  assert.equal(withReview("owner", M2).pulls[0].officialApproval, undefined);
  assert.equal(e2eRun(withReview("owner", M2)).completion, "incomplete");
  assert.equal(e2eRun(withReview("reviewer", S105)).completion, "incomplete");
  assert.equal(e2eRun(withReview("reviewer", M2, "COMMENTED")).completion, "incomplete");
  const noAuthor = e2e({ pulls: [{ ...rawPull(100, T, H100, M2), user: null }] });
  assert.equal(noAuthor.pulls[0].officialApproval, undefined);
});
test("#15 skipped PR detail or truncated PR list → unknown/evidence_partial end to end (A7)", () => {
  const skipped = e2eRun(e2e({ detail: false })); assert.equal(skipped.completion, "unknown"); assert.ok(skipped.missingEvidence.includes("evidence_partial"));
  assert.equal(e2eRun(e2e({ pullsTruncated: true })).completion, "unknown");
});
test("#18 one model: a closed issue that is not complete is not 'done' in nextAction either; cancelled stays not done (A8)", () => {
  const acc = rawComment(1, 100, `<!-- gpt-pm-accept:v1 issue99:pr100:${M2}:target=${T} -->`);
  const closed = (reason: string | null) => e2e({ issue: { state: "closed", state_reason: reason }, comments: [acc] });
  const c = closed("completed"); assert.equal(c.nextAction.code, "done"); assert.equal(e2eRun(c, "closed", "completed").phase, "done");
  const n = closed("not_planned"); assert.equal(n.nextAction.code, "closed_unverified"); assert.notEqual(e2eRun(n, "closed", "not_planned").phase, "done");
  const noAcc = e2e({ issue: { state: "closed", state_reason: "completed" } }); assert.equal(noAcc.nextAction.code, "closed_unverified"); assert.equal(e2eRun(noAcc, "closed", "completed").phase, "unknown");
});
