import { projects, tasks } from "@/lib/data";
import { Card, PageTitle, TaskStatusBadge } from "@/components/ui";
import { agentLabel } from "@/lib/labels";
import { showDate } from "@/lib/format";

const REPO = "jonghee1998/ai-orchestrator";

export default function TasksPage() {
  const projectName = (id: string) =>
    projects.find((p) => p.id === id)?.name ?? id;

  return (
    <div>
      <PageTitle
        title="작업"
        subtitle="GitHub Issue 기반 작업 큐 (연동은 Phase 2)"
      />
      <div className="space-y-2">
        {tasks.map((t) => (
          <Card key={t.id}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium">{t.title}</p>
                <p className="mt-0.5 text-xs text-text-faint">
                  {projectName(t.projectId)} · {showDate(t.updatedAt)}
                </p>
              </div>
              <TaskStatusBadge status={t.status} />
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded bg-bg-raised px-2 py-0.5 text-text-muted">
                담당: {t.assignee ? agentLabel[t.assignee] : "미배정"}
              </span>
              {t.issueNumber ? (
                <a
                  href={`https://github.com/${REPO}/issues/${t.issueNumber}`}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded bg-accent-dim/40 px-2 py-0.5 text-accent"
                >
                  Issue #{t.issueNumber}
                </a>
              ) : (
                <span className="rounded bg-bg-raised px-2 py-0.5 text-text-faint">
                  Issue 없음
                </span>
              )}
              {t.prNumber ? (
                <a
                  href={`https://github.com/${REPO}/pull/${t.prNumber}`}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded bg-accent-dim/40 px-2 py-0.5 text-accent"
                >
                  PR #{t.prNumber}
                </a>
              ) : (
                <span className="rounded bg-bg-raised px-2 py-0.5 text-text-faint">
                  PR 없음
                </span>
              )}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
