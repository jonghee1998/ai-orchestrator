"use client";
// #34 — live agents (store snapshot via authenticated /api/dashboard). No static sample data.
import { Card, PageTitle } from "@/components/ui";
import { useAuthedJson } from "@/components/live/useAuthedJson";
import { LiveStatus } from "@/components/live/LiveStatus";

type Agent = {
  key: string; provider: string; enabled: boolean; effective: boolean; blockedReason: string | null;
  lastAck: string | null; lastRun: string | null; lastHeartbeat: string | null; lastStatus: string | null;
  running: number; queued: number; held: number; orchestratorDispatches: number; suppressedByGate: number;
  externalGate: { state: "none" | "fresh" | "stale"; lastAt?: string; lastAllowed?: boolean; count?: number };
};
const NAMES: Record<string, string> = { gpt: "GPT", "claude-sonnet": "Claude Sonnet", "claude-opus": "Claude Opus", codex: "Codex" };
const t = (s: string | null | undefined) => (s ? s.replace("T", " ").slice(0, 19) + "Z" : "없음");

export default function AgentsPage() {
  const { state, reload } = useAuthedJson<{ generatedAt: string; agents: Agent[] }>("/api/dashboard", (st, b) => {
    const j = b as { mode?: string; agents?: unknown; generatedAt?: string } | null;
    if (j?.mode === "unconfigured") return "unconfigured";
    return st === 200 && j?.mode === "live" && Array.isArray(j.agents) ? (j as { generatedAt: string; agents: Agent[] }) : null;
  });
  return (
    <div className="space-y-3">
      <PageTitle title="에이전트" subtitle="실제 저장소 상태 · 게이트 · 콜백 증거 (provider 사용량은 unknown)" />
      <LiveStatus s={state} reload={reload} what="에이전트 상태" />
      {state.kind === "ok" && (
        <>
          <p className="text-xs text-text-faint">갱신 {t(state.data.generatedAt)}</p>
          {state.data.agents.map((a) => (
            <Card key={a.key}>
              <div className="flex items-center justify-between gap-3">
                <p className="font-medium">{NAMES[a.key] ?? a.key} <span className="text-xs text-text-faint">({a.provider})</span></p>
                <span className={`shrink-0 rounded-full px-2 py-1 text-xs ${a.enabled ? "bg-green-900/40 text-green-200" : "bg-bg-raised text-text-faint"}`}>{a.enabled ? "ON" : "OFF"}</span>
              </div>
              <p className="mt-1 text-xs text-text-muted">{a.effective ? "dispatch 허용" : `차단: ${a.blockedReason}`} · 실행/대기/보류 {a.running}/{a.queued}/{a.held}</p>
              <p className="text-[11px] text-text-faint">마지막 ACK {t(a.lastAck)} · 시작 {t(a.lastRun)} · heartbeat {t(a.lastHeartbeat)} · 상태 {a.lastStatus ?? "기록 없음"}</p>
              <p className="text-[11px] text-text-faint">오케스트레이터 dispatch {a.orchestratorDispatches}건 · 게이트 차단 {a.suppressedByGate}건 · provider 사용량 unknown</p>
              <p className="text-[11px] text-text-faint">외부 루틴 게이트 증거: {a.externalGate.state === "none" ? "없음 — 외부 루틴 통제 미확인(unknown)" : `${a.externalGate.state === "fresh" ? "최근" : "오래됨"} ${t(a.externalGate.lastAt)} · ${a.externalGate.lastAllowed ? "허용" : "차단"} (${a.externalGate.count}회)`}</p>
            </Card>
          ))}
        </>
      )}
    </div>
  );
}
