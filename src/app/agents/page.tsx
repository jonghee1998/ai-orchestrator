import { agents } from "@/lib/data";
import { AgentCard } from "@/components/AgentCard";
import { PageTitle } from "@/components/ui";
import { SampleBanner } from "@/components/SampleBanner";

export default function AgentsPage() {
  return (
    <div>
      <PageTitle
        title="에이전트"
        subtitle="연결 상태·사용 한도·클라우드 실행 가능 여부"
      />
      <SampleBanner what="에이전트 카드" />
      <div className="space-y-3">
        {agents.map((a) => (
          <AgentCard key={a.id} agent={a} />
        ))}
      </div>
      <p className="mt-4 text-xs text-text-faint">
        실제 연결 검증 전까지 모든 에이전트는 &quot;연결 안 됨&quot;으로
        표시되며, 확인할 수 없는 값은 unknown 으로 둡니다.
      </p>
    </div>
  );
}
