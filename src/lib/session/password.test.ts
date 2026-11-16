import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, scryptSync } from "node:crypto";
import { passwordConfigured, verifyPassword, PASSWORD_PREFIX } from "./password";
import { handleSession } from "./http";
import { LoginLimiter, LOGIN_ATTEMPTS, LOGIN_WINDOW_MS } from "./rate-limit";
import { authorize } from "./guard";
import { BROWSER_SESSION_TTL_SEC, cookieName, issueSession, SESSION_TTL_SEC, verifySession } from "./session";
const PASSWORD = "test-only password with spaces!";
const salt = randomBytes(16);
const hash = PASSWORD_PREFIX + salt.toString("hex") + "$" + scryptSync(PASSWORD, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }).toString("hex");
const env = { NODE_ENV: "production", ADMIN_USERNAME: "owner-test", ADMIN_PASSWORD_HASH: hash, CONTROL_ADMIN_TOKEN: "test-internal-admin-token-long", CONTROL_READ_TOKEN: "test-read-token-long-value" };
const NOW = 1_800_000_000_000;
const H = (extra: Record<string, string> = {}) => new Headers({ host: "app.example", origin: "https://app.example", ...extra });
const body = (remember = false, password = PASSWORD, username = env.ADMIN_USERNAME) => JSON.stringify({ username, password, remember });
const login = (remember = false, e = env) => handleSession("POST", H(), body(remember), e, NOW, new LoginLimiter());
const cookie = (r: { setCookie?: string }) => r.setCookie!.split(";")[0];

test("password hash is fixed-cost salted scrypt; plaintext/malformed/weak costs fail closed", async () => {
  assert.ok(passwordConfigured(env));
  assert.ok(await verifyPassword(env.ADMIN_USERNAME, PASSWORD, env));
  assert.equal(await verifyPassword("unknown", PASSWORD, env), false);
  assert.equal(await verifyPassword(env.ADMIN_USERNAME, PASSWORD + "x", env), false);
  assert.equal(await verifyPassword(env.ADMIN_USERNAME, PASSWORD.trim(), env), true);
  for (const h of [PASSWORD, "", hash.replace("131072", "1024"), hash + "x", hash.replace("scrypt", "bcrypt")]) {
    const e = { ...env, ADMIN_PASSWORD_HASH: h };
    assert.equal(passwordConfigured(e), false);
    assert.equal((await login(false, e)).status, 503);
  }
  assert.equal((await login(false, { ...env, ADMIN_USERNAME: "" })).status, 503);
  assert.equal((await login(false, { ...env, CONTROL_ADMIN_TOKEN: "" })).status, 503);
});

test("password login returns admin cookie without exposing ID, password, hash or internal token", async () => {
  const r = await login(true);
  assert.equal(r.status, 200);
  const result = JSON.stringify(r);
  for (const secret of [env.ADMIN_USERNAME, PASSWORD, hash, env.CONTROL_ADMIN_TOKEN]) assert.ok(!result.includes(secret));
  for (const attr of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", `Max-Age=${SESSION_TTL_SEC}`]) assert.ok(r.setCookie!.includes(attr));
  const read = await handleSession("GET", H({ cookie: cookie(r) }), "", env, NOW + 1000);
  assert.equal((read.body as any).authenticated, true);
  assert.equal((read.body as any).role, "admin");
  assert.ok((read.body as any).csrfToken);
  assert.equal(authorize("GET", H({ cookie: cookie(r) }), "read", env, NOW).ok, true);
});

test("remember is opt-in; browser cookie has no persistence; both server deadlines enforced", async () => {
  const session = await login();
  assert.ok(!/Max-Age|Expires=/.test(session.setCookie!));
  assert.equal((session.body as any).ttlSeconds, BROWSER_SESSION_TTL_SEC);
  const value = cookie(session).split("=")[1];
  assert.ok(verifySession(value, env, NOW + (BROWSER_SESSION_TTL_SEC - 1) * 1000));
  assert.equal(verifySession(value, env, NOW + BROWSER_SESSION_TTL_SEC * 1000), null);
  const persistent = await login(true);
  const v = cookie(persistent).split("=")[1];
  assert.ok(verifySession(v, env, NOW + 29 * 86400_000));
  assert.equal(verifySession(v, env, NOW + SESSION_TTL_SEC * 1000), null);
  assert.equal((await handleSession("POST", H(), body().replace(',"remember":false', ''), env, NOW, new LoginLimiter())).setCookie!.includes("Max-Age"), false);
});

test("wrong username/password share generic 401; malformed and oversized requests issue no cookie", async () => {
  for (const raw of [body(false, "bad"), body(false, PASSWORD, "unknown")]) {
    const r = await handleSession("POST", H(), raw, env, NOW, new LoginLimiter());
    assert.deepEqual(r, { status: 401, body: { error: "unauthorized" } });
  }
  for (const raw of ["{", "null", "[]", "{}", JSON.stringify({ username: [], password: PASSWORD }), JSON.stringify({ username: env.ADMIN_USERNAME, password: PASSWORD, remember: "true" })]) {
    const r = await handleSession("POST", H(), raw, env, NOW, new LoginLimiter());
    assert.equal(r.status, 400); assert.equal(r.setCookie, undefined);
  }
  assert.equal((await handleSession("POST", H(), "x".repeat(4097), env, NOW)).status, 413);
});

test("rate limit: five attempts, Retry-After, no username/IP bypass, expiry permits retry", async () => {
  const limiter = new LoginLimiter();
  for (let i = 0; i < LOGIN_ATTEMPTS; i++) {
    const r = await handleSession("POST", H({ "x-forwarded-for": `192.0.2.${i}` }), body(false, "bad", `bad-${i}`), env, NOW + i, limiter);
    assert.equal(r.status, 401);
  }
  const blocked = await handleSession("POST", H(), body(), env, NOW + 1000, limiter);
  assert.equal(blocked.status, 429); assert.equal(blocked.setCookie, undefined);
  assert.equal(blocked.retryAfter, 899);
  assert.equal((await handleSession("POST", H(), body(), env, NOW + LOGIN_WINDOW_MS, limiter)).status, 200);
});

test("rate limit reserves concurrent requests before hashing; successful login does not reset it", async () => {
  const limiter = new LoginLimiter();
  const replies = await Promise.all(Array.from({ length: LOGIN_ATTEMPTS + 2 }, () => handleSession("POST", H(), body(), env, NOW, limiter)));
  assert.equal(replies.filter(r => r.status === 200).length, LOGIN_ATTEMPTS);
  assert.equal(replies.filter(r => r.status === 429).length, 2);
  assert.equal((await handleSession("POST", H(), JSON.stringify({ token: env.CONTROL_ADMIN_TOKEN }), env, NOW, limiter)).status, 429);
});

test("login/logout CSRF requires positive same origin; cookies cannot authorize logout without CSRF", async () => {
  for (const h of [new Headers({ host: "app.example" }), H({ origin: "https://evil.example" }), H({ origin: "http://app.example" }), H({ "sec-fetch-site": "cross-site" }), H({ origin: "https://evil.example", "x-forwarded-host": "evil.example" })]) {
    assert.equal((await handleSession("POST", h, body(), env, NOW, new LoginLimiter())).status, 403);
    assert.equal((await handleSession("DELETE", h, "", env, NOW)).status, 403);
  }
  const r = await login();
  const h = H({ cookie: cookie(r) });
  assert.equal((await handleSession("DELETE", h, "", env, NOW)).status, 403);
  h.set("x-csrf-token", (r.body as any).csrfToken);
  const out = await handleSession("DELETE", h, "", env, NOW);
  assert.equal(out.status, 200); assert.match(out.setCookie!, /Max-Age=0/);
});

test("password/id/epoch/token rotation revokes signed sessions; legacy header tokens still work", () => {
  const { value } = issueSession("admin", env, NOW)!;
  for (const e of [{ ...env, ADMIN_PASSWORD_HASH: hash + "x" }, { ...env, ADMIN_USERNAME: "changed" }, { ...env, CONTROL_SESSION_EPOCH: "2" }, { ...env, CONTROL_ADMIN_TOKEN: "changed-internal-token-value" }]) assert.equal(verifySession(value, e, NOW), null);
  assert.deepEqual(authorize("POST", H({ "x-admin-token": env.CONTROL_ADMIN_TOKEN }), "admin", env, NOW), { ok: true, via: "token" });
  assert.equal(authorize("GET", H({ "x-admin-token": env.CONTROL_READ_TOKEN }), "read", env, NOW).ok, true);
  assert.equal(authorize("POST", H({ "x-admin-token": env.CONTROL_READ_TOKEN }), "admin", env, NOW).ok, false);
  assert.equal(authorize("GET", H({ "x-admin-token": "bad", cookie: `${cookieName(env)}=${value}` }), "read", env, NOW).ok, false);
});
