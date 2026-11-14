import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentSecret, signCallback, verifyCallback } from "./callback-auth";
import { FileRunStore, MemoryRunStore, getRunStore, RunStoreConfigurationError } from "./store";
import { applyCallback, reconcile, recordSubmission, requestDispatch, retryDispatchRecord } from "./service";

const T = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
const NOW = Date.UTC(2026, 0, 1);
const body = '{"x":1}';
const sig = (s = "sec", ts = String(NOW), id = "evt-00001") => signCallback(s, ts, id, body);
const v = (o: Partial<Parameters<typeof verifyCallback>[0]> = {}) =>
  verifyCallback({ secret: "sec", timestamp: String(NOW), eventId: "evt-00001", signature: sig(), rawBody: body, nowMs: NOW, ...o });

test("auth: valid, tampered body, wrong secret, skew, missing secret, bad sig", () => {
  assert.equal(v().ok, true);
  assert.equal(v({ rawBody: '{"x":2}' }).ok, false);
  assert.equal(v({ signature: sig("other") }).ok, false);
  assert.equal(v({ nowMs: NOW + 6 * 60_000 }).ok, false);
  assert.deepEqual(v({ secret: undefined }), { ok: false, reason: "missing_secret" });
  assert.equal(v({ signature: "zz" }).ok, false);
  assert.equal(v({ signature: null }).ok, false);
  assert.equal(v({ eventId: "x" }).ok, false);
});

test("agentSecret is per-agent and env-only", () => {
  assert.equal(agentSecret("claude", { RUN_CALLBACK_SECRET_CLAUDE: "a" }), "a");
  assert.equal(agentSecret("codex", { RUN_CALLBACK_SECRET_CLAUDE: "a" }), undefined);
  assert.equal(agentSecret("../x", {}), undefined);
});

test("store fails closed without RUN_STORE_PATH", () => {
  assert.throws(() => getRunStore({}), RunStoreConfigurationError);
});

test("disabled routing creates no record", async () => {
  const s = new MemoryRunStore();
  assert.deepEqual(await requestDispatch(s, 1, "claude", T(0), false), { ok: false, reason: "disabled" });
  assert.equal(Object.keys((await s.read()).records).length, 0);
});

test("concurrent dispatch requests: exactly one wins", async () => {
  const s = new MemoryRunStore();
  const rs = await Promise.all(Array.from({ length: 10 }, () => requestDispatch(s, 1, "claude", T(0))));
  assert.equal(rs.filter((r) => r.ok).length, 1);
  assert.equal(Object.keys((await s.read()).records).length, 1);
});

test("callback replay is idempotent; wrong agent / unknown dispatch rejected", async () => {
  const s = new MemoryRunStore();
  const r = await requestDispatch(s, 1, "claude", T(0));
  assert.ok(r.ok);
  const id = r.ok ? r.record.dispatchId : "";
  await recordSubmission(s, id, "accepted", T(1));
  const a = await applyCallback(s, "evt-1", id, "claude", { type: "ack", at: T(2), runId: "r" }, T(2));
  assert.ok(a.ok && !a.duplicate);
  const dup = await applyCallback(s, "evt-1", id, "claude", { type: "finished", at: T(3), runId: "r", ok: true }, T(3));
  assert.ok(dup.ok && dup.duplicate);
  assert.equal((await s.read()).records[id].status, "acknowledged");
  assert.deepEqual(await applyCallback(s, "evt-2", id, "codex", { type: "heartbeat", at: T(4), runId: "r" }, T(4)), { ok: false, reason: "agent_mismatch" });
  assert.deepEqual(await applyCallback(s, "evt-3", "nope", "claude", { type: "ack", at: T(4), runId: "r" }, T(4)), { ok: false, reason: "unknown_dispatch" });
});

test("restart: file store persists records and replay IDs; reconcile times out stale", async () => {
  const f = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "runs-")), "s.json");
  const s1 = new FileRunStore(f);
  const r = await requestDispatch(s1, 2, "claude", T(0));
  const id = r.ok ? r.record.dispatchId : "";
  await recordSubmission(s1, id, "accepted", T(1));
  await applyCallback(s1, "evt-a", id, "claude", { type: "ack", at: T(2), runId: "r" }, T(2));
  const s2 = new FileRunStore(f); // "restart"
  assert.equal((await s2.read()).records[id].status, "acknowledged");
  const dup = await applyCallback(s2, "evt-a", id, "claude", { type: "started", at: T(3), runId: "r" }, T(3));
  assert.ok(dup.ok && dup.duplicate);
  assert.equal(await reconcile(s2, T(2 + 1000)), 1);
  assert.equal((await s2.read()).records[id].status, "timeout");
});

test("crash between persist and submit -> unknown timeout, no auto-resubmit/retry", async () => {
  const s = new MemoryRunStore();
  const r = await requestDispatch(s, 3, "claude", T(0));
  const id = r.ok ? r.record.dispatchId : "";
  await reconcile(s, T(1000));
  const rec = (await s.read()).records[id];
  assert.equal(rec.status, "timeout"); assert.equal(rec.submission, "unknown");
  assert.deepEqual(await retryDispatchRecord(s, 3, "claude", T(1001)), { ok: false, reason: "not_retryable" });
});

test("lost ACK (submission unknown) is not retried; known-not-accepted is retryable once", async () => {
  const s = new MemoryRunStore();
  const a = await requestDispatch(s, 4, "claude", T(0));
  const id = a.ok ? a.record.dispatchId : "";
  await recordSubmission(s, id, "unknown", T(1));
  assert.equal((await retryDispatchRecord(s, 4, "claude", T(2))).ok, false); // active
  await reconcile(s, T(1000));
  assert.equal((await retryDispatchRecord(s, 4, "claude", T(1001))).ok, false); // unknown -> no retry
  const b = await requestDispatch(s, 5, "claude", T(0));
  const id2 = b.ok ? b.record.dispatchId : "";
  await recordSubmission(s, id2, "rejected_not_accepted", T(1));
  const rt = await retryDispatchRecord(s, 5, "claude", T(2));
  assert.ok(rt.ok && rt.record.attempt === 2);
  assert.equal((await retryDispatchRecord(s, 5, "claude", T(3))).ok, false); // active now
});
