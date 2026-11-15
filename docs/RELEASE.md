# 릴리스 준비 (Issue #23) — Vercel + Supabase Postgres (제안, 기존 프로젝트 가정 없음)

상태: **릴리스 차단(BLOCKED)**. main 병합·배포 없음. 아래 "소유자 조치"가 완료되고 라이브 스모크가 검증되기 전에는 릴리스 금지.

## Verified (이 세션에서 실제 실행)
- 단위/통합 테스트 58/58 (로컬 PostgreSQL 16 대상 `TEST_DATABASE_URL` 포함, skip 0), typecheck, build OK.
- 로컬 Postgres 대상 마이그레이션(`node scripts/migrate.mjs`), 20개 동시 트랜잭션 무손실, 롤백, "재시작"(새 풀/스토어) 내구성.
- **버그 발견·수정**: 동시 첫 트랜잭션이 `CREATE TABLE IF NOT EXISTS`에서 충돌(23505) → advisory lock 추가.
- 로컬 `next start` + 실제 Postgres 스모크: 무인증 401, 인증 dashboard/readiness, 프리셋 변경 영속, cron 인증(Bearer CRON_SECRET) 200/무인증 401, GitHub 미설정 시 dispatch 503(fail-closed).
- 모바일(390px) 스크린샷 `docs/screenshots/{home,control}-mobile.png`, 가로 오버플로 없음.

## Blocked / Not verified
1. 외부 GitHub 트리거(라벨 `agent:*`+`status:ready` → 예약 루틴/webhook)는 저장소 코드로 제어 불가 → **OFF는 계정 전체 제어가 아님**(UI에 상시 고지).
2. 실제 provider 라이브 스모크, Vercel/Supabase 실환경 배포·크론 실행, 콜백 서명 실수신 — 미실행(자격증명·유료 호출 승인 필요).
3. 인증된 "poll" 증거: 현재 증거 = HMAC 서명 콜백 + 시간초과 reconcile(provider 호출 없음). provider 폴링 API는 없음(미구현·미주장).
4. Vercel Hobby 플랜 크론은 하루 1회로 제한 — 5분 주기는 Pro 필요(`vercel.json` 조정 가능).

## 소유자 조치 체크리스트
1. Supabase 프로젝트 생성 → Connection string(풀러, SSL) 확인. `DATABASE_URL`로만 사용.
2. 마이그레이션: `DATABASE_URL=... node scripts/migrate.mjs` (멱등).
3. Vercel 프로젝트 생성 후 환경변수(모두 Secret, 저장소/채팅에 기록 금지):
   - `DATABASE_URL` (Supabase), `CONTROL_ADMIN_TOKEN` (≥16자), `CONTROL_READ_TOKEN` (≥16자, 선택)
   - `GITHUB_TOKEN` (Issues 쓰기 fine-grained), `GITHUB_REPO=jonghee1998/ai-orchestrator`
   - `RUN_CALLBACK_SECRET_CLAUDE_SONNET`·`_CLAUDE_OPUS`·`_CODEX`·`_GPT` 에이전트별 **고유** 서명 비밀(≥32자, 공유 금지 — #34), `CRON_SECRET` (≥16자; Vercel Cron이 Bearer로 전송)
4. 외부 루틴: 라벨 기반 루틴/webhook을 비활성화하거나, 루틴 프롬프트가 `GET /api/dashboard`(읽기 토큰)로 게이트 확인 후 동작하도록 구성.
5. 프리뷰 배포 → `/` 의 "릴리스 준비도"에서 missing 0 확인 → 소규모 라이브 스모크(승인된 1건) → 증거(콜백 ACK) 확인.
6. 위 모두 확인 후 명시적 승인으로 main 병합/운영 배포.

---

## Issue #60 — GitHub 기반 대시보드 릴리스 수용 (세션 콜백 없이)

### 추가된 것 (읽기 전용)
- `GET /api/evidence` (읽기/관리자 토큰 필수, `requireRead`) → `src/lib/github/evidence-reader.ts` (GitHub REST **GET만**, 10s 타임아웃, `redirect: "error"`, 페이지 상한: issues 3·pulls 1·comments 5·상세 PR 30, 동시 5) → `src/lib/github/evidence.ts` (순수 함수).
- `/evidence` 페이지 (하단 내비 "증거"): 이슈별 ACK·완료 보고·연결 PR·리뷰·수정 라운드·PM 마커·다음 조치. 60초 폴링 + 서버 인스턴스당 30초 메모.
- 응답에 `source: "github"`, `runtimeProof: "not_included"` 고정. 코멘트 작성자는 GitHub 로그인(루틴은 소유자 계정으로 게시)이며 본문의 에이전트명은 **자기 보고** — UI에 상시 표기. 세션 콜백(#59)은 조회하지 않음.
- 신호 규칙: 코멘트 분류는 **첫 줄만**(괄호 안 dedupe 키 제외, ACK 토큰만), PM 마커 `gpt-pm-event-state:v1 prN:<sha>:…:review:k` / `gpt-pm-followup:prN:<sha>:<agent>:revise:k`, 공식 리뷰 `APPROVED`/`CHANGES_REQUESTED`, 봇 리뷰의 `commit_id == head`. 수정 반영 판정 = 판정 이후 커밋 / 마커 SHA≠현재 head / head 브랜치 위에 스택된 PR. 상세 미조회 PR은 `detail: "skipped"`로 표시하고 추정하지 않음.
- 신규 비밀 없음: 기존 `GITHUB_REPO` + `GITHUB_READ_TOKEN`(없으면 `GITHUB_TOKEN`)만 사용. DB 불필요, 쓰기 없음.

### 검증 (이 세션 실측)
- `npm test` 162 중 160 pass / 0 fail / 2 skip(Postgres), `npm run typecheck`, `npm run build` 성공.
- 실제 GitHub 데이터(공개 저장소 GET, 스크래치 스크립트): 이슈 37·PR 23·코멘트 138·상세 PR 23. 예: #57/#59 → PR #58 "Codex 리뷰 요청됨(현재 head)", #55 → PR #56 "봇 리뷰 완료 — PM 판정 필요", #41 → PR #44 "수정은 스택 PR #48에서 진행".
- 로컬 `next start`: 무토큰 401, 잘못된 토큰 401, 유효 토큰+GitHub 미설정 → `unconfigured` 200, `/evidence` 200.
- **미검증**: Vercel 프리뷰 상의 `/api/evidence` 실호출(배포 보호 #59로 세션에서 접근 불가 — 우회하지 않음).

### 릴리스 조상(ancestry) — 확인 결과
- `main` = `79e10b2` (초기화 커밋 1개, 사실상 빈 기준선). 기준 `fb5e578`은 main의 후손(26커밋), 마이그레이션은 `db/migrations/001_orchestrator_state.sql` 1개(멱등).
- 열린 스택: PR #2(→main) ← … ← #54 ← #56 ← #58 ← 본 PR. `fb5e578`에 **포함되지 않은** PR head: #43(`99da358`), #47(`58ea47a`), #37(`62ee0ff`). #54가 #43+#47을 재적용한 통합본이면 이 PR들은 병합하지 말고 superseded로 닫아야 함(PM 판단).

### 소유자 릴리스 단계 (승인 후에만)
1. PM이 본 PR 수용 확인 → 본 PR을 `claude/beautiful-keller-6hcepx`에 병합.
2. 단일 릴리스 PR: 최종 스택 브랜치 → `main` (중간 스택 PR들은 개별 병합 대신 superseded 처리 권장). main 병합은 소유자 명시 승인 필요.
3. Vercel 환경변수(기존 값 재사용, 신규 비밀 불필요): `CONTROL_ADMIN_TOKEN`(+선택 `CONTROL_READ_TOKEN`), `GITHUB_REPO`, `GITHUB_READ_TOKEN`(Issues/PR read). 제어·실행 기능까지 운영하려면 기존 목록(`DATABASE_URL`, `CRON_SECRET`, 에이전트별 서명 비밀 등)도 필요.
4. `DATABASE_URL=… node scripts/migrate.mjs` (운영 DB 쓰기 — 소유자가 직접 실행).
5. 프리뷰에서 소유자 브라우저로 `/evidence` 확인(Vercel 배포 보호 유지 + 앱 토큰) → 운영 배포.

### 차단/결정 필요
- `/api/readiness`의 `releaseBlocked`는 서명 비밀·DB·CRON 미설정 시 계속 true. GitHub 증거 전용 릴리스라면 PM이 이 게이트를 "제어 기능 비활성 상태로 릴리스"로 수용할지 결정 필요(게이트 코드는 변경하지 않음).
- 세션 콜백 런타임 증명(#59)은 보류 — 대시보드는 GitHub 증거만 표시.
- 코멘트 기반 신호는 같은 소유자 계정이 게시하므로 작성자 위조 방지 증명이 아님(표기됨).
