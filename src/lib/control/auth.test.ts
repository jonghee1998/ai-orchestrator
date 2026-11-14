import assert from "node:assert/strict";
import test from "node:test";
import { checkAdmin } from "./auth";

test("admin auth fails closed", () => {
  const env = { CONTROL_ADMIN_TOKEN: "0123456789abcdef0123" };
  assert.equal(checkAdmin("x", {}).ok, false);
  assert.equal(checkAdmin("x", { CONTROL_ADMIN_TOKEN: "short" }).ok, false);
  assert.equal(checkAdmin(null, env).ok, false);
  assert.equal(checkAdmin("wrong", env).ok, false);
  assert.deepEqual(checkAdmin(env.CONTROL_ADMIN_TOKEN, env), { ok: true });
});

import { checkCron } from "./auth";
test("cron auth: bearer CRON_SECRET or admin token; fail closed", () => {
  const env = { CRON_SECRET: "c".repeat(16), CONTROL_ADMIN_TOKEN: "a".repeat(16) };
  assert.deepEqual(checkCron(null, null, {}), { ok: false, status: 503 });
  assert.deepEqual(checkCron("Bearer " + "c".repeat(16), null, env), { ok: true });
  assert.deepEqual(checkCron("Bearer wrong", null, env), { ok: false, status: 401 });
  assert.deepEqual(checkCron(null, "a".repeat(16), env), { ok: true });
  assert.deepEqual(checkCron("Bearer " + "c".repeat(16), null, { CRON_SECRET: "c".repeat(16) }), { ok: true });
  assert.deepEqual(checkCron("Bearer " + "c".repeat(16), null, { CONTROL_ADMIN_TOKEN: "a".repeat(16) }), { ok: false, status: 401 });
});

import { normalizeToken, checkRead } from "./auth";
test("token normalization tolerates paste artifacts on both sides, stays exact otherwise", () => {
  const t = "0123456789abcdef0123";
  assert.equal(normalizeToken(` \t${t}\r\n`), t);
  assert.equal(normalizeToken(`"${t}"`), t);
  assert.equal(normalizeToken(`'${t}\n'`), t);
  assert.equal(normalizeToken(`﻿${t}​`), t);
  assert.equal(normalizeToken(null), "");
  // server env with trailing newline / quotes still matches clean input and padded input
  for (const cfg of [`${t}\n`, `"${t}"`, ` ${t} `]) {
    assert.deepEqual(checkAdmin(t, { CONTROL_ADMIN_TOKEN: cfg }), { ok: true });
    assert.deepEqual(checkAdmin(` ${t}\n`, { CONTROL_ADMIN_TOKEN: cfg }), { ok: true });
    assert.deepEqual(checkRead(t, { CONTROL_ADMIN_TOKEN: cfg }), { ok: true });
  }
  // interior difference is still rejected (auth not weakened)
  assert.equal(checkAdmin(t.slice(0, 5) + " " + t.slice(5), { CONTROL_ADMIN_TOKEN: t }).ok, false);
  assert.equal(checkAdmin(t.toUpperCase(), { CONTROL_ADMIN_TOKEN: t }).ok, false);
});
test("diagnostic reasons distinguish missing config from mismatch without values", () => {
  const t = "0123456789abcdef0123";
  assert.deepEqual(checkAdmin(t, {}), { ok: false, status: 503, reason: "not_configured" });
  assert.deepEqual(checkAdmin(t, { CONTROL_ADMIN_TOKEN: "   short " }), { ok: false, status: 503, reason: "not_configured" });
  assert.deepEqual(checkAdmin("  ", { CONTROL_ADMIN_TOKEN: t }), { ok: false, status: 401, reason: "token_missing" });
  assert.deepEqual(checkAdmin("x".repeat(20), { CONTROL_ADMIN_TOKEN: t }), { ok: false, status: 401, reason: "mismatch" });
  assert.deepEqual(checkRead(null, { CONTROL_READ_TOKEN: t }), { ok: false, status: 401, reason: "token_missing" });
  assert.deepEqual(checkRead("y".repeat(20), {}), { ok: false, status: 503, reason: "not_configured" });
});
