import test from "node:test";
import assert from "node:assert/strict";
import { bucketOf, buildCards, summarize, parseRuns, parseWorkflows, type RunRow, type WorkflowRow } from "./viewModel";

const run = (o: Partial<RunRow> = {}): RunRow => ({ dispatchId: "d1", issueNumber: 42, agent: "claude-sonnet", attempt: 1, status: "queued", verified: false, submission: null,
  lastActivityAt: "2026-11-14T00:00:00Z", lastError: null, evidence: [], latency: null, collaboration: null, execution: null, ...o });

test("bucket mapping never reports unACKed dispatch as running", () => {
  assert.equal(bucketOf("unknown"), "unknown");
  assert.equal(bucketOf("running"), "running");
  assert.equal(bucketOf("timeout"), "blocked");
  assert.equal(bucketOf("succeeded"), "completed");
  assert.equal(bucketOf("weird"), "unknown");
});
const HMAC = { origin: "runner", receipt: "hmac_signed", execution: "none", cleanup: "unproven", verified: true };
test("missing data stays null/unverified, not invented", () => {
  const [c] = buildCards([run()], []);
  assert.equal(c.sha, null); assert.equal(c.branch, null); assert.equal(c.ack.verified, false); assert.deepEqual(c.links, []);
});
test("collaboration data yields branch/sha/links; only github urls accepted", () => {
  const sha = "a".repeat(40);
  const [c] = buildCards([run({ status: "running", verified: true, trust: HMAC, latency: { ackMs: 4000 }, collaboration: { workflowId: "w", cycle: 1, step: "claude", repo: "o/r", baseBranch: "b", baseSha: sha, workBranch: "x", targetSha: sha, prNumber: 7 },
    evidence: [{ kind: "pr", url: "https://github.com/o/r/pull/7" }, { kind: "other", url: "javascript:alert(1)" }] })], []);
  assert.equal(c.branch, null, "planned workBranch is not review evidence"); assert.equal(c.sha, sha); assert.equal(c.ack.verified, true); assert.match(c.ack.text, /4s/);
  assert.equal(c.links.length, 3); assert.ok(c.links.every((l) => l.url.startsWith("https://github.com/")));
});
test("summarize and parsers", () => {
  assert.equal(summarize(buildCards([run(), run({ status: "failed" })], [])).blocked, 1);
  assert.equal(parseRuns(200, { mode: "unconfigured", runs: [] }), "unconfigured");
  assert.equal(parseRuns(500, { mode: "error", runs: [] }), null);
  assert.equal(parseWorkflows(503, { error: "store_unconfigured" }), "unconfigured");
  assert.deepEqual(parseWorkflows(200, { workflows: [] }), []);
});

const SHA = "a".repeat(40);
const collab = (o: object = {}) => ({ workflowId: "w", cycle: 1, step: "review", repo: "o/r", baseBranch: "b", baseSha: SHA, workBranch: "future/work", targetSha: SHA, prNumber: 43, ...o });
const wf = (o: Partial<WorkflowRow> = {}): WorkflowRow => ({ id: "w", stage: "pm", cycle: 1, feedback: "", updatedAt: "2026-11-14T00:00:00Z", dispatchId: "d1",
  assignment: { repo: "o/r", issueNumber: 42, baseBranch: "b", baseSha: SHA, workBranch: "future/work", claudeAgent: "c", sourcePr: 43 },
  latest: { number: 43, headSha: SHA, headBranch: "claude/reviewed", url: "https://github.com/o/r/pull/43", open: true }, history: [], ...o });

test("source-PR review shows the reviewed PR head branch, not the future workBranch", () => {
  const [c] = buildCards([run({ collaboration: collab() })], [wf()]);
  assert.equal(c.branch, "claude/reviewed");
});
test("branch is unknown when PR or SHA does not match the dispatch", () => {
  assert.equal(buildCards([run({ collaboration: collab() })], [wf({ latest: { number: 99, headSha: SHA, headBranch: "other", url: "u", open: true } })])[0].branch, null);
  assert.equal(buildCards([run({ collaboration: collab() })], [wf({ latest: { number: 43, headSha: "b".repeat(40), headBranch: "moved", url: "u", open: true } })])[0].branch, null);
  assert.equal(buildCards([run({ collaboration: collab({ prNumber: undefined }) })], [wf()])[0].branch, null);
  assert.equal(buildCards([run({ collaboration: collab() })], [])[0].branch, null);
});
test("past failed run does not inherit later approved cycle's stage/PR/feedback", () => {
  const old = run({ dispatchId: "d-old", status: "failed", collaboration: collab({ cycle: 1, prNumber: undefined }) });
  const later = wf({ stage: "approved", cycle: 2, dispatchId: "d-new", feedback: "LGTM" });
  const [c] = buildCards([old], [later]);
  assert.equal(c.nextAction, "원인 확인 후 명시적 재시도 필요");
  assert.equal(c.findings, null);
  assert.ok(!c.links.some((l) => l.label.startsWith("PR")));
  // same cycle but a different (later) dispatch also must not bind
  assert.equal(buildCards([old], [wf({ stage: "approved", cycle: 1, dispatchId: "d-new" })])[0].nextAction, "원인 확인 후 명시적 재시도 필요");
  // the matching dispatch+cycle does bind
  assert.equal(buildCards([run({ collaboration: collab() })], [wf({ stage: "approved" })])[0].nextAction, "승인됨 — 추가 작업 없음");
});
test("malformed/partial/null nested responses are rejected (loader error), never crash", () => {
  const good = run({ execution: { exitCode: 0, summary: "s", headSha: SHA, tests: [{ command: "t", exitCode: 0 }] }, collaboration: collab() });
  assert.deepEqual(parseRuns(200, { mode: "live", runs: [good] })?.length, 1);
  const bad: unknown[] = [null, 5, "x", {}, { ...good, execution: { exitCode: 0, summary: "s", headSha: SHA, tests: null } },
    { ...good, execution: { exitCode: 0, summary: "s", headSha: SHA, tests: [null] } }, { ...good, execution: { exitCode: 0, summary: "s", headSha: SHA, tests: [{ command: "t" }] } },
    { ...good, collaboration: { workflowId: "w" } }, { ...good, evidence: [null] }, { ...good, evidence: "x" }, { ...good, latency: 5 }, { ...good, status: undefined }];
  for (const b of bad) assert.equal(parseRuns(200, { mode: "live", runs: [good, b] }), null, JSON.stringify(b)?.slice(0, 60));
  assert.equal(parseRuns(200, null), null); assert.equal(parseRuns(200, "x"), null); assert.equal(parseRuns(200, [] as unknown), null);
  assert.equal(parseWorkflows(200, { workflows: [wf()] })?.length, 1);
  for (const b of [null, 1, {}, { ...wf(), assignment: null }, { ...wf(), latest: 3 }, { ...wf(), history: [null] }, { ...wf(), cycle: "1" }])
    assert.equal(parseWorkflows(200, { workflows: [b] }), null);
  assert.equal(parseWorkflows(200, [] as unknown), null);
});

// #57 (PR56 P2): evidence labels — SYNTHETIC rows (no live data).
test("#57: session rows are never verified, even if a payload claims verified:true", () => {
  const session = { origin: "session", receipt: "session_header", execution: "session_self_report_unverified", cleanup: "unproven", verified: false };
  const ex = { exitCode: 0, summary: "done", headSha: SHA, tests: [{ command: "npm test", exitCode: 0 }] };
  for (const trust of [session, { ...session, verified: true }, { ...session, receipt: "hmac_signed" }, { ...session, cleanup: "runner_attested" }]) {
    const [c] = buildCards([run({ status: "succeeded", verified: true, trust, execution: ex })], []);
    assert.equal(c.ack.verified, false, JSON.stringify(trust)); assert.match(c.ack.text, /자기보고/); assert.doesNotMatch(c.ack.text, /검증됨/);
    assert.match(c.findings!, /^세션 자기보고\(미검증\)/); assert.match(c.findings!, /1\/1 통과 보고/);
  }
});
test("#57: legacy payload without trust, malformed trust and HMAC runner rows", () => {
  const [legacy] = buildCards([run({ status: "running", verified: true })], []);
  assert.equal(legacy.ack.verified, false, "verified:true alone (no trust) is not enough"); assert.match(legacy.ack.text, /trust 정보 없음/);
  for (const trust of [null, "x", [], { origin: "runner" }, { ...HMAC, receipt: "forged" }]) {
    const [c] = buildCards([run({ status: "running", verified: true, trust })], []);
    assert.equal(c.ack.verified, false, JSON.stringify(trust));
  }
  const [hmacFalse] = buildCards([run({ status: "running", verified: false, trust: HMAC })], []);
  assert.equal(hmacFalse.ack.verified, false, "both flags must agree");
  const [ok] = buildCards([run({ status: "succeeded", verified: true, trust: { ...HMAC, execution: "runner_reported", cleanup: "runner_attested" },
    execution: { exitCode: 0, summary: "ok", headSha: SHA, tests: [{ command: "t", exitCode: 0 }] } })], []);
  assert.equal(ok.ack.verified, true); assert.match(ok.ack.text, /runner 정리 증명/); assert.doesNotMatch(ok.findings!, /자기보고/);
  const [unk] = buildCards([run({ status: "unknown", submission: "unknown" })], []);
  assert.equal(unk.ack.verified, false); assert.match(unk.ack.text, /수신 미확인/);
});
