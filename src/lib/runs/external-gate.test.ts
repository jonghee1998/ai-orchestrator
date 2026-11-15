import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRunStore, type StoreData } from "./store";
import { checkExternalGate, gateEvidence, parseGateRequest, signGateResponse } from "./external-gate";
import { handleGate } from "./gate-http";
import { signCallback } from "./callback-auth";
import { authorizeSubmission, recordSubmission, requestDispatch } from "./service";
import { buildSnapshot } from "../control/service";
import { probeGitHub, githubReadConfig } from "../github/integration";
import { readGitHubWorkQueue } from "../github/github-read-queue";
import { callbackSecretStatus, computeReadiness } from "../readiness";

const NOW = "2026-01-01T00:00:00.000Z";
const on = (s: MemoryRunStore, ...keys: string[]) => s.transact((d: StoreData) => {
  d.control = { ...d.control, claudeProvider: true, agents: { ...d.control.agents, ...Object.fromEntries(keys.map((k) => [k, true])) } };
});
/** Orchestrator-authorized dispatch for (issue, agent): request -> gate-authorized submit -> accepted. */
async function dispatched(s: MemoryRunStore, issue: number, agent: string) {
  const r = await requestDispatch(s, issue, agent, NOW); assert.ok(r.ok);
  const a = await authorizeSubmission(s, r.record.dispatchId, NOW); assert.ok(a.ok);
  await recordSubmission(s, r.record.dispatchId, "accepted", NOW);
  return r.record.dispatchId;
}

test("external gate: default OFF blocks, records evidence + suppression count", async () => {
  const s = new MemoryRunStore();
  const r = await checkExternalGate(s, { agent: "claude-sonnet", issueNumber: 1 }, "evt-00000001", NOW);
  assert.ok(r.ok && !r.allow && r.reason === "agent_disabled");
  const d = await s.read();
  assert.equal(d.gateChecks["claude-sonnet"].allowed, false);
  assert.equal(d.blocked["claude-sonnet"], 1);
});
test("external gate: agent ON but no orchestrator dispatch for that task => deny (label-only trigger)", async () => {
  const s = new MemoryRunStore(); await on(s, "codex");
  const r = await checkExternalGate(s, { agent: "codex", issueNumber: 7 }, "evt-00000002", NOW);
  assert.ok(r.ok && !r.allow && r.reason === "no_authorized_dispatch");
});
test("external gate: allows only the exact (issue, agent) the orchestrator authorized", async () => {
  const s = new MemoryRunStore(); await on(s, "codex", "claude-opus", "claude-sonnet");
  const id = await dispatched(s, 7, "codex");
  const ok = await checkExternalGate(s, { agent: "codex", issueNumber: 7 }, "evt-00000003", NOW);
  assert.ok(ok.ok && ok.allow && ok.dispatchId === id);
  // other issue, other agent, wrong dispatchId => deny
  const r1 = await checkExternalGate(s, { agent: "codex", issueNumber: 8 }, "evt-00000004", NOW);
  assert.ok(r1.ok && !r1.allow && r1.reason === "no_authorized_dispatch");
  const r2 = await checkExternalGate(s, { agent: "claude-opus", issueNumber: 7 }, "evt-00000005", NOW);
  assert.ok(r2.ok && !r2.allow && r2.reason === "no_authorized_dispatch");
  const r3 = await checkExternalGate(s, { agent: "codex", issueNumber: 7, dispatchId: "d-7-codex-9" }, "evt-00000006", NOW);
  assert.ok(r3.ok && !r3.allow && r3.reason === "dispatch_mismatch");
  // replay + unknown agent
  assert.deepEqual(await checkExternalGate(s, { agent: "codex", issueNumber: 7 }, "evt-00000003", NOW), { ok: false, reason: "replay" });
  assert.deepEqual(await checkExternalGate(s, { agent: "nope", issueNumber: 7 }, "evt-00000007", NOW), { ok: false, reason: "unknown_agent" });
});
test("external gate: queued-but-not-authorized record denies; authorized queued (label race) allows", async () => {
  const s = new MemoryRunStore(); await on(s, "codex");
  const r = await requestDispatch(s, 9, "codex", NOW); assert.ok(r.ok);
  const a = await checkExternalGate(s, { agent: "codex", issueNumber: 9 }, "evt-00000010", NOW);
  assert.ok(a.ok && !a.allow && a.reason === "no_authorized_dispatch");
  assert.ok((await authorizeSubmission(s, r.record.dispatchId, NOW)).ok);
  const b = await checkExternalGate(s, { agent: "codex", issueNumber: 9 }, "evt-00000011", NOW);
  assert.ok(b.ok && b.allow);
});
test("external gate: OFF after dispatch denies; finished dispatch denies", async () => {
  const s = new MemoryRunStore(); await on(s, "claude-opus");
  const id = await dispatched(s, 34, "claude-opus");
  await s.transact((d) => { d.control = { ...d.control, claudeProvider: false }; });
  const r = await checkExternalGate(s, { agent: "claude-opus", issueNumber: 34 }, "evt-00000020", NOW);
  assert.ok(r.ok && !r.allow && r.reason === "provider_disabled");
  await on(s, "claude-opus");
  await s.transact((d) => { d.records[id] = { ...d.records[id], status: "succeeded" }; });
  const f = await checkExternalGate(s, { agent: "claude-opus", issueNumber: 34 }, "evt-00000021", NOW);
  assert.ok(f.ok && !f.allow && f.reason === "dispatch_finished");
});
test("gate request parser: strict v2 shape", () => {
  assert.deepEqual(parseGateRequest('{"v":2,"agent":"codex","issueNumber":3}'), { agent: "codex", issueNumber: 3, dispatchId: undefined });
  for (const b of ["", "null", '{"agent":"codex","issueNumber":3}', '{"v":2,"agent":"codex","issueNumber":0}', '{"v":2,"agent":"codex","issueNumber":"3"}', '{"v":2,"agent":"codex","issueNumber":3,"dispatchId":"a b"}'])
    assert.equal(parseGateRequest(b), null, b);
});

// ---- HTTP handler: per-agent secret binding ----
const SON = "s".repeat(40), OPUS = "o".repeat(40);
const ENV = { RUN_CALLBACK_SECRET_CLAUDE_SONNET: SON, RUN_CALLBACK_SECRET_CLAUDE_OPUS: OPUS, RUN_CALLBACK_SECRET_CLAUDE: "legacy-shared-secret-xxxxxxxxxxxxxx" };
const NOWMS = Date.parse(NOW), TS = String(Math.floor(NOWMS / 1000));
const hdr = (o: Record<string, string>) => ({ get: (n: string) => o[n] ?? null });
function call(s: MemoryRunStore, opts: { key: string; secret: string; body: string; eventId: string }, env: Record<string, string> = ENV) {
  const sig = signCallback(opts.secret, TS, opts.eventId, opts.body);
  return handleGate(hdr({ "x-agent-key": opts.key, "x-timestamp": TS, "x-event-id": opts.eventId, "x-signature": sig }), opts.body, () => s, env, NOWMS);
}
test("gate http: Sonnet secret cannot obtain an Opus allow (agent bound by per-agent secret + signed body)", async () => {
  const s = new MemoryRunStore(); await on(s, "claude-opus", "claude-sonnet");
  await dispatched(s, 34, "claude-opus");
  const body = '{"v":2,"agent":"claude-opus","issueNumber":34}';
  // header claims opus, signed with sonnet secret => 401
  assert.equal((await call(s, { key: "claude-opus", secret: SON, body, eventId: "evt-10000001" })).status, 401);
  // header claims sonnet (valid sonnet sig) but body says opus => 401
  assert.equal((await call(s, { key: "claude-sonnet", secret: SON, body, eventId: "evt-10000002" })).status, 401);
  // legacy provider-wide secret is NOT accepted
  assert.equal((await call(s, { key: "claude-opus", secret: ENV.RUN_CALLBACK_SECRET_CLAUDE, body, eventId: "evt-10000003" })).status, 401);
  // correct opus secret => 200 allow, response signature verifies
  const ok = await call(s, { key: "claude-opus", secret: OPUS, body, eventId: "evt-10000004" });
  assert.equal(ok.status, 200);
  const j = JSON.parse(ok.body); assert.equal(j.allow, true); assert.equal(j.dispatchId, "d-34-claude-opus-1");
  assert.equal(ok.signature, signGateResponse(OPUS, j.at, j.eventId, ok.body));
  // replay => 409
  assert.equal((await call(s, { key: "claude-opus", secret: OPUS, body, eventId: "evt-10000004" })).status, 409);
});
test("gate http: missing per-agent secret => 503; tampered body => 401; bad shape => 400", async () => {
  const s = new MemoryRunStore();
  assert.equal((await call(s, { key: "codex", secret: "x".repeat(40), body: '{"v":2,"agent":"codex","issueNumber":1}', eventId: "evt-20000001" })).status, 503);
  const body = '{"v":2,"agent":"claude-opus","issueNumber":34}';
  const sig = signCallback(OPUS, TS, "evt-20000002", body);
  const t = await handleGate(hdr({ "x-agent-key": "claude-opus", "x-timestamp": TS, "x-event-id": "evt-20000002", "x-signature": sig }), body.replace("34", "35"), () => s, ENV, NOWMS);
  assert.equal(t.status, 401);
  assert.equal((await call(s, { key: "claude-opus", secret: OPUS, body: '{"v":1}', eventId: "evt-20000003" })).status, 400);
  const off = await call(s, { key: "claude-opus", secret: OPUS, body, eventId: "evt-20000004" });
  assert.equal(off.status, 200); assert.equal(JSON.parse(off.body).allow, false);
});
test("readiness: per-agent secrets required, shared values and legacy-only flagged, values never leaked", () => {
  assert.equal(callbackSecretStatus({ RUN_CALLBACK_SECRET_CLAUDE_OPUS: OPUS, RUN_CALLBACK_SECRET_CLAUDE_SONNET: OPUS }).shared, true);
  const shared = computeReadiness({ RUN_CALLBACK_SECRET_CLAUDE_OPUS: OPUS, RUN_CALLBACK_SECRET_CLAUDE_SONNET: OPUS }).items.find((i) => i.id === "callback")!;
  assert.equal(shared.state, "blocked"); assert.ok(!JSON.stringify(shared).includes(OPUS));
  assert.equal(callbackSecretStatus({ RUN_CALLBACK_SECRET_CLAUDE: "x".repeat(40) }).legacyOnly, true);
  assert.equal(computeReadiness({ RUN_CALLBACK_SECRET_CLAUDE: "x".repeat(40) }).items.find((i) => i.id === "callback")!.state, "missing");
  assert.equal(computeReadiness(ENV).items.find((i) => i.id === "callback")!.state, "ok");
});
test("gate evidence: none/fresh/stale, surfaced in snapshot; never claims control", async () => {
  assert.equal(gateEvidence(undefined, Date.parse(NOW)).state, "none");
  const c = { at: NOW, allowed: false, count: 1 };
  assert.equal(gateEvidence(c, Date.parse(NOW) + 1000).state, "fresh");
  assert.equal(gateEvidence(c, Date.parse(NOW) + 48 * 3600_000).state, "stale");
  const s = new MemoryRunStore();
  await checkExternalGate(s, { agent: "codex", issueNumber: 1 }, "evt-00000005", NOW);
  const snap = buildSnapshot(await s.read(), NOW);
  assert.equal(snap.agents.find((a) => a.key === "codex")?.externalGate.state, "fresh");
  assert.equal(snap.agents.find((a) => a.key === "gpt")?.externalGate.state, "none");
});
test("gate response signature is deterministic and secret-bound", () => {
  assert.equal(signGateResponse("a", NOW, "e", "{}"), signGateResponse("a", NOW, "e", "{}"));
  assert.notEqual(signGateResponse("a", NOW, "e", "{}"), signGateResponse("b", NOW, "e", "{}"));
});

const res = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
test("github probe: unconfigured / live / error, GET only, token never returned", async () => {
  assert.equal((await probeGitHub({})).state, "unconfigured");
  let seen: { method?: string; url?: string } = {};
  const live = await probeGitHub({ GITHUB_REPO: "o/r", GITHUB_READ_TOKEN: "SECRETTOK" }, (async (u: unknown, i?: RequestInit) => { seen = { method: i?.method, url: String(u) }; return String(u).endsWith("/issues?state=open&per_page=1") ? res(200, []) : res(200, { open_issues_count: 3 }); }) as typeof fetch);
  assert.equal(live.state, "live"); assert.equal(live.tokenSource, "dedicated"); assert.equal(live.openIssues, 3);
  assert.equal(live.readOnly, "unknown"); assert.equal(seen.method, "GET"); assert.equal(live.issues, "readable");
  assert.ok(!JSON.stringify(live).includes("SECRETTOK"));
  assert.equal((await probeGitHub({ GITHUB_REPO: "o/r", GITHUB_TOKEN: "t" }, (async () => res(401, {})) as typeof fetch)).state, "error");
  assert.equal((await probeGitHub({ GITHUB_REPO: "o/r", GITHUB_TOKEN: "t" }, (async () => { throw new Error("x"); }) as typeof fetch)).state, "error");
  assert.equal(githubReadConfig({ GITHUB_REPO: "o/r", GITHUB_TOKEN: "t" }).tokenSource, "shared");
});
test("work queue prefers GITHUB_READ_TOKEN", async () => {
  let auth = "";
  await readGitHubWorkQueue({ GITHUB_REPO: "o/r", GITHUB_TOKEN: "WRITE", GITHUB_READ_TOKEN: "READ" }, (async (_u: unknown, i?: RequestInit) => { auth = String((i?.headers as Record<string, string>).Authorization); return res(200, []); }) as typeof fetch);
  assert.equal(auth, "Bearer READ");
});
test("github probe: repo GET ok but Issues not readable => error (not live)", async () => {
  const env = { GITHUB_REPO: "o/r", GITHUB_READ_TOKEN: "t" };
  const f = (issuesStatus: number, repo: object = { open_issues_count: 1 }) => (async (u: unknown) => (String(u).includes("/issues") ? res(issuesStatus, {}) : res(200, repo))) as typeof fetch;
  const denied = await probeGitHub(env, f(403)); assert.equal(denied.state, "error"); assert.equal(denied.issues, "denied");
  const gone = await probeGitHub(env, f(410)); assert.equal(gone.issues, "disabled");
  const off = await probeGitHub(env, f(200, { has_issues: false })); assert.equal(off.state, "error"); assert.equal(off.issues, "disabled");
  const notList = await probeGitHub(env, (async () => res(200, { open_issues_count: 1 })) as typeof fetch); assert.equal(notList.state, "error");
});

test("#67: github probe verifies the evidence reads (pulls, comments, reviews, commits) without changing queue liveness", async () => {
  const env = { GITHUB_REPO: "o/r", GITHUB_READ_TOKEN: "SECRETTOK" };
  const route = (over: Record<string, number> = {}, pulls: unknown[] = [{ number: 9 }]) => {
    const seen: string[] = [];
    const f = (async (u: unknown, i?: RequestInit) => {
      const url = String(u).replace("https://api.github.com/repos/o/r", ""); seen.push(`${i?.method} ${url}`);
      const key = url.startsWith("/pulls/9/reviews") ? "reviews" : url.startsWith("/pulls/9/commits") ? "commits" : url.startsWith("/pulls") ? "pulls" : url.startsWith("/issues/comments") ? "comments" : url.startsWith("/issues") ? "issues" : "repo";
      if (over[key]) return res(over[key], {});
      return key === "repo" ? res(200, { open_issues_count: 1 }) : key === "pulls" ? res(200, pulls) : res(200, []);
    }) as typeof fetch;
    return { f, seen };
  };
  const all = route(); const ok = await probeGitHub(env, all.f);
  assert.equal(ok.state, "live"); assert.deepEqual(ok.evidenceReads, { pulls: "readable", comments: "readable", reviews: "readable", commits: "readable" });
  assert.ok(all.seen.every((x) => x.startsWith("GET "))); assert.ok(all.seen.some((x) => x.includes("/pulls/9/commits")));
  assert.ok(!JSON.stringify(ok).includes("SECRETTOK"));
  const noPr = await probeGitHub(env, route({ pulls: 403 }).f);
  assert.equal(noPr.state, "live", "queue stays live"); assert.equal(noPr.evidenceReads.pulls, "denied"); assert.equal(noPr.evidenceReads.reviews, "not_probed");
  assert.equal((await probeGitHub(env, route({ comments: 403 }).f)).evidenceReads.comments, "denied");
  assert.equal((await probeGitHub(env, route({ reviews: 404 }).f)).evidenceReads.reviews, "denied");
  assert.equal((await probeGitHub(env, route({ commits: 500 }).f)).evidenceReads.commits, "error");
  assert.deepEqual((await probeGitHub(env, route({}, []).f)).evidenceReads, { pulls: "readable", comments: "readable", reviews: "no_sample", commits: "no_sample" });
  // Queue not live => evidence endpoints are not probed at all.
  assert.equal((await probeGitHub(env, route({ issues: 403 }).f)).evidenceReads.pulls, "not_probed");
});
