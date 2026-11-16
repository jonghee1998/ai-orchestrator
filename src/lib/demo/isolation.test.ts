import assert from "node:assert/strict";
import test from "node:test";
import { handleCollaboration, type Dependencies } from "../runs/collaboration-http";
import { demoReadResponse, demoRequestBlock } from "./respond-http";
import { demoRead, type DemoKind } from "./respond";
import { parseWorkflows } from "../../components/progress/viewModel";
import { SCENARIOS } from "./mode";
const env = { DEMO_MODE: "1", CONTROL_ADMIN_TOKEN: "demo-only-internal-test-token" };
const H = (scenario = "normal") => new Headers({ "x-admin-token": env.CONTROL_ADMIN_TOKEN, cookie: `demo_scenario=${scenario}` });
const kinds: DemoKind[] = ["dashboard", "readiness", "runs", "work-queue", "evidence", "collaboration"];

test("#86 collaboration: every demo scenario returns fixtures without accessing store, GitHub or agent", async () => {
  let effects = 0;
  const accessed = (): never => { effects++; throw new Error("real dependency accessed in demo"); };
  const deps: Dependencies = { env, nowMs: 0, get store() { return accessed(); }, get github() { return accessed(); }, get adapter() { return accessed(); } };
  for (const scenario of SCENARIOS) {
    const r = await handleCollaboration("GET", H(scenario), "", deps);
    assert.deepEqual({ status: r.status, body: JSON.parse(r.body) }, demoRead("collaboration", scenario));
    if (r.status === 200) {
      const workflows = parseWorkflows(r.status, JSON.parse(r.body));
      assert.ok(Array.isArray(workflows));
      assert.equal(workflows.length, scenario === "empty" ? 0 : 1);
      if (workflows[0]) assert.equal(workflows[0].id, "demo-workflow-902");
    }
  }
  assert.equal((await handleCollaboration("POST", H(), '{"action":"submit","dispatchId":"demo-2"}', deps)).status, 403);
  assert.equal((await handleCollaboration("GET", H(), "", { env: { ...env, VERCEL_ENV: "production" }, nowMs: 0, store: accessed, github: new Proxy({} as Dependencies["github"], { get: accessed }), adapter: new Proxy({} as Dependencies["adapter"], { get: accessed }) })).status, 503);
  assert.equal(effects, 0);
});

test("every read API selects fixtures; misconfigured demo fails closed at Node runtime", async () => {
  for (const kind of kinds) {
    for (const scenario of SCENARIOS) {
      const req = new Request(`https://app.example/api/${kind}`, { headers: H(scenario) });
      const r = demoReadResponse(req, kind, env)!;
      assert.equal(r.headers.get("X-Demo"), "1");
      assert.equal(r.status, demoRead(kind, scenario).status);
      assert.deepEqual(await r.json(), JSON.parse(JSON.stringify(demoRead(kind, scenario).body)));
      for (const e of [{ ...env, VERCEL_ENV: "production" }, { ...env, DATABASE_URL: "postgres://unused" }, { ...env, GITHUB_TOKEN: "must-not-be-used" }, { ...env, DEMO_MODE: "yes" }]) {
        const blocked = demoReadResponse(req, kind, e)!;
        assert.equal(blocked.status, 503);
        assert.equal((await blocked.json()).error, "demo_misconfigured");
      }
    }
  }
});

test("runtime barrier blocks all data mutations and cron GET; off mode preserves existing APIs", () => {
  for (const path of ["control", "dispatch", "reconcile", "collaboration", "collaboration/worker", "collaboration/session", "gate", "runs/callback"]) {
    const req = new Request(`https://app.example/api/${path}`, { method: "POST" });
    assert.equal(demoRequestBlock(req, env)!.status, 403);
    assert.equal(demoRequestBlock(req, { ...env, VERCEL_ENV: "production" })!.status, 503);
    assert.equal(demoRequestBlock(req, {}) , null);
  }
  assert.equal(demoRequestBlock(new Request("https://app.example/api/reconcile"), env)!.status, 403);
  assert.equal(demoReadResponse(new Request("https://app.example/api/collaboration"), "collaboration", {}), null);
});
