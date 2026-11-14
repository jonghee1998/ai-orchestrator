// 홈 / 개요 화면 — 전체 상태를 한눈에 요약한다.

import Link from "next/link";
import { agents, projects, tasks } from "@/lib/data";
import { Card, ConnectionBadge, PageTitle, UnknownTag } from "@/components/ui";
import { roleLabel } from "@/lib/labels";

export default function HomePage() {
  const connected = agents.filter(
    (a) => a.connectionStatus === "connected",
  ).length;
  const activeProjects = projects.filter((p) => p.status === "active").length;
  const openTasks = tasks.filter(
    (t) => t.status !== "done",
  ).length;

  return (
    <div>
      <PageTitle
        title="AI Orchestrator"
        subtitle="다중 AI 에이전트를 GitHub 중심으로 관리하는 개인 대시보드"
      />

      <div className="grid grid-cols-3 gap-2">
        <Stat label="연결 에이전트" value={`${connected}/${agents.length}`} />
        <Stat label="진행 프로젝트" value={String(activeProjects)} />
        <Stat label="열린 작업" value={String(openTasks)} />
      </div>

      <section className="mt-6">
        <SectionHeader title="에이전트" href="/agents" />
        <div className="space-y-2">
          {agents.map((a) => (
            <Card key={a.id} className="flex items-center justify-between">
              <div>
                <p className="font-medium">{a.name}</p>
                <p className="text-xs text-text-muted">{roleLabel[a.role]}</p>
              </div>
              <ConnectionBadge status={a.connectionStatus} />
            </Card>
          ))}
        </div>
      </section>

      <section className="mt-6">
        <SectionHeader title="프로젝트" href="/projects" />
        <div className="space-y-2">
          {projects.map((p) => (
            <Card key={p.id} className="flex items-center justify-between">
              <div className="min-w-0">
                <p className="truncate font-medium">{p.name}</p>
                <p className="truncate text-xs text-text-muted">
                  {p.taskCount}개 작업
                </p>
              </div>
              <div className="shrink-0 text-right text-sm">
                {p.progress.state === "known" ? (
                  <span className="tabular-nums">{p.progress.value}%</span>
                ) : (
                  <UnknownTag hint={p.progress.reason} />
                )}
              </div>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card className="text-center">
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      <p className="mt-1 text-[11px] text-text-muted">{label}</p>
    </Card>
  );
}

function SectionHeader({ title, href }: { title: string; href: string }) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <h2 className="text-sm font-semibold text-text-muted">{title}</h2>
      <Link href={href} className="text-xs text-accent">
        전체 보기 →
      </Link>
    </div>
  );
}
