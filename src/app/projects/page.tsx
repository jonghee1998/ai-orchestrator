import { projects, tasks } from "@/lib/data";
import { Card, PageTitle, ProjectStatusBadge, UnknownTag } from "@/components/ui";
import { TaskStatusBadge } from "@/components/ui";
import { SampleBanner } from "@/components/SampleBanner";
import { agentLabel } from "@/lib/labels";

export default function ProjectsPage() {
  return (
    <div>
      <PageTitle title="프로젝트" subtitle="프로젝트별 작업과 진행 상황" />
      <SampleBanner what="프로젝트·작업 목록" />
      <div className="space-y-3">
        {projects.map((p) => {
          const projectTasks = tasks.filter((t) => t.projectId === p.id);
          return (
            <Card key={p.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="font-semibold">{p.name}</h3>
                  <p className="mt-0.5 text-sm text-text-muted">
                    {p.description}
                  </p>
                </div>
                <ProjectStatusBadge status={p.status} />
              </div>

              <div className="mt-2 flex items-center gap-3 text-xs text-text-faint">
                <span>작업 {p.taskCount}개</span>
                <span>·</span>
                <span className="flex items-center gap-1">
                  진행률{" "}
                  {p.progress.state === "known" ? (
                    <span className="tabular-nums text-text-muted">
                      {p.progress.value}%
                    </span>
                  ) : (
                    <UnknownTag hint={p.progress.reason} />
                  )}
                </span>
              </div>

              <ul className="mt-3 space-y-2 border-t border-border-subtle pt-3">
                {projectTasks.map((t) => (
                  <li
                    key={t.id}
                    className="flex items-center justify-between gap-3"
                  >
                    <span className="min-w-0 truncate text-sm">{t.title}</span>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-xs text-text-faint">
                        {t.assignee ? agentLabel[t.assignee] : "미배정"}
                      </span>
                      <TaskStatusBadge status={t.status} />
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
