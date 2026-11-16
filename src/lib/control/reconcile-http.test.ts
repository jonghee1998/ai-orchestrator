import assert from "node:assert/strict";
import test from "node:test";
import { handleReconcile } from "./reconcile-http";
import { cookieName, csrfToken, issueSession } from "../session/session";
const env = { NODE_ENV: "production", CONTROL_ADMIN_TOKEN: "test-admin-token-long-value", CONTROL_READ_TOKEN: "test-read-token-long-value", CRON_SECRET: "test-cron-secret-long-value" };
const NOW = 1_800_000_000_000;
const session = issueSession("admin", env, NOW)!;
const H = (extra: Record<string, string> = {}) => new Headers({ host: "app.example", origin: "https://app.example", ...extra });
const cookie = `${cookieName(env)}=${session.value}`;

test("#86: cookie GET reconciliation never executes, even with a valid CSRF token", async () => {
  let calls = 0;
  const run = async () => { calls++; return { status: 200, body: { ok: true } }; };
  for (const h of [H({ cookie }), H({ cookie, "x-csrf-token": csrfToken(session.session, env) }), H()]) {
    assert.equal((await handleReconcile("GET", h, env, NOW, run)).status, 401);
  }
  assert.equal(calls, 0);
});
test("#86: cookie POST reconciliation executes only with valid same-origin CSRF and admin role", async () => {
  let calls = 0;
  const run = async () => { calls++; return { status: 200, body: { ok: true } }; };
  const csrf = csrfToken(session.session, env);
  for (const h of [H({ cookie }), H({ cookie, "x-csrf-token": "bad" }), H({ cookie, "x-csrf-token": csrf, origin: "https://evil.example" })]) assert.equal((await handleReconcile("POST", h, env, NOW, run)).status, 403);
  const read = issueSession("read", env, NOW)!;
  assert.equal((await handleReconcile("POST", H({ cookie: `${cookieName(env)}=${read.value}`, "x-csrf-token": csrfToken(read.session, env) }), env, NOW, run)).status, 403);
  assert.equal(calls, 0);
  assert.equal((await handleReconcile("POST", H({ cookie, "x-csrf-token": csrf }), env, NOW, run)).status, 200);
  assert.equal(calls, 1);
});
test("explicit admin-header and cron GET compatibility; invalid credentials never invoke runner", async () => {
  let calls = 0;
  const run = async () => { calls++; return { status: 200, body: {} }; };
  for (const h of [H({ "x-admin-token": env.CONTROL_ADMIN_TOKEN }), H({ authorization: `Bearer ${env.CRON_SECRET}` })]) assert.equal((await handleReconcile("GET", h, env, NOW, run)).status, 200);
  for (const h of [H({ "x-admin-token": "bad", cookie }), H({ authorization: "Bearer bad", cookie }), H({ "x-admin-token": env.CONTROL_READ_TOKEN })]) assert.equal((await handleReconcile("GET", h, env, NOW, run)).status, 401);
  assert.equal(calls, 2);
  for (const e of [{ ...env, DEMO_MODE: "1" }, { ...env, DEMO_MODE: "1", VERCEL_ENV: "production" }]) assert.ok([403, 503].includes((await handleReconcile("GET", H({ "x-admin-token": env.CONTROL_ADMIN_TOKEN }), e, NOW, run)).status));
  assert.equal(calls, 2);
});
