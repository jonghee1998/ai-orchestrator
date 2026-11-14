import { activity } from "@/lib/data";
import { Card, PageTitle } from "@/components/ui";
import RunsPanel from "@/components/RunsPanel";
import { agentLabel } from "@/lib/labels";
import { showDate } from "@/lib/format";
import type { ActivityKind } from "@/lib/types";

const kindLabel: Record<ActivityKind, string> = {
  task_created: "작업 생성",
  task_assigned: "작업 배정",
  status_changed: "상태 변경",
  agent_connected: "에이전트 연결",
  handoff: "협업/인계",
  note: "메모",
};

export default function ActivityPage() {
  const sorted = [...activity].sort(
    (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
  );

  return (
    <div>
      <PageTitle
        title="활동"
        subtitle="작업 실행 로그 및 에이전트 간 협업 기록"
      />
      <RunsPanel />
      <ol className="space-y-2">
        {sorted.map((e) => (
          <Card key={e.id}>
            <div className="flex items-center justify-between gap-3">
              <span className="rounded bg-bg-raised px-2 py-0.5 text-xs text-text-muted">
                {kindLabel[e.kind]}
              </span>
              <span className="text-xs text-text-faint">{showDate(e.at)}</span>
            </div>
            <p className="mt-2 text-sm">{e.message}</p>
            <p className="mt-1 text-xs text-text-faint">
              주체: {e.actor === "system" ? "시스템" : agentLabel[e.actor]}
            </p>
          </Card>
        ))}
      </ol>
    </div>
  );
}
