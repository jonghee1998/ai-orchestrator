import assert from "node:assert/strict";
import test from "node:test";
import { createRequestTracker, loadQueue } from "./loader";

const reply = (status: number, body: unknown) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

test("live: parses mode live with tasks", async () => {
  const s = await loadQueue(reply(200, { mode: "live", tasks: [{ id: "1", title: "t", agent: "claude", status: "status:ready", dependsOn: [], url: "" }] }));
  assert.equal(s.kind, "live");
  assert.equal(s.kind === "live" && s.res.tasks.length, 1);
});

test("unconfigured: stays a live-kind response with mode unconfigured", async () => {
  const s = await loadQueue(reply(200, { mode: "unconfigured", tasks: [] }));
  assert.equal(s.kind === "live" && s.res.mode, "unconfigured");
});

test("error: 502 body following contract is surfaced as mode error", async () => {
  const s = await loadQueue(reply(502, { mode: "error", tasks: [], error: "boom" }));
  assert.equal(s.kind === "live" && s.res.mode, "error");
  assert.equal(s.kind === "live" && s.res.error, "boom");
});

test("unavailable: network failure, bad body, HTTP error", async () => {
  const net = await loadQueue(async () => { throw new Error("offline"); });
  assert.deepEqual(net, { kind: "unavailable", reason: "offline" });
  const bad = await loadQueue(reply(200, { nope: 1 }));
  assert.equal(bad.kind === "unavailable" && bad.reason, "응답 형식이 계약과 다릅니다");
  const http = await loadQueue(reply(500, null));
  assert.equal(http.kind === "unavailable" && http.reason, "HTTP 500");
});

test("sample exit: a fresh request after invalidate is current (no stuck loading)", () => {
  const t = createRequestTracker();
  const first = t.next(); // mount
  t.invalidate(); // enter sample
  const refresh = t.next(); // exit sample -> refresh
  assert.equal(t.isCurrent(first), false);
  assert.equal(t.isCurrent(refresh), true);
});

test("stale response: older request is ignored once a newer one starts", () => {
  const t = createRequestTracker();
  const a = t.next();
  const b = t.next();
  assert.equal(t.isCurrent(a), false);
  assert.equal(t.isCurrent(b), true);
  t.invalidate(); // sample / unmount
  assert.equal(t.isCurrent(b), false);
});
