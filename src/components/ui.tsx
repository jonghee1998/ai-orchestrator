// 공용 프레젠테이션 컴포넌트 (배지, 카드, 섹션 헤더 등)

import type {
  ConnectionStatus,
  ProjectStatus,
  TaskStatus,
} from "@/lib/types";

/** 탭 머리 (시안 header): 제목 22px 굵게 + 아래 12px 회색 한 줄(갱신 시각·부제), 오른쪽에 버튼(actions). */
export function PageTitle({
  title,
  subtitle,
  actions,
  subtitleTestId,
}: {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  subtitleTestId?: string;
}) {
  return (
    <header className="mb-4 flex items-center justify-between gap-2 pt-1">
      <div className="min-w-0">
        <h1 className="text-[22px] font-[750] tracking-[-0.03em]">{title}</h1>
        {subtitle && <p className="mt-[3px] text-xs tabular-nums text-text-muted" data-testid={subtitleTestId}>{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </header>
  );
}

/** 40px 정사각 아이콘 버튼 (흰 바탕·테두리). 누르는 영역은 바깥으로 2px 넓혀 44px. 이름은 aria-label. */
export const ICON_BUTTON =
  "relative inline-flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-card text-text after:absolute after:-inset-0.5 after:content-[''] disabled:opacity-50";
/** 진한 바탕 흰 글자 버튼 (시안 'PM에게 말하기'). */
export const PRIMARY_BUTTON =
  "relative inline-flex h-10 items-center rounded-xl bg-text px-3.5 text-[13px] font-[650] text-white after:absolute after:-inset-0.5 after:content-[''] disabled:opacity-50";
/** 흰 바탕 테두리 글자 버튼 (보조 동작). */
export const BUTTON =
  "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-border bg-bg-card px-3 text-[13px] font-semibold text-text disabled:opacity-50";
/** 카드 제목 (시안 .ph h2 / 아이디어함 h4). */
export const CARD_TITLE = "text-base font-[750] tracking-[-0.02em]";
/** 카드 안 목록 한 줄: 위쪽 줄 구분선 하나. */
export const ROW = "border-t border-border py-3";
/** 결과 메시지 상자 (흰 카드 위·바탕 위 어디서든 보이도록 테두리 한 줄). */
export const STATUS_BOX = "rounded-xl border border-border bg-bg-card px-3.5 py-2.5 text-[13px]";
/** 입력칸: 회색 바탕 + 테두리 한 줄. */
export const FIELD = "w-full rounded-xl border border-border bg-bg px-3 text-sm";

export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-[18px] bg-bg-card px-4 py-[18px] shadow-[0_1px_2px_rgba(17,20,24,.04),0_4px_16px_rgba(17,20,24,.04)] ${className}`}
    >
      {children}
    </div>
  );
}

const connectionMeta: Record<
  ConnectionStatus,
  { label: string; color: string }
> = {
  connected: { label: "연결됨", color: "bg-ok/10 text-ok" },
  disconnected: { label: "연결 안 됨", color: "bg-unknown/10 text-text-muted" },
  connecting: { label: "연결 중", color: "bg-warn/10 text-warn" },
  error: { label: "오류", color: "bg-danger/10 text-danger" },
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
  backlog: { label: "대기", color: "bg-unknown/10 text-text-muted" },
  queued: { label: "큐", color: "bg-accent-dim text-accent" },
  in_progress: { label: "진행 중", color: "bg-warn/10 text-warn" },
  in_review: { label: "검수 중", color: "bg-accent-dim text-accent" },
  done: { label: "완료", color: "bg-ok/10 text-ok" },
  blocked: { label: "막힘", color: "bg-danger/10 text-danger" },
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
    active: { label: "진행", color: "bg-ok/10 text-ok" },
    paused: { label: "일시중지", color: "bg-warn/10 text-warn" },
    done: { label: "완료", color: "bg-unknown/10 text-text-muted" },
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
      className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium text-text-muted ring-1 ring-inset ring-unknown/30"
    >
      unknown
    </span>
  );
}
