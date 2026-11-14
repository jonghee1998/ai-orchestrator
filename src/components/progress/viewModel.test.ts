import test from "node:test";
import assert from "node:assert/strict";
import { bucketOf, buildCards, summarize, parseRuns, parseWorkflows, type RunRow } from "./viewModel";

const run = (o: Partial<RunRow> = {}): RunRow => ({ dispatchId: "d1", issueNumber: 42, agent: "claude-sonnet", attempt: 1, status: "queued", verified: false, submission: null,
  lastActivityAt: "2026-11-14T00:00:00Z", lastError: null, evidence: [], latency: null, collaboration: null, execution: null, ...o });

test("bucket mapping never reports unACKed dispatch as running", () => {
  assert.equal(bucketOf("unknown"), "unknown");
  assert.equal(bucketOf("running"), "running");
  assert.equal(bucketOf("timeout"), "blocked");
  assert.equal(bucketOf("succeeded"), "completed");
  assert.equal(bucketOf("weird"), "unknown");
});
test("missing data stays null/unverified, not invented", () => {
  const [c] = buildCards([run()], []);
  assert.equal(c.sha, null); assert.equal(c.branch, null); assert.equal(c.ack.verified, false); assert.deepEqual(c.links, []);
});
test("collaboration data yields branch/sha/links; only github urls accepted", () => {
  const sha = "a".repeat(40);
  const [c] = buildCards([run({ status: "running", verified: true, latency: { ackMs: 4000 }, collaboration: { workflowId: "w", cycle: 1, step: "claude", repo: "o/r", baseBranch: "b", baseSha: sha, workBranch: "x", targetSha: sha, prNumber: 7 },
    evidence: [{ kind: "pr", url: "https://github.com/o/r/pull/7" }, { kind: "other", url: "javascript:alert(1)" }] })], []);
  assert.equal(c.branch, "x"); assert.equal(c.sha, sha); assert.equal(c.ack.verified, true); assert.match(c.ack.text, /4s/);
  assert.equal(c.links.length, 3); assert.ok(c.links.every((l) => l.url.startsWith("https://github.com/")));
});
test("summarize and parsers", () => {
  assert.equal(summarize(buildCards([run(), run({ status: "failed" })], [])).blocked, 1);
  assert.equal(parseRuns(200, { mode: "unconfigured", runs: [] }), "unconfigured");
  assert.equal(parseRuns(500, { mode: "error", runs: [] }), null);
  assert.equal(parseWorkflows(503, { error: "store_unconfigured" }), "unconfigured");
  assert.deepEqual(parseWorkflows(200, { workflows: [] }), []);
});
