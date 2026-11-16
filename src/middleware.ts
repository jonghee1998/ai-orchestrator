// 데모 모드 전역 게이트 (#85). Edge 호환을 위해 순수 모듈(demo/gate, demo/mode)만 사용한다.
// - DEMO_MODE 미설정: 아무 것도 하지 않음 (운영 동작 불변)
// - DEMO_MODE=1 이지만 운영/실제 자원 감지: 모든 /api 요청 503 (fail closed)
// - DEMO_MODE=1 정상: 변경성 요청(GET 외, 크론 GET /api/reconcile 포함) 403 — 쓰기·외부 호출 불가
import { NextResponse, type NextRequest } from "next/server";
import { demoBlockResponse, demoDecision } from "./lib/demo/gate";

const OPEN = ["/api/session", "/api/demo"]; // 세션 쿠키 발급과 데모 상태/시나리오 조회는 외부 효과가 없다
export function middleware(req: NextRequest) {
  const p = req.nextUrl.pathname;
  if (OPEN.includes(p)) return NextResponse.next();
  const d = demoDecision(req.headers);
  if (d.demo === false) return NextResponse.next();
  const mutation = !["GET", "HEAD"].includes(req.method) || p === "/api/reconcile";
  return demoBlockResponse(d, mutation) ?? NextResponse.next();
}
export const config = { matcher: ["/api/:path*"] };
