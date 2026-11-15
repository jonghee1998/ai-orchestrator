import assert from "node:assert/strict";
import test from "node:test";
import { createRequestTracker, loadQueue as load } from "./loader";

const TOKEN = "reader-token-0123456789";
const loadQueue = (f: Parameters<typeof load>[0]) => load(f, TOKEN);

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

// #65 regression: /tasks returned HTTP 401 with a valid admin token because the loader sent no auth header.
test("#65: sends the tab token as x-admin-token to the same read endpoint", async () => {
  const calls: { url: string; headers?: Record<string, string> }[] = [];
  const s = await load(async (url, init) => { calls.push({ url, headers: init?.headers }); return { ok: true, status: 200, json: async () => ({ mode: "live", tasks: [] }) }; }, `  ${TOKEN} `);
  assert.equal(s.kind, "live");
  assert.deepEqual(calls, [{ url: "/api/work-queue", headers: { "x-admin-token": TOKEN } }]);
});
test("#65: no token -> notoken without any request; 401 -> unauth (never 'HTTP 401' unavailable)", async () => {
  let n = 0;
  const none = await load(async () => { n++; return { ok: true, status: 200, json: async () => ({}) }; }, "   ");
  assert.deepEqual(none, { kind: "notoken" }); assert.equal(n, 0);
  const denied = await load(reply(401, { error: "unauthorized" }), TOKEN);
  assert.deepEqual(denied, { kind: "unauth" });
});
