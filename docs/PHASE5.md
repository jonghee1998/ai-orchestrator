# Phase 5 — 통합, 실제 dispatch 게이팅, 인수 (Issue #21)

기준: Phase 4 PR #20 HEAD `9abbf0e`. **상태: 릴리스 차단(BLOCKED) — 아래 외부 설정/자격증명 필요.**

## 1. 트리거 감사 (실제 확인)
- 모든 브랜치(`git ls-tree`)에서 `.github/workflows`, `.claude/`, Codex 설정 파일 **없음**. 저장소 안에는 GitHub Actions/Claude/Codex 트리거 설정이 존재하지 않는다.
- 작업 시작은 저장소 **밖**의 설정(예: Issue webhook `issues.opened`/라벨 → 예약 Claude 루틴, "agent:claude + status:ready" 라벨 기준)으로 이루어진다. 이 설정은 저장소 코드/환경변수로 **제어할 수 없고 검증하지 못했다**.
- 외부 우회 경로: (a) 사람이 직접 `agent:claude`+`status:ready` 라벨을 붙이면 orchestrator 게이트를 거치지 않고 Claude 루틴이 실행됨, (b) 해당 루틴이 직접 실행/예약됨, (c) ChatGPT/Codex 쪽 직접 호출. orchestrator의 OFF는 이 경로를 **차단하지 못한다**.
- orchestrator 자신의 dispatch는 GitHub 라벨 부착(`GitHubLabelAdapter`)이며, 이것이 외부 루틴을 깨우는 유일한 기존 메커니즘이다. GPT/ChatGPT에는 지원되는 dispatch API가 없어 어댑터가 `unsupported`로 처리(호출 없음). 계정 전체 제어 주장 없음.

## 2. 구현
- `runs/dispatcher.ts`: `dispatchIssue`/`submitQueued` = 게이트(요청) → `authorizeSubmission`(provider 호출 직전, 원자적) → 어댑터 → 결과 영구 기록. 멱등키=dispatchId, 전송 실패/타임아웃=`unknown`(자동 재시도 금지), 4xx=`rejected`(명시 재시도 가능). 에러 상세/토큰은 저장하지 않음.
- 라벨 핸드오프(Issue #79): `claude-opus`→`agent:opus`, `claude-sonnet`→`agent:claude`, `codex`→`agent:codex`. 어댑터는 GET issue → 기존 `agent:*`/`status:*` 전부 제거 + 대상 agent + `status:ready`로 PUT(전체 교체) → 응답 라벨 검증. 무관 라벨 보존. 읽기 실패=쓰기 없음=`rejected`(재시도 가능), 쓰기 5xx/408/전송오류/응답 불일치=`unknown`. GET→PUT은 원자적이지 않으며 `X-Idempotency-Key`는 GitHub가 무시하는 추적용 헤더일 뿐 — 배타성은 store 게이트가 보장. `accepted`는 라벨 반영일 뿐 에이전트 실행 증거가 아님(Claude 루틴은 신규 issues.opened에서만 시작).
- `runs/pg-store.ts` + `getRunStore`: `DATABASE_URL` → Postgres(`SELECT … FOR UPDATE` 단일 행 트랜잭션). 서버리스(VERCEL 등)에서는 파일 폴백 **금지**. 둘 다 없으면 fail-closed.
- 인증: `GET /api/dashboard|runs|work-queue`는 `CONTROL_READ_TOKEN` 또는 `CONTROL_ADMIN_TOKEN`(미설정 503, 불일치 401). `POST /api/dispatch`, `/api/reconcile`, `/api/control`은 admin 토큰.
- 재조정: `POST /api/reconcile`(외부 스케줄러가 주기 호출) — provider 호출/재제출 없음.
- 테스트(provider spy): GPT-only, Claude-only, ON/OFF 경합, 중복 요청, lost ACK/타임아웃, 4xx, 재시작(FileRunStore 재생성), 서버리스 폴백 금지, Pg 트랜잭션, 읽기 인증.

## 3. 미완료 / 차단 사항 (수동 조치 필요)
1. **외부 트리거 제어(차단)**: 라벨 기반 Claude 루틴/webhook이 orchestrator OFF를 따르려면, 소유자가 해당 루틴을 직접 비활성화하거나 루틴 프롬프트가 `GET /api/dashboard`(읽기 토큰)로 게이트를 확인하도록 구성해야 한다. 현재 불가 → OFF는 orchestrator dispatch만 억제.
2. **실제 provider 증거 없음**: 이 세션에는 운영 환경/자격증명(DATABASE_URL, GITHUB_TOKEN 쓰기권한, CONTROL_*_TOKEN, RUN_CALLBACK_SECRET_*)이 없고, 라이브 라벨 부착은 외부 루틴(유료)을 실제로 기동시킬 수 있어 승인 없이 실행하지 않았다. **Phase 5 인수 기준(실제 provider 증거)은 미충족.**
3. 실제 Postgres에 대한 통합 테스트 미실행(가짜 클라이언트 단위 테스트만).
4. reconcile 스케줄러(cron) 미구성 — 배포 환경에서 `/api/reconcile` 주기 호출 설정 필요.
5. 취소 미지원, provider 사용량 텔레메트리 없음(`unknown`) 유지.
6. 좁은 경합 구간: `authorizeSubmission` 통과 후 provider 호출 사이에 OFF가 되면 그 한 건은 전송된다(이후 호출은 모두 차단).

## 4. Phase 4 리뷰에서 발견·수정
- `/api/dashboard`, `/api/runs`, `/api/work-queue`가 **무인증** 노출 → 읽기 토큰 필수로 수정.
- 파일 스토어가 서버리스에서도 선택 가능 → 금지.
