import { PageTitle } from "@/components/ui";
import { WorkQueueDashboard } from "@/components/work-queue/WorkQueueDashboard";

export default function TasksPage() {
  return (
    <div>
      <PageTitle
        title="병렬 개발 대시보드"
        subtitle="Sonnet · Opus · Codex 작업 배정과 인계 현황 (읽기 전용)"
      />
      <WorkQueueDashboard />
    </div>
  );
}
