import test from "node:test";
import assert from "node:assert/strict";
import { run, decide, ACTIVATION_TOKEN, PROBE_BRANCH, MARKER, LABELS } from "./routine-probe.mjs";

const good = {
  GITHUB_REPOSITORY: "jonghee1998/ai-orchestrator",
  GITHUB_EVENT_NAME: "push",
  GITHUB_REF: `refs/heads/${PROBE_BRANCH}`,
  GITHUB_ACTOR: "jonghee1998",
};
const mkApi = (items = []) => {
  const calls = [];
  const api = async (m, p, b) => { calls.push([m, p, b]); return m === "GET" ? { items } : { number: 999 }; };
  return { api, calls };
};
const quiet = () => {};

test("activation conditions all met -> apply", () => {
  assert.equal(decide(good, ACTIVATION_TOKEN + "\n").mode, "apply");
});
for (const [name, patch, text] of [
  ["wrong branch (implementation PR / integration push)", { GITHUB_REF: "refs/heads/codex/issue-92-mobile-v2" }, ACTIVATION_TOKEN],
  ["main", { GITHUB_REF: "refs/heads/main" }, ACTIVATION_TOKEN],
  ["pull_request event", { GITHUB_EVENT_NAME: "pull_request" }, ACTIVATION_TOKEN],
  ["other actor", { GITHUB_ACTOR: "someone" }, ACTIVATION_TOKEN],
  ["fork repo", { GITHUB_REPOSITORY: "x/ai-orchestrator" }, ACTIVATION_TOKEN],
  ["missing activation file", {}, ""],
  ["wrong token", {}, "ACTIVATE other"],
  ["explicit dry-run", { PROBE_DRY_RUN: "true" }, ACTIVATION_TOKEN],
]) {
  test(`dry-run: ${name}`, async () => {
    const { api, calls } = mkApi();
    const r = await run({ env: { ...good, ...patch }, activationText: text, api, log: quiet });
    assert.equal(r.created, false);
    assert.equal(calls.length, 0, "dry-run must make no API calls");
  });
}
test("apply creates exactly one labeled issue with marker", async () => {
  const { api, calls } = mkApi();
  const r = await run({ env: good, activationText: ACTIVATION_TOKEN, api, log: quiet });
  assert.equal(r.created, true);
  const posts = calls.filter((c) => c[0] === "POST");
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0][2].labels, LABELS);
  assert.ok(posts[0][2].body.includes(MARKER));
});
test("dedupe: existing marker issue blocks creation", async () => {
  const { api, calls } = mkApi([{ body: MARKER }]);
  const r = await run({ env: good, activationText: ACTIVATION_TOKEN, api, log: quiet });
  assert.equal(r.created, false);
  assert.equal(calls.filter((c) => c[0] === "POST").length, 0);
});
