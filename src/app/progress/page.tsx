import { PageTitle } from "@/components/ui";
import { ProgressDashboard } from "@/components/progress/ProgressDashboard";

export default function ProgressPage() {
  return (
    <div>
      <PageTitle title="협업 진행 현황" subtitle="에이전트별 실행 증거 · 읽기 전용 · 미확인은 unknown 표시" />
      <ProgressDashboard />
    </div>
  );
}
