"use client";
// #34 — live activity: run records (RunsPanel) + durable audit log from the store. No static samples.
import { Card, PageTitle } from "@/components/ui";
import RunsPanel from "@/components/RunsPanel";
import { useAuthedJson } from "@/components/live/useAuthedJson";
import { LiveStatus } from "@/components/live/LiveStatus";
import { GitHubActivityPanel, useGitHubEvidence } from "@/components/github/GitHubEvidencePanels";

type Audit = { at: string; actor: string; action: string; detail: string };
const t = (s: string) => s.replace("T", " ").slice(0, 19) + "Z";

export default function ActivityPage() {
  const { state, reload } = useAuthedJson<Audit[]>("/api/dashboard", (st, b) => {
    const j = b as { mode?: string; audit?: unknown } | null;
    if (j?.mode === "unconfigured") return "unconfigured";
    return st === 200 && j?.mode === "live" && Array.isArray(j.audit) ? (j.audit as Audit[]) : null;
  });
  const gh = useGitHubEvidence();
  return (
    <div>
      <PageTitle title="활동" subtitle="GitHub 증거(ACK·완료보고·리뷰·판정)와 내부 런타임 기록(실행·감사 로그)을 분리 표시" />
      <GitHubActivityPanel ev={gh} />
      <h2 className="mb-1 mt-6 text-sm font-semibold text-text-muted">내부 런타임 기록 <span className="rounded bg-bg-raised px-1.5 py-0.5 text-[10px] text-text-faint">오케스트레이터 저장소</span></h2>
      <p className="mb-2 text-[11px] text-text-faint">오케스트레이터 dispatch·콜백 실행만 표시합니다. 비어 있어도 GitHub 작업이 없다는 뜻이 아닙니다.</p>
      <RunsPanel />
      <h2 className="mb-2 mt-6 text-sm font-semibold text-text-muted">감사 로그 (최근 30건)</h2>
      <LiveStatus s={state} reload={reload} what="감사 로그" />
      {state.kind === "ok" && state.data.length === 0 && <p className="text-xs text-text-faint">내부 감사 로그 0건 (GitHub 활동은 위 별도 표시).</p>}
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
