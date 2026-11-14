import assert from "node:assert/strict";
import test from "node:test";
import { computeReadiness } from "./readiness";

test("empty env: required items missing, release blocked", () => {
  const r = computeReadiness({});
  assert.equal(r.releaseBlocked, true);
  assert.equal(r.items.find((i) => i.id === "database")?.state, "missing");
});
test("fully configured env still blocked by external trigger + live smoke", () => {
  const r = computeReadiness({ DATABASE_URL: "x", CONTROL_ADMIN_TOKEN: "a".repeat(16), CONTROL_READ_TOKEN: "b".repeat(16), GITHUB_TOKEN: "t", GITHUB_REPO: "o/r", RUN_CALLBACK_SECRET_CLAUDE_SONNET: "s".repeat(32), CRON_SECRET: "c".repeat(16) });
  assert.equal(r.items.filter((i) => i.state === "missing").length, 0);
  assert.equal(r.releaseBlocked, true);
});
test("never leaks secret values", () => {
  const r = JSON.stringify(computeReadiness({ DATABASE_URL: "postgres://u:SECRETPW@h/db", CONTROL_ADMIN_TOKEN: "TOKENVALUE0123456789" }));
  assert.ok(!r.includes("SECRETPW") && !r.includes("TOKENVALUE"));
});
