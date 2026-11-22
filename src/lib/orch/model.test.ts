import assert from "node:assert/strict";
import test from "node:test";
import { STATUS_LABEL, approveMessage, configuredRepos, parseRun, planReviewBadge, sortRuns, switchChange, switchesFromVars } from "./model";
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
  assert.equal(STATUS_LABEL.awaiting_merge, "반영 승인 대기");
  assert.equal(merge.next, "완공 보고서 확인 후 반영 (최종 PR #20)");
  assert.equal(parseRun("o/r", issue(9, { status: "awaiting_merge" }))!.next, "완공 보고서 확인 후 반영 (최종 PR #?)");
  assert.equal(parseRun("o/r", issue(10, { status: "finalizing" }))!.next, "최종 CI 통과 시 자동 반영");

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

import { requestUsageRun } from "./github";

test("manual usage refresh: dispatches unless a run started within 2 minutes", async () => {
  const now = Date.parse("2026-11-21T04:00:00Z");
  const calls: string[] = [];
  const fake = (lastRun: string) => (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method}`);
    if (String(url).includes("/runs")) return new Response(JSON.stringify({ workflow_runs: [{ created_at: lastRun }] }), { status: 200 });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const env = { ORCH_GITHUB_TOKEN: "t" };
  assert.equal(await requestUsageRun("o/r", env, now, undefined, fake("2026-11-21T03:59:00Z")), "running");
  assert.equal(await requestUsageRun("o/r", env, now, undefined, fake("2026-11-21T03:50:00Z")), "requested", "10 minutes ago is fine for a manual press");
  assert.deepEqual(calls, ["GET", "GET", "POST"]);
  assert.equal(await requestUsageRun("o/r", {}, now, undefined, fake("2026-11-21T03:50:00Z")), "unavailable");
});

// ---- steps (list, state, checks)
const stepsOf = (n: number, state: object | null, steps = 3) => {
  const body = `${planBlock(steps)}${state ? `\n<!-- orch-state:v1 ${JSON.stringify({ v: 1, ...state })} -->` : ""}`;
  return parseRun("o/r", { number: n, html_url: "u", title: "t", body })!;
};
const states = (r: { steps: { state: string }[] }) => r.steps.map((s) => s.state);

test("parseRun steps: in progress → passed / current / pending", () => {
  const r = stepsOf(20, { status: "implementing", step: 2, passed: { 1: true } });
  assert.deepEqual(states(r), ["passed", "current", "pending"]);
  assert.equal(r.passed, 1);
  assert.deepEqual(r.steps[0], { id: 1, title: "s1", state: "passed", checks: [{ text: "x", done: true }] });
  assert.deepEqual(r.steps[1].checks, [{ text: "x", done: false }]);
});

test("parseRun steps: blocked keeps the stopped step current", () => {
  assert.deepEqual(states(stepsOf(21, { status: "blocked", step: 2, passed: { 1: 5 }, reason: "r" })), ["passed", "current", "pending"]);
});

test("parseRun steps: done / awaiting_merge / finalizing → all passed, checks done", () => {
  for (const status of ["done", "awaiting_merge", "finalizing"]) {
    const r = stepsOf(22, { status, step: 3 });
    assert.deepEqual(states(r), ["passed", "passed", "passed"]);
    assert.equal(r.passed, 3);
    assert.ok(r.steps.every((s) => s.checks.every((c) => c.done)));
  }
});

test("parseRun steps: waiting / cancelled → no current", () => {
  assert.deepEqual(states(stepsOf(23, null)), ["pending", "pending", "pending"]);
  assert.deepEqual(states(stepsOf(24, { status: "waiting", step: 1 })), ["pending", "pending", "pending"]);
  assert.deepEqual(states(stepsOf(25, { status: "cancelled", step: 2, passed: { 1: 3 } })), ["passed", "pending", "pending"]);
});

test("parseRun steps: string key with PR number value", () => {
  const r = stepsOf(26, { status: "reviewing", step: 3, passed: { "1": 41, "2": 42 } });
  assert.deepEqual(states(r), ["passed", "passed", "current"]);
  assert.equal(r.passed, 2);
  assert.deepEqual(states(stepsOf(27, { status: "implementing", step: 1, passed: {} })), ["current", "pending", "pending"]);
});

test("parseRun steps: malformed input does not throw", () => {
  const plan = {
    goal: "g",
    steps: [null, "x", 7, { id: 1.5, title: "frac" }, { id: "2", title: "str" },
      { id: 3, title: "ok", done_when: "not array" },
      { id: 4, title: "t".repeat(300), done_when: [1, null, "a".repeat(300), "  ", "good"] }],
  };
  const body = "```json\n" + JSON.stringify(plan) + "\n```";
  const r = parseRun("o/r", { number: 30, html_url: "u", title: "t", body })!;
  assert.deepEqual(r.steps.map((s) => s.id), [3, 4]);
  assert.deepEqual(r.steps[0].checks, []);
  assert.equal(r.steps[1].title.length, 200);
  assert.deepEqual(r.steps[1].checks.map((c) => c.text.length), [200, 4]);
});

test("parseRun: prose mention of the state marker in the plan context does not break state (run #239)", () => {
  const body = "설명: <!-- orch-state:v1 --> 마커를 읽는다\n\n```json\n" + JSON.stringify({ goal: "g", steps: [{ id: 1, title: "t", task: "x", done_when: ["d"] }] }) + "\n```\n<!-- orch-state:v1 " + JSON.stringify({ v: 1, status: "implementing", step: 1 }) + " -->";
  const r = parseRun("o/r", { number: 1, title: "[plan] g", html_url: "u", body });
  assert.equal(r?.status, "implementing");
});

test("planReviewBadge: none / OK / REVISE / ERROR / stale", () => {
  const rv = (verdict: "OK" | "REVISE" | "ERROR", stale = false, round = 2) => ({ round, verdict, reviewer: "codex", at: null, hash: "h", stale });
  assert.deepEqual(planReviewBadge(null), { text: "감사 전", tone: "muted", revise: false });
  assert.deepEqual(planReviewBadge(rv("OK")), { text: "감사 OK 2/3", tone: "ok", revise: false });
  assert.deepEqual(planReviewBadge(rv("REVISE", false, 1)), { text: "수정 필요 1/3", tone: "warn", revise: true });
  assert.deepEqual(planReviewBadge(rv("ERROR")), { text: "감사 실패", tone: "danger", revise: false });
  for (const v of ["OK", "REVISE", "ERROR"] as const) assert.equal(planReviewBadge(rv(v, true)).text, "감사 후 수정됨 · 재감사 대기");
});

test("approveMessage: success, plan_changed and errors", () => {
  assert.equal(approveMessage(200, { ok: true }).ok, true);
  assert.deepEqual(approveMessage(409, { error: "plan_changed" }), { ok: false, text: "계획이 바뀌었습니다. 새로고침 후 다시 확인하세요" });
  assert.match(approveMessage(409, { error: "not_pending" }).text, /승인 대기 계획이 아닙니다/);
  assert.match(approveMessage(503, { error: "write_unconfigured" }).text, /ORCH_GITHUB_TOKEN/);
  assert.match(approveMessage(401, { error: "unauthorized" }).text, /관리자 로그인/);
  assert.equal(approveMessage(502, { error: "github_error", detail: "권한 없음 또는 저장소 없음" }).text, "승인 실패 · 권한 없음 또는 저장소 없음");
  assert.equal(approveMessage(500, null).ok, false);
});
