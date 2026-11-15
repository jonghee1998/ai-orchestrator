import assert from "node:assert/strict";
import test from "node:test";
import { computeReadiness, githubEvidenceReadiness } from "./readiness";

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
test("#65: GitHub read-only readiness is separate and never clears releaseBlocked", () => {
  const r = computeReadiness({ CONTROL_ADMIN_TOKEN: "a".repeat(16), GITHUB_READ_TOKEN: "t", GITHUB_REPO: "o/r" });
  const live = { state: "live" as const, evidenceReads: { pulls: "readable", comments: "readable", reviews: "readable", commits: "readable" } as const };
  const g = githubEvidenceReadiness(r.items, live);
  assert.equal(g.ready, true); assert.equal(g.runtimeVerified, false); assert.equal(g.scope, "github_read_only");
  assert.equal(r.releaseBlocked, true);
  assert.equal(githubEvidenceReadiness(computeReadiness({ CONTROL_ADMIN_TOKEN: "a".repeat(16) }).items, live).ready, false);
  assert.equal(githubEvidenceReadiness(computeReadiness({ GITHUB_READ_TOKEN: "t", GITHUB_REPO: "o/r" }).items, live).ready, false);
});

test("#67: evidence readiness requires the evidence reads, not only the Issues queue read", () => {
  const items = computeReadiness({ CONTROL_ADMIN_TOKEN: "a".repeat(16), GITHUB_READ_TOKEN: "t", GITHUB_REPO: "o/r" }).items;
  const ok = { pulls: "readable", comments: "readable", reviews: "readable", commits: "readable" } as const;
  // No probe result => never ready (config presence alone proves nothing).
  const none = githubEvidenceReadiness(items);
  assert.equal(none.ready, false); assert.equal(none.reads, null);
  // Queue readable but PR reads denied => narrower queue scope reported explicitly, evidence NOT ready.
  const prDenied = githubEvidenceReadiness(items, { state: "live", evidenceReads: { ...ok, pulls: "denied", reviews: "not_probed", commits: "not_probed" } });
  assert.equal(prDenied.ready, false); assert.equal(prDenied.queueReadable, true);
  assert.match(prDenied.detail, /큐 읽기만 확인됨/); assert.match(prDenied.detail, /PR 목록\(denied\)/);
  for (const k of ["comments", "reviews", "commits"] as const)
    assert.equal(githubEvidenceReadiness(items, { state: "live", evidenceReads: { ...ok, [k]: "error" } }).ready, false, k);
  // Repo with no PRs: the reader makes no per-PR reads either, so "no_sample" is acceptable.
  assert.equal(githubEvidenceReadiness(items, { state: "live", evidenceReads: { ...ok, reviews: "no_sample", commits: "no_sample" } }).ready, true);
  // Probe not live => not ready even if reads look fine.
  assert.equal(githubEvidenceReadiness(items, { state: "error", evidenceReads: ok }).queueReadable, false);
});
