import assert from "node:assert/strict";
import test from "node:test";
import { applyEvent, createDispatch, displayStatus, evaluateTimeout, latencies, requestDispatch, retryDispatch } from "./run-tracking";

const T = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
const dispatched = () => applyEvent(createDispatch(16, "claude", T(0)), { type: "dispatched", at: T(1) });

test("happy path: dispatched -> ack -> running -> succeeded with evidence", () => {
  let r = dispatched();
  r = applyEvent(r, { type: "ack", at: T(3), runId: "run-1" });
  r = applyEvent(r, { type: "started", at: T(5), runId: "run-1" });
  r = applyEvent(r, { type: "heartbeat", at: T(20), runId: "run-1" });
  r = applyEvent(r, { type: "finished", at: T(30), runId: "run-1", ok: true, evidence: [{ kind: "pr", url: "https://x/pr/1", at: T(30) }] });
  assert.equal(r.status, "succeeded");
  assert.equal(r.evidence.length, 1);
  assert.deepEqual(latencies(r), { ackMs: 2000, startMs: 2000 });
});

test("dispatched without ACK displays unknown, never running", () => {
  assert.equal(displayStatus(dispatched()), "unknown");
});

test("ACK timeout and heartbeat timeout", () => {
  assert.equal(evaluateTimeout(dispatched(), T(1 + 301)).status, "timeout");
  assert.equal(evaluateTimeout(dispatched(), T(1 + 299)).status, "dispatched");
  let r = applyEvent(applyEvent(dispatched(), { type: "ack", at: T(2), runId: "a" }), { type: "started", at: T(3), runId: "a" });
  assert.equal(evaluateTimeout(r, T(3 + 901)).lastError, "heartbeat timeout");
});

test("out-of-order, duplicate, wrong-run and post-terminal events are ignored", () => {
  const d = dispatched();
  assert.equal(applyEvent(d, { type: "heartbeat", at: T(2), runId: "a" }), d);
  assert.equal(applyEvent(d, { type: "finished", at: T(2), runId: "a", ok: true }), d);
  const a = applyEvent(d, { type: "ack", at: T(2), runId: "a" });
  assert.equal(applyEvent(a, { type: "ack", at: T(3), runId: "b" }), a);
  assert.equal(applyEvent(a, { type: "started", at: T(3), runId: "b" }), a);
  const f = applyEvent(a, { type: "finished", at: T(4), runId: "a", ok: false, error: "boom" });
  assert.equal(f.status, "failed");
  assert.equal(applyEvent(f, { type: "heartbeat", at: T(5), runId: "a" }), f);
});

test("duplicate prevention and explicit retry", () => {
  const first = requestDispatch([], 16, "claude", T(0));
  assert.ok(first.ok);
  if (!first.ok) return;
  assert.equal(requestDispatch([first.record], 16, "claude", T(1)).ok, false);
  assert.deepEqual(retryDispatch([first.record], 16, "claude", T(2)), { ok: false, reason: "active_dispatch_exists" });
  const timedOut = evaluateTimeout(applyEvent(first.record, { type: "dispatched", at: T(1) }), T(1000));
  const retry = retryDispatch([timedOut], 16, "claude", T(1001));
  assert.ok(retry.ok && retry.record.attempt === 2 && retry.record.dispatchId === "d-16-claude-2");
});
