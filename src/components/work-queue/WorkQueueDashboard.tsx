"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui";
import { useRegisterRefresh } from "@/components/live/refresh";
import { readToken, useSession } from "@/components/live/session";
import { SAMPLE_TASKS } from "./fixtures";
import { createRequestTracker, loadQueue, type Source } from "./loader";
import {
  AGENTS,
  buildModel,
  type DashboardModel,
  type Phase,
  type QueueAgent,
  type TaskView,
} from "./viewModel";

const agentName: Record<QueueAgent, string> = {
  claude: "Sonnet (Claude)",
  opus: "Opus",
  codex: "Codex",
  unknown: "담당 미확인",
};

const phaseMeta: Record<Phase, { label: string; color: string }> = {
  active: { label: "진행 중", color: "bg-warn/15 text-warn" },
  ready: { label: "대기(준비됨)", color: "bg-accent/15 text-accent" },
  review: { label: "검수", color: "bg-accent/15 text-accent" },
  done: { label: "완료", color: "bg-ok/15 text-ok" },
  blocked: { label: "막힘", color: "bg-danger/15 text-danger" },
  unknown: { label: "unknown", color: "bg-unknown/15 text-text-muted" },
};

export function WorkQueueDashboard() {
  const sessVersion = useSession().version;
  const [src, setSrc] = useState<Source>({ kind: "loading" });
  const tracker = useRef(createRequestTracker()).current;

  const srcRef = useRef<Source>(src); srcRef.current = src;
  // 마운트·재시도·샘플 종료·전역 새로고침 모두 이 함수를 사용한다. 최신 요청만 반영하고,
  // #81: 이미 live 데이터가 있으면 로딩으로 비우지 않으며 실패 시 마지막 정상 데이터를 유지한다.
  const [staleErr, setStaleErr] = useState<string | null>(null);
  const refresh = useCallback(async (): Promise<boolean> => {
    const id = tracker.next();
    const hadLive = srcRef.current.kind === "live" && srcRef.current.res.mode === "live";
    if (!hadLive) setSrc({ kind: "loading" });
    const next = await loadQueue(fetch, readToken());
    if (!tracker.isCurrent(id)) return false;
    const ok = next.kind === "live" && next.res.mode === "live";
    if (ok || !hadLive || next.kind === "unauth" || next.kind === "notoken") { setSrc(next); setStaleErr(null); }
    else setStaleErr(next.kind === "unavailable" ? next.reason : next.kind === "live" ? "서버 오류 응답" : "갱신 실패");
    return ok;
  }, [tracker]);

  useEffect(() => {
    void refresh();
    return () => tracker.invalidate();
  }, [refresh, tracker, sessVersion]);
  useRegisterRefresh("/api/work-queue", refresh);

  const showSample = useCallback(() => {
    tracker.invalidate(); // 진행 중인 응답이 샘플 화면을 덮어쓰지 않도록
    setSrc({ kind: "sample" });
  }, [tracker]);

  const tasks =
    src.kind === "live"
      ? src.res.mode === "live"
        ? src.res.tasks
        : []
      : src.kind === "sample"
        ? SAMPLE_TASKS
        : [];
  const model = buildModel(tasks);

  return (
    <div className="space-y-4">
      <StatusBanner src={src} onSample={showSample} onExit={() => void refresh()} onRetry={() => void refresh()} />
      {staleErr && <p role="status" className="text-xs text-warn">최신 갱신 실패 ({staleErr}) — 마지막 정상 데이터를 표시 중입니다.</p>}
      {tasks.length > 0 && <Body model={model} sample={src.kind === "sample"} />}
      {src.kind === "live" && src.res.mode === "live" && tasks.length === 0 && (
        <Card className="text-sm text-text-muted">표시할 작업이 없습니다.</Card>
      )}
    </div>
  );
}

function StatusBanner({
  src,
  onSample,
  onExit,
  onRetry,
}: {
  src: Source;
  onSample: () => void;
  onExit: () => void;
  onRetry: () => void;
}) {
  if (src.kind === "loading")
    return <Card className="text-sm text-text-muted">작업 큐 불러오는 중…</Card>;
  if (src.kind === "sample")
    return (
      <Card className="border-warn/40 bg-warn/10 text-sm text-warn">
        <p className="font-medium">샘플 모드 — 실제 데이터가 아닙니다</p>
        <button onClick={onExit} className="mt-2 text-xs underline">
          샘플 종료
        </button>
      </Card>
    );
  if (src.kind === "notoken")
    return (
      <Card className="text-sm">
        로그인이 필요합니다. <Link href="/" className="text-accent">홈</Link>에서 한 번 로그인하면 작업 큐를 실제 데이터로 표시합니다.
      </Card>
    );
  if (src.kind === "unauth")
    return (
      <Card className="text-sm">
        세션이 없거나 만료되었습니다 (401).{" "}
        <button onClick={onRetry} className="ml-2 text-xs text-accent underline">다시 시도</button>
      </Card>
    );
  const msg =
    src.kind === "unavailable"
      ? { t: "작업 큐를 사용할 수 없음", d: `API 호출 실패: ${src.reason}`, c: "text-danger" }
      : src.res.mode === "unconfigured"
        ? { t: "작업 큐 미설정", d: "GitHub 연동이 설정되지 않아 실제 작업을 표시할 수 없습니다.", c: "text-warn" }
        : src.res.mode === "error"
          ? { t: "작업 큐 오류", d: src.res.error ?? "원인 미상", c: "text-danger" }
          : null;
  return (
    <>
      {msg ? (
        <Card>
          <p className={`font-medium ${msg.c}`}>{msg.t}</p>
          <p className="mt-1 text-sm text-text-muted">{msg.d}</p>
          <div className="mt-3 flex gap-2">
            <button onClick={onRetry} className="rounded bg-bg-raised px-3 py-1.5 text-xs text-accent">
              다시 시도
            </button>
            <button onClick={onSample} className="rounded bg-bg-raised px-3 py-1.5 text-xs text-accent">
              샘플 모드로 레이아웃 보기
            </button>
          </div>
        </Card>
      ) : (
        <p className="text-xs text-ok">
          ● 실시간 작업 큐 (읽기 전용){" "}
          <button onClick={onRetry} className="ml-2 text-text-muted underline">
            새로고침
          </button>
        </p>
      )}
    </>
  );
}

function Badge({ phase }: { phase: Phase }) {
  const m = phaseMeta[phase];
  return (
    <span className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${m.color}`}>
      {m.label}
    </span>
  );
}

function TaskRow({ t }: { t: TaskView }) {
  const title = t.url ? (
    <a href={t.url} target="_blank" rel="noreferrer" className="font-medium text-accent">
      {t.title}
    </a>
  ) : (
    <span className="font-medium">{t.title}</span>
  );
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 break-words text-sm">{title}</div>
        <Badge phase={t.phase} />
      </div>
      {t.phase === "unknown" && (
        <p className="mt-1 text-xs text-text-faint">상태 &quot;{t.status || "없음"}&quot; 해석 불가</p>
      )}
      {t.waitingOn.length > 0 && (
        <p className="mt-1 text-xs text-danger">선행 대기: {t.waitingOn.join(", ")}</p>
      )}
      {t.missingDeps.length > 0 && (
        <p className="mt-1 text-xs text-text-faint">선행 작업 확인 불가: {t.missingDeps.join(", ")}</p>
      )}
    </div>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-text-muted">
        {title}
        {count !== undefined && <span className="ml-1 tabular-nums">({count})</span>}
      </h2>
      {children}
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="text-xs text-text-faint">{text}</p>;
}

function Body({ model, sample }: { model: DashboardModel; sample: boolean }) {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-2 text-center">
        <Card><p className="text-2xl font-semibold tabular-nums">{model.concurrent.length}</p><p className="text-[11px] text-text-muted">동시 진행</p></Card>
        <Card><p className="text-2xl font-semibold tabular-nums">{model.blocked.length}</p><p className="text-[11px] text-text-muted">막힘</p></Card>
        <Card><p className="text-2xl font-semibold tabular-nums">{model.unknownState.length}</p><p className="text-[11px] text-text-muted">unknown</p></Card>
      </div>

      <Section title="동시 진행 작업" count={model.concurrent.length}>
        {model.concurrent.length ? (
          <div className="space-y-2">
            {model.concurrent.map((t) => (
              <div key={t.id}>
                <p className="mb-1 text-[11px] text-text-faint">{agentName[t.agent]}</p>
                <TaskRow t={t} />
              </div>
            ))}
          </div>
        ) : (
          <Empty text="진행 중인 작업 없음" />
        )}
      </Section>

      <Section title="에이전트별 배정">
        <div className="space-y-3">
          {AGENTS.map((a) => (
            <Card key={a}>
              <p className="mb-2 text-sm font-medium">
                {agentName[a]} <span className="text-text-faint">({model.byAgent[a].length})</span>
              </p>
              {model.byAgent[a].length ? (
                <div className="space-y-2">{model.byAgent[a].map((t) => <TaskRow key={t.id} t={t} />)}</div>
              ) : (
                <Empty text="배정 없음" />
              )}
            </Card>
          ))}
        </div>
      </Section>

      <Section title="인계 타임라인 (의존 관계)" count={model.handoffs.length}>
        {model.handoffs.length ? (
          <ol className="space-y-2 border-l border-border pl-3">
            {model.handoffs.map((h) => (
              <li key={`${h.from.id}>${h.to.id}`} className="text-xs">
                <span className="text-text-muted">{agentName[h.from.agent]}</span> {h.from.title}
                <span className="mx-1 text-accent">→</span>
                <span className="text-text-muted">{agentName[h.to.agent]}</span> {h.to.title}
                <Badge phase={h.from.phase} />
              </li>
            ))}
          </ol>
        ) : (
          <Empty text="의존 관계 없음 · 시각 정보는 API 계약에 없어 순서만 표시합니다" />
        )}
      </Section>

      <Section title="막힘 / unknown" count={new Set([...model.blocked, ...model.unknownState]).size}>
        {model.blocked.length + model.unknownState.length ? (
          <div className="space-y-2">
            {[...new Set([...model.blocked, ...model.unknownState])].map((t) => <TaskRow key={t.id} t={t} />)}
          </div>
        ) : (
          <Empty text="없음" />
        )}
      </Section>
      {sample && <p className="text-center text-xs text-warn">위 내용은 모두 샘플입니다</p>}
    </div>
  );
}
