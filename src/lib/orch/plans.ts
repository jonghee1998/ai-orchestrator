// Pending plan Issues for the dashboard. Server-only (node:crypto) — never import from a client component.
// Mirrors the engine: plan validation/normalization = scripts/orch/core.mjs validatePlan,
// hash = scripts/orch/plan-review.mjs planHash, review marker = plan-review.mjs previousReviews.
// plans.test.ts checks both against the .mjs originals; change them together.
import { createHash } from "node:crypto";
import type { PendingPlan } from "./model";

export const MAX_STEPS = 10;
export const DEFAULT_MAX_RETRIES = 3;
const ACTIONS_BOT_ID = 41898282;
const STOP_LABELS = ["orch:go", "orch:run", "orch:done", "orch:blocked", "orch:cancel"];
const PLAN_RE = /```json[^\n]*\n([\s\S]*?)```/;
const MARK_RE = /<!-- orch-plan-review:v1 ([\s\S]*?) -->/;

export interface PlanStep { id: number; title: string; task: string; done_when: string[]; stop_if: string[]; model: string | null }
export interface Plan { goal: string; context: string; model: string | null; max_retries: number; auto_merge: boolean; try: string; steps: PlanStep[] }
export type PlanResult = { ok: true; plan: Plan } | { ok: false; error: string };

/* eslint-disable @typescript-eslint/no-explicit-any */
const isStr = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const isModel = (v: unknown) => typeof v === "string" && /^[a-z0-9][a-z0-9.\-]{0,63}$/.test(v);

/** Same rules, messages and output (field order included — it feeds the hash) as core.mjs validatePlan. */
export function validatePlan(p: any): PlanResult {
  const err = (error: string): PlanResult => ({ ok: false, error });
  if (!p || typeof p !== "object") return err("계획이 객체가 아닙니다.");
  if (!isStr(p.goal)) return err("goal이 비어 있습니다.");
  if (!Array.isArray(p.steps) || p.steps.length === 0) return err("steps가 비어 있습니다.");
  if (p.steps.length > MAX_STEPS) return err(`steps는 최대 ${MAX_STEPS}개입니다.`);
  for (const [i, s] of (p.steps as any[]).entries()) {
    const at = `steps[${i}]`;
    if (!s || typeof s !== "object") return err(`${at}가 객체가 아닙니다.`);
    if (s.id !== i + 1) return err(`${at}.id는 ${i + 1}이어야 합니다.`);
    if (!isStr(s.title)) return err(`${at}.title이 비어 있습니다.`);
    if (!isStr(s.task)) return err(`${at}.task가 비어 있습니다.`);
    if (!isStrArr(s.done_when) || s.done_when.length === 0) return err(`${at}.done_when이 비어 있습니다.`);
    if (s.stop_if !== undefined && !Array.isArray(s.stop_if)) return err(`${at}.stop_if는 배열이어야 합니다.`);
    if (s.stop_if && !isStrArr(s.stop_if)) return err(`${at}.stop_if에 빈 항목이 있습니다.`);
  }
  const maxRetries = p.max_retries ?? DEFAULT_MAX_RETRIES;
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 3) return err("max_retries는 0~3 정수입니다.");
  if (p.model !== undefined && !isModel(p.model)) return err("model 형식이 올바르지 않습니다.");
  for (const [i, s] of (p.steps as any[]).entries()) {
    if (s.model !== undefined && !isModel(s.model)) return err(`steps[${i}].model 형식이 올바르지 않습니다.`);
  }
  if (p.auto_merge !== undefined && typeof p.auto_merge !== "boolean") return err("auto_merge는 true/false입니다.");
  if (p.try !== undefined && !(typeof p.try === "string" && p.try.length <= 2000)) return err("try는 2000자 이내 문자열입니다.");
  return {
    ok: true,
    plan: {
      goal: p.goal.trim(),
      context: isStr(p.context) ? p.context.trim() : "",
      model: p.model ?? null,
      max_retries: maxRetries,
      auto_merge: p.auto_merge ?? true,
      try: isStr(p.try) ? p.try.trim() : "",
      steps: (p.steps as any[]).map((s) => ({
        id: s.id,
        title: s.title.trim(),
        task: s.task.trim(),
        done_when: (s.done_when as string[]).map((x) => x.trim()),
        stop_if: ((s.stop_if ?? []) as string[]).map((x) => x.trim()),
        model: s.model ?? null,
      })),
    },
  };
}

/** Same as core.mjs parsePlan: first ```json block of the Issue body. */
export function parsePlan(body: string | null | undefined): PlanResult {
  const m = PLAN_RE.exec(body ?? "");
  if (!m) return { ok: false, error: "본문에 ```json 계획 블록이 없습니다." };
  let raw: unknown;
  try {
    raw = JSON.parse(m[1]);
  } catch (e) {
    return { ok: false, error: `계획 JSON 파싱 실패: ${(e as Error).message}` };
  }
  return validatePlan(raw);
}

/** Same as plan-review.mjs planHash. */
export const planHash = (plan: Plan) => createHash("sha256").update(JSON.stringify(plan)).digest("hex").slice(0, 16);

type Label = string | { name?: string };
export interface PlanIssue {
  number: number;
  title?: string;
  body?: string | null;
  html_url?: string;
  state?: string;
  pull_request?: unknown;
  labels?: Label[];
  user?: { login?: string } | null;
}
export interface PlanComment {
  body?: string | null;
  created_at?: string;
  user?: { id?: number; type?: string } | null;
}

/** Latest review marker posted by the Actions bot (a person cannot forge one). Highest round wins, like previousReviews. */
function latestReview(comments: PlanComment[]) {
  const found: { round: number; hash: string; verdict: "OK" | "REVISE" | "ERROR"; reviewer: string; at: string | null }[] = [];
  for (const c of comments ?? []) {
    if (c?.user?.id !== ACTIONS_BOT_ID || c?.user?.type !== "Bot") continue;
    const m = MARK_RE.exec(c.body ?? "");
    if (!m) continue;
    try {
      const j = JSON.parse(m[1]);
      if (!Number.isInteger(j.round) || typeof j.hash !== "string") continue;
      found.push({
        round: j.round,
        hash: j.hash,
        verdict: j.verdict === "OK" || j.verdict === "REVISE" ? j.verdict : "ERROR",
        reviewer: typeof j.reviewer === "string" ? j.reviewer : "",
        at: typeof c.created_at === "string" ? c.created_at : null,
      });
    } catch { /* ignore broken marker */ }
  }
  return found.sort((a, b) => a.round - b.round).at(-1) ?? null; // stable: same round → later comment
}

/** Cheap checks that need no comments: owner-authored open '[plan]' Issue, not a PR, not yet approved/run. */
export function isPlanCandidate(repo: string, issue: PlanIssue): boolean {
  const owner = repo.split("/")[0];
  if (!issue || issue.user?.login !== owner) return false; // same rule as the engine (scripts/orch/main.mjs)
  if (!(issue.title ?? "").startsWith("[plan]")) return false;
  if (issue.state !== "open" || issue.pull_request) return false;
  const labels = (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l?.name ?? ""));
  return !labels.some((l) => STOP_LABELS.includes(l));
}

/** A pending plan, or null when the Issue is not one (see isPlanCandidate) or its plan JSON is invalid. */
export function parsePendingPlan(repo: string, issue: PlanIssue, comments: PlanComment[]): PendingPlan | null {
  if (!isPlanCandidate(repo, issue)) return null;
  const parsed = parsePlan(issue.body);
  if (!parsed.ok) return null;
  const hash = planHash(parsed.plan);
  const r = latestReview(comments);
  return {
    repo,
    number: issue.number,
    url: issue.html_url ?? `https://github.com/${repo}/issues/${issue.number}`,
    goal: parsed.plan.goal,
    steps: parsed.plan.steps.length,
    hash,
    review: r ? { ...r, stale: r.hash !== hash } : null,
  };
}
