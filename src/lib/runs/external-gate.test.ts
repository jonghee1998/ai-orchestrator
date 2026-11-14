import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRunStore } from "./store";
import { checkExternalGate, gateEvidence, signGateResponse } from "./external-gate";
import { buildSnapshot } from "../control/service";
import { probeGitHub, githubReadConfig } from "../github/integration";
import { readGitHubWorkQueue } from "../github/github-read-queue";

const NOW = "2026-01-01T00:00:00.000Z";

test("external gate: default OFF blocks, records evidence + suppression count", async () => {
  const s = new MemoryRunStore();
  const r = await checkExternalGate(s, "claude-sonnet", "evt-00000001", NOW);
  assert.ok(r.ok && !r.allow && r.reason === "agent_disabled");
  const d = await s.read();
  assert.equal(d.gateChecks["claude-sonnet"].allowed, false);
  assert.equal(d.blocked["claude-sonnet"], 1);
});
test("external gate: allows only when enabled; replay + unknown agent rejected", async () => {
  const s = new MemoryRunStore();
  await s.transact((d) => { d.control = { ...d.control, agents: { ...d.control.agents, codex: true } }; });
  const ok = await checkExternalGate(s, "codex", "evt-00000002", NOW);
  assert.ok(ok.ok && ok.allow);
  assert.deepEqual(await checkExternalGate(s, "codex", "evt-00000002", NOW), { ok: false, reason: "replay" });
  assert.deepEqual(await checkExternalGate(s, "nope", "evt-00000003", NOW), { ok: false, reason: "unknown_agent" });
});
test("external gate: claude provider switch off blocks even if agent on", async () => {
  const s = new MemoryRunStore();
  await s.transact((d) => { d.control = { ...d.control, agents: { ...d.control.agents, "claude-opus": true }, claudeProvider: false }; });
  const r = await checkExternalGate(s, "claude-opus", "evt-00000004", NOW);
  assert.ok(r.ok && !r.allow && r.reason === "provider_disabled");
});
test("gate evidence: none/fresh/stale, surfaced in snapshot; never claims control", async () => {
  assert.equal(gateEvidence(undefined, Date.parse(NOW)).state, "none");
  const c = { at: NOW, allowed: false, count: 1 };
  assert.equal(gateEvidence(c, Date.parse(NOW) + 1000).state, "fresh");
  assert.equal(gateEvidence(c, Date.parse(NOW) + 48 * 3600_000).state, "stale");
  const s = new MemoryRunStore();
  await checkExternalGate(s, "codex", "evt-00000005", NOW);
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
  const live = await probeGitHub({ GITHUB_REPO: "o/r", GITHUB_READ_TOKEN: "SECRETTOK" }, (async (u: unknown, i?: RequestInit) => { seen = { method: i?.method, url: String(u) }; return res(200, { open_issues_count: 3 }); }) as typeof fetch);
  assert.equal(live.state, "live"); assert.equal(live.tokenSource, "dedicated"); assert.equal(live.openIssues, 3);
  assert.equal(live.readOnly, "unknown"); assert.equal(seen.method, "GET");
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
