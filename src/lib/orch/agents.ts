import type { OrchRun, Switches } from "./model";

// Which AI is working on what right now. Pure: no I/O.
// The engine does not store "the model in use", so it is recomputed here with a copy of
// scripts/orch/core.mjs pickModel / resolveModel (agents.test.ts compares both against the real engine).
//
// Known limits (the screen can differ from reality):
//  - held: runs waiting on a switch (OrchRun.held) are left out. A run WITHOUT held is recomputed with the
//    switches as they are NOW, so if the owner flipped a switch after the engine assigned the model, the shown model
//    can differ from the one actually running.
//  - review: the engine falls back to Opus when Codex is on but unusable (quota, login, limit); we only see the
//    switch, so we show Codex. If codex and opus are both off nobody can review, so the run is left out.

export type AgentId = "sonnet" | "opus" | "fable" | "codex" | "user";
export interface AgentItem { repo: string; number: number; url: string; goal: string; step: number | null; total: number; activity: string }
/** off: this AI is OFF in every repo whose switches were read (user: always false). */
export interface AgentRow { agent: AgentId; off: boolean; items: AgentItem[] }

export const AGENT_ORDER: AgentId[] = ["sonnet", "opus", "fable", "codex", "user"];

// Copies of scripts/orch/core.mjs (MODEL_LIGHT, MODEL_HEAVY, ESCALATE_AFTER, HEAVY_TEXT_RE).
const MODEL_LIGHT = "sonnet";
const MODEL_HEAVY = "opus";
const MODEL_FABLE = "claude-fable-5-2";
const ESCALATE_AFTER = 2;
const HEAVY_TEXT_RE = /(migration|schema|\bsql\b|database|\bdb\b|auth|login|session|password|token|oauth|payment|billing|permission|security|deploy|DB|데이터베이스|스키마|인증|로그인|비밀번호|결제|권한|보안|배포|마이그레이션)/i;

/** Engine default when switches could not be read: everything on. */
const DEFAULT_SWITCHES: Switches = { sonnet: true, opus: true, fable: true, codex: true, paused: false, auto: false, codexDev: true, window: "" };

const isFable = (model: string) => /fable/i.test(model);
const isHeavy = (model: string) => /opus|fable/i.test(model);

export function pickModel(run: Pick<OrchRun, "steps" | "planModel">, stepId: number | null, retries: number): string {
  const step = run.steps.find((s) => s.id === stepId);
  let model: string;
  if (step?.model) model = step.model;
  else if (run.planModel) model = run.planModel;
  else if (HEAVY_TEXT_RE.test(`${step?.title ?? ""}\n${step?.task ?? ""}`)) model = MODEL_HEAVY;
  else model = MODEL_LIGHT;
  if (retries >= ESCALATE_AFTER && /sonnet|haiku/i.test(model)) model = MODEL_HEAVY;
  return model;
}

/** Model after the ON/OFF switches, or null when both Sonnet and Opus are OFF (engine: hold). */
export function resolveModel(model: string, sw: Pick<Switches, "sonnet" | "opus" | "fable">): string | null {
  if (isFable(model)) {
    if (sw.fable) return MODEL_FABLE;
    model = MODEL_HEAVY;
  }
  const heavy = isHeavy(model);
  if (heavy ? sw.opus : sw.sonnet) return model;
  if (heavy && sw.sonnet) return MODEL_LIGHT;
  if (!heavy && sw.opus) return MODEL_HEAVY;
  return null;
}

export function activeAgents(runs: OrchRun[], switchesByRepo: Record<string, Switches | null>): AgentRow[] {
  const rows: AgentRow[] = AGENT_ORDER.map((agent) => ({ agent, off: false, items: [] }));
  const byId = (id: AgentId) => rows.find((r) => r.agent === id)!;

  for (const r of runs) {
    if (r.held) continue;
    const sw = switchesByRepo[r.repo] ?? DEFAULT_SWITCHES;
    const base = { repo: r.repo, number: r.number, url: r.url, goal: r.goal, step: r.step, total: r.total };
    if (r.status === "implementing" || r.status === "fixing") {
      const m = resolveModel(pickModel(r, r.step, r.retries), sw);
      if (m === null) continue;
      byId(isFable(m) ? "fable" : /opus/i.test(m) ? "opus" : "sonnet").items.push({ ...base, activity: r.status === "implementing" ? "구현 중" : "수정 중" });
    } else if (r.status === "reviewing") {
      const who: AgentId | null = sw.codex ? "codex" : sw.opus ? "opus" : null;
      if (who) byId(who).items.push({ ...base, activity: "검수 중" });
    } else if (r.status === "rechecking") {
      if (sw.opus) byId("opus").items.push({ ...base, activity: "재검수 중" });
    } else if (r.status === "awaiting_merge") byId("user").items.push({ ...base, activity: "반영 승인 대기" });
    else if (r.status === "blocked") byId("user").items.push({ ...base, activity: "멈춤 확인 필요" });
  }

  // off: OFF in every repo whose switches were read; none read → not off.
  const known = Object.values(switchesByRepo).filter((s): s is Switches => !!s);
  for (const k of ["sonnet", "opus", "fable", "codex"] as const) byId(k).off = known.length > 0 && known.every((s) => !s[k]);
  return rows;
}
