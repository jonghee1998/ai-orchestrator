import assert from "node:assert/strict";
import test from "node:test";
import { authorize } from "./guard";
import { handleSession } from "./http";
import { cookieName, csrfToken, issueSession, SESSION_TTL_SEC, verifySession } from "./session";

const ADMIN = "admin-token-0123456789abcdef";
const READ = "read-token-0123456789abcdef";
const env = { NODE_ENV: "production", CONTROL_ADMIN_TOKEN: ADMIN, CONTROL_READ_TOKEN: READ } as const;
const NOW = Date.UTC(2026, 10, 16);
const H = (o: Record<string, string>) => new Headers({ host: "app.example", ...o });
const login = (token: string, e: Record<string, string | undefined> = env) =>
  handleSession("POST", H({ origin: "https://app.example" }), JSON.stringify({ token }), e, NOW);
const cookieOf = (setCookie?: string) => (setCookie ?? "").split(";")[0];

test("login with admin token issues HttpOnly Secure SameSite cookie; no raw token anywhere", () => {
  const r = login(ADMIN);
  assert.equal(r.status, 200);
  const c = r.setCookie!;
  assert.match(c, /^__Host-orch_session=/);
  for (const a of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", `Max-Age=${SESSION_TTL_SEC}`]) assert.ok(c.includes(a), a);
  assert.equal(SESSION_TTL_SEC, 30 * 24 * 3600);
  assert.ok(!c.includes(ADMIN) && !JSON.stringify(r.body).includes(ADMIN));
  assert.ok(!Buffer.from(c.split("=")[1].split(".")[0], "base64url").toString().includes(ADMIN));
});
test("wrong/empty token → 401 and no cookie; unconfigured → 503", () => {
  for (const t of ["", "nope", ADMIN + "x"]) { const r = login(t); assert.equal(r.status, 401); assert.equal(r.setCookie, undefined); }
  assert.equal(login(ADMIN, { NODE_ENV: "production" }).status, 503);
});
test("login/logout CSRF: cross-origin POST/DELETE rejected", () => {
  const evil = H({ origin: "https://evil.example" });
  assert.equal(handleSession("POST", evil, JSON.stringify({ token: ADMIN }), env, NOW).status, 403);
  assert.equal(handleSession("DELETE", evil, "", env, NOW).status, 403);
  const out = handleSession("DELETE", H({ origin: "https://app.example" }), "", env, NOW);
  assert.equal(out.status, 200); assert.match(out.setCookie!, /Max-Age=0/);
});
test("session survives reload/browser restart (cookie only) and GET returns role+csrf", () => {
  const ck = cookieOf(login(ADMIN).setCookie);
  const r = handleSession("GET", H({ cookie: ck }), "", env, NOW + 10 * 24 * 3600_000);
  assert.deepEqual({ a: (r.body as any).authenticated, role: (r.body as any).role }, { a: true, role: "admin" });
  assert.ok((r.body as any).csrfToken.length > 20);
  assert.equal((handleSession("GET", H({}), "", env, NOW).body as any).authenticated, false);
});
test("expiry: valid before 30d, rejected after; tampered/forged/foreign cookies rejected", () => {
  const { value, session } = issueSession("admin", env, NOW)!;
  assert.ok(verifySession(value, env, NOW + (SESSION_TTL_SEC - 5) * 1000));
  assert.equal(verifySession(value, env, NOW + (SESSION_TTL_SEC + 1) * 1000), null);
  const [b, m] = value.split(".");
  const forged = Buffer.from(JSON.stringify({ ...session, role: "admin", exp: session.exp + 99999 })).toString("base64url");
  assert.equal(verifySession(`${forged}.${m}`, env, NOW), null);
  assert.equal(verifySession(`${b}.${m}x`, env, NOW), null);
  assert.equal(verifySession("garbage", env, NOW), null);
  // read-role payload re-labelled admin cannot verify (different key)
  const rd = issueSession("read", env, NOW)!;
  const relabelled = Buffer.from(JSON.stringify({ ...rd.session, role: "admin" })).toString("base64url");
  assert.equal(verifySession(`${relabelled}.${rd.value.split(".")[1]}`, env, NOW), null);
});
test("revocation: token rotation or CONTROL_SESSION_EPOCH change invalidates all sessions", () => {
  const { value } = issueSession("admin", env, NOW)!;
  assert.ok(verifySession(value, env, NOW));
  assert.equal(verifySession(value, { ...env, CONTROL_ADMIN_TOKEN: "rotated-token-0123456789abc" }, NOW), null);
  assert.equal(verifySession(value, { ...env, CONTROL_SESSION_EPOCH: "2" }, NOW), null);
  assert.equal(verifySession(value, { ...env, CONTROL_ADMIN_TOKEN: undefined }, NOW), null);
});

const sess = { admin: issueSession("admin", env, NOW)!, read: issueSession("read", env, NOW)! };
const cookie = (role: "admin" | "read") => `${cookieName(env)}=${sess[role].value}`;
const csrf = (role: "admin" | "read") => csrfToken(sess[role].session, env);
test("guard: unauthenticated → 401/503 on read and admin", () => {
  assert.deepEqual(authorize("GET", H({}), "read", env, NOW), { ok: false, status: 401, reason: "token_missing" });
  assert.deepEqual(authorize("POST", H({}), "admin", env, NOW), { ok: false, status: 401, reason: "token_missing" });
  assert.equal((authorize("GET", H({}), "read", {}, NOW) as any).status, 503);
});
test("guard: existing x-admin-token clients keep working (no cookie, no CSRF needed); bad header never falls back to cookie", () => {
  assert.deepEqual(authorize("POST", H({ "x-admin-token": ADMIN }), "admin", env, NOW), { ok: true, via: "token" });
  assert.deepEqual(authorize("GET", H({ "x-admin-token": READ }), "read", env, NOW), { ok: true, via: "token" });
  assert.equal(authorize("POST", H({ "x-admin-token": READ }), "admin", env, NOW).ok, false);
  assert.equal(authorize("GET", H({ "x-admin-token": "bad", cookie: cookie("admin") }), "read", env, NOW).ok, false);
});
test("guard: session reads allowed; read-role cannot do admin; unsigned cookie rejected", () => {
  assert.deepEqual(authorize("GET", H({ cookie: cookie("read") }), "read", env, NOW), { ok: true, via: "session" });
  const r = authorize("POST", H({ cookie: cookie("read"), origin: "https://app.example", "x-csrf-token": csrf("read") }), "admin", env, NOW);
  assert.deepEqual(r, { ok: false, status: 403, reason: "insufficient_role" });
  assert.equal(authorize("GET", H({ cookie: `${cookieName(env)}=abc.def` }), "read", env, NOW).ok, false);
});
test("guard CSRF: cookie-auth mutation requires matching x-csrf-token and same Origin", () => {
  const base = { cookie: cookie("admin") };
  assert.deepEqual(authorize("POST", H({ ...base, origin: "https://app.example" }), "admin", env, NOW), { ok: false, status: 403, reason: "csrf" });
  assert.deepEqual(authorize("POST", H({ ...base, origin: "https://app.example", "x-csrf-token": "wrong" }), "admin", env, NOW), { ok: false, status: 403, reason: "csrf" });
  assert.deepEqual(authorize("POST", H({ ...base, origin: "https://evil.example", "x-csrf-token": csrf("admin") }), "admin", env, NOW), { ok: false, status: 403, reason: "csrf" });
  assert.deepEqual(authorize("POST", H({ ...base, "sec-fetch-site": "cross-site", "x-csrf-token": csrf("admin") }), "admin", env, NOW), { ok: false, status: 403, reason: "csrf" });
  assert.deepEqual(authorize("POST", H({ ...base, origin: "https://app.example", "x-csrf-token": csrf("admin") }), "admin", env, NOW), { ok: true, via: "session" });
});
test("guard: no automatic elevation from Vercel identity headers", () => {
  const r = authorize("POST", H({ "x-vercel-id": "iad1::abc", "x-vercel-sc-headers": "{}", "x-forwarded-user": "owner" }), "admin", env, NOW);
  assert.equal(r.ok, false);
});
