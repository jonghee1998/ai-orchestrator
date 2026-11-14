"use client";
// #34 — live activity: run records (RunsPanel) + durable audit log from the store. No static samples.
import { Card, PageTitle } from "@/components/ui";
import RunsPanel from "@/components/RunsPanel";
import { useAuthedJson } from "@/components/live/useAuthedJson";
import { LiveStatus } from "@/components/live/LiveStatus";

type Audit = { at: string; actor: string; action: string; detail: string };
const t = (s: string) => s.replace("T", " ").slice(0, 19) + "Z";

export default function ActivityPage() {
  const { state, reload } = useAuthedJson<Audit[]>("/api/dashboard", (st, b) => {
    const j = b as { mode?: string; audit?: unknown } | null;
    if (j?.mode === "unconfigured") return "unconfigured";
    return st === 200 && j?.mode === "live" && Array.isArray(j.audit) ? (j.audit as Audit[]) : null;
  });
  return (
    <div>
      <PageTitle title="활동" subtitle="실행 기록 및 제어/게이트 감사 로그 (저장소 기준)" />
      <RunsPanel />
      <h2 className="mb-2 mt-6 text-sm font-semibold text-text-muted">감사 로그 (최근 30건)</h2>
      <LiveStatus s={state} reload={reload} what="감사 로그" />
      {state.kind === "ok" && state.data.length === 0 && <p className="text-xs text-text-faint">기록된 활동이 없습니다.</p>}
      {state.kind === "ok" && (
        <ol className="space-y-2">
          {state.data.map((e, i) => (
            <Card key={`${e.at}-${i}`}>
              <div className="flex items-center justify-between gap-3">
                <span className="rounded bg-bg-raised px-2 py-0.5 text-xs text-text-muted">{e.action}</span>
                <span className="text-xs text-text-faint">{t(e.at)}</span>
              </div>
              <p className="mt-2 break-words text-sm">{e.detail}</p>
              <p className="mt-1 text-xs text-text-faint">주체: {e.actor}</p>
            </Card>
          ))}
        </ol>
      )}
    </div>
  );
}
