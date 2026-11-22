// Run after npm run build. All credentials/state are random, disposable and local to each server.
import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
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
  const password = random(), username = random(), token = random();
  const hash = await hashPassword(password);
  const socket = createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const env = { PATH: process.env.PATH, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", ADMIN_USERNAME: username, ADMIN_PASSWORD_HASH: hash, CONTROL_ADMIN_TOKEN: token, ...extra };
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
    return { request, base, close, tmp, password, username, token, hash };
  } catch (e) { await close(); throw e; }
}
const post = (body, headers = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const cookie = r => r.headers.get("set-cookie").split(";")[0];

test("real HTTP: password login, browser/persistent session, logout/CSRF, /api/orch authentication and rate limit", async () => {
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
    assert.equal((await s.request("/api/orch")).status, 401);
    const orch = await s.request("/api/orch", { headers: { cookie: h.cookie } });
    assert.equal(orch.status, 200); assert.equal(orch.body.mode, "unconfigured");
    assert.equal((await s.request("/api/orch", post({}, { cookie: h.cookie }))).status, 403);
    assert.equal((await s.request("/api/orch", post({}, { ...h, origin: "https://evil.example" }))).status, 403);
    const authed = await s.request("/api/orch", post({}, h)); // passes auth+CSRF, then fails validation
    assert.equal(authed.status, 400); assert.equal(authed.body.error, "unknown_repo");
    const admin = await s.request("/api/orch", post({}, { "x-admin-token": s.token }));
    assert.equal(admin.status, 400); assert.equal(admin.body.error, "unknown_repo");
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
