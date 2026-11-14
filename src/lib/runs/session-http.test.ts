// #55: routine-session channel — auth isolation, replay, wrong agent/dispatch, stale SHA, fail closed, fence preserved.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { assignCollaboration, claimCollaboration, decideCollaboration, finishCollaboration, leaseCollaboration, provablyQuiescent, quiesceCollaboration, type Assignment } from "./collaboration";
import type { CollaborationGitHub, PullSnapshot } from "./collaboration-github";
import { MemoryRunStore, RunStoreConfigurationError, type RunStore } from "./store";
import { submitQueued, type DispatchAdapter } from "./dispatcher";
import { handleSession } from "./session-http";
import { handleCollaborationWorker } from "./collaboration-http";
import { handleGate } from "./gate-http";
import { sessionAuthState } from "./session-auth";

const NOW = "2026-01-01T00:00:00.000Z", MS = Date.parse(NOW), A = "a".repeat(40), B = "b".repeat(40);
const OPUS_TOKEN = "opus-session-token-" + "x".repeat(40), SONNET_TOKEN = "sonnet-session-token-" + "y".repeat(40);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const ENV = {
  GITHUB_REPO: "o/r", CONTROL_ADMIN_TOKEN: "admin".repeat(5),
  RUN_CALLBACK_SECRET_CLAUDE_OPUS: "opus-hmac-secret-value", RUN_CALLBACK_SECRET_CODEX: "codex-hmac-secret-value",
  SESSION_TOKEN_SHA256_CLAUDE_OPUS: hash(OPUS_TOKEN), SESSION_TOKEN_SHA256_CLAUDE_SONNET: hash(SONNET_TOKEN),
};
const assignment: Assignment = { repo: "o/r", issueNumber: 55, baseBranch: "claude/base", baseSha: A, sourcePr: 54, workBranch: "claude/issue-55", claudeAgent: "claude-opus", instructions: "Implement", reviewCompletedPr: false };
const base: PullSnapshot = { number: 54, repo: "o/r", headBranch: "claude/base", headSha: A, baseBranch: "main", url: "https://github.com/o/r/pull/54", open: true };
const work: PullSnapshot = { number: 60, repo: "o/r", headBranch: "claude/issue-55", headSha: B, baseBranch: "claude/base", url: "https://github.com/o/r/pull/60", open: true };

async function setup(env: Record<string, string | undefined> = ENV) {
  const store = new MemoryRunStore();
  await store.transact(d => { d.control.agents["claude-opus"] = true; d.control.agents["claude-sonnet"] = true; d.control.agents.codex = true; d.control.claudeProvider = true; });
  const pulls = new Map([[54, base], [60, work]]);
  const github: CollaborationGitHub = { branch: async () => A, pull: async (_r, n) => structuredClone(pulls.get(n)!), descendsFrom: async () => true };
  const adapter: DispatchAdapter = { supports: () => true, submit: async () => ({ outcome: "accepted" }) };
  const w = await assignCollaboration(store, github, assignment, NOW);
  await submitQueued(store, adapter, w.dispatchId!, NOW);
  let n = 0;
  const deps = (over: Partial<{ store: () => RunStore; env: Record<string, string | undefined>; nowMs: number }> = {}) => ({ store: () => store as RunStore, github, adapter, env, nowMs: MS, ...over });
  const call = (body: object, o: { token?: string | null; agent?: string; eventId?: string; ts?: number; deps?: ReturnType<typeof deps> } = {}) => {
    const h = new Headers({ "x-agent-key": o.agent ?? "claude-opus", "x-event-id": o.eventId ?? `sess-${String(++n).padStart(6, "0")}`, "x-timestamp": String(o.ts ?? MS) });
    if (o.token !== null) h.set("x-orch-session-token", o.token ?? OPUS_TOKEN);
    return handleSession(h, JSON.stringify(body), o.deps ?? deps()).then(r => ({ ...r, json: JSON.parse(r.body) }));
  };
  const id = w.dispatchId!;
  const ctx = { v: 1, agent: "claude-opus", issueNumber: 55, dispatchId: id, runId: "session-run-0001", targetSha: A };
  return { store, github, adapter, w, id, call, deps, ctx, pulls };
}

test("session auth: per-agent token isolation, no HMAC/admin reuse, missing config fails closed (503)", async () => {
  const s = await setup();
  const gate = { v: 1, action: "gate", agent: "claude-opus", issueNumber: 55 };
  assert.equal((await s.call(gate, { token: null })).status, 401);
  assert.equal((await s.call(gate, { token: "short" })).status, 401);
  assert.equal((await s.call(gate, { token: SONNET_TOKEN })).status, 401, "Sonnet token cannot act as Opus");
  assert.equal((await s.call({ ...gate, agent: "claude-sonnet" }, { agent: "claude-sonnet" })).status, 401, "Opus token cannot act as Sonnet");
  assert.equal((await s.call({ ...gate, agent: "codex" }, { agent: "codex" })).status, 401, "codex has no session channel");
  assert.equal((await s.call({ ...gate, agent: "gpt" }, { agent: "gpt" })).status, 401);
  // The HMAC key itself is never a usable session token, and the admin token is not either.
  assert.equal((await s.call(gate, { token: ENV.RUN_CALLBACK_SECRET_CLAUDE_OPUS + "-padding-padding-pad" })).status, 401);
  assert.equal((await s.call(gate, { token: ENV.CONTROL_ADMIN_TOKEN + "-padding" })).status, 401);
  const cfg = (env: Record<string, string | undefined>) => s.call(gate, { deps: s.deps({ env }) });
  assert.equal((await cfg({ ...ENV, SESSION_TOKEN_SHA256_CLAUDE_OPUS: undefined })).status, 503);
  assert.equal((await cfg({ ...ENV, SESSION_TOKEN_SHA256_CLAUDE_OPUS: "not-a-hash" })).status, 503);
  // Owner reused a credential of another trust domain => refuse the channel rather than accept it.
  const reused = "reused-credential-value-0123456789abcdef";
  assert.equal((await cfg({ ...ENV, RUN_CALLBACK_SECRET_CLAUDE_OPUS: reused, SESSION_TOKEN_SHA256_CLAUDE_OPUS: hash(reused) })).status, 503);
  assert.equal((await cfg({ ...ENV, CONTROL_ADMIN_TOKEN: reused, SESSION_TOKEN_SHA256_CLAUDE_OPUS: hash(reused) })).status, 503);
  assert.equal((await cfg({ ...ENV, SESSION_TOKEN_SHA256_CLAUDE_SONNET: hash(OPUS_TOKEN) })).status, 503, "same token for both agents");
  assert.equal(sessionAuthState("claude-opus", ENV), "configured");
  assert.equal(sessionAuthState("claude-opus", { ...ENV, SESSION_TOKEN_SHA256_CLAUDE_SONNET: hash(OPUS_TOKEN) }), "misconfigured");
  // Error bodies never echo the token or hash.
  const r = await s.call(gate, { token: SONNET_TOKEN });
  assert.ok(!r.body.includes(SONNET_TOKEN) && !r.body.includes(hash(SONNET_TOKEN)) && !r.body.includes(hash(OPUS_TOKEN)));
});

test("existing HMAC endpoints are not weakened: the session header alone is refused", async () => {
  const s = await setup();
  const raw = JSON.stringify({ v: 2, agent: "claude-opus", action: "claim", issueNumber: 55, dispatchId: s.id, runId: "run-00000001" });
  const h = new Headers({ "x-agent-key": "claude-opus", "x-orch-session-token": OPUS_TOKEN, "x-timestamp": String(MS), "x-event-id": "evt-hmac-0001" });
  assert.equal((await handleCollaborationWorker(h, raw, s.deps())).status, 401);
  const g = await handleGate(h, JSON.stringify({ v: 2, agent: "claude-opus", issueNumber: 55 }), () => s.store, ENV, MS);
  assert.equal(g.status, 401);
  assert.equal((await s.store.read()).records[s.id].status, "dispatched", "nothing was claimed");
});

test("session gate/claim: task binding, replay, skew, wrong agent/dispatch, stale SHA", async () => {
  const s = await setup();
  const g = await s.call({ v: 1, action: "gate", agent: "claude-opus", issueNumber: 55 }, { eventId: "sess-gate-0001" });
  assert.equal(g.status, 200); assert.equal(g.json.allow, true); assert.equal(g.json.dispatchId, s.id);
  assert.equal(g.json.task.targetSha, A); assert.equal(g.json.task.workBranch, "claude/issue-55"); assert.equal(g.json.trust, "external_session");
  assert.equal((await s.call({ v: 1, action: "gate", agent: "claude-opus", issueNumber: 55 }, { eventId: "sess-gate-0001" })).status, 409, "replay");
  assert.equal((await s.call({ v: 1, action: "gate", agent: "claude-opus", issueNumber: 55 }, { ts: MS - 6 * 60_000 })).status, 401, "skew");
  assert.equal((await s.call({ v: 1, action: "gate", agent: "claude-sonnet", issueNumber: 55 })).status, 400, "body agent must equal token agent");
  assert.equal((await s.call({ v: 1, action: "gate", agent: "claude-opus", issueNumber: 99 })).json.reason, "no_authorized_dispatch");
  assert.equal((await s.call({ ...s.ctx, action: "claim", issueNumber: 99 })).json.error, "dispatch_mismatch");
  assert.equal((await s.call({ ...s.ctx, action: "claim", dispatchId: "w-other-1-claude" })).json.error, "dispatch_mismatch");
  assert.equal((await s.call({ ...s.ctx, action: "claim", targetSha: B })).json.error, "stale_target_sha");
  assert.equal((await s.call({ ...s.ctx, action: "claim", targetSha: "abc" })).status, 400);
  assert.equal((await s.call({ ...s.ctx, action: "claim", runId: "x" })).status, 400);
  assert.equal((await s.store.read()).records[s.id].status, "dispatched", "no rejected request claimed");
  const c = await s.call({ ...s.ctx, action: "claim" }, { eventId: "sess-claim-0001" });
  assert.equal(c.status, 200); assert.equal(c.json.record.runOrigin, "session"); assert.equal(c.json.record.status, "running");
  assert.equal((await s.call({ ...s.ctx, action: "claim" }, { eventId: "sess-claim-0001" })).status, 409, "replayed claim");
  assert.equal((await s.call({ ...s.ctx, action: "claim", runId: "session-run-0002" })).status, 409, "second writer refused");
  const audit = (await s.store.read()).audit.map(a => a.action);
  assert.ok(audit.includes("external_allowed"));
});

test("session runs: channel isolation, no quiescence claims, self-reported finish keeps the writer fence", async () => {
  const s = await setup();
  assert.equal((await s.call({ ...s.ctx, action: "claim" })).status, 200);
  assert.equal((await s.call({ ...s.ctx, action: "quiesce", quiescence: { reason: "lease_revoked", processGroupEmpty: true, signal: null } })).json.error, "unsupported_for_session");
  assert.equal((await s.call({ ...s.ctx, action: "cleanup_failed" })).json.error, "unsupported_for_session");
  // The HMAC runner channel cannot lease, quiesce or finish a session-claimed run.
  await assert.rejects(leaseCollaboration(s.store, s.id, "claude-opus", s.ctx.runId, NOW), /origin_mismatch/);
  await assert.rejects(quiesceCollaboration(s.store, s.id, "claude-opus", s.ctx.runId, { reason: "lease_revoked", processGroupEmpty: true, signal: null }, NOW), /origin_mismatch/);
  await assert.rejects(finishCollaboration(s.store, s.github, s.id, "claude-opus", s.ctx.runId,
    { exitCode: 0, headSha: B, summary: "x", tests: [{ command: "npm test", exitCode: 0 }], prNumber: 60, cleanup: { processGroupsEmpty: true, groups: 1 } }, NOW), /origin_mismatch/);
  const l = await s.call({ ...s.ctx, action: "lease" }, { eventId: "sess-lease-0001" });
  assert.equal(l.json.lease, "held");
  assert.equal((await s.call({ ...s.ctx, action: "lease" }, { eventId: "sess-lease-0001" })).status, 409, "replayed lease");
  assert.equal((await s.call({ ...s.ctx, action: "lease", runId: "session-run-9999" })).json.lease, "revoked");
  const res = { exitCode: 0, headSha: B, summary: "Implemented", tests: [{ command: "npm test", exitCode: 0 }], prNumber: 60 };
  assert.equal((await s.call({ ...s.ctx, action: "finish", result: { ...res, cleanup: { processGroupsEmpty: true, groups: 1 } } })).json.error, "invalid_result", "session cannot claim cleanup");
  s.pulls.set(60, { ...work, headSha: "c".repeat(40) });
  assert.equal((await s.call({ ...s.ctx, action: "finish", result: res })).json.error, "stale_or_unrelated_pr", "server verifies PR HEAD");
  s.pulls.set(60, work);
  const f = await s.call({ ...s.ctx, action: "finish", result: res });
  assert.equal(f.status, 200); assert.equal(f.json.workflow.stage, "codex");
  const again = await s.call({ ...s.ctx, action: "finish", result: res });
  assert.equal(again.status, 200, "lost-response resend with a new event id is idempotent");
  const rec = (await s.store.read()).records[s.id];
  assert.equal(rec.execution?.attestation, "external_session_self_report"); assert.equal(rec.execution?.cleanup, undefined);
  assert.equal(provablyQuiescent(rec), false, "a session result is never cleanup proof");
  // Codex review (HMAC runner) -> PM revise: the session writer is not provably quiescent, so recovery stays fenced.
  const review = f.json.workflow.dispatchId as string;
  await submitQueued(s.store, s.adapter, review, NOW);
  await claimCollaboration(s.store, review, "codex", "codex-run-0001", NOW);
  const w = await finishCollaboration(s.store, s.github, review, "codex", "codex-run-0001", { ...res, cleanup: { processGroupsEmpty: true, groups: 2 } }, NOW);
  assert.equal(w.stage, "pm");
  await assert.rejects(decideCollaboration(s.store, s.github, w.id, B, "revise", "fix it", NOW), /prior_execution_not_quiesced/);
});

test("session channel cannot drive a runner-claimed run; OFF and store failures fail closed", async () => {
  const s = await setup();
  await claimCollaboration(s.store, s.id, "claude-opus", "runner-run-0001", NOW);
  assert.equal((await s.call({ ...s.ctx, runId: "runner-run-0001", action: "lease" })).json.error, "origin_mismatch");
  assert.equal((await s.call({ ...s.ctx, runId: "runner-run-0001", action: "finish", result: { exitCode: 0, headSha: B, summary: "x", tests: [{ command: "t", exitCode: 0 }], prNumber: 60 } })).json.error, "origin_mismatch");

  const off = await setup();
  await off.store.transact(d => { d.control.agents["claude-opus"] = false; });
  const g = await off.call({ v: 1, action: "gate", agent: "claude-opus", issueNumber: 55 });
  assert.equal(g.json.allow, false); assert.equal(g.json.reason, "agent_disabled");
  assert.equal((await off.call({ ...off.ctx, action: "claim" })).json.error, "agent_disabled");
  await off.store.transact(d => { d.control.agents["claude-opus"] = true; d.control.claudeProvider = false; });
  assert.equal((await off.call({ ...off.ctx, action: "claim" })).status, 409, "provider switch off");
  assert.equal((await off.store.read()).records[off.id].status, "dispatched");

  const broken = { transact: async () => { throw new RunStoreConfigurationError("x"); }, read: async () => { throw new RunStoreConfigurationError("x"); } } as RunStore;
  const r = await off.call({ v: 1, action: "gate", agent: "claude-opus", issueNumber: 55 }, { deps: off.deps({ store: () => broken }) });
  assert.equal(r.status, 503); assert.equal(r.json.allow, undefined);
});
