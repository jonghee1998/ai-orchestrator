"use client";
// #34 — live project view: the configured GitHub repo's work queue (authenticated /api/work-queue). No static samples.
import { Card, PageTitle } from "@/components/ui";
import { useAuthedJson } from "@/components/live/useAuthedJson";
import { LiveStatus } from "@/components/live/LiveStatus";
import { buildModel, parseResponse, type Phase, type QueueTask } from "@/components/work-queue/viewModel";

const PHASES: { id: Phase; label: string }[] = [
  { id: "active", label: "진행 중" }, { id: "ready", label: "준비" }, { id: "review", label: "검수" },
  { id: "blocked", label: "차단" }, { id: "unknown", label: "상태 unknown" }, { id: "done", label: "완료" },
];

export default function ProjectsPage() {
  const { state, reload } = useAuthedJson<QueueTask[]>("/api/work-queue", (_st, b) => {
    const r = parseResponse(b);
    if (!r) return null;
    if (r.mode === "unconfigured") return "unconfigured";
    return r.mode === "live" ? r.tasks : null;
  });
  const model = state.kind === "ok" ? buildModel(state.data) : null;
  return (
    <div className="space-y-3">
      <PageTitle title="프로젝트" subtitle="GitHub 작업 큐(GITHUB_REPO) 실제 이슈 기준 진행 상황" />
      <LiveStatus s={state} reload={reload} what="프로젝트 작업" />
      {model && (
        <>
          <Card>
            <p className="text-sm">이슈 {model.tasks.length}개 · 진행률 {model.tasks.length ? `${Math.round((model.tasks.filter((x) => x.phase === "done").length / model.tasks.length) * 100)}% (완료 라벨 기준)` : "unknown (이슈 없음)"}</p>
            <p className="mt-1 text-[11px] text-text-faint">진행률은 status:* 라벨만으로 계산합니다. 라벨이 없거나 모호하면 unknown 으로 분류합니다.</p>
          </Card>
          {PHASES.map(({ id, label }) => {
            const rows = model.tasks.filter((x) => x.phase === id);
            if (!rows.length) return null;
            return (
              <section key={id} aria-label={label} className="space-y-2">
                <h2 className="text-sm font-semibold text-text-muted">{label} · {rows.length}</h2>
                {rows.map((x) => (
                  <Card key={x.id}>
                    <a href={x.url} target="_blank" rel="noreferrer" className="block break-words text-sm">{x.id} {x.title}</a>
                    <p className="text-[11px] text-text-faint">담당 {x.agent} · {x.status || "status 라벨 없음"}{x.waitingOn.length ? ` · 대기: ${x.waitingOn.join(", ")}` : ""}{x.missingDeps.length ? ` · 확인 불가 선행: ${x.missingDeps.join(", ")}` : ""}</p>
                  </Card>
                ))}
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
