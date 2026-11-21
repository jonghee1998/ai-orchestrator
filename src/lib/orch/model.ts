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
  awaiting_merge: "반영 승인 대기",
  done: "완료",
  cancelled: "취소",
};

export type StepState = "passed" | "current" | "pending";
export interface RunStep {
  id: number;
  title: string;
  state: StepState;
  checks: { text: string; done: boolean }[];
}

export interface OrchRun {
  steps: RunStep[];
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

/** Engine state marker: one-line JSON with < > escaped; the last valid one wins (a plan may mention the marker in prose). */
const STATE_RE = /<!-- orch-state:v1 (\{[^<>\n]*\}) -->/g;
const lastState = (body: string) => {
  let found: ReturnType<typeof parseJson> = null;
  for (const m of body.matchAll(STATE_RE)) { const j = parseJson(m[1]); if (j && j.v === 1) found = j; }
  return found;
};
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
  const st = lastState(body);
  const raw = st && st.v === 1 ? str(st.status) : null;
  const status: OrchStatus = raw && STATUSES.has(raw) ? (raw as OrchStatus) : "waiting";
  const passedMap = obj(st?.passed) ?? {};
  const curStep = num(st?.step);
  const allPassed = status === "done" || status === "awaiting_merge" || status === "finalizing";
  const runSteps: RunStep[] = [];
  for (const item of steps) {
    const s = obj(item);
    const id = s?.id;
    if (!s || typeof id !== "number" || !Number.isInteger(id)) continue;
    const state: StepState = allPassed || Object.prototype.hasOwnProperty.call(passedMap, String(id)) ? "passed"
      : status !== "waiting" && status !== "cancelled" && id === curStep ? "current"
      : "pending";
    const checks = (Array.isArray(s.done_when) ? s.done_when : [])
      .map((c) => str(c))
      .filter((c): c is string => c !== null)
      .map((c) => ({ text: c.slice(0, 200), done: state === "passed" }));
    runSteps.push({ id, title: (str(s.title) ?? `스텝 ${id}`).slice(0, 200), state, checks });
  }
  const held = str(obj(st?.held)?.reason);
  const reason = status === "blocked" ? str(st?.reason) : null;
  const finalPr = num(st?.finalPr);
  const pr = num(st?.pr);
  const needsUser = status === "blocked" || status === "awaiting_merge";
  const next =
    status === "waiting" ? "계획 확인 후 orch:go 라벨을 붙이면 시작"
    : status === "blocked" ? "사유 확인 후 orch:go(재개) 또는 orch:cancel"
    : status === "awaiting_merge" ? `완공 보고서 확인 후 반영 (최종 PR #${finalPr ?? "?"})`
    : held ? "스위치가 켜지면 자동으로 이어감"
    : status === "finalizing" ? "최종 CI 통과 시 자동 반영"
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
    passed: runSteps.filter((s) => s.state === "passed").length,
    steps: runSteps,
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

// ---------------------------------------------------------------- usage (orch:usage Issue, written by usage.yml)

export interface UsageWindow { pct: number | null; resetsAt: string | null }
export interface UsageView {
  updatedAt: string | null;
  claude: { fiveHour: UsageWindow | null; sevenDay: UsageWindow | null } | null;
  claudeCheckedAt: string | null;
  claudeError: string | null;
  codex: {
    fiveHour: UsageWindow | null;
    weekly: UsageWindow | null;
    checkedAt: string | null;
    error: string | null;
    needsLogin: boolean;
    limited: boolean;
    lastReviewAt: string | null;
  };
}

const USAGE_RE = /<!-- orch-usage:v1 ([\s\S]*?) -->/;
const window = (v: unknown): UsageWindow | null => {
  const o = obj(v);
  if (!o) return null;
  const p = num(o.pct);
  return { pct: p !== null && p >= 0 && p <= 1000 ? p : null, resetsAt: str(o.resetsAt) };
};

/** Parse the usage snapshot marker. Unknown shapes → null fields, never invented numbers. */
export function parseUsage(body: string | null | undefined): UsageView | null {
  const j = parseJson(USAGE_RE.exec(body ?? "")?.[1]);
  if (!j || j.v !== 1) return null;
  const c = obj(j.claude);
  const x = obj(j.codex) ?? {};
  const q = obj(x.quota);
  return {
    updatedAt: str(j.updatedAt),
    claude: c ? { fiveHour: window(c.fiveHour), sevenDay: window(c.sevenDay) } : null,
    claudeCheckedAt: str(j.claudeCheckedAt),
    claudeError: str(j.claudeError),
    codex: {
      fiveHour: q ? window(q.fiveHour) : null,
      weekly: q ? window(q.weekly) : null,
      checkedAt: str(x.quotaCheckedAt),
      error: str(x.quotaError),
      needsLogin: x.needsLogin === true,
      limited: x.limited === true,
      lastReviewAt: str(x.lastReviewAt),
    },
  };
}

/** Usage is account-wide: pick the freshest snapshot across repos. */
export function latestUsage(views: { usage?: UsageView | null }[]): UsageView | null {
  return views.map((v) => v.usage ?? null).filter((u): u is UsageView => !!u)
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0] ?? null;
}

/** Snapshot older than this → the dashboard asks GitHub to run usage.yml (scheduled runs are often skipped). */
export const USAGE_MAX_AGE_MS = 65 * 60_000;
/** Do not ask again while a usage run started this recently (queued, running or just finished). */
export const USAGE_RETRY_MS = 15 * 60_000;

export function usageStale(u: UsageView | null | undefined, nowMs: number, maxAgeMs = USAGE_MAX_AGE_MS): boolean {
  if (!u) return false; // no usage Issue in this repo → usage is not set up here
  const t = Date.parse(u.updatedAt ?? "");
  return !Number.isFinite(t) || nowMs - t > maxAgeMs;
}

export type UsageRefresh = "fresh" | "requested" | "running" | "unavailable";

/** A '[plan]' Issue waiting for the owner's orch:go, with the latest plan-review (audit) result. Built in plans.ts (server). */
export interface PendingPlan {
  repo: string;
  number: number;
  url: string;
  goal: string;
  steps: number;
  /** Same as scripts/orch/plan-review.mjs planHash of the normalized plan. */
  hash: string;
  review: {
    round: number;
    verdict: "OK" | "REVISE" | "ERROR";
    reviewer: string;
    at: string | null;
    hash: string;
    /** The plan changed after this review (marker hash ≠ current hash). */
    stale: boolean;
  } | null;
}

/** Plan-review rounds per plan (scripts/orch/plan-review.mjs MAX_ROUNDS). */
export const PLAN_REVIEW_ROUNDS = 3;

export type PlanBadgeTone = "ok" | "warn" | "danger" | "muted";

/** Audit badge for a pending plan card. A review of an older plan version is shown as stale, whatever its verdict. */
export function planReviewBadge(review: PendingPlan["review"]): { text: string; tone: PlanBadgeTone; revise: boolean } {
  if (!review) return { text: "감사 전", tone: "muted", revise: false };
  if (review.stale) return { text: "감사 후 수정됨 · 재감사 대기", tone: "muted", revise: false };
  const r = `${review.round}/${PLAN_REVIEW_ROUNDS}`;
  if (review.verdict === "OK") return { text: `✅ 감사 OK ${r}`, tone: "ok", revise: false };
  if (review.verdict === "REVISE") return { text: `✏️ 수정 필요 ${r}`, tone: "warn", revise: true };
  return { text: "⚠️ 감사 실패", tone: "danger", revise: false };
}

/** Result line after POST { action: 'approve' } (status + JSON body from /api/orch). */
export function approveMessage(status: number, body: { ok?: boolean; error?: string; detail?: string } | null): { ok: boolean; text: string } {
  if (status === 200 && body?.ok) return { ok: true, text: "승인함 · orch:go 라벨을 붙였습니다. 엔진이 곧 시작합니다." };
  const e = body?.error;
  if (e === "plan_changed") return { ok: false, text: "계획이 바뀌었습니다. 새로고침 후 다시 확인하세요" };
  if (e === "not_pending") return { ok: false, text: "승인 실패 · 이미 승인됐거나 승인 대기 계획이 아닙니다. 새로고침 후 확인하세요" };
  if (e === "write_unconfigured") return { ok: false, text: "승인 실패 · 서버에 쓰기 토큰(ORCH_GITHUB_TOKEN)이 없습니다" };
  if (e === "unauthorized" || status === 401 || status === 403) return { ok: false, text: "승인 실패 · 관리자 로그인이 필요합니다" };
  return { ok: false, text: `승인 실패 · ${body?.detail ?? e ?? status}` };
}

export interface RepoView {
  repo: string;
  plans: PendingPlan[];
  plansError: string | null;
  usage?: UsageView | null;
  usageRefresh?: UsageRefresh;
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
