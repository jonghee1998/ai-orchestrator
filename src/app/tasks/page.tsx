import { PageTitle } from "@/components/ui";
import { TasksEvidence } from "@/components/github/TasksEvidence";
import { WorkQueueDashboard } from "@/components/work-queue/WorkQueueDashboard";

export default function TasksPage() {
  return (
    <div>
      <PageTitle
        title="병렬 개발 대시보드"
        subtitle="Sonnet · Opus · Codex 작업 배정과 인계 현황 (읽기 전용)"
      />
      <TasksEvidence />
      <h2 className="mb-2 mt-6 text-sm font-semibold text-text-muted">작업 큐 (라벨 기준)</h2>
      <WorkQueueDashboard />
    </div>
  );
}
