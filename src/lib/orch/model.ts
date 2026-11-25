import type { PatchNote } from "@/lib/patchnotes";
// Orchestrator engine (scripts/orch) → dashboard view model. Pure: no I/O.
// Source of truth is the run Issue body: plan (first ```json block) + <!-- orch-state:v1 {...} --> marker.
// ON/OFF switches are GitHub repository variables (ORCH_*), the same values the Actions engine reads.

export type OrchStatus =
  | "waiting" | "implementing" | "reviewing" | "fixing" | "blocked"
  | "rechecking" | "finalizing" | "awaiting_merge" | "done" | "cancelled";

export const STATUS_LABEL: Record<OrchStatus, string> = {
  waiting: "시작 전",
  implementing: "구현 중",
  reviewing: "검수 중",
  fixing: "수정 중",
  blocked: "중단 · 판단 필요",
  rechecking: "Claude 재검수 중",
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
  /** Plan step.model (any string the engine accepts), null when unset. */
  model: string | null;
  /** Plan step.task (used only to mirror the engine's risky-text check), null when unset. */
  task: string | null;
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
  /** plan JSON max_retries (engine default 3). */
  maxRetries: number;
  /** Plan-level model (plan.model), null when unset. */
  planModel: string | null;
  held: string | null;
  reason: string | null;
  updatedAt: string | null;
  needsUser: boolean;
  next: string;
  /** Plan JSON top-level "phase" (roadmap phases[].id), null when unset or malformed. */
  phase: string | null;
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

/** Plan JSON top-level "phase": a string or integer (-> string), 1~10 chars after trim; anything else -> null. */
export function phaseOf(v: unknown): string | null {
  const s = typeof v === "number" ? (Number.isInteger(v) ? String(v) : null) : str(v);
  return s && s.length <= 10 ? s : null;
}

function parseJson(text: string | undefined): Json | null {
  if (!text) return null;
  try { return obj(JSON.parse(text)); } catch { return null; }
}

/** Same default as scripts/orch/core.mjs (DEFAULT_MAX_RETRIES = 3); missing, non-integer or negative → 3. */
const maxRetriesOf = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 3);

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
  const allPassed = status === "done" || status === "awaiting_merge" || status === "finalizing" || status === "rechecking";
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
    runSteps.push({ id, title: (str(s.title) ?? `스텝 ${id}`).slice(0, 200), state, checks, model: str(s.model), task: typeof s.task === "string" ? s.task : null });
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
    : status === "rechecking" ? "Codex 임시 통과 스텝을 Claude가 재검수한 뒤 반영"
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
    maxRetries: maxRetriesOf(plan.max_retries),
    planModel: str(plan.model),
    held,
    reason,
    updatedAt: str(st?.updatedAt),
    needsUser,
    next,
    phase: phaseOf(plan.phase),
  };
}

// ---------------------------------------------------------------- switches

export const SWITCH_VARS = {
  sonnet: "ORCH_SONNET",
  opus: "ORCH_OPUS",
  codex: "ORCH_CODEX",
  paused: "ORCH_PAUSED",
  auto: "ORCH_AUTO",
  codexDev: "ORCH_CODEX_DEV",
  window: "ORCH_WINDOW",
} as const;
export type SwitchKey = keyof typeof SWITCH_VARS;
export type FlagKey = Exclude<SwitchKey, "window">;
export const FLAG_KEYS: FlagKey[] = ["sonnet", "opus", "codex", "codexDev", "paused", "auto"];

export interface Switches { sonnet: boolean; opus: boolean; codex: boolean; paused: boolean; auto: boolean; codexDev: boolean; window: string }

const OFF_RE = /^(off|false|0|no|disabled?)$/i;
const ON_RE = /^(on|true|1|yes|enabled?)$/i;
const flag = (v: string | undefined, dflt: boolean) => {
  const t = (v ?? "").trim();
  if (!t) return dflt;
  if (OFF_RE.test(t)) return false;
  if (ON_RE.test(t)) return true;
  return dflt;
};

/** Same defaults as scripts/orch/core.mjs readSwitches: unset → AI on, not paused, auto mode off, no window. */
export function switchesFromVars(vars: { name: string; value: string }[]): Switches {
  const get = (k: string) => vars.find((v) => v.name === k)?.value;
  return {
    sonnet: flag(get(SWITCH_VARS.sonnet), true),
    opus: flag(get(SWITCH_VARS.opus), true),
    codex: flag(get(SWITCH_VARS.codex), true),
    paused: flag(get(SWITCH_VARS.paused), false),
    auto: flag(get(SWITCH_VARS.auto), false),
    codexDev: flag(get(SWITCH_VARS.codexDev), true),
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
  /** Plan JSON top-level "phase" (not part of the normalized plan / hash), null when unset or malformed. */
  phase: string | null;
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
  if (review.verdict === "OK") return { text: `감사 OK ${r}`, tone: "ok", revise: false };
  if (review.verdict === "REVISE") return { text: `수정 필요 ${r}`, tone: "warn", revise: true };
  return { text: "감사 실패", tone: "danger", revise: false };
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

/** One model's opinion on an idea (scripts/orch/idea-review.mjs clean()). */
export interface Opinion {
  value: "high" | "medium" | "low";
  effort: "S" | "M" | "L";
  risk: "high" | "medium" | "low";
  steps: number | null;
  recommend: "now" | "later" | "hold";
  reasons: string;
}

/** Owner-authored '[idea] 항목' Issue + the latest Actions-bot review (orch-idea:v1 marker). */
export interface Idea {
  repo: string;
  number: number;
  url: string;
  /** Title without the '[idea] ' prefix. */
  title: string;
  /** Issue body (the owner's own opinion), at most 4000 chars. */
  mine: string;
  createdAt: string | null;
  closed: boolean;
  /** collecting = no review yet, stale = text changed after the review, codex_pending = Claude only so far. */
  status: "collecting" | "codex_pending" | "done" | "stale";
  review: {
    recommend: "now" | "later" | "hold";
    summary: string;
    agree: string;
    disagree: string;
    at: string | null;
    claude: Opinion | null;
    codex: Opinion | null;
  } | null;
}

export type DeployMode = "batch" | "direct" | "unknown";

/** Card header deploy text: everything merged is deployed ('direct', or 'batch' with 0 pending) → '배포 완료'; pending → '배포 대기 N'; unknown/unreadable → '배포 대기 ?'. */
export function deployLabel(mode: DeployMode, pending: number | null): string {
  if (mode === "direct") return "배포 완료";
  if (mode === "batch" && pending === 0) return "배포 완료";
  if (mode === "batch" && typeof pending === "number" && pending > 0) return `배포 대기 ${pending}`;
  return "배포 대기 ?";
}

export interface RepoView {
  repo: string;
  plans: PendingPlan[];
  plansError: string | null;
  ideas: Idea[];
  ideasError: string | null;
  usage?: UsageView | null;
  usageRefresh?: UsageRefresh;
  switches: Switches | null;
  switchesError: string | null;
  runs: OrchRun[];
  runsError: string | null;
  /** docs/roadmap.json; null = no file in this repo (404) or it could not be read (then roadmapError is set). */
  roadmap: Roadmap | null;
  roadmapError: string | null;
  /** Merge commits on main since tag prod-deployed (approximation); null = no tag or read failed. */
  deployPending: number | null;
  /** compare prod-deployed...main: ok → 'batch', 404 (no tag) → 'direct' (deployed on every merge), other failure → 'unknown'. */
  deployMode: DeployMode;
  /** Card app link: ORCH_APP_URLS entry, else roadmap.json app; always null for this dashboard's own repo (isSelf). */
  app: RoadmapApp | null;
  /** ORCH_DEPLOY_EVERY (default 10). */
  deployEvery: number;
  /** docs/patchnotes.json (other projects' patch notes); null = no file (404) or unreadable (then patchNotesError). */
  patchNotes?: PatchNote[] | null;
  patchNotesError?: string | null;
  /** This dashboard's own repo (decided on the server: ORCH_SELF_REPO or SELF_REPO). Its card gets no 'app' link. */
  isSelf: boolean;
}

/** The dashboard's own repository (patch notes tab, project card without an 'app' link). The server may override it with ORCH_SELF_REPO. */
export const SELF_REPO = "jonghee1998/ai-orchestrator";

/** Server-side: is this the dashboard's own repo? ORCH_SELF_REPO (trimmed, non-empty) wins over SELF_REPO. */
export function isSelfRepo(repo: string, env: Readonly<Record<string, string | undefined>>): boolean {
  return repo === (env.ORCH_SELF_REPO?.trim() || SELF_REPO);
}

export interface MergedSwitches {
  /** The dashboard's own repo (RepoView.isSelf) switches; null when that repo is missing or unreadable (never another repo's values). */
  value: Switches | null;
  /** Per key (FLAG_KEYS then window), readable repos whose value differs from `value`. Only keys with at least one repo. */
  differs: { key: SwitchKey; repos: string[] }[];
  /** Repos whose switches could not be read (switches null), the own repo included. */
  unreadable: string[];
}

/** One switch set for "apply to every project": the own repo is the reference, the rest are compared to it. */
export function mergedSwitches(repos: RepoView[]): MergedSwitches {
  const self = repos.find((r) => r.isSelf);
  const value = self?.switches ?? null;
  const unreadable = repos.filter((r) => !r.switches).map((r) => r.repo);
  const differs: MergedSwitches["differs"] = [];
  if (value) {
    for (const key of [...FLAG_KEYS, "window"] as SwitchKey[]) {
      const list = repos.filter((r) => r.switches && r.switches[key] !== value[key]).map((r) => r.repo);
      if (list.length) differs.push({ key, repos: list });
    }
  }
  return { value: value ? { ...value } : null, differs, unreadable };
}

/** Active runs first (needs-user first), then recent finished ones. */
export function sortRuns(runs: OrchRun[]): OrchRun[] {
  const rank = (r: OrchRun) => (r.needsUser ? 0 : ["done", "cancelled"].includes(r.status) ? 2 : 1);
  return [...runs].sort((a, b) => rank(a) - rank(b) || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

/** Idea filter chips: '전체' (null) + one per repo (ORCH_REPOS order), each with its idea count. Zero-count repos keep their chip. */
export function ideaFilterChips(repos: { repo: string; ideas: Idea[] }[]): { repo: string | null; count: number }[] {
  const all = repos.reduce((n, v) => n + v.ideas.length, 0);
  return [{ repo: null, count: all }, ...repos.map((v) => ({ repo: v.repo, count: v.ideas.length }))];
}

/** Ideas to show for the chosen repo (null = all), newest first. Does not mutate the input. */
export function filterIdeas(repos: { repo: string; ideas: Idea[] }[], repo: string | null): Idea[] {
  const list = repos.filter((v) => repo === null || v.repo === repo).flatMap((v) => v.ideas);
  return [...list].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

/** Repo preselected in the register form: the filtered one, else the first repo. */
export function defaultIdeaRepo(repos: { repo: string }[], filter: string | null): string {
  return filter !== null && repos.some((v) => v.repo === filter) ? filter : (repos[0]?.repo ?? "");
}

// ---------------------------------------------------------------- roadmap (docs/roadmap.json: 0단계 setup, 6단계 expansion)

export type RoadmapStatus = "done" | "doing" | "todo" | "na";
export interface RoadmapItem {
  id: string;
  /** At most 24 chars. */
  title: string;
  status: RoadmapStatus;
  /** At most 80 chars. */
  note: string | null;
  /** PR number or file path. */
  ref: number | string | null;
  /** PM-managed to-dos (phases only; same format everywhere). Empty when unset. */
  tasks: RoadmapTask[];
}
export interface RoadmapTask { title: string; owner: "me" | "ai"; status: "done" | "todo" }
export const ROADMAP_TASK_TITLE_MAX = 40;

function roadmapTasks(v: unknown): RoadmapTask[] {
  const out: RoadmapTask[] = [];
  for (const t of Array.isArray(v) ? v : []) {
    const o = obj(t);
    const title = str(o?.title);
    if (!o || !title || (o.owner !== "me" && o.owner !== "ai") || (o.status !== "done" && o.status !== "todo")) continue;
    out.push({ title: title.slice(0, ROADMAP_TASK_TITLE_MAX), owner: o.owner, status: o.status });
  }
  return out;
}
/** Link to the project's own app screen (roadmap.json top-level "app"). label null → shown as '화면 열기'. */
export interface RoadmapApp { label: string | null; url: string }
export interface Roadmap { version: number; setup: RoadmapItem[]; expansion: RoadmapItem[]; phases: RoadmapItem[]; app: RoadmapApp | null }

export const ROADMAP_TITLE_MAX = 24;
export const ROADMAP_NOTE_MAX = 80;
export const ROADMAP_APP_LABEL_MAX = 12;
const ROADMAP_STATUSES = new Set<string>(["done", "doing", "todo", "na"]);

function roadmapItem(v: unknown): RoadmapItem | null {
  const o = obj(v);
  const id = str(o?.id);
  const title = str(o?.title);
  if (!o || !id || !title) return null;
  const status = str(o.status);
  const ref = typeof o.ref === "number" && Number.isInteger(o.ref) && o.ref > 0 ? o.ref : (str(o.ref)?.slice(0, 200) ?? null);
  return {
    id: id.slice(0, 10),
    title: title.slice(0, ROADMAP_TITLE_MAX),
    status: status && ROADMAP_STATUSES.has(status) ? (status as RoadmapStatus) : "todo",
    note: str(o.note)?.slice(0, ROADMAP_NOTE_MAX) ?? null,
    ref,
    tasks: roadmapTasks(o.tasks),
  };
}

/**
 * Shared app-link check (roadmap.json "app" and ORCH_APP_URLS). Only a well-formed https:// URL is accepted; anything
 * else → null. URL and label are trimmed, label cut to 12 chars, blank/non-string label → null.
 */
export function parseAppLink(url: unknown, label: unknown): RoadmapApp | null {
  const u = str(url)?.trim();
  if (!u || !u.startsWith("https://")) return null;
  try { if (new URL(u).protocol !== "https:") return null; } catch { return null; }
  return { label: str(label)?.trim().slice(0, ROADMAP_APP_LABEL_MAX) || null, url: u };
}

/** roadmap.json "app": { label?, url } → parseAppLink. */
function roadmapApp(v: unknown): RoadmapApp | null {
  const o = obj(v);
  return o ? parseAppLink(o.url, o.label) : null;
}

/**
 * Server variable ORCH_APP_URLS: comma list of 'owner/repo=https://…' or 'owner/repo=label|https://…'.
 * Entries, repo names, labels and URLs are trimmed; repo names compared case-insensitively; the first well-formed
 * entry for the repo wins; malformed entries are skipped. No entry → null.
 */
export function appFromEnv(repo: string, env: Readonly<Record<string, string | undefined>>): RoadmapApp | null {
  const want = repo.trim().toLowerCase();
  for (const raw of (env.ORCH_APP_URLS ?? "").split(",")) {
    const entry = raw.trim();
    const eq = entry.indexOf("=");
    if (eq <= 0 || entry.slice(0, eq).trim().toLowerCase() !== want) continue;
    const value = entry.slice(eq + 1);
    const bar = value.indexOf("|");
    const app = bar >= 0 ? parseAppLink(value.slice(bar + 1), value.slice(0, bar)) : parseAppLink(value, null);
    if (app) return app;
  }
  return null;
}

/** Parse docs/roadmap.json. Not a JSON object → null; malformed items skipped, long strings cut, unknown status → todo. */
export function parseRoadmap(text: string | null | undefined): Roadmap | null {
  const j = parseJson(text ?? undefined);
  if (!j) return null;
  const list = (v: unknown) => (Array.isArray(v) ? v : []).map(roadmapItem).filter((i): i is RoadmapItem => i !== null);
  const version = num(j.version);
  return { version: version !== null && Number.isInteger(version) && version > 0 ? version : 1, setup: list(j.setup), expansion: list(j.expansion), phases: list(j.phases), app: roadmapApp(j.app) };
}

/**
 * docs/patchnotes.json → newest first, only well-formed entries ({version 'x.y.z', date 'YYYY-MM-DD', title, items[], pr?}).
 * Accepts a bare array or { notes: [...] }. Not JSON / no valid entry → null.
 */
export function parsePatchNotes(text: string | null | undefined): PatchNote[] | null {
  const raw = (() => { try { return JSON.parse(text ?? ""); } catch { return null; } })();
  const arr: unknown[] | null = Array.isArray(raw) ? raw : raw && Array.isArray(raw.notes) ? raw.notes : null;
  if (!arr) return null;
  const ok = arr.flatMap((x) => {
    const o = x as Record<string, unknown> | null;
    if (!o || typeof o.version !== "string" || !/^\d+\.\d+\.\d+$/.test(o.version) || typeof o.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(o.date)
      || typeof o.title !== "string" || !o.title.trim() || !Array.isArray(o.items)) return [];
    const items = o.items.filter((i): i is string => typeof i === "string" && i.trim() !== "");
    if (!items.length) return [];
    const pr = typeof o.pr === "number" && Number.isInteger(o.pr) && o.pr > 0 ? o.pr : undefined;
    return [{ version: o.version, date: o.date, title: o.title.trim(), items, ...(pr ? { pr } : {}) } as PatchNote];
  });
  if (!ok.length) return null;
  const key = (v: string) => v.split(".").map((n) => n.padStart(6, "0")).join(".");
  return ok.sort((a, b) => key(b.version).localeCompare(key(a.version)));
}

/**
 * Phase status derived from linked runs. An item whose ref is a positive integer and that matches an OrchRun number
 * takes the run's state: done → 'done'; implementing/reviewing/fixing/finalizing/awaiting_merge/waiting/blocked → 'doing';
 * cancelled keeps the roadmap value. With no matching run (an old run pushed out of the recent-20 list, or a plan Issue
 * that is not a run yet) the roadmap.json value is used as is — so the PM also sets finished phases to 'done' in roadmap.json.
 * Does not mutate the input.
 */
export function phaseStatus(items: RoadmapItem[], runs: OrchRun[]): RoadmapItem[] {
  return items.map((i) => {
    if (typeof i.ref !== "number" || !Number.isInteger(i.ref) || i.ref <= 0) return { ...i };
    const run = runs.find((r) => r.number === i.ref);
    if (!run || run.status === "cancelled") return { ...i };
    return { ...i, status: run.status === "done" ? "done" : "doing" };
  });
}

/** Checklist progress. 'na' items are left out of the total; text = '완료/전체'. */
export function roadmapCount(items: RoadmapItem[]): { done: number; doing: number; todo: number; total: number; text: string } {
  const c = { done: 0, doing: 0, todo: 0 };
  for (const i of items) if (i.status !== "na") c[i.status]++;
  const total = c.done + c.doing + c.todo;
  return { ...c, total, text: `${c.done}/${total}` };
}

// ---------------------------------------------------------------- architecture (docs/architecture.json: 구조 탭)

export type ArchTone = "plain" | "accent" | "deep";
export interface ArchBox { x: number; y: number; w: number; h: number; lines: string[]; tone: ArchTone }
export interface ArchArrow { points: [number, number][] }
export type ArchBlock =
  | { type: "text"; lines: string[] }
  | { type: "table"; head: string[]; rows: string[][] }
  | { type: "diagram"; width: number; height: number; label: string; boxes: ArchBox[]; arrows: ArchArrow[]; caption: string | null };
export interface ArchSection { no: string; kicker: string; title: string; blocks: ArchBlock[] }
export interface Architecture { version: number; purpose: string | null; sections: ArchSection[] }

/** Raw file size limit (UTF-8 bytes) for docs/architecture.json. */
export const ARCH_MAX_BYTES = 65_536;
export const ARCH_LIMITS = {
  purpose: 60, kicker: 12, title: 40, no: 4, line: 120, cell: 40, boxLine: 18, label: 120, caption: 80,
  sections: 12, blocks: 6, textLines: 8, cols: 4, rows: 20, boxes: 24, arrows: 30, boxLines: 3,
  minPoints: 2, maxPoints: 6, width: 300, minHeight: 40, maxHeight: 1200,
} as const;
const L = ARCH_LIMITS;

/** Cut to n code points (no splitting of surrogate pairs). */
const cut = (s: string, n: number) => { const a = Array.from(s); return a.length > n ? a.slice(0, n).join("") : s; };
/** Box text: at most 18 chars per line; longer → 17 chars + '…'. */
const cutEllipsis = (s: string, n: number) => { const a = Array.from(s); return a.length > n ? a.slice(0, n - 1).join("") + "…" : s; };
const strList = (v: unknown, maxItems: number, maxLen: number) =>
  (Array.isArray(v) ? v : []).map(str).filter((s): s is string => s !== null).slice(0, maxItems).map((s) => cut(s, maxLen));

function archBox(v: unknown, height: number): ArchBox | null {
  const o = obj(v);
  if (!o) return null;
  const [x, y, w, h] = [num(o.x), num(o.y), num(o.w), num(o.h)];
  if (x === null || y === null || w === null || h === null || x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > L.width || y + h > height) return null;
  const lines = (Array.isArray(o.lines) ? o.lines : []).map(str).filter((s): s is string => s !== null).slice(0, L.boxLines).map((s) => cutEllipsis(s, L.boxLine));
  if (!lines.length) return null;
  const tone: ArchTone = o.tone === "accent" || o.tone === "deep" ? o.tone : "plain";
  return { x, y, w, h, lines, tone };
}

function archArrow(v: unknown, height: number): ArchArrow | null {
  const pts = obj(v)?.points;
  if (!Array.isArray(pts) || pts.length < L.minPoints || pts.length > L.maxPoints) return null;
  const points: [number, number][] = [];
  for (const p of pts) {
    if (!Array.isArray(p) || p.length !== 2) return null;
    const [x, y] = [num(p[0]), num(p[1])];
    if (x === null || y === null || x < 0 || y < 0 || x > L.width || y > height) return null;
    points.push([x, y]);
  }
  return { points };
}

function archBlock(v: unknown): ArchBlock | null {
  const o = obj(v);
  if (!o) return null;
  if (o.type === "text") {
    const lines = strList(o.lines, L.textLines, L.line);
    return lines.length ? { type: "text", lines } : null;
  }
  if (o.type === "table") {
    const head = (Array.isArray(o.head) ? o.head : []).slice(0, L.cols).map((c) => cut(typeof c === "string" ? c.trim() : "", L.cell));
    if (!head.length || head.every((c) => !c)) return null;
    const rows = (Array.isArray(o.rows) ? o.rows : []).filter(Array.isArray).slice(0, L.rows)
      .map((r: unknown[]) => head.map((_, i) => cut(typeof r[i] === "string" ? (r[i] as string).trim() : "", L.cell)));
    return rows.length ? { type: "table", head, rows } : null;
  }
  if (o.type === "diagram") {
    const height = o.height;
    if (o.width !== L.width || typeof height !== "number" || !Number.isInteger(height) || height < L.minHeight || height > L.maxHeight) return null;
    const boxes = (Array.isArray(o.boxes) ? o.boxes : []).map((b) => archBox(b, height)).filter((b): b is ArchBox => b !== null).slice(0, L.boxes);
    const arrows = (Array.isArray(o.arrows) ? o.arrows : []).map((a) => archArrow(a, height)).filter((a): a is ArchArrow => a !== null).slice(0, L.arrows);
    if (!boxes.length) return null;
    const caption = str(o.caption);
    return { type: "diagram", width: L.width, height, label: cut(str(o.label) ?? "", L.label), boxes, arrows, caption: caption ? cut(caption, L.caption) : null };
  }
  return null;
}

function archSection(v: unknown): ArchSection | null {
  const o = obj(v);
  const no = str(o?.no);
  const title = str(o?.title);
  if (!o || !no || !title) return null;
  const blocks = (Array.isArray(o.blocks) ? o.blocks : []).map(archBlock).filter((b): b is ArchBlock => b !== null).slice(0, L.blocks);
  if (!blocks.length) return null;
  return { no: cut(no, L.no), kicker: cut(str(o.kicker) ?? "", L.kicker), title: cut(title, L.title), blocks };
}

/**
 * Parse docs/architecture.json. Over 65,536 UTF-8 bytes, not a JSON object or no valid section → null.
 * Malformed blocks/sections, out-of-range boxes/arrows are dropped; long strings and lists are cut.
 * Strings stay plain text (rendered as text, never as HTML).
 */
export function parseArchitecture(text: string | null | undefined): Architecture | null {
  if (typeof text !== "string" || new TextEncoder().encode(text).length > ARCH_MAX_BYTES) return null;
  const j = parseJson(text);
  if (!j) return null;
  const sections = (Array.isArray(j.sections) ? j.sections : []).map(archSection).filter((s): s is ArchSection => s !== null).slice(0, L.sections);
  if (!sections.length) return null;
  const version = num(j.version);
  const purpose = str(j.purpose);
  return { version: version !== null && Number.isInteger(version) && version > 0 ? version : 1, purpose: purpose ? cut(purpose, L.purpose) : null, sections };
}

/** ORCH_DEPLOY_EVERY as a positive integer (deploy.yml default 10); missing or odd values → 10. */
export function deployEveryFromVars(vars: { name: string; value: string }[]): number {
  const v = (vars.find((x) => x.name === "ORCH_DEPLOY_EVERY")?.value ?? "").trim();
  return /^\d+$/.test(v) && Number(v) > 0 ? Number(v) : 10;
}
