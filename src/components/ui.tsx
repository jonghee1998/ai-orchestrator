// 공용 프레젠테이션 컴포넌트 (배지, 카드, 섹션 헤더 등)

import type {
  ConnectionStatus,
  ProjectStatus,
  TaskStatus,
} from "@/lib/types";

export function PageTitle({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <header className="mb-4">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      {subtitle && <p className="mt-1 text-sm text-text-muted">{subtitle}</p>}
    </header>
  );
}

export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border border-border bg-bg-card p-4 ${className}`}
    >
      {children}
    </div>
  );
}

const connectionMeta: Record<
  ConnectionStatus,
  { label: string; color: string }
> = {
  connected: { label: "연결됨", color: "bg-ok/15 text-ok" },
  disconnected: { label: "연결 안 됨", color: "bg-unknown/15 text-text-muted" },
  connecting: { label: "연결 중", color: "bg-warn/15 text-warn" },
  error: { label: "오류", color: "bg-danger/15 text-danger" },
};

export function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  const m = connectionMeta[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${m.color}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {m.label}
    </span>
  );
}

const taskStatusMeta: Record<TaskStatus, { label: string; color: string }> = {
  backlog: { label: "대기", color: "bg-unknown/15 text-text-muted" },
  queued: { label: "큐", color: "bg-accent/15 text-accent" },
  in_progress: { label: "진행 중", color: "bg-warn/15 text-warn" },
  in_review: { label: "검수 중", color: "bg-accent/15 text-accent" },
  done: { label: "완료", color: "bg-ok/15 text-ok" },
  blocked: { label: "막힘", color: "bg-danger/15 text-danger" },
};

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  const m = taskStatusMeta[status];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${m.color}`}
    >
      {m.label}
    </span>
  );
}

const projectStatusMeta: Record<ProjectStatus, { label: string; color: string }> =
  {
    active: { label: "진행", color: "bg-ok/15 text-ok" },
    paused: { label: "일시중지", color: "bg-warn/15 text-warn" },
    done: { label: "완료", color: "bg-unknown/15 text-text-muted" },
  };

export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  const m = projectStatusMeta[status];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${m.color}`}
    >
      {m.label}
    </span>
  );
}

/** 값을 확인할 수 없을 때 쓰는 통일된 unknown 표시 */
export function UnknownTag({ hint }: { hint?: string }) {
  return (
    <span
      title={hint}
      className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium text-unknown ring-1 ring-inset ring-unknown/30"
    >
      unknown
    </span>
  );
}
