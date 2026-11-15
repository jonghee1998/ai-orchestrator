# Live integration (Issue #31) — 감사 결과, 게이트, 스모크 계획

상태: **main 병합/운영 배포 없음. 유료 에이전트 dispatch 없음.** (스택: PR30 `cf0fceeb` 위)

## 1. 감사: "샘플 배너" vs 실제 저장소
- 원인: `layout.tsx`가 상수 `SAMPLE_MODE=true`일 때 **모든 페이지** 상단에 "아직 실제 … 연결되지 않았습니다" 배너를 고정 표시했고, 홈에도 `data.ts`의 고정 샘플 카드(가짜 3개 지표)가 있었음 → 실제 DB/인증 연결과 모순.
- 수정: 전역 배너 제거. 홈은 인증된 `/api/dashboard`·`/api/readiness`만 표시(샘플 없음). 샘플(`data.ts`)을 렌더링하는 `/agents`·`/projects`·`/activity`(정적 목록)에만 구역 배너 부착.
- `/tasks`는 이미 `GET /api/work-queue`(live/unconfigured/error) 사용 — 샘플은 버튼으로만.

## 2. GitHub 큐 연결 상태 (configured / live / unknown)
- `/api/readiness`가 **GET만** 사용하는 프로브(`GET /repos/{repo}` + **`GET /repos/{repo}/issues?per_page=1`**, #34)로 `live | unconfigured | error`를 보고하고 홈에 표시. 값/토큰은 절대 반환하지 않음.
- `GITHUB_READ_TOKEN`(읽기 전용) 우선 사용, 없으면 `GITHUB_TOKEN` 대체(최소권한 미충족으로 표시). 작업 큐 읽기도 동일 우선순위.
- #34: 저장소 GET 성공만으로는 Issues 접근이 증명되지 않으므로 `/issues` GET이 200+배열일 때만 `live`(`issues: readable`). 403/404 → `denied`, 410/`has_issues:false` → `disabled`, 그 외 → `error`. 한계: **공개** 저장소에서는 Issues 권한 없는 토큰도 공개 이슈를 읽을 수 있어 권한 증명이 약함(비공개 저장소에서는 유효).
- **읽기 전용 검증 한계**: GET만으로는 토큰에 쓰기 권한이 *없음*을 증명할 수 없음 → `readOnly: "unknown"`(classic PAT가 `x-oauth-scopes`에 repo scope를 노출하지 않을 때만 `no_write_scope_header`). 쓰기 권한 부재 확인은 소유자가 토큰 생성 화면에서 확인해야 함.
- 이 세션에서 **실제 GitHub 라이브 프로브는 실행하지 않음**(배포 환경 변수 접근 불가, 테스트는 mock fetch).

## 3. 외부 트리거 소유권 감사 / 게이트
- 코드 내 dispatch 경로는 하나: `GitHubLabelAdapter`(기존 `agent:*`/`status:*`를 대상 agent+`status:ready`로 교체, 무관 라벨 보존) — 이미 `authorizeSubmission` 게이트 통과 후에만 호출(강제됨).
- 외부 경로(예: 본 작업을 실행한 예약 루틴 — GitHub `issues.opened` webhook 트리거)는 **저장소 코드로 차단 불가**. 라벨/이슈 생성만으로 시작되며, 소유자의 루틴 설정(claude.ai/code/routines 등)에 있음. **외부 루틴이 통제된다고 주장하지 않음.**
- **게이트 v2 (#34)** `POST /api/gate` — 루틴이 시작 시 먼저 호출하는 **에이전트·작업 바인딩 서명 게이트** (v1 GET은 405로 폐기):
  - 본문(서명 대상): `{"v":2,"agent":"claude-opus","issueNumber":34[,"dispatchId":"d-34-claude-opus-1"]}`
  - 헤더: `x-agent-key`(본문 agent와 일치해야 함), `x-timestamp`, `x-event-id`(1회용), `x-signature` = HMAC-SHA256(`RUN_CALLBACK_SECRET_<AGENT_KEY>`, `${ts}.${eventId}.${rawBody}`). 예: `claude-opus` → `RUN_CALLBACK_SECRET_CLAUDE_OPUS`. **provider 공용 비밀 fallback 없음** → Sonnet 비밀로 Opus 허가를 받을 수 없음(테스트+로컬 서버로 확인).
  - **작업별 승인**: 제어 게이트(ON/provider/스케줄) 통과 **그리고** 오케스트레이터가 `authorizeSubmission`으로 승인한 바로 그 `(issueNumber, agent)` dispatch가 진행 중일 때만 `allow:true` + `dispatchId`. 사람이 라벨만 붙인 이슈 → `no_authorized_dispatch`. 보류/종료/다른 dispatchId → `dispatch_held|dispatch_finished|dispatch_mismatch`.
  - 응답: `{allow, reason, agent, issueNumber, dispatchId, at, eventId}` + `x-signature`(같은 에이전트 비밀로 `${at}.${eventId}.${body}`). 인증 실패 401 / 비밀 미설정 503 / replay 409 / 형식 오류 400 — 모두 `allow:false`.
  - 증거는 `gateChecks`·감사 로그(`external_allowed|external_blocked`)에 기록. 증거는 "루틴이 질의했음"만 증명 → 릴리스 준비도 "외부 트리거"는 소유자가 루틴 설정을 바꾸고 OFF 거부를 실측하기 전까지 `blocked`.
- 루틴 측 클라이언트: `scripts/gate-check.mjs` (요청 서명 + **응답 서명/바인딩 검증**, allow일 때만 exit 0, `dispatchId` 출력).
- **루틴 프롬프트에 넣을 정확한 첫 단계** (소유자만 설정 가능 — 각 루틴 환경에 `ORCH_URL`, `GATE_SECRET`=해당 에이전트 비밀만 설정):
  ```
  0. 작업 처리 전에 반드시 실행: node scripts/gate-check.mjs <claude-opus|claude-sonnet|codex> <이슈번호>
     exit 0 이 아니면 즉시 종료한다. 이슈 라벨/댓글/브랜치를 포함해 어떤 변경도 하지 않는다.
     성공 시 출력된 dispatchId를 /api/runs/callback(ack/started/heartbeat/finished, 같은 에이전트 비밀로 서명)에 사용한다.
  ```
  루틴이 게이트를 건너뛰면 통제되지 않음 — 이 한계는 코드로 해결 불가.
- 안전 기본값: `all-paused`(모든 에이전트 OFF). 서명 비밀 미설정 시 503.

> #55: HMAC 키를 가질 수 없는 루틴 세션용 호환 경로는 [SESSION_AUTH.md](./SESSION_AUTH.md) 참고 (기존 HMAC 경로 불변).

## 4. 통제된 스모크 계획 (1건, **별도 명시 승인 전 실행 금지**)
사전: 소유자가 Vercel/Supabase 환경변수 설정, 마이그레이션, 프리뷰 배포; `/` 준비도에서 missing 0 확인.
1. 테스트 전용 Issue 1개 생성(라벨 없음, "스모크 — 코드 변경 금지, 댓글만").
2. `scripts/gate-check.mjs`로 서명 호출 → 기본 OFF에서 `allow:false`(exit 1) 확인, ON이어도 dispatch 없는 이슈는 `no_authorized_dispatch` 확인.
3. **(승인 후에만)** `claude-sonnet` ON + `claude` provider ON → `/api/dispatch`로 해당 이슈 1건.
4. 루틴이 `ack`/`finished` 서명 콜백(`/api/runs/callback`) 전송 → 대시보드에서 `verified`(agent 확인, HMAC run만 — 세션 run은 #57부터 항상 미검증 자기보고로 표시) 확인.
5. 즉시 `all-paused` 복귀. 콜백 미수신이면 `unknown` 유지(성공 주장 금지).
이 세션에서는 어떤 단계도 실행하지 않음.

## 5. 정확한 차단 요소 / 소유자 조치
1. Vercel 프로젝트+환경변수(`DATABASE_URL`, `CONTROL_*_TOKEN`, `CRON_SECRET`, `RUN_CALLBACK_SECRET_*`, `GITHUB_REPO`, **`GITHUB_READ_TOKEN`**, dispatch 시에만 `GITHUB_TOKEN`).
2. 외부 루틴 설정에 `/api/gate` 선행 호출 추가, 또는 라벨/이슈 webhook 트리거 비활성화 — 소유자만 가능, 이 세션에서 검증 불가.
3. 라이브 스모크 승인(유료 호출 가능).
4. 읽기 토큰이 쓰기 권한이 없는지 토큰 설정에서 확인.

## 6. #34 변경 요약 (PR32 `dd024e4f` 위 스택)
- 게이트 v2: 에이전트별 비밀 + 서명 본문에 agent/issue 바인딩 + 작업별 승인(`submitAuthorizedAt`). v1 GET 폐기.
- 준비도: 에이전트별 비밀 필수, 에이전트 간 동일 값 → `blocked`, 공용 provider 비밀만 있으면 `missing`. GitHub 프로브는 Issues 읽기까지 확인.
- `/agents`·`/projects`·`/activity`: 정적 샘플(`data.ts`) 제거 → 인증된 `/api/dashboard`·`/api/work-queue` 실제 데이터. 토큰 없음/401/미설정/오류는 그대로 표시.
- 로컬 실측(`next start` + 파일 저장소, 실제 dispatch 없음): OFF → 서명된 deny, Sonnet 비밀로 Opus 주장 → 401, GET → 405, 비밀 없는 에이전트 → 503, ON+승인 dispatch(#34 시드) → allow+dispatchId, ON+다른 이슈 → `no_authorized_dispatch`.
- 마이그레이션: 기존 `RUN_CALLBACK_SECRET_CLAUDE` 사용자는 `_CLAUDE_SONNET`/`_CLAUDE_OPUS`로 **서로 다른 값**을 설정해야 콜백/게이트가 동작(미설정 시 503 fail closed).
