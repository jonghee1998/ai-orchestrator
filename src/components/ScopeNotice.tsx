// Always-visible honesty notice: OFF is NOT account-wide control.
export function ScopeNotice() {
  return (
    <div role="note" className="rounded-xl border border-yellow-700/50 bg-yellow-900/20 p-3 text-xs text-yellow-100">
      <b>OFF 범위 안내:</b> OFF는 이 orchestrator의 dispatch/재시도/대화만 차단합니다. GitHub 라벨 기반 외부 루틴·webhook, 직접 실행된 Claude/Codex/ChatGPT는 <b>차단되지 않습니다</b>. 계정 전체 제어가 아닙니다.
    </div>
  );
}
