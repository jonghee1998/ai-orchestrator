import type { AgentStatus } from "@/lib/types";
import { roleLabel } from "@/lib/labels";
import { showMeasured, showMeasuredDate } from "@/lib/format";
import { Card, ConnectionBadge, UnknownTag } from "./ui";

export function AgentCard({ agent }: { agent: AgentStatus }) {
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">{agent.name}</h3>
          <p className="mt-0.5 text-xs text-text-muted">
            {roleLabel[agent.role]}
          </p>
        </div>
        <ConnectionBadge status={agent.connectionStatus} />
      </div>

      <dl className="mt-3 space-y-1.5 text-sm">
        <Row label="연결 방식" value={agent.connection} />
        <Row
          label="클라우드 자동 실행"
          value={
            agent.cloudCapable.state === "known" ? (
              agent.cloudCapable.value ? (
                "가능"
              ) : (
                "불가"
              )
            ) : (
              <UnknownTag hint={agent.cloudCapable.reason} />
            )
          }
        />
        <Row
          label="마지막 확인"
          value={
            agent.lastCheckedAt.state === "known" ? (
              showMeasuredDate(agent.lastCheckedAt)
            ) : (
              <UnknownTag hint={agent.lastCheckedAt.reason} />
            )
          }
        />
      </dl>

      <div className="mt-3 border-t border-border-subtle pt-3">
        <p className="mb-1.5 text-xs font-medium text-text-faint">사용 한도</p>
        <ul className="space-y-1">
          {agent.usage.map((q, i) => (
            <li key={i} className="flex items-center justify-between text-sm">
              <span className="text-text-muted">{q.label}</span>
              <span className="tabular-nums">
                {q.used.state === "known" || q.limit.state === "known" ? (
                  <>
                    {showMeasured(q.used)} / {showMeasured(q.limit)}
                  </>
                ) : (
                  <UnknownTag hint={q.used.reason} />
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

function Row({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-text-muted">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}
