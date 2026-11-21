import test from "node:test";
import assert from "node:assert/strict";
import { run, decide, markerExists, ProbeError, PER_PAGE, MAX_PAGES, ACTIVATION_TOKEN, PROBE_BRANCH, MARKER, LABELS } from "./routine-probe.mjs";

const good = {
  GITHUB_REPOSITORY: "jonghee1998/ai-orchestrator",
  GITHUB_EVENT_NAME: "push",
  GITHUB_REF: `refs/heads/${PROBE_BRANCH}`,
  GITHUB_ACTOR: "jonghee1998",
  GITHUB_RUN_ATTEMPT: "1",
};
// pages: array of GET responses by page index (default: one empty page). postImpl overrides POST.
const mkApi = (pages = [[]], postImpl = async () => ({ number: 999 })) => {
  const calls = [];
  const api = async (m, p, b) => {
    calls.push([m, p, b]);
    if (m === "GET") {
      const n = Number(new URL("https://x" + p).searchParams.get("page"));
      return n - 1 < pages.length ? pages[n - 1] : [];
    }
    return postImpl(m, p, b);
  };
  return { api, calls };
};
const filler = (n, start = 1) => Array.from({ length: n }, (_, k) => ({ number: start + k, body: "x" }));
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
  const { api, calls } = mkApi([[{ number: 1, body: "a\n" + MARKER + "\nb" }]]);
  const r = await run({ env: good, activationText: ACTIVATION_TOKEN, api, log: quiet });
  assert.equal(r.created, false);
  assert.equal(calls.filter((c) => c[0] === "POST").length, 0);
});

test("dedupe: closed issue (state=all listing) blocks creation; query uses state=all", async () => {
  const { api, calls } = mkApi([[{ number: 5, state: "closed", body: MARKER }]]);
  const r = await run({ env: good, activationText: ACTIVATION_TOKEN, api, log: quiet });
  assert.equal(r.deduped, true);
  assert.match(calls[0][1], /^\/repos\/jonghee1998\/ai-orchestrator\/issues\?state=all&per_page=100&page=1$/);
  assert.equal(calls.filter((c) => c[0] === "POST").length, 0);
});
test("marker must match exactly (substring / PR items do not count)", async () => {
  const { api } = mkApi([[{ number: 1, body: "see " + MARKER + " inline" }, { number: 2, body: MARKER, pull_request: {} }, { number: 3, body: null }]]);
  assert.equal(await markerExists(api, "r"), false);
});
test("pagination: marker on page 2 is found; stops at short page", async () => {
  const { api, calls } = mkApi([filler(PER_PAGE), [{ number: 500, body: MARKER }]]);
  assert.equal(await markerExists(api, "r"), true);
  assert.equal(calls.length, 2);
});
test("pagination: full pages then short empty page -> not found", async () => {
  const { api, calls } = mkApi([filler(PER_PAGE), filler(PER_PAGE, 101), []]);
  assert.equal(await markerExists(api, "r"), false);
  assert.equal(calls.length, 3);
});
test("pagination bound exceeded -> fail closed, no POST", async () => {
  const pages = Array.from({ length: MAX_PAGES }, (_, k) => filler(PER_PAGE, k * PER_PAGE + 1));
  const { api, calls } = mkApi(pages);
  await assert.rejects(run({ env: good, activationText: ACTIVATION_TOKEN, api, log: quiet }), /pagination bound/);
  assert.equal(calls.filter((c) => c[0] === "POST").length, 0);
});
for (const [name, resp] of [["non-array", { items: [] }], ["null", null], ["bad item", [{ body: "x" }]], ["bad body type", [{ number: 1, body: 5 }]]]) {
  test(`malformed list response (${name}) -> fail closed, no POST`, async () => {
    const { api, calls } = mkApi([resp]);
    await assert.rejects(run({ env: good, activationText: ACTIVATION_TOKEN, api, log: quiet }), ProbeError);
    assert.equal(calls.filter((c) => c[0] === "POST").length, 0);
  });
}
test("list API error propagates -> no POST", async () => {
  const calls = [];
  const api = async (m, p) => { calls.push(m); throw new Error("GET -> 502"); };
  await assert.rejects(run({ env: good, activationText: ACTIVATION_TOKEN, api, log: quiet }), /502/);
  assert.deepEqual(calls, ["GET"]);
});
test("rerun (GITHUB_RUN_ATTEMPT=2 or unset) -> dry-run, no API calls", async () => {
  for (const attempt of ["2", undefined]) {
    const { api, calls } = mkApi();
    const r = await run({ env: { ...good, GITHUB_RUN_ATTEMPT: attempt }, activationText: ACTIVATION_TOKEN, api, log: quiet });
    assert.equal(r.created, false);
    assert.equal(calls.length, 0);
  }
});
test("ambiguous POST (network/5xx error) -> error, exactly one POST, no retry", async () => {
  const { api, calls } = mkApi([[]], async () => { throw new Error("POST -> 502"); });
  await assert.rejects(run({ env: good, activationText: ACTIVATION_TOKEN, api, log: quiet }), /ambiguous POST.*NOT retrying/);
  assert.equal(calls.filter((c) => c[0] === "POST").length, 1);
});
test("ambiguous POST (2xx without issue number) -> error, no retry", async () => {
  const { api, calls } = mkApi([[]], async () => ({}));
  await assert.rejects(run({ env: good, activationText: ACTIVATION_TOKEN, api, log: quiet }), /ambiguous POST response/);
  assert.equal(calls.filter((c) => c[0] === "POST").length, 1);
});
