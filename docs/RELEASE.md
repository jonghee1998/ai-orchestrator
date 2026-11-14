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
