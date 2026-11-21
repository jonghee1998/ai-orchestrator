> 이 문서의 데모·시뮬레이션 기능은 2026-11-21 삭제되었습니다.

# Issue #87 구현·검증 결과

- 개발 브랜치: `codex/issue-87-login`
- 기준 SHA: `3ad27f7af4eeb9b19298f7752d7ccfe1a5833c5f`
- PR 대상: `claude/issue-85-usability`

## 변경 동작

단일 관리자 아이디·비밀번호 로그인, 고정 비용 scrypt(N=131072, r=8, p=1) 해시 검증,
기본 계정 없음, 서버 내부 관리자 토큰 유지, 로그인 유지 선택(30일/브라우저 세션·서버 만료 12시간),
HttpOnly/Secure/SameSite 쿠키, 로그아웃·만료·자격증명/EPOCH 교체 폐기, CSRF와 로그인 시도 제한을 구현했다.
기존 관리자/읽기 헤더 토큰, 크론 인증, 에이전트 인증은 유지한다.

`GET /api/reconcile`은 쿠키로 실행하지 않으며 명시적 관리자 토큰/크론 인증만 허용한다.
쿠키 기반 POST는 관리자 권한과 CSRF를 요구한다. 데모 collaboration 읽기는 합성 워크플로를 반환하며
데이터 API는 Node 런타임에서도 데모 게이트를 재검증한다. 기존 KST·전역 새로고침·시나리오를 유지한다.
관리자 최초 설정 및 제한 범위는 [ADMIN_LOGIN.md](./ADMIN_LOGIN.md)에 있다.

## 실행한 검증

Node.js 22.23.5에서 다음을 실행했다.

| 검사 | 결과 |
| --- | --- |
| `npm ci --cache /workspace/.npm --no-audit --no-fund` | 성공; lockfile 변경 없음 |
| `npm run typecheck` | 성공 |
| `npm test` (자식 프로세스 회수 래퍼 내) | 276개 실행, 273 pass, 0 fail, 3 skip |
| `npm run build` | 성공 |
| `node --test scripts/login-smoke.test.mjs` | 3 pass, 0 fail, skip 0 |
| HTTPS Chromium, 모바일 390×844 | 로그인, 기본 미선택/30일 선택, 쿠키 속성, 새로고침 유지, 로그아웃, 비밀 브라우저 저장 금지, KST, 전역 새로고침, collaboration/빈 시나리오, 가로 넘침 없음 확인 |
| 브라우저 외부 요청·페이지 예외 | 0건 |
| `git diff --check` | 통과 |

추가 회귀 검사는 잘못된 계정/해시, 기본 설정 부재, 브라우저/30일 세션 만료·위변조·전체 폐기,
CSRF·출처 위조·로그아웃, 로그인 제한·동시 요청·Retry-After, 기존 토큰 호환성,
reconciliation 미인가 시 실행 0회, collaboration의 store/GitHub/agent 의존성 접근 0회를 검증한다.
실제 HTTP 검사는 6개 데모 데이터 API의 모든 시나리오와 8개 변경 API·크론 GET을 확인했다.
운영 데모/DB 설정/실제 GitHub 토큰 설정 감지 시 503도 확인했다.
HTTP 스모크는 CI에서 빌드 뒤 자동 실행하도록 연결했다.

### 실행 환경 제약

- 최초 직접 `npm test`에서는 기존 `subscription-worker`의 실제 SIGKILL/ESRCH 검사가 실패했다.
  이 컨테이너의 PID 1(`tail`)이 고아 프로세스를 회수하지 않아 좀비 프로세스 그룹이 남는 것을 확인했다.
  외부 Python 래퍼에서 Linux `PR_SET_CHILD_SUBREAPER`를 활성화하고 **동일한 `npm test`**를 실행하자 통과했다.
  래퍼는 입양된 자식을 회수하고 원래 명령의 종료 코드를 그대로 반환한다. 테스트/worker 코드를 약화하거나 건너뛰지 않았다.
- 원래 skip 3개: `TEST_DATABASE_URL` 없는 PostgreSQL 통합 2개, `unshare --pid --mount-proc` 권한 없는 검사 1개.
- 브라우저 검사는 테스트 전용 임시 TLS 인증서와 로컬 HTTPS 프록시를 사용했다. 외부 요청은 차단했다.
- 로그인 시도 제한은 프로세스당 15분/5회다. 서버리스/다중 인스턴스 전체에 공유되지 않으며 재시작 시 초기화된다.
  분산 전역 제한은 소유자가 별도의 공유/WAF 제한으로 구성해야 한다.
- 무상태 로그아웃은 브라우저 쿠키 삭제다. 개별 서버 폐기 목록은 없고 탈취 시 EPOCH 교체로 전체 폐기한다.
- Claude 호출, main 병합, 배포, 운영 환경변수 변경, 유료 API 호출은 수행하지 않았다.

## 변경 파일

- `.env.example`
- `.github/workflows/ci.yml`
- `README.md`
- `docs/ADMIN_LOGIN.md`
- `docs/DASHBOARD_USABILITY.md`
- `docs/ISSUE87_VALIDATION.md`
- `scripts/hash-admin-password.mjs`
- `scripts/login-smoke.test.mjs`
- `src/app/api/collaboration/route.ts`
- `src/app/api/collaboration/session/route.ts`
- `src/app/api/collaboration/worker/route.ts`
- `src/app/api/control/route.ts`
- `src/app/api/dispatch/route.ts`
- `src/app/api/gate/route.ts`
- `src/app/api/reconcile/route.ts`
- `src/app/api/runs/callback/route.ts`
- `src/app/api/session/route.ts`
- `src/components/LoginCard.tsx`
- `src/components/control/ControlDashboard.tsx`
- `src/components/live/session.ts`
- `src/lib/control/reconcile-http.test.ts`
- `src/lib/control/reconcile-http.ts`
- `src/lib/demo/fixtures.ts`
- `src/lib/demo/isolation.test.ts`
- `src/lib/demo/respond-http.ts`
- `src/lib/demo/respond.ts`
- `src/lib/runs/collaboration-http.ts`
- `src/lib/session/http.ts`
- `src/lib/session/password.test.ts`
- `src/lib/session/password.ts`
- `src/lib/session/rate-limit.ts`
- `src/lib/session/session.test.ts`
- `src/lib/session/session.ts`
