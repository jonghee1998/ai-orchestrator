import assert from "node:assert/strict";
import test from "node:test";
import { configuredRepos, parseRun, sortRuns, switchChange, switchesFromVars } from "./model";
import { readRepo, writeSwitch } from "./github";

const planBlock = (steps = 2) => "```json\n" + JSON.stringify({
  goal: "역할 유틸 추가",
  steps: Array.from({ length: steps }, (_, i) => ({ id: i + 1, title: `s${i + 1}`, task: "t", done_when: ["x"] })),
}) + "\n```";
const issue = (n: number, state: object | null, extra = "") => ({
  number: n, html_url: `https://gh/i/${n}`, title: "[plan] x",
  body: `${planBlock()}\n${extra}${state ? `\n<!-- orch-state:v1 ${JSON.stringify({ v: 1, ...state })} -->` : ""}`,
});

test("parseRun: plan + state marker → view model; non-plan issues ignored", () => {
  assert.equal(parseRun("o/r", { number: 1, html_url: "u", title: "t", body: "no plan" }), null);
  const waiting = parseRun("o/r", issue(2, null))!;
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.total, 2);
  assert.match(waiting.next, /orch:go/);

  const r = parseRun("o/r", issue(3, { status: "reviewing", step: 2, passed: { 1: 10 }, pr: 11, retries: 1, updatedAt: "2026-11-20T00:00:00Z" }))!;
  assert.deepEqual([r.status, r.step, r.passed, r.pr, r.retries, r.needsUser], ["reviewing", 2, 1, 11, 1, false]);
  assert.equal(r.statusLabel, "검수 중");

  const held = parseRun("o/r", issue(4, { status: "implementing", step: 1, held: { mode: "implement", reason: "Sonnet·Opus가 모두 OFF" } }))!;
  assert.equal(held.held, "Sonnet·Opus가 모두 OFF");
  assert.match(held.statusLabel, /^대기/);
  assert.match(held.next, /자동으로 이어감/);

  const blocked = parseRun("o/r", issue(5, { status: "blocked", step: 1, reason: "검증 4회 연속 실패" }))!;
  assert.equal(blocked.needsUser, true);
  assert.equal(blocked.reason, "검증 4회 연속 실패");

  const merge = parseRun("o/r", issue(6, { status: "awaiting_merge", finalPr: 20 }))!;
  assert.equal(merge.needsUser, true);
  assert.match(merge.next, /#20/);

  const bogus = parseRun("o/r", issue(7, { status: "hacked" }))!;
  assert.equal(bogus.status, "waiting", "unknown status never shown as progress");
  const broken = parseRun("o/r", { number: 8, html_url: "u", title: "t", body: `${planBlock()}\n<!-- orch-state:v1 {not json -->` })!;
  assert.equal(broken.status, "waiting");
});

test("sortRuns: needs-user first, finished last", () => {
  const mk = (n: number, s: object) => parseRun("o/r", issue(n, s))!;
  const order = sortRuns([mk(1, { status: "done" }), mk(2, { status: "implementing", step: 1 }), mk(3, { status: "blocked" })]).map((r) => r.number);
  assert.deepEqual(order, [3, 2, 1]);
});

test("switches: same defaults as the engine; dashboard changes validated", () => {
  assert.deepEqual(switchesFromVars([]), { sonnet: true, opus: true, codex: true, paused: false, window: "" });
  assert.deepEqual(switchesFromVars([{ name: "ORCH_CODEX", value: "off" }, { name: "ORCH_PAUSED", value: "on" }, { name: "ORCH_WINDOW", value: " 08:00-24:00 " }]),
    { sonnet: true, opus: true, codex: false, paused: true, window: "08:00-24:00" });
  assert.deepEqual(switchChange("codex", false), { ok: true, name: "ORCH_CODEX", value: "off" });
  assert.deepEqual(switchChange("paused", true), { ok: true, name: "ORCH_PAUSED", value: "on" });
  assert.deepEqual(switchChange("window", "22:00-06:00"), { ok: true, name: "ORCH_WINDOW", value: "22:00-06:00" });
  assert.deepEqual(switchChange("window", ""), { ok: true, name: "ORCH_WINDOW", value: "" });
  assert.equal(switchChange("window", "25:00-26:00").ok, false);
  assert.equal(switchChange("codex", "off").ok, false, "flags must be boolean");
  assert.equal(switchChange("gpt", true).ok, false);
  assert.equal(switchChange("__proto__", true).ok, false);
});

test("configuredRepos: ORCH_REPOS list, falls back to GITHUB_REPO, rejects junk", () => {
  assert.deepEqual(configuredRepos({ ORCH_REPOS: "a/b, c/d ,a/b,bad,../x" }), ["a/b", "c/d"]);
  assert.deepEqual(configuredRepos({ GITHUB_REPO: "o/r" }), ["o/r"]);
  assert.deepEqual(configuredRepos({}), []);
});

test("github I/O: reads runs+switches per repo, partial failure stays explicit; writes create-or-update then wake engine", async () => {
  const calls: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const u = new URL(url); const m = init?.method ?? "GET";
    calls.push(`${m} ${u.pathname}${u.search}`);
    const json = (s: number, b: unknown) => new Response(b === null ? null : JSON.stringify(b), { status: s });
    if (u.pathname.endsWith("/issues") && u.searchParams.get("labels") === "orch:run") return json(200, [issue(1, { status: "implementing", step: 1 }), { ...issue(2, null), pull_request: {} }]);
    if (u.pathname.endsWith("/issues")) return json(200, []);
    if (u.pathname.endsWith("/actions/variables") && m === "GET") return json(403, { message: "no" });
    if (u.pathname.endsWith("/actions/variables/ORCH_CODEX") && m === "PATCH") return json(404, {});
    if (u.pathname.endsWith("/actions/variables") && m === "POST") return json(201, {});
    if (u.pathname.endsWith("/dispatches")) return json(204, null);
    return json(500, {});
  }) as typeof fetch;

  const v = await readRepo("o/r", { ORCH_GITHUB_TOKEN: "t" }, f);
  assert.equal(v.runs.length, 1, "PRs filtered out");
  assert.equal(v.switches, null);
  assert.match(v.switchesError!, /권한/);

  await assert.rejects(writeSwitch("o/r", "ORCH_CODEX", "off", { GITHUB_TOKEN: "read-only" }, f), /not configured/, "writes never use the read token");
  calls.length = 0;
  assert.deepEqual(await writeSwitch("o/r", "ORCH_CODEX", "off", { ORCH_GITHUB_TOKEN: "t" }, f), { woke: true });
  assert.deepEqual(calls, [
    "PATCH /repos/o/r/actions/variables/ORCH_CODEX",
    "POST /repos/o/r/actions/variables",
    "POST /repos/o/r/actions/workflows/orchestrator.yml/dispatches",
  ]);
});

import { latestUsage, parseUsage } from "./model";
test("usage snapshot: parsed from marker, invalid numbers dropped, freshest repo wins", () => {
  const snap = (updatedAt: string, extra: object = {}) => `표\n<!-- orch-usage:v1 ${JSON.stringify({ v: 1, updatedAt,
    claude: { fiveHour: { pct: 23, resetsAt: "2026-11-21T00:00:00.000Z" }, sevenDay: { pct: "x", resetsAt: null } },
    claudeCheckedAt: updatedAt, claudeError: null,
    codex: { limited: true, lastReviewAt: null, quota: { fiveHour: { pct: 0, resetsAt: "2026-11-21T03:14:00.000Z" }, weekly: { pct: 100, resetsAt: "2026-11-24T00:52:30.000Z" } }, quotaCheckedAt: updatedAt, quotaError: null, needsLogin: false },
    ...extra })} -->`;
  const u = parseUsage(snap("2026-11-20T22:14:00Z"))!;
  assert.equal(u.claude!.fiveHour!.pct, 23);
  assert.equal(u.claude!.sevenDay!.pct, null, "non-number never shown as a value");
  assert.deepEqual([u.codex.weekly!.pct, u.codex.limited, u.codex.needsLogin], [100, true, false]);
  assert.equal(parseUsage("no marker"), null);
  assert.equal(parseUsage(snap("x", { v: 2 })), null);
  const noQuota = parseUsage(snap("2026-11-20T22:00:00Z", { codex: { needsLogin: true } }))!;
  assert.deepEqual([noQuota.codex.weekly, noQuota.codex.needsLogin], [null, true]);
  assert.equal(latestUsage([{ usage: noQuota }, { usage: u }, {}])!.updatedAt, "2026-11-20T22:14:00Z");
});

import { usageStale } from "./model";
import { refreshUsageIfStale } from "./github";

test("usage refresh: stale snapshot asks GitHub for a usage run, throttled; fresh or no token does nothing", async () => {
  const now = Date.parse("2026-11-21T04:00:00Z");
  const u = (at: string | null) => ({ ...(parseUsage(`<!-- orch-usage:v1 {"v":1,"updatedAt":"2026-11-21T00:00:00Z"} -->`) as NonNullable<ReturnType<typeof parseUsage>>), updatedAt: at });
  assert.equal(usageStale(null, now), false, "no usage issue → not set up");
  assert.equal(usageStale(u("2026-11-21T03:30:00Z"), now), false);
  assert.equal(usageStale(u("2026-11-21T00:29:00Z"), now), true);
  assert.equal(usageStale(u(null), now), true);

  const calls: string[] = [];
  const fake = (lastRun: string | null) => (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method} ${String(url).replace(/^https:\/\/api\.github\.com/, "")}`);
    if (String(url).includes("/runs")) return new Response(JSON.stringify({ workflow_runs: lastRun ? [{ created_at: lastRun }] : [] }), { status: 200 });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const env = { ORCH_GITHUB_TOKEN: "t" };

  assert.equal(await refreshUsageIfStale("o/r", u("2026-11-21T03:30:00Z"), env, now, fake(null)), "fresh");
  assert.equal(calls.length, 0);
  assert.equal(await refreshUsageIfStale("o/r", u("2026-11-21T00:29:00Z"), {}, now, fake(null)), "unavailable", "reads never dispatch without the write token");
  assert.equal(calls.length, 0);
  assert.equal(await refreshUsageIfStale("o/r", u("2026-11-21T00:29:00Z"), env, now, fake("2026-11-21T03:55:00Z")), "running");
  assert.deepEqual(calls, ["GET /repos/o/r/actions/workflows/usage.yml/runs?per_page=1"]);
  calls.length = 0;
  assert.equal(await refreshUsageIfStale("o/r", u("2026-11-21T00:29:00Z"), env, now, fake("2026-11-21T00:28:00Z")), "requested");
  assert.deepEqual(calls, ["GET /repos/o/r/actions/workflows/usage.yml/runs?per_page=1", "POST /repos/o/r/actions/workflows/usage.yml/dispatches"]);
});
