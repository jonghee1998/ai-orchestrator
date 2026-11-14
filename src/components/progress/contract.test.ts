// #53 integration contract: the progress view-model must accept the REAL response shapes produced by the
// backend stack (PR44/48/50/52: blocked stages, cleanup proof, quiescence, cleanup_failed). Synthetic in-memory
// store flows only — no provider, no network.
import assert from "node:assert/strict";
import test from "node:test";
import { assignCollaboration, claimCollaboration, finishCollaboration, decideCollaboration, quiesceCollaboration, reportCleanupFailure, type Assignment, type ExecutionResult } from "../../lib/runs/collaboration";
import type { CollaborationGitHub, PullSnapshot } from "../../lib/runs/collaboration-github";
import { handleCollaboration } from "../../lib/runs/collaboration-http";
import { MemoryRunStore, type RunStore } from "../../lib/runs/store";
import { submitQueued, type DispatchAdapter } from "../../lib/runs/dispatcher";
import { runView } from "../../lib/runs/run-trust";
import { handleSession } from "../../lib/runs/session-http";
import { createHash } from "node:crypto";
import { buildCards, parseRuns, parseWorkflows } from "./viewModel";

const NOW = "2026-01-01T00:00:00.000Z", MS = Date.parse(NOW), A = "a".repeat(40), B = "b".repeat(40);
const assignment: Assignment = { repo: "o/r", issueNumber: 36, baseBranch: "claude/base", baseSha: A, sourcePr: 35, workBranch: "claude/issue-36", claudeAgent: "claude-sonnet", instructions: "x", reviewCompletedPr: true };
const pr: PullSnapshot = { number: 35, repo: "o/r", headBranch: "claude/base", headSha: A, baseBranch: "main", url: "https://github.com/o/r/pull/35", open: true };
const result: ExecutionResult = { exitCode: 0, summary: "findings", headSha: A, tests: [{ command: "npm test", exitCode: 0 }], prNumber: 35, cleanup: { processGroupsEmpty: true, groups: 3 } };
const github: CollaborationGitHub = { branch: async () => A, pull: async () => structuredClone(pr), descendsFrom: async () => true };
const adapter: DispatchAdapter = { supports: (a) => a !== "gpt", submit: async () => ({ outcome: "accepted" }) };
const env = { CONTROL_ADMIN_TOKEN: "admin".repeat(5), CONTROL_READ_TOKEN: "reader".repeat(5), GITHUB_REPO: "o/r" };

// #57: src/app/api/runs/route.ts maps every record with runView (route imports next/server, so it is not in the test
// build) — this uses that exact mapping function, not a copy.
async function apiRuns(store: RunStore): Promise<unknown> {
  const { records } = await store.read();
  return JSON.parse(JSON.stringify({ mode: "live", runs: Object.values(records).map(runView) }));
}
async function apiWorkflows(store: RunStore): Promise<unknown> {
  const r = await handleCollaboration("GET", new Headers({ "x-admin-token": env.CONTROL_READ_TOKEN }), "", { store: () => store, github, adapter, env, nowMs: MS });
  assert.equal(r.status, 200);
  return JSON.parse(r.body);
}
async function setup() {
  const store = new MemoryRunStore();
  await store.transact((d) => { d.control.agents.codex = true; d.control.agents["claude-sonnet"] = true; d.control.claudeProvider = true; });
  const w = await assignCollaboration(store, github, assignment, NOW);
  await submitQueued(store, adapter, w.dispatchId!, NOW);
  await claimCollaboration(store, w.dispatchId!, "codex", "run-00001", NOW);
  return { store, id: w.dispatchId!, wid: w.id };
}
async function parsed(store: RunStore) {
  const runs = parseRuns(200, await apiRuns(store)), wfs = parseWorkflows(200, await apiWorkflows(store));
  assert.ok(Array.isArray(runs), "parseRuns rejected a real /api/runs body"); assert.ok(Array.isArray(wfs), "parseWorkflows rejected a real /api/collaboration body");
  return buildCards(runs, wfs);
}

test("#53 contract: finish with cleanup proof -> PM stage parses; branch/SHA/next action coherent", async () => {
  const s = await setup();
  await finishCollaboration(s.store, github, s.id, "codex", "run-00001", result, NOW);
  const [c] = await parsed(s.store);
  assert.equal(c.bucket, "completed"); assert.equal(c.sha, A); assert.equal(c.shaKind, "head");
  assert.equal(c.branch, "claude/base"); assert.match(c.nextAction, /PM 검수/); assert.match(c.findings!, /1\/1/);
  // #57: HMAC runner result — verified receipt with runner cleanup proof.
  assert.equal(c.ack.verified, true); assert.match(c.ack.text, /HMAC/); assert.match(c.ack.text, /runner 정리 증명/);
});
// #57 (PR56 P2): SYNTHETIC session flow through the real session handler -> real /api/runs mapping -> progress model.
const TOKEN = "sonnet-session-token-" + "z".repeat(40);
async function sessionRun(exitCode: number) {
  const store = new MemoryRunStore();
  await store.transact((d) => { d.control.agents["claude-sonnet"] = true; d.control.claudeProvider = true; });
  const dev: PullSnapshot = { number: 37, repo: "o/r", headBranch: "claude/issue-36", headSha: B, baseBranch: "claude/base", url: "https://github.com/o/r/pull/37", open: true };
  const gh: CollaborationGitHub = { branch: async () => A, pull: async (_r, n) => structuredClone(n === 37 ? dev : pr), descendsFrom: async () => true };
  const w = await assignCollaboration(store, gh, { ...assignment, reviewCompletedPr: false }, NOW);
  await submitQueued(store, adapter, w.dispatchId!, NOW);
  const deps = { store: () => store as RunStore, github: gh, adapter, env: { SESSION_TOKEN_SHA256_CLAUDE_SONNET: createHash("sha256").update(TOKEN).digest("hex") }, nowMs: MS };
  let n = 0;
  const call = (b: object) => handleSession(new Headers({ "x-agent-key": "claude-sonnet", "x-orch-session-token": TOKEN, "x-timestamp": String(MS), "x-event-id": `contract-${++n}-0000` }),
    JSON.stringify({ v: 1, agent: "claude-sonnet", issueNumber: 36, dispatchId: w.dispatchId, runId: "session-run-0036", targetSha: A, ...b }), deps);
  assert.equal((await call({ action: "claim" })).status, 200);
  const running = (await parsed(store)).find((c) => c.dispatchId === w.dispatchId)!;
  assert.equal(running.ack.verified, false); assert.match(running.ack.text, /세션 수신만 인증/);
  assert.equal((await call({ action: "finish", result: { exitCode, headSha: B, summary: "s", tests: [{ command: "npm test", exitCode }], prNumber: 37 } })).status, 200);
  const api = (await apiRuns(store)) as { runs: { dispatchId: string; verified: boolean; origin: string; trust: { execution: string; cleanup: string } }[] };
  const row = api.runs.find((r) => r.dispatchId === w.dispatchId)!;
  assert.equal(row.verified, false); assert.equal(row.origin, "session");
  assert.equal(row.trust.execution, "session_self_report_unverified"); assert.equal(row.trust.cleanup, "unproven");
  return (await parsed(store)).find((c) => c.dispatchId === w.dispatchId)!;
}
test("#57 contract (synthetic): session SUCCESS is a self-report — not verified, tests 'reported', no cleanup proof", async () => {
  const c = await sessionRun(0);
  assert.equal(c.bucket, "completed"); assert.equal(c.ack.verified, false);
  assert.match(c.ack.text, /자기보고\(미검증\)/); assert.match(c.ack.text, /정리 증명 없음/); assert.doesNotMatch(c.ack.text, /검증됨|HMAC/);
  assert.match(c.findings!, /^세션 자기보고\(미검증\)/); assert.match(c.findings!, /통과 보고/);
});
test("#57 contract (synthetic): session FAILURE stays unverified and blocked", async () => {
  const c = await sessionRun(1);
  assert.equal(c.bucket, "blocked"); assert.equal(c.ack.verified, false); assert.match(c.findings!, /^세션 자기보고/);
});
test("#53 contract: quiesced (lease_revoked) and cleanup_failed records parse as blocked, never running", async () => {
  for (const kind of ["quiesce", "cleanup_failed"] as const) {
    const s = await setup();
    if (kind === "quiesce") await quiesceCollaboration(s.store, s.id, "codex", "run-00001", { reason: "lease_revoked", processGroupEmpty: true, signal: "SIGKILL" }, NOW);
    else await reportCleanupFailure(s.store, s.id, "codex", "run-00001", { reason: "normal_exit", groups: 2, unproven: 1 }, NOW);
    const wfs = parseWorkflows(200, await apiWorkflows(s.store)) as { stage: string }[];
    assert.equal(wfs[0].stage, "blocked", kind);
    const [c] = await parsed(s.store);
    assert.equal(c.bucket, "blocked", kind); assert.match(c.nextAction, /차단됨/, kind);
    // No execution was stored: SHA is the dispatch target (not a reported head); branch is the PR head bound to that target SHA.
    assert.equal(c.shaKind, "target", kind); assert.equal(c.sha, A, kind); assert.equal(c.branch, "claude/base", kind); assert.equal(c.findings, null, kind);
  }
});
test("#53 contract: PM revise -> cycle 2; historical cycle-1 card does not inherit cycle-2 workflow", async () => {
  const s = await setup();
  await finishCollaboration(s.store, github, s.id, "codex", "run-00001", result, NOW);
  await decideCollaboration(s.store, github, s.wid, A, "revise", "fix", NOW);
  const cards = await parsed(s.store);
  assert.equal(cards.length, 2);
  const old = cards.find((c) => c.dispatchId === s.id)!, cur = cards.find((c) => c.dispatchId !== s.id)!;
  assert.equal(old.branch, null); assert.match(old.nextAction, /결과 검수/);
  assert.match(cur.task, /cycle 2/); assert.equal(cur.bucket, "queued"); assert.notEqual(cur.sha, B);
});
