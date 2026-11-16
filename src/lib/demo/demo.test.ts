import assert from "node:assert/strict";
import test from "node:test";
import { demoBlockResponse, demoDecision } from "./gate";
import { demoState, FORBIDDEN_ENV } from "./mode";
import { demoRead } from "./respond";
import { demoDashboard, demoEvidence, demoQueue, demoRuns, DEMO_NOW } from "./fixtures";
import { handleDemoState } from "./state-http";

test("OFF unless DEMO_MODE=1 (production behavior unchanged)", () => {
  assert.deepEqual(demoState({}), { mode: "off" });
  assert.deepEqual(demoState({ DATABASE_URL: "x", VERCEL_ENV: "production" }), { mode: "off" });
  assert.equal(demoDecision(new Headers(), {}).demo, false);
  assert.equal(demoBlockResponse({ demo: false }, true), null);
});
test("fail closed: DEMO_MODE on production deployment", () => {
  const s = demoState({ DEMO_MODE: "1", VERCEL_ENV: "production" });
  assert.deepEqual(s, { mode: "blocked", reason: "demo_on_production_deployment" });
  const r = demoBlockResponse(demoDecision(new Headers(), { DEMO_MODE: "1", VERCEL_ENV: "production" }), false)!;
  assert.equal(r.status, 503);
});
test("fail closed: any real resource/secret env present (no production env inheritance)", () => {
  for (const k of [...FORBIDDEN_ENV, "RUN_CALLBACK_SECRET_CLAUDE_SONNET"]) {
    assert.equal(demoState({ DEMO_MODE: "1", VERCEL_ENV: "preview", [k]: "v" }).mode, "blocked", k);
  }
  assert.equal(demoState({ DEMO_MODE: "1", VERCEL_ENV: "preview", DATABASE_URL: "  " }).mode, "on"); // 빈 값은 미설정
});
test("ambiguous flag value blocks instead of enabling", () => {
  for (const v of ["true", "yes", "0", "on"]) assert.equal(demoState({ DEMO_MODE: v }).mode, "blocked", v);
});
test("demo ON (preview, no secrets): reads synthetic, every mutation rejected 403", () => {
  const env = { DEMO_MODE: "1", VERCEL_ENV: "preview" };
  assert.equal(demoState(env).mode, "on");
  const d = demoDecision(new Headers(), env);
  assert.equal(d.demo, true);
  assert.equal(demoBlockResponse(d, false), null);
  assert.equal(demoBlockResponse(d, true)!.status, 403);
});
test("scenario cookie selects scenario; invalid falls back to normal", () => {
  const env = { DEMO_MODE: "1" };
  assert.equal((demoDecision(new Headers({ cookie: "demo_scenario=empty" }), env) as any).scenario, "empty");
  assert.equal((demoDecision(new Headers({ cookie: "demo_scenario=evil" }), env) as any).scenario, "normal");
});
test("fixtures are deterministic and cover all states", () => {
  assert.deepEqual(demoDashboard("normal"), demoDashboard("normal"));
  const statuses = new Set<string>(demoRuns("normal").map((r) => r.status));
  for (const s of ["queued", "running", "succeeded", "failed", "timeout"]) assert.ok(statuses.has(s), s);
  assert.ok(demoRuns("normal").some((r) => r.lastError));
  const q = new Set(demoQueue("normal").map((t) => t.status));
  for (const s of ["backlog", "ready", "queued", "in-progress", "review", "done", "blocked"]) assert.ok(q.has(`status:${s}`), s);
  const codes = new Set(demoEvidence("normal").issues.map((i) => i.nextAction.code));
  for (const c of ["pm_review", "agent_revision", "done", "blocked"]) assert.ok(codes.has(c as any), c);
  assert.equal(demoRuns("empty").length, 0); assert.equal(demoQueue("empty").length, 0); assert.equal(demoEvidence("empty").issues.length, 0);
  assert.ok(demoQueue("normal").every((t) => t.title.startsWith("[DEMO]")));
  assert.equal(DEMO_NOW, "2026-01-15T03:30:00.000Z");
});
test("mock refresh: success, partial failure (some endpoints fail), total error", () => {
  const kinds = ["dashboard", "readiness", "runs", "work-queue", "evidence"] as const;
  assert.ok(kinds.every((k) => demoRead(k, "normal").status === 200));
  const part = Object.fromEntries(kinds.map((k) => [k, demoRead(k, "partial-failure").status]));
  assert.deepEqual(part, { dashboard: 200, readiness: 502, runs: 200, "work-queue": 502, evidence: 502 });
  assert.ok(kinds.every((k) => demoRead(k, "error").status === 500));
});
test("/api/demo: off → demo:false; blocked → 503; POST sets non-sensitive scenario cookie only", () => {
  assert.deepEqual(handleDemoState("GET", new Headers(), "", {}).body, { demo: false });
  assert.equal(handleDemoState("GET", new Headers(), "", { DEMO_MODE: "1", VERCEL_ENV: "production" }).status, 503);
  const r = handleDemoState("POST", new Headers({ host: "a", origin: "https://a" }), JSON.stringify({ scenario: "partial-failure" }), { DEMO_MODE: "1" });
  assert.match(r.setCookie!, /^demo_scenario=partial-failure;/);
  assert.equal(handleDemoState("POST", new Headers({ host: "a", origin: "https://evil" }), "{}", { DEMO_MODE: "1" }).status, 403);
});
