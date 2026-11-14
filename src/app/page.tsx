// 홈 — 실제 상태(인증된 /api/dashboard, /api/readiness)만 표시한다. 샘플 데이터 없음 (Issue #31).
import OverviewDashboard from "@/components/overview/OverviewDashboard";

export default function HomePage() {
  return (
    <div>
      <OverviewDashboard />
    </div>
  );
}
