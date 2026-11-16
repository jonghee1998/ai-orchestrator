"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useDemo } from "./DemoContext";
import { agentAvailable, initialSimulation, recalculateRestrictions, type AgentId, type SimProject, type SimulationState, type TaskState } from "@/lib/simulation/model";
import { useRegisterRefresh } from "@/components/live/refresh";

const STORAGE = "ai-orchestrator:issue92:v1";
type Api = {
  state: SimulationState | null; ready: boolean; enabled: boolean; error?: string;
  reset(): void; setScenario(s: SimulationState["scenario"]): void; saveProject(p: SimProject): void;
  toggleAgent(id: AgentId): void; assign(projectId: string, taskId: string, agent: AgentId): boolean;
  transition(projectId: string, taskId: string, next: TaskState, detail?: string): boolean;
  decide(id: string, decision: "approved" | "held"): void; addUsage(service: "codex" | "claude", amount: number): void;
  resetUsage(service: "codex" | "claude"): void;
};
const Context = createContext<Api | null>(null);
const now = () => new Date().toISOString();
const briefing = (state: SimulationState, type: "change" | "complete", projectId: string, title: string, summary: string, owner: string) => ({ ...state, briefings: [{ id: `b-${Date.now()}-${Math.random()}`, type, projectId, title, summary, at: now(), next: type === "complete" ? "결과 확인" : "다음 상태 확인", owner, evidence: "개발계 시뮬레이션" }, ...state.briefings] });

export function SimulationProvider({ children }: { children: React.ReactNode }) {
  const { info } = useDemo(); const enabled = info.demo === true;
  const [state, setState] = useState<SimulationState | null>(null); const [ready, setReady] = useState(false); const [error, setError] = useState<string>();
  useEffect(() => {
    if (!enabled) { setState(null); setReady(true); return; }
    try { const raw = localStorage.getItem(STORAGE); setState(raw ? JSON.parse(raw) : initialSimulation()); } catch { setState(initialSimulation()); setError("저장된 개발계 상태를 읽지 못해 초기 상태를 사용합니다."); }
    setReady(true);
  }, [enabled]);
  useEffect(() => { if (enabled && state && ready) try { localStorage.setItem(STORAGE, JSON.stringify(state)); } catch { setError("개발계 상태를 저장하지 못했습니다."); } }, [enabled, ready, state]);
  const update = useCallback((fn: (s: SimulationState) => SimulationState) => setState((s) => s ? { ...fn(s), updatedAt: now() } : s), []);
  useRegisterRefresh("development-simulation", async () => {
    if (!enabled) return false;
    update((s) => s);
    return true;
  });
  const api = useMemo<Api>(() => ({
    state, ready, enabled, error,
    reset: () => { const fresh = initialSimulation(); setState(fresh); try { localStorage.setItem(STORAGE, JSON.stringify(fresh)); } catch {} },
    setScenario: (scenario) => update((s) => ({ ...s, scenario })),
    saveProject: (p) => update((s) => ({ ...s, projects: s.projects.some((x) => x.id === p.id) ? s.projects.map((x) => x.id === p.id ? p : x) : [p, ...s.projects] })),
    toggleAgent: (id) => update((s) => ({ ...s, agents: s.agents.map((a) => a.id === id ? { ...a, manualEnabled: !a.manualEnabled } : a) })),
    assign: (projectId, taskId, agent) => {
      if (!state || !agentAvailable(state, agent)) return false;
      const conflict = state.projects.some((p) => p.tasks.some((t) => t.agent === agent && t.state === "running" && t.id !== taskId));
      if (conflict) { setError("해당 AI가 다른 프로젝트에서 실행 중입니다. 기존 실행을 마친 뒤 배정하세요."); return false; }
      setError(undefined); update((s) => ({ ...s, projects: s.projects.map((p) => p.id !== projectId ? p : { ...p, tasks: p.tasks.map((t) => t.id === taskId ? { ...t, agent, state: "assigned" } : t) }) })); return true;
    },
    transition: (projectId, taskId, next, detail) => {
      if (!state) return false; const task = state.projects.find((p) => p.id === projectId)?.tasks.find((t) => t.id === taskId); if (!task) return false;
      if (["assigned", "running", "revision"].includes(next) && !agentAvailable(state, task.agent)) { setError("이 AI는 수동 OFF 또는 사용량 제한으로 신규 실행할 수 없습니다."); return false; }
      if (next === "running" && state.projects.some((p) => p.tasks.some((t) => t.agent === task.agent && t.state === "running" && t.id !== taskId))) { setError("이 AI가 이미 다른 업무를 실행 중입니다."); return false; }
      setError(undefined); update((s) => {
        let n = { ...s, projects: s.projects.map((p) => {
          if (p.id !== projectId) return p;
          const tasks = p.tasks.map((t) => t.id !== taskId ? t : { ...t, state: next, runStartedAt: next === "running" ? now() : t.runStartedAt, result: next === "done" ? detail || "개발계 가상 완료" : t.result, failure: next === "failed" ? detail || "개발계 가상 실행 실패" : next === "revision" ? undefined : t.failure });
          const stages = p.stages.map((stage) => { const rows = tasks.filter((t) => t.stageId === stage.id); return rows.length && rows.every((t) => t.state === "done") ? { ...stage, status: "done" as const } : rows.some((t) => ["running", "review", "revision", "decision", "failed"].includes(t.state)) ? { ...stage, status: "active" as const } : stage; });
          return { ...p, tasks, stages, state: stages.length > 0 && stages.every((stage) => stage.status === "done") ? "done" as const : p.state };
        }) };
        return briefing(n, next === "done" ? "complete" : "change", projectId, `${task.title} · ${next === "done" ? "완료 보고" : next === "failed" ? "실행 실패" : "상태 변경"}`, detail || `개발계에서 ${next} 상태로 변경되었습니다.`, task.agent);
      }); return true;
    },
    decide: (id, decision) => update((s) => ({ ...s, briefings: s.briefings.map((b) => b.id === id ? { ...b, decision, summary: `${b.summary} · 사용자 ${decision === "approved" ? "승인" : "보류"}` } : b), projects: s.projects.map((p) => ({ ...p, tasks: p.tasks.map((t) => t.state === "decision" && s.briefings.find((b) => b.id === id)?.projectId === p.id ? { ...t, state: decision === "approved" ? "done" : "paused", result: decision === "approved" ? "개발계 사용자 승인" : t.result } : t) })) })),
    addUsage: (service, amount) => update((s) => {
      const next = recalculateRestrictions({ ...s, usage: s.usage.map((u) => u.id !== service ? u : { ...u, periods: u.periods.map((p) => ({ ...p, used: p.used === null ? null : Math.min(100, p.used + amount), checkedAt: now() })) }) });
      const limited = next.usage.find((u) => u.id === service)?.periods.some((p) => p.used !== null && p.used >= next.policy.threshold);
      return limited ? { ...next, briefings: [{ id: `usage-${Date.now()}`, type: "usage", title: `${service === "codex" ? "Codex" : "Claude"} 사용 한도 주의`, summary: "개발계 가상 사용량이 정책 임계치에 도달해 신규 배정을 제한합니다.", at: now(), next: "가상 사용량 초기화 또는 정책 확인", owner: "사용자", userAction: "신규 업무 보류 여부 확인", evidence: "개발계 가상 사용량" }, ...next.briefings] } : next;
    }),
    resetUsage: (service) => update((s) => recalculateRestrictions({ ...s, usage: s.usage.map((u) => u.id !== service ? u : { ...u, periods: u.periods.map((p) => ({ ...p, used: 0, resetsAt: new Date(Date.now() + (p.id === "daily" ? 3 : 73) * 3_600_000).toISOString(), checkedAt: now(), stale: false })) }) })),
  }), [enabled, error, ready, state, update]);
  return <Context.Provider value={api}>{children}</Context.Provider>;
}
export function useSimulation() { const value = useContext(Context); if (!value) throw new Error("SimulationProvider missing"); return value; }
