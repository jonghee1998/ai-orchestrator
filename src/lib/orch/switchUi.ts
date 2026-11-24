// AI 팀 탭 'AI ON/OFF' (모든 프로젝트에 한 번에 적용): 응답 → 사용자 문구, '모두 맞추기' 순차 저장.
// 화면(OrchSwitchesPanel)과 분리한 순수 함수라 DOM 없이 테스트한다.
import { FLAG_KEYS, switchChange, type MergedSwitches, type SwitchKey, type Switches } from "./model";
import type { SwitchAllRepoResult } from "./switchAll";

export type SwitchTone = "ok" | "warn";
export interface SwitchMessage { tone: SwitchTone; text: string }

/** 짧은 키 이름: 차이 줄·실패 메시지에 쓴다. */
export const SWITCH_LABEL: Record<SwitchKey, string> = { sonnet: "Sonnet", opus: "Opus", codex: "Codex", paused: "일시정지", auto: "자동 모드", codexDev: "Codex 개발", window: "작업 시간대" };

export const WRITE_UNCONFIGURED_TEXT = "서버에 쓰기 토큰(ORCH_GITHUB_TOKEN)이 없어 읽기만 가능합니다.";

const short = (repo: string) => repo.split("/")[1] ?? repo;

/** POST /api/orch { key, value, scope: "all" } 의 HTTP 상태와 본문. status 0 = 네트워크 오류. */
export interface SwitchAllResponse { status: number; body: unknown }

function bodyResults(body: unknown): SwitchAllRepoResult[] | null {
  const r = (body as { results?: unknown } | null)?.results;
  return Array.isArray(r) ? (r as SwitchAllRepoResult[]) : null;
}
function bodyError(res: SwitchAllResponse): string {
  if (res.status === 0) return "네트워크 오류";
  const b = res.body as { detail?: unknown; error?: unknown } | null;
  return typeof b?.detail === "string" ? b.detail : typeof b?.error === "string" ? b.error : `HTTP ${res.status}`;
}

/**
 * 한 번의 scope all 저장 결과 → 문구. 전체 성공 문구('{n}개 프로젝트에 적용')는 모든 저장소가 저장·깨우기 성공일 때만.
 * 503 = 쓰기 토큰 없음, 다른 오류 상태 = '저장 실패 · 사유', 빈 대상 = '적용할 프로젝트 없음'.
 */
export function switchResultMessage(res: SwitchAllResponse): SwitchMessage {
  if (res.status === 503) return { tone: "warn", text: `저장 실패 · ${WRITE_UNCONFIGURED_TEXT}` };
  const results = res.status === 200 ? bodyResults(res.body) : null;
  if (!results) return { tone: "warn", text: `저장 실패 · ${bodyError(res)}` };
  if (results.length === 0) return { tone: "warn", text: "적용할 프로젝트 없음" };
  const failed = results.filter((r) => !r.saved);
  const noWake = results.filter((r) => r.saved && !r.woke);
  if (failed.length) {
    const parts = failed.map((r) => `${short(r.repo)} · ${r.error ?? "저장 실패"}`);
    if (noWake.length) parts.push(`즉시 실행 요청 실패 ${noWake.map((r) => short(r.repo)).join(", ")}`);
    return { tone: "warn", text: `${failed.length === results.length ? "모두 실패" : "일부 실패"}: ${parts.join(" / ")}` };
  }
  if (noWake.length) return { tone: "warn", text: `저장 ${results.length}개 · 즉시 실행 요청 실패 ${noWake.length}개` };
  return { tone: "ok", text: `${results.length}개 프로젝트에 적용` };
}

/** 카드 위 경고 한 줄: '일부 프로젝트 값이 다름: Codex(orch-second) · 작업 시간대(a, b)'. 다름이 없으면 null. */
export function differsText(differs: MergedSwitches["differs"]): string | null {
  if (!differs.length) return null;
  return `일부 프로젝트 값이 다름: ${differs.map((d) => `${SWITCH_LABEL[d.key]}(${d.repos.map(short).join(", ")})`).join(" · ")}`;
}

/** '모두 맞추기' 키 하나의 결과. rejected = switchChange 거부 또는 요청 실패 사유(그 키는 쓰지 않았거나 결과를 모름). */
export interface AlignKeyResult { key: SwitchKey; rejected?: string; results: SwitchAllRepoResult[] }

export type SwitchPoster = (key: SwitchKey, value: boolean | string) => Promise<SwitchAllResponse>;

/**
 * 다른 키만 기준 값(value)으로 차례로 scope all 저장. 한 키가 거부·실패해도 그 키만 실패로 남기고 다음 키를 계속한다.
 * 순서는 differs 순서(FLAG_KEYS → window).
 */
export async function alignSwitches(value: Switches, differs: MergedSwitches["differs"], post: SwitchPoster): Promise<AlignKeyResult[]> {
  const out: AlignKeyResult[] = [];
  const order: SwitchKey[] = [...FLAG_KEYS, "window"];
  const keys = order.filter((k) => differs.some((d) => d.key === k));
  for (const key of keys) {
    const v = value[key];
    const check = switchChange(key, v);
    if (!check.ok) { out.push({ key, rejected: check.error, results: [] }); continue; }
    let res: SwitchAllResponse;
    try { res = await post(key, v); } catch { res = { status: 0, body: null }; }
    const results = res.status === 200 ? bodyResults(res.body) : null;
    if (!results) out.push({ key, rejected: res.status === 503 ? "쓰기 토큰 없음" : bodyError(res), results: [] });
    else if (!results.length) out.push({ key, rejected: "적용할 프로젝트 없음", results: [] });
    else out.push({ key, results });
  }
  return out;
}

/** '모두 맞추기' 결과 → 한 문구. 실패는 '키: 저장소(저장 실패|즉시 실행 실패)' 또는 '키: 거부(사유)'로 식별. */
export function alignResultMessage(list: AlignKeyResult[]): SwitchMessage {
  if (!list.length) return { tone: "ok", text: "맞출 값이 없습니다" };
  const bad: string[] = [];
  for (const k of list) {
    const label = SWITCH_LABEL[k.key];
    if (k.rejected) { bad.push(`${label}: 거부(${k.rejected})`); continue; }
    const fails = k.results.filter((r) => !r.saved || !r.woke).map((r) => `${short(r.repo)}(${!r.saved ? "저장 실패" : "즉시 실행 실패"})`);
    if (fails.length) bad.push(`${label}: ${fails.join(", ")}`);
  }
  if (bad.length) return { tone: "warn", text: `일부 실패: ${bad.join(" / ")}` };
  return { tone: "ok", text: `모두 맞춤 · ${list.map((k) => SWITCH_LABEL[k.key]).join(", ")}` };
}
