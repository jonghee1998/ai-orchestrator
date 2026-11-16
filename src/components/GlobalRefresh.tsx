"use client";
// #81 — 모든 탭 공용 상단 새로고침. 읽기(GET) 재검증만 수행하며 dispatch/reconcile 등 변경 요청은 보내지 않는다.
import { refreshCenter, useRefreshState } from "@/components/live/refresh";
import { formatRefreshTime } from "@/lib/refresh/format";

export function GlobalRefresh() {
  const s = useRefreshState();
  const failed = s.failed;
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-bg-raised/95 backdrop-blur" data-testid="global-refresh">
      <div className="mx-auto flex max-w-app items-center gap-2 px-4 py-2">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">AI Orchestrator</span>
        <span className="shrink-0 text-[11px] text-text-faint" aria-live="polite" data-testid="refresh-time">
          {s.inFlight ? "갱신 중…" : `마지막 성공 ${formatRefreshTime(s.lastSuccessAt)}`}
        </span>
        <button
          type="button"
          onClick={() => { void refreshCenter.refreshAll(); }}
          disabled={s.inFlight}
          aria-busy={s.inFlight}
          aria-label="전체 새로고침"
          className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1 rounded-lg border border-border px-3 text-xs disabled:opacity-60"
        >
          <span aria-hidden className={s.inFlight ? "animate-spin" : ""}>↻</span>
          <span className="hidden min-[360px]:inline">{s.inFlight ? "갱신 중" : "새로고침"}</span>
        </button>
      </div>
      {!s.inFlight && failed.length > 0 && (
        <p role="status" className="mx-auto max-w-app break-all px-4 pb-2 text-[11px] text-warn" data-testid="refresh-failed">
          일부 갱신 실패 ({failed.length}/{s.registered}): {failed.join(", ")} — 마지막 정상 데이터를 유지합니다.
        </p>
      )}
    </header>
  );
}
