// Run after npm run build. All credentials/state are random, disposable and local to each server.
import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
const random = () => randomBytes(24).toString("hex");
async function hashPassword(password) {
  const child = spawn(process.execPath, ["scripts/hash-admin-password.mjs"], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", c => { out += c; }); child.stderr.on("data", c => { err += c; });
  child.stdin.end(password);
  const [code] = await once(child, "exit");
  assert.equal(code, 0, err);
  return out.trim();
}
async function server(extra = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "orch-login-smoke-"));
  const password = random(), username = random(), token = random(), cron = random();
  const hash = await hashPassword(password);
  const socket = createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const env = { PATH: process.env.PATH, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", ADMIN_USERNAME: username, ADMIN_PASSWORD_HASH: hash, CONTROL_ADMIN_TOKEN: token, CRON_SECRET: cron, RUN_STORE_PATH: path.join(tmp, "store.json"), ...extra };
  // Demo must never inherit even a local store or cron. These are generated test values, not deployment secrets.
  if (env.DEMO_MODE) { delete env.RUN_STORE_PATH; delete env.CRON_SECRET; }
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", c => { log += c; }); child.stderr.on("data", c => { log += c; });
  const base = `http://127.0.0.1:${port}`;
  const request = async (url, options = {}) => {
    const r = await fetch(base + url, { ...options, headers: { origin: `https://127.0.0.1:${port}`, ...options.headers } });
    return { status: r.status, headers: r.headers, body: await r.json() };
  };
  const close = async () => {
    if (child.exitCode === null) {
      const exited = once(child, "exit"); child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exited; clearTimeout(timer);
    }
    await rm(tmp, { recursive: true, force: true });
  };
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(`test server exited: ${log}`);
      try { if ((await request("/api/session")).status === 200) { ready = true; break; } } catch { /* startup */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, "test server did not become ready");
    return { request, base, close, tmp, password, username, token, cron, hash };
  } catch (e) { await close(); throw e; }
}
const dataPaths = ["dashboard", "readiness", "runs", "work-queue", "evidence", "collaboration"];
const mutations = ["control", "dispatch", "reconcile", "collaboration", "collaboration/worker", "collaboration/session", "gate", "runs/callback"];
const post = (body, headers = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const cookie = r => r.headers.get("set-cookie").split(";")[0];

test("real HTTP: password login, browser/persistent session, logout/CSRF, reconcile authentication and rate limit", async () => {
  const s = await server();
  try {
    const credentials = { username: s.username, password: s.password };
    assert.equal((await s.request("/api/session")).body.authenticated, false);
    assert.equal((await s.request("/api/session", post(credentials, { origin: "https://evil.example" }))).status, 403);
    const r = await s.request("/api/session", post(credentials));
    assert.equal(r.status, 200); assert.equal(r.body.role, "admin");
    const set = r.headers.get("set-cookie");
    for (const attr of ["__Host-orch_session=", "HttpOnly", "Secure", "SameSite=Strict"]) assert.ok(set.includes(attr));
    assert.ok(!/Max-Age|Expires=/.test(set));
    for (const secret of [s.password, s.token, s.hash]) assert.ok(!JSON.stringify(r.body).includes(secret) && !set.includes(secret));
    const h = { cookie: cookie(r), "x-csrf-token": r.body.csrfToken };
    assert.equal((await s.request("/api/session", { headers: h })).body.authenticated, true);
    const before = await readFile(path.join(s.tmp, "store.json"), "utf8").catch(() => null);
    assert.equal((await s.request("/api/reconcile", { headers: h })).status, 401);
    assert.equal(await readFile(path.join(s.tmp, "store.json"), "utf8").catch(() => null), before, "cookie GET must not initialize or mutate store");
    assert.equal((await s.request("/api/reconcile", post({}, { cookie: h.cookie }))).status, 403);
    assert.equal((await s.request("/api/reconcile", post({}, { ...h, origin: "https://evil.example" }))).status, 403);
    assert.equal((await s.request("/api/reconcile", post({}, h))).status, 200);
    assert.equal((await s.request("/api/reconcile", { headers: { "x-admin-token": s.token } })).status, 200);
    assert.equal((await s.request("/api/reconcile", { headers: { authorization: `Bearer ${s.cron}` } })).status, 200);
    assert.equal((await s.request("/api/session", { method: "DELETE", headers: { cookie: h.cookie } })).status, 403);
    const out = await s.request("/api/session", { method: "DELETE", headers: h });
    assert.equal(out.status, 200); assert.ok(out.headers.get("set-cookie").includes("Max-Age=0"));
    assert.equal((await s.request("/api/session", { headers: { cookie: cookie(out) } })).body.authenticated, false);
    const persistent = await s.request("/api/session", post({ ...credentials, remember: true }));
    assert.equal(persistent.status, 200); assert.ok(persistent.headers.get("set-cookie").includes("Max-Age=2592000"));
    const forged = cookie(persistent) + "x";
    assert.equal((await s.request("/api/session", { headers: { cookie: forged } })).body.authenticated, false);
    // #122: anonymous malformed junk and successful logins do not consume the budget; only wrong credentials do.
    for (let i = 0; i < 20; i++) assert.equal((await s.request("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: "{" })).status, 400);
    for (let i = 0; i < 5; i++) assert.equal((await s.request("/api/session", post({ username: `wrong-${i}`, password: "wrong" }))).status, 401);
    const limited = await s.request("/api/session", post(credentials, { "x-forwarded-for": "192.0.2.42" }));
    assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get("retry-after")) > 0);
    assert.equal(limited.headers.get("set-cookie"), null);
  } finally { await s.close(); }
});

test("real HTTP: legacy Host-only token exchange works; cross-origin/password Host-only rejected; flood does not lock owner", async () => {
  const s = await server();
  try {
    // Node fetch sends only Host (no Origin / Sec-Fetch-Site), like curl-based legacy scripts.
    const raw = async (body, headers = {}) => { const r = await fetch(s.base + "/api/session", { method: "POST", headers: { "content-type": "application/json", ...headers }, body }); return { status: r.status, set: r.headers.get("set-cookie") }; };
    for (let i = 0; i < 20; i++) assert.equal((await raw("{")).status, 403); // junk never reaches the login budget
    const ok = await raw(JSON.stringify({ token: s.token }));
    assert.equal(ok.status, 200); assert.ok(ok.set.includes("HttpOnly"));
    assert.equal((await raw(JSON.stringify({ token: s.token }), { origin: "https://evil.example" })).status, 403);
    assert.equal((await raw(JSON.stringify({ username: s.username, password: s.password }))).status, 403);
    assert.equal((await s.request("/api/session", post({ username: s.username, password: s.password }))).status, 200);
  } finally { await s.close(); }
});

test("real HTTP: all demo reads/scenarios are synthetic; all mutation endpoints and cron GET stay blocked", async () => {
  const s = await server({ DEMO_MODE: "1", VERCEL_ENV: "preview" });
  try {
    const r = await s.request("/api/session", post({ username: s.username, password: s.password }));
    assert.equal(r.status, 200);
    const h = { cookie: cookie(r), "x-csrf-token": r.body.csrfToken, "x-admin-token": s.token };
    for (const scenario of ["normal", "empty", "partial-failure", "error"]) {
      const selected = await s.request("/api/demo", post({ scenario }));
      assert.equal(selected.status, 200);
      const headers = { ...h, cookie: h.cookie + "; " + cookie(selected) };
      for (const path of dataPaths) {
        const reply = await s.request(`/api/${path}`, { headers });
        assert.equal(reply.headers.get("x-demo"), "1", path);
        const partialFails = ["readiness", "work-queue", "evidence"].includes(path);
        assert.equal(reply.status, scenario === "error" ? 500 : scenario === "partial-failure" && partialFails ? 502 : 200, `${path}/${scenario}`);
        if (path === "collaboration" && reply.status === 200) {
          assert.equal(reply.body.workflows.length, scenario === "empty" ? 0 : 1);
          if (reply.body.workflows[0]) assert.equal(reply.body.workflows[0].assignment.repo, "demo/synthetic");
        }
      }
    }
    for (const path of mutations) {
      const r = await s.request(`/api/${path}`, post({}, h));
      assert.equal(r.status, 403, path); assert.equal(r.body.error, "demo_read_only");
    }
    assert.equal((await s.request("/api/reconcile", { headers: h })).status, 403);
    assert.equal(await readFile(path.join(s.tmp, "store.json"), "utf8").catch(() => null), null);
  } finally { await s.close(); }
});

test("real HTTP: production demo and real-resource demo configurations fail closed", async () => {
  for (const extra of [{ VERCEL_ENV: "production" }, { DATABASE_URL: "postgresql://unused.invalid/test" }, { GITHUB_TOKEN: "test-only-must-not-be-used" }]) {
    const s = await server({ DEMO_MODE: "1", ...extra });
    try {
      for (const path of dataPaths) assert.equal((await s.request(`/api/${path}`, { headers: { "x-admin-token": s.token } })).status, 503, path);
      for (const path of mutations) assert.equal((await s.request(`/api/${path}`, post({}, { "x-admin-token": s.token }))).status, 503, path);
      assert.equal((await s.request("/api/reconcile", { headers: { "x-admin-token": s.token } })).status, 503);
    } finally { await s.close(); }
  }
});
