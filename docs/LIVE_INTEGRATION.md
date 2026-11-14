# Live integration (Issue #31) — 감사 결과, 게이트, 스모크 계획

상태: **main 병합/운영 배포 없음. 유료 에이전트 dispatch 없음.** (스택: PR30 `cf0fceeb` 위)

## 1. 감사: "샘플 배너" vs 실제 저장소
- 원인: `layout.tsx`가 상수 `SAMPLE_MODE=true`일 때 **모든 페이지** 상단에 "아직 실제 … 연결되지 않았습니다" 배너를 고정 표시했고, 홈에도 `data.ts`의 고정 샘플 카드(가짜 3개 지표)가 있었음 → 실제 DB/인증 연결과 모순.
- 수정: 전역 배너 제거. 홈은 인증된 `/api/dashboard`·`/api/readiness`만 표시(샘플 없음). 샘플(`data.ts`)을 렌더링하는 `/agents`·`/projects`·`/activity`(정적 목록)에만 구역 배너 부착.
- `/tasks`는 이미 `GET /api/work-queue`(live/unconfigured/error) 사용 — 샘플은 버튼으로만.

## 2. GitHub 큐 연결 상태 (configured / live / unknown)
- `/api/readiness`가 **GET만** 사용하는 프로브(`GET /repos/{repo}`)로 `live | unconfigured | error`를 보고하고 홈에 표시. 값/토큰은 절대 반환하지 않음.
- `GITHUB_READ_TOKEN`(읽기 전용) 우선 사용, 없으면 `GITHUB_TOKEN` 대체(최소권한 미충족으로 표시). 작업 큐 읽기도 동일 우선순위.
- **읽기 전용 검증 한계**: GET만으로는 토큰에 쓰기 권한이 *없음*을 증명할 수 없음 → `readOnly: "unknown"`(classic PAT가 `x-oauth-scopes`에 repo scope를 노출하지 않을 때만 `no_write_scope_header`). 쓰기 권한 부재 확인은 소유자가 토큰 생성 화면에서 확인해야 함.
- 이 세션에서 **실제 GitHub 라이브 프로브는 실행하지 않음**(배포 환경 변수 접근 불가, 테스트는 mock fetch).

## 3. 외부 트리거 소유권 감사 / 게이트
- 코드 내 dispatch 경로는 하나: `GitHubLabelAdapter`(라벨 `agent:*`+`status:ready` 부착) — 이미 `authorizeSubmission` 게이트 통과 후에만 호출(강제됨).
- 외부 경로(예: 본 작업을 실행한 예약 루틴 — GitHub `issues.opened` webhook 트리거)는 **저장소 코드로 차단 불가**. 라벨/이슈 생성만으로 시작되며, 소유자의 루틴 설정(claude.ai/code/routines 등)에 있음. **외부 루틴이 통제된다고 주장하지 않음.**
- 신규 `GET|POST /api/gate` — 루틴이 시작 시 먼저 호출하는 **서명된 게이트**:
  - 요청 헤더: `x-agent-key`(`claude-sonnet|claude-opus|codex|gpt`), `x-timestamp`, `x-event-id`(1회용), `x-signature` = HMAC-SHA256(`RUN_CALLBACK_SECRET_<CLAUDE|CODEX|GPT>`, `${ts}.${eventId}.`).
  - 응답: `{allow, reason, ...}` + `x-signature`(응답 서명, 루틴이 검증 가능). 인증 실패/미설정/오류/기본 OFF → `allow:false`(fail closed), replay 409.
  - 동일한 원자적 `evaluateGate`(OFF 기본값, Claude provider 스위치, 스케줄) 사용. 호출 기록은 `gateChecks`(서명된 증거)로 저장, 차단은 `blocked` 카운트·감사 로그.
  - 대시보드는 에이전트별 "외부 루틴 게이트 증거"(없음/최근/오래됨)를 표시. 증거 **없음 = 통제 미확인(unknown)**. 증거가 있어도 "루틴이 질의했음"만 증명하며 질의 없이 실행되는 경로는 막지 못함 → 릴리스 준비도의 "외부 트리거" 항목은 계속 `blocked`.
- 루틴 프롬프트 첫 단계 예시(소유자가 루틴에 추가해야 함):
  ```
  1. 서명된 GET <배포URL>/api/gate (x-agent-key: claude-sonnet, 위 서명). allow:true + 응답 서명 검증이 아니면 즉시 종료(이슈 변경 금지).
  ```
- 안전 기본값: `all-paused`(모든 에이전트 OFF). 서명 비밀 미설정 시 503.

## 4. 통제된 스모크 계획 (1건, **별도 명시 승인 전 실행 금지**)
사전: 소유자가 Vercel/Supabase 환경변수 설정, 마이그레이션, 프리뷰 배포; `/` 준비도에서 missing 0 확인.
1. 테스트 전용 Issue 1개 생성(라벨 없음, "스모크 — 코드 변경 금지, 댓글만").
2. `/api/gate`를 서명 호출 → 기본 OFF에서 `allow:false` 확인(증거 기록 확인).
3. **(승인 후에만)** `claude-sonnet` ON + `claude` provider ON → `/api/dispatch`로 해당 이슈 1건.
4. 루틴이 `ack`/`finished` 서명 콜백(`/api/runs/callback`) 전송 → 대시보드에서 `verified`(agent 확인) 확인.
5. 즉시 `all-paused` 복귀. 콜백 미수신이면 `unknown` 유지(성공 주장 금지).
이 세션에서는 어떤 단계도 실행하지 않음.

## 5. 정확한 차단 요소 / 소유자 조치
1. Vercel 프로젝트+환경변수(`DATABASE_URL`, `CONTROL_*_TOKEN`, `CRON_SECRET`, `RUN_CALLBACK_SECRET_*`, `GITHUB_REPO`, **`GITHUB_READ_TOKEN`**, dispatch 시에만 `GITHUB_TOKEN`).
2. 외부 루틴 설정에 `/api/gate` 선행 호출 추가, 또는 라벨/이슈 webhook 트리거 비활성화 — 소유자만 가능, 이 세션에서 검증 불가.
3. 라이브 스모크 승인(유료 호출 가능).
4. 읽기 토큰이 쓰기 권한이 없는지 토큰 설정에서 확인.
