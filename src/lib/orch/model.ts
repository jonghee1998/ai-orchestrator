// Orchestrator engine (scripts/orch) → dashboard view model. Pure: no I/O.
// Source of truth is the run Issue body: plan (first ```json block) + <!-- orch-state:v1 {...} --> marker.
// ON/OFF switches are GitHub repository variables (ORCH_*), the same values the Actions engine reads.

export type OrchStatus =
  | "waiting" | "implementing" | "reviewing" | "fixing" | "blocked"
  | "finalizing" | "awaiting_merge" | "done" | "cancelled";

export const STATUS_LABEL: Record<OrchStatus, string> = {
  waiting: "시작 전",
  implementing: "구현 중",
  reviewing: "검수 중",
  fixing: "수정 중",
  blocked: "중단 · 판단 필요",
  finalizing: "최종 확인 중",
  awaiting_merge: "머지 승인 대기",
  done: "완료",
  cancelled: "취소",
};

export interface OrchRun {
  repo: string;
  number: number;
  url: string;
  goal: string;
  status: OrchStatus;
  statusLabel: string;
  step: number | null;
  total: number;
  passed: number;
  pr: number | null;
  finalPr: number | null;
  retries: number;
  held: string | null;
  reason: string | null;
  updatedAt: string | null;
  needsUser: boolean;
  next: string;
}

export interface IssueLike {
  number: number;
  html_url: string;
  title: string;
  body?: string | null;
  state?: string;
  labels?: { name?: string }[];
}

const STATE_RE = /<!-- orch-state:v1 ([\s\S]*?) -->/;
const PLAN_RE = /```json[^\n]*\n([\s\S]*?)```/;
const STATUSES = new Set<string>(Object.keys(STATUS_LABEL));

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function parseJson(text: string | undefined): Json | null {
  if (!text) return null;
  try { return obj(JSON.parse(text)); } catch { return null; }
}

/** Parse one run Issue. Returns null when the Issue is not an orchestrator plan. */
export function parseRun(repo: string, issue: IssueLike): OrchRun | null {
  const body = issue.body ?? "";
  const plan = parseJson(PLAN_RE.exec(body)?.[1]);
  const steps = Array.isArray(plan?.steps) ? (plan!.steps as unknown[]) : null;
  if (!plan || !steps || !str(plan.goal)) return null;
  const st = parseJson(STATE_RE.exec(body)?.[1]);
  const raw = st && st.v === 1 ? str(st.status) : null;
  const status: OrchStatus = raw && STATUSES.has(raw) ? (raw as OrchStatus) : "waiting";
  const passedMap = obj(st?.passed) ?? {};
  const held = str(obj(st?.held)?.reason);
  const reason = status === "blocked" ? str(st?.reason) : null;
  const finalPr = num(st?.finalPr);
  const pr = num(st?.pr);
  const needsUser = status === "blocked" || status === "awaiting_merge";
  const next =
    status === "waiting" ? "계획 확인 후 orch:go 라벨을 붙이면 시작"
    : status === "blocked" ? "사유 확인 후 orch:go(재개) 또는 orch:cancel"
    : status === "awaiting_merge" ? `최종 PR #${finalPr ?? "?"} 완공 보고서 확인 후 머지`
    : held ? "스위치가 켜지면 자동으로 이어감"
    : status === "finalizing" ? "최종 CI 통과 시 자동 머지"
    : status === "done" || status === "cancelled" ? "없음"
    : "자동 진행 중";
  return {
    repo,
    number: issue.number,
    url: issue.html_url,
    goal: str(plan.goal)!,
    status,
    statusLabel: held && ["implementing", "fixing", "reviewing"].includes(status) ? `대기 · ${STATUS_LABEL[status]}` : STATUS_LABEL[status],
    step: num(st?.step),
    total: steps.length,
    passed: Object.keys(passedMap).length,
    pr,
    finalPr,
    retries: num(st?.retries) ?? 0,
    held,
    reason,
    updatedAt: str(st?.updatedAt),
    needsUser,
    next,
  };
}

// ---------------------------------------------------------------- switches

export const SWITCH_VARS = {
  sonnet: "ORCH_SONNET",
  opus: "ORCH_OPUS",
  codex: "ORCH_CODEX",
  paused: "ORCH_PAUSED",
  window: "ORCH_WINDOW",
} as const;
export type SwitchKey = keyof typeof SWITCH_VARS;
export type FlagKey = Exclude<SwitchKey, "window">;
export const FLAG_KEYS: FlagKey[] = ["sonnet", "opus", "codex", "paused"];

export interface Switches { sonnet: boolean; opus: boolean; codex: boolean; paused: boolean; window: string }

const OFF_RE = /^(off|false|0|no|disabled?)$/i;
const ON_RE = /^(on|true|1|yes|enabled?)$/i;
const flag = (v: string | undefined, dflt: boolean) => {
  const t = (v ?? "").trim();
  if (!t) return dflt;
  if (OFF_RE.test(t)) return false;
  if (ON_RE.test(t)) return true;
  return dflt;
};

/** Same defaults as scripts/orch/core.mjs readSwitches: unset → AI on, not paused, no window. */
export function switchesFromVars(vars: { name: string; value: string }[]): Switches {
  const get = (k: string) => vars.find((v) => v.name === k)?.value;
  return {
    sonnet: flag(get(SWITCH_VARS.sonnet), true),
    opus: flag(get(SWITCH_VARS.opus), true),
    codex: flag(get(SWITCH_VARS.codex), true),
    paused: flag(get(SWITCH_VARS.paused), false),
    window: (get(SWITCH_VARS.window) ?? "").trim(),
  };
}

const WINDOW_RE = /^([01]\d|2[0-3]):[0-5]\d\s*-\s*([01]\d|2[0-4]):[0-5]\d$/;

/** Validate a dashboard change into the repository variable write it implies. */
export function switchChange(key: unknown, value: unknown): { ok: true; name: string; value: string } | { ok: false; error: string } {
  if (typeof key !== "string" || !Object.prototype.hasOwnProperty.call(SWITCH_VARS, key)) return { ok: false, error: "unknown_switch" };
  const k = key as SwitchKey;
  if (k === "window") {
    if (typeof value !== "string") return { ok: false, error: "bad_value" };
    const v = value.trim();
    if (v && !WINDOW_RE.test(v)) return { ok: false, error: "bad_window" };
    return { ok: true, name: SWITCH_VARS.window, value: v };
  }
  if (typeof value !== "boolean") return { ok: false, error: "bad_value" };
  return { ok: true, name: SWITCH_VARS[k], value: value ? "on" : "off" };
}

/** Repos the dashboard may read and change: ORCH_REPOS (comma list) or GITHUB_REPO. */
export function configuredRepos(env: Readonly<Record<string, string | undefined>>): string[] {
  const raw = env.ORCH_REPOS?.trim() || env.GITHUB_REPO?.trim() || "";
  return [...new Set(raw.split(",").map((s) => s.trim()).filter((s) => /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][\w.-]*$/.test(s) && !s.includes("..")))];
}

export interface RepoView {
  repo: string;
  switches: Switches | null;
  switchesError: string | null;
  runs: OrchRun[];
  runsError: string | null;
}

/** Active runs first (needs-user first), then recent finished ones. */
export function sortRuns(runs: OrchRun[]): OrchRun[] {
  const rank = (r: OrchRun) => (r.needsUser ? 0 : ["done", "cancelled"].includes(r.status) ? 2 : 1);
  return [...runs].sort((a, b) => rank(a) - rank(b) || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}
