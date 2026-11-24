import assert from "node:assert/strict";
import test from "node:test";
import type { SwitchKey, Switches } from "./model";
import { alignResultMessage, alignSwitches, differsText, switchResultMessage, type SwitchAllResponse } from "./switchUi";

const OK = (repo: string) => ({ repo, saved: true, woke: true });
const ALL_OK = /^\d+개 프로젝트에 적용$/;
const r200 = (results: unknown[]) => ({ status: 200, body: { ok: true, results } });

// ---------------------------------------------------------------- switchResultMessage

test("switchResultMessage: every repo saved and woke → '{n}개 프로젝트에 적용' (ok tone)", () => {
  assert.deepEqual(switchResultMessage(r200([OK("o/a"), OK("o/b"), OK("o/c")])), { tone: "ok", text: "3개 프로젝트에 적용" });
});

test("switchResultMessage: saved but a wake failed → count only, no success or timing wording", () => {
  const m = switchResultMessage(r200([OK("o/a"), { repo: "o/b", saved: true, woke: false }]));
  assert.deepEqual(m, { tone: "warn", text: "저장 2개 · 즉시 실행 요청 실패 1개" });
  assert.doesNotMatch(m.text, ALL_OK);
  assert.doesNotMatch(m.text, /분|반영/);
});

test("switchResultMessage: a save failure → warn '일부 실패: 저장소 · 오류', never the full-success text", () => {
  const m = switchResultMessage({ status: 200, body: { ok: false, results: [OK("o/a"), { repo: "o/b", saved: false, woke: false, error: "GitHub 403" }] } });
  assert.equal(m.tone, "warn");
  assert.equal(m.text, "일부 실패: b · GitHub 403");
  assert.doesNotMatch(m.text, ALL_OK);
});

test("switchResultMessage: save failure plus wake failure names both repos", () => {
  const m = switchResultMessage(r200([{ repo: "o/a", saved: true, woke: false }, { repo: "o/b", saved: false, woke: false, error: "GitHub 500" }]));
  assert.equal(m.text, "일부 실패: b · GitHub 500 / 즉시 실행 요청 실패 a");
});

test("switchResultMessage: every repo failed → '모두 실패'", () => {
  const m = switchResultMessage(r200([{ repo: "o/a", saved: false, woke: false, error: "GitHub 403" }]));
  assert.deepEqual(m, { tone: "warn", text: "모두 실패: a · GitHub 403" });
});

test("switchResultMessage: no target repos → '적용할 프로젝트 없음'", () => {
  const m = switchResultMessage({ status: 200, body: { ok: false, results: [] } });
  assert.deepEqual(m, { tone: "warn", text: "적용할 프로젝트 없음" });
});

test("switchResultMessage: 503 → existing write-token wording; other errors and network failure → '저장 실패'", () => {
  const m503 = switchResultMessage({ status: 503, body: { error: "write_unconfigured" } });
  assert.equal(m503.tone, "warn");
  assert.match(m503.text, /쓰기 토큰\(ORCH_GITHUB_TOKEN\)이 없어/);
  assert.deepEqual(switchResultMessage({ status: 400, body: { error: "bad_window" } }), { tone: "warn", text: "저장 실패 · bad_window" });
  assert.deepEqual(switchResultMessage({ status: 0, body: null }), { tone: "warn", text: "저장 실패 · 네트워크 오류" });
  assert.deepEqual(switchResultMessage({ status: 200, body: { ok: true } }), { tone: "warn", text: "저장 실패 · HTTP 200" });
  for (const m of [m503]) assert.doesNotMatch(m.text, ALL_OK);
});

// ---------------------------------------------------------------- differsText

test("differsText: key labels with short repo names; none → null", () => {
  assert.equal(differsText([]), null);
  assert.equal(differsText([{ key: "codex", repos: ["o/b"] }, { key: "window", repos: ["o/b", "o/c"] }]), "일부 프로젝트 값이 다름: Codex(b) · 작업 시간대(b, c)");
});

// ---------------------------------------------------------------- alignSwitches / alignResultMessage

const VALUE: Switches = { sonnet: true, opus: true, codex: false, paused: false, auto: false, window: "08:00-24:00" };

test("alignSwitches: only differing keys, in FLAG_KEYS → window order, with the reference value", async () => {
  const calls: [SwitchKey, boolean | string][] = [];
  const out = await alignSwitches(VALUE, [{ key: "window", repos: ["o/b"] }, { key: "codex", repos: ["o/b"] }], async (k, v) => { calls.push([k, v]); return r200([OK("o/a"), OK("o/b")]); });
  assert.deepEqual(calls, [["codex", false], ["window", "08:00-24:00"]]);
  assert.deepEqual(out.map((k) => k.key), ["codex", "window"]);
  assert.deepEqual(alignResultMessage(out), { tone: "ok", text: "모두 맞춤 · Codex, 작업 시간대" });
});

test("alignSwitches mixed: first key rejected → next keys continue; one key save failure, another wake failure, all identified", async () => {
  // 기준 값의 작업 시간대가 형식에 맞지 않음(옛 값) → switchChange 거부, 요청 없음
  const value: Switches = { ...VALUE, window: "아무때나" };
  const differs = [{ key: "sonnet" as const, repos: ["o/b"] }, { key: "opus" as const, repos: ["o/b"] }, { key: "codex" as const, repos: ["o/c"] }, { key: "window" as const, repos: ["o/b"] }];
  const replies: Record<string, () => Promise<SwitchAllResponse>> = {
    sonnet: async () => { throw new Error("offline"); }, // 요청 실패
    opus: async () => ({ status: 200, body: { ok: false, results: [OK("o/a"), { repo: "o/b", saved: false, woke: false, error: "GitHub 403" }] } }),
    codex: async () => r200([OK("o/a"), { repo: "o/c", saved: true, woke: false }]),
  };
  const calls: string[] = [];
  const out = await alignSwitches(value, differs, (k) => { calls.push(k); return replies[k](); });
  assert.deepEqual(calls, ["sonnet", "opus", "codex"]); // window 은 거부되어 요청하지 않음, 앞 키 실패에도 계속
  assert.deepEqual(out, [
    { key: "sonnet", rejected: "네트워크 오류", results: [] },
    { key: "opus", results: [OK("o/a"), { repo: "o/b", saved: false, woke: false, error: "GitHub 403" }] },
    { key: "codex", results: [OK("o/a"), { repo: "o/c", saved: true, woke: false }] },
    { key: "window", rejected: "bad_window", results: [] },
  ]);
  const m = alignResultMessage(out);
  assert.equal(m.tone, "warn");
  assert.equal(m.text, "일부 실패: Sonnet: 거부(네트워크 오류) / Opus: b(저장 실패) / Codex: c(즉시 실행 실패) / 작업 시간대: 거부(bad_window)");
  assert.doesNotMatch(m.text, /모두 맞춤|프로젝트에 적용/);
});

test("alignSwitches: window rejected by switchChange, other key succeeds → still not a full success", async () => {
  const out = await alignSwitches({ ...VALUE, window: "x" }, [{ key: "window", repos: ["o/b"] }, { key: "paused", repos: ["o/b"] }], async () => r200([OK("o/a")]));
  assert.deepEqual(out.map((k) => [k.key, k.rejected ?? null]), [["paused", null], ["window", "bad_window"]]);
  assert.deepEqual(alignResultMessage(out), { tone: "warn", text: "일부 실패: 작업 시간대: 거부(bad_window)" });
});

test("alignSwitches: HTTP error, 503 and empty targets are per-key rejections", async () => {
  const replies: Record<string, SwitchAllResponse> = {
    sonnet: { status: 502, body: { error: "github_error" } },
    opus: { status: 503, body: { error: "write_unconfigured" } },
    codex: { status: 200, body: { ok: false, results: [] } },
  };
  const out = await alignSwitches(VALUE, [{ key: "sonnet", repos: ["o/b"] }, { key: "opus", repos: ["o/b"] }, { key: "codex", repos: ["o/b"] }], async (k) => replies[k]);
  assert.deepEqual(out.map((k) => k.rejected), ["github_error", "쓰기 토큰 없음", "적용할 프로젝트 없음"]);
  assert.equal(alignResultMessage(out).tone, "warn");
});
