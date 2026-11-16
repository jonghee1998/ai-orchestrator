# 대시보드 사용성 (Issue #85)

## 1. 관리자 로그인 (Issue #87)
홈(또는 /control)에서 일반 아이디·비밀번호로 로그인한다. 단일 관리자 계정이며 기본값은 없다.
서버 `ADMIN_USERNAME`·`ADMIN_PASSWORD_HASH`와 내부용 `CONTROL_ADMIN_TOKEN` 설정, 최초 해시 생성,
로그인 상태 유지(선택 30일/미선택 브라우저 세션·최대 12시간), CSRF·시도 제한·폐기는
[관리자 로그인](./ADMIN_LOGIN.md)을 참고한다. 기존 토큰 입력 UI는 제거했으며 API 헤더 인증은 유지한다.

## 2. KST 표시
`src/lib/time/kst.ts` 의 `formatKst*` 가 유일한 포매터다(`YYYY-MM-DD HH:mm:ss KST`). 저장·API 는 UTC ISO 그대로.
DST 없는 고정 +9h 산술이라 실행 환경 TZ/ICU 와 무관하다. 전역 새로고침, 활동, 실행, GitHub 증거, 진행 화면 모두 사용.

## 3. 데모 모드 (격리 환경)
- 서버 측 `DEMO_MODE=1` 일 때만 켜진다. 합성 결정적 픽스처(`src/lib/demo/fixtures.ts`)를 응답하며
  **GitHub/DB/프로바이더 호출과 모든 변경 요청이 없다**(미들웨어가 GET 외·`/api/reconcile` 모두 403).
- **fail closed**: `DEMO_MODE=1` + `VERCEL_ENV=production`, 또는 실제 자원/비밀 env(`DATABASE_URL`, `RUN_STORE_PATH`, `GITHUB_TOKEN/READ_TOKEN/REPO`, `CRON_SECRET`, `GATE_SECRET`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `RUN_CALLBACK_SECRET_*`)가 하나라도 있으면 모든 `/api/*`(세션·`/api/demo` 제외)가 503. `DEMO_MODE` 의 `1` 이 아닌 값도 차단.
- UI: 상단 노란 **DEMO** 배너, 시나리오 선택(정상=모든 상태 / 빈 상태 / 부분 실패 / 전체 오류) + 초기화. 선택은 비민감 쿠키 `demo_scenario`.
- 시나리오 모사: 정상=queued/running/succeeded/failed/timeout/held 실행 + backlog~blocked 큐 + review/revision/done/blocked 증거; 부분 실패=대시보드·실행만 성공, readiness/큐/증거는 502; 전체 오류=500.
- 운영(`DEMO_MODE` 미설정) 동작·읽기 전용·런타임 게이트는 변경 없음.

### 별도 Vercel 프로젝트 배포 계획 (GPT 가 프로비저닝, 개발자는 배포하지 않음)
1. 같은 저장소를 **새 Vercel 프로젝트**(예: `ai-orchestrator-demo`)로 연결, Production Branch 를 `demo`(또는 개발 브랜치)로 지정. 운영 프로젝트와 env 를 공유/복사하지 않는다.
2. env 는 **다음만** 설정: `DEMO_MODE=1`, `ADMIN_USERNAME`·`ADMIN_PASSWORD_HASH`(데모 전용 계정/해시), `CONTROL_ADMIN_TOKEN`(데모 전용 새 값, ≥16자), `CONTROL_SESSION_EPOCH`(선택). 위 금지 env 는 설정 금지.
3. 이 프로젝트의 배포는 Preview/Development 환경(`VERCEL_ENV!=production`)이어야 데모가 켜진다. Production 환경으로 배포하면 fail-closed(503) 되므로, 데모 프로젝트에서는 Production Branch 를 존재하지 않는 브랜치로 두고 `demo` 브랜치를 Preview 로 사용한다.
4. 크론(`vercel.json` 의 `/api/reconcile`)은 데모에서 403 으로 무해. 유료 API·DB 없음.

## 검증 구분
- 실제: 단위/계약 테스트, `next build`, 실제 `next start` HTTP 스모크(세션/CSRF/데모/fail-closed), Playwright(모바일 iPhone 13 뷰포트) 로그인·새로고침·로그아웃.
- 모사: 데모 픽스처·시나리오(합성). 실제 Vercel 배포·실제 GitHub/DB 는 검증하지 않음.
