"use client";
// 독립 로그인 게이트: 세션 확인 전/비인증 상태에서는 대시보드·내비게이션·데모 UI를 렌더링하지 않고
// (하위 컴포넌트가 마운트되지 않으므로 데이터 요청도 발생하지 않는다) 로그인 화면만 보여준다.
import { LoginCard } from "@/components/LoginCard";
import { useSession } from "@/components/live/session";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const s = useSession();
  if (s.status === "unknown") return <div className="flex min-h-dvh items-center justify-center text-sm text-text-faint" role="status" data-testid="auth-loading">세션 확인 중…</div>;
  if (s.status !== "authed") return (
    <div className="mx-auto flex min-h-dvh max-w-app flex-col justify-center gap-4 px-4" data-testid="login-gate">
      <h1 className="text-lg font-semibold">AI Orchestrator</h1>
      <LoginCard />
    </div>
  );
  return <>{children}</>;
}
