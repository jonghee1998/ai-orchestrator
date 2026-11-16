// #122 login admission regression tests: anonymous flood, owner login, throttling, legacy Host-only, CSRF, concurrency, expiry.
import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, scryptSync } from "node:crypto";
import { handleSession } from "./http";
import { clientKey, LoginLimiter, LOGIN_ATTEMPTS, LOGIN_GLOBAL_ATTEMPTS, LOGIN_MAX_CLIENTS, LOGIN_WINDOW_MS, UNATTRIBUTED } from "./rate-limit";
import { legacyHostOnly, sameOrigin } from "./session";
import { PASSWORD_PREFIX } from "./password";

const PASSWORD = "admission test password";
const salt = randomBytes(16);
const hash = PASSWORD_PREFIX + salt.toString("hex") + "$" + scryptSync(PASSWORD, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }).toString("hex");
const TOKEN = "admission-admin-token-0123456789";
const env = { NODE_ENV: "production", ADMIN_USERNAME: "owner-admission", ADMIN_PASSWORD_HASH: hash, CONTROL_ADMIN_TOKEN: TOKEN, CONTROL_READ_TOKEN: "admission-read-token-0123456789" };
const NOW = 1_800_000_000_000;
const browser = (extra: Record<string, string> = {}) => new Headers({ host: "app.example", origin: "https://app.example", ...extra });
const hostOnly = (extra: Record<string, string> = {}) => new Headers({ host: "app.example", ...extra });
const good = JSON.stringify({ username: env.ADMIN_USERNAME, password: PASSWORD });
const bad = JSON.stringify({ username: env.ADMIN_USERNAME, password: "wrong" });
const post = (h: Headers, raw: string, l: LoginLimiter, e: Record<string, string | undefined> = env, t = NOW) => handleSession("POST", h, raw, e, t, l);

test("anonymous malformed/oversized/cross-origin flood does not consume the owner's login budget", async () => {
  const l = new LoginLimiter();
  for (let i = 0; i < 200; i++) {
    for (const [h, raw] of [[browser(), "{"], [browser(), "null"], [browser(), "[]"], [browser(), "x".repeat(5000)], [browser(), JSON.stringify({ username: [], password: 1 })],
      [browser({ origin: "https://evil.example" }), good], [hostOnly(), good], [hostOnly(), "{"], [hostOnly(), "garbage"]] as const) {
      const r = await post(h, raw, l);
      assert.ok([400, 403, 413].includes(r.status), `${r.status}`);
    }
  }
  const ok = await post(browser(), good, l);
  assert.equal(ok.status, 200); assert.ok(ok.setCookie);
});

test("valid owner login (password and legacy token) is never counted against the failure budget", async () => {
  const l = new LoginLimiter();
  for (let i = 0; i < LOGIN_ATTEMPTS * 3; i++) assert.equal((await post(browser(), i % 2 ? good : JSON.stringify({ token: TOKEN }), l)).status, 200);
});

test("wrong-password throttling: five failures then 429 with Retry-After, even for the right password; expiry resets", async () => {
  const l = new LoginLimiter();
  for (let i = 0; i < LOGIN_ATTEMPTS; i++) assert.equal((await post(browser(), bad, l, env, NOW + i)).status, 401);
  const blocked = await post(browser(), good, l, env, NOW + 1000);
  assert.equal(blocked.status, 429); assert.equal(blocked.setCookie, undefined); assert.equal(blocked.retryAfter, 899);
  assert.equal((await post(browser(), JSON.stringify({ token: "nope" }), l, env, NOW + LOGIN_WINDOW_MS - 1)).status, 429);
  assert.equal((await post(browser(), good, l, env, NOW + LOGIN_WINDOW_MS)).status, 200); // window expired
  // a fresh window counts failures from zero again
  for (let i = 0; i < LOGIN_ATTEMPTS; i++) assert.equal((await post(browser(), bad, l, env, NOW + LOGIN_WINDOW_MS + 5 + i)).status, 401);
  assert.equal((await post(browser(), bad, l, env, NOW + LOGIN_WINDOW_MS + 100)).status, 429);
});

test("wrong legacy tokens are throttled too", async () => {
  const l = new LoginLimiter();
  for (let i = 0; i < LOGIN_ATTEMPTS; i++) assert.equal((await post(hostOnly(), JSON.stringify({ token: `bad-${i}` }), l)).status, 401);
  assert.equal((await post(hostOnly(), JSON.stringify({ token: TOKEN }), l)).status, 429);
});

test("an attacker's failures do not lock out the owner when the platform proxy header attributes clients", async () => {
  const e = { ...env, VERCEL: "1" };
  const l = new LoginLimiter();
  for (let i = 0; i < LOGIN_ATTEMPTS; i++) assert.equal((await post(browser({ "x-vercel-forwarded-for": "203.0.113.9" }), bad, l, e)).status, 401);
  assert.equal((await post(browser({ "x-vercel-forwarded-for": "203.0.113.9" }), bad, l, e)).status, 429);
  assert.equal((await post(browser({ "x-vercel-forwarded-for": "198.51.100.7" }), good, l, e)).status, 200);
});

test("global ceiling bounds distributed guessing; per-client map is memory-bounded", () => {
  const l = new LoginLimiter();
  let allowed = 0;
  for (let i = 0; i < LOGIN_GLOBAL_ATTEMPTS + 20; i++) if (l.take(NOW, `10.0.${i >> 8}.${i & 255}`).allowed) allowed++;
  assert.equal(allowed, LOGIN_GLOBAL_ATTEMPTS);
  const m = new LoginLimiter();
  for (let i = 0; i < LOGIN_MAX_CLIENTS + 500; i++) m.take(NOW + i * LOGIN_WINDOW_MS, `k${i}`).release?.("refund");
  assert.ok((m as any).clients.size <= LOGIN_MAX_CLIENTS);
});

test("forwarded headers are not trusted: spoofing x-forwarded-for / x-real-ip / forwarded cannot rotate buckets", async () => {
  for (const e of [env, { ...env, VERCEL: "1" }]) {
    const l = new LoginLimiter();
    for (let i = 0; i < LOGIN_ATTEMPTS; i++) {
      const h = browser({ "x-forwarded-for": `192.0.2.${i}`, "x-real-ip": `192.0.2.${i}`, forwarded: `for=192.0.2.${i}` });
      assert.equal((await post(h, bad, l, e)).status, 401);
    }
    assert.equal((await post(browser({ "x-forwarded-for": "192.0.2.200" }), bad, l, e)).status, 429);
  }
  assert.equal(clientKey(browser({ "x-vercel-forwarded-for": "203.0.113.9" }), env), UNATTRIBUTED); // not on a trusted platform
  assert.equal(clientKey(browser({ "x-vercel-forwarded-for": "203.0.113.9" }), { VERCEL: "1" }), "203.0.113.9");
  assert.equal(clientKey(browser({ "x-vercel-forwarded-for": "not-an-ip" }), { VERCEL: "1" }), UNATTRIBUTED);
  assert.equal(clientKey(browser(), { LOGIN_TRUST_PROXY: "vercel" }), UNATTRIBUTED);
});

test("legacy Host-only: token exchange works without Origin/Sec-Fetch-Site; password login, logout and any cross-origin evidence do not", async () => {
  const token = JSON.stringify({ token: TOKEN });
  const ok = await post(hostOnly(), token, new LoginLimiter());
  assert.equal(ok.status, 200); assert.match(ok.setCookie!, /HttpOnly/); assert.match(ok.setCookie!, /SameSite=Strict/);
  assert.equal((await post(hostOnly({ "sec-fetch-site": "same-origin" }), token, new LoginLimiter())).status, 200);
  for (const h of [hostOnly({ origin: "https://evil.example" }), hostOnly({ origin: "null" }), hostOnly({ "sec-fetch-site": "cross-site" }), hostOnly({ "sec-fetch-site": "same-site" }),
    hostOnly({ origin: "http://app.example" }), hostOnly({ origin: "https://evil.example", "x-forwarded-host": "app.example" }), new Headers({ origin: "https://app.example" })]) {
    const r = await post(h, token, new LoginLimiter());
    assert.equal(r.status, 403, JSON.stringify([...h])); assert.equal(r.setCookie, undefined);
  }
  assert.equal((await post(hostOnly(), good, new LoginLimiter())).status, 403);           // password path stays strict
  assert.equal((await post(hostOnly(), JSON.stringify({ token: TOKEN, password: "x" }), new LoginLimiter())).status, 403);
  assert.equal((await handleSession("DELETE", hostOnly(), "", env, NOW)).status, 403);     // logout stays strict
  assert.equal(legacyHostOnly(hostOnly()), true); assert.equal(sameOrigin(hostOnly(), env), false);
  assert.equal(legacyHostOnly(new Headers()), false);
});

test("browser same-origin and cross-origin handling is unchanged", async () => {
  assert.equal((await post(browser(), good, new LoginLimiter())).status, 200);
  assert.equal((await post(browser({ origin: "https://evil.example" }), good, new LoginLimiter())).status, 403);
  assert.equal((await post(browser({ "sec-fetch-site": "cross-site" }), good, new LoginLimiter())).status, 403);
  assert.equal((await handleSession("DELETE", browser({ origin: "https://evil.example" }), "", env, NOW)).status, 403);
  assert.equal((await handleSession("DELETE", browser(), "", env, NOW)).status, 200);
});

test("concurrency: parallel failures cannot exceed the per-client budget; refunds never go negative or cross windows", async () => {
  const l = new LoginLimiter();
  const r = await Promise.all(Array.from({ length: 12 }, () => post(browser(), bad, l)));
  assert.equal(r.filter(x => x.status === 401).length, LOGIN_ATTEMPTS);
  assert.equal(r.filter(x => x.status === 429).length, 12 - LOGIN_ATTEMPTS);
  const m = new LoginLimiter();
  const a = m.take(NOW);
  const later = NOW + LOGIN_WINDOW_MS;
  const b = m.take(later); // new window
  a.release?.("refund"); a.release?.("refund");
  for (let i = 1; i < LOGIN_ATTEMPTS; i++) assert.ok(m.take(later).allowed);
  assert.equal(m.take(later).allowed, false); // stale refund did not erase the new window's reservation
  b.release?.("refund"); assert.ok(m.take(later).allowed);
});
