import assert from "node:assert/strict";
import test from "node:test";
import { checkAdmin } from "./auth";

test("admin auth fails closed", () => {
  const env = { CONTROL_ADMIN_TOKEN: "0123456789abcdef0123" };
  assert.deepEqual(checkAdmin("x", {}), { ok: false, status: 503 });
  assert.deepEqual(checkAdmin("x", { CONTROL_ADMIN_TOKEN: "short" }), { ok: false, status: 503 });
  assert.deepEqual(checkAdmin(null, env), { ok: false, status: 401 });
  assert.deepEqual(checkAdmin("wrong", env), { ok: false, status: 401 });
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
