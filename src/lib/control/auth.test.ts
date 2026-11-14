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
