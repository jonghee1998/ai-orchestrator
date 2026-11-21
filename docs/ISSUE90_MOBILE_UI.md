> 이 문서의 데모·시뮬레이션 기능은 2026-11-21 삭제되었습니다.

# Issue #90 모바일 4탭 UI

기준: `main` / `f1f615d7e3d4ba044d2dd9e3d621f62dedd6b3a3`.
작업 브랜치: `codex/issue-90-mobile-ui`.
PM이 제공한 개발계 SHA `901602684b22a428525b2c8e5d16d1e20a0b99be`와 main의 파일 동일성 검증을 사용했다.
Vercel 접근이나 GitHub API 재인증은 수행하지 않았다. Issue #89 인증 수정과 #78 자동화는 변경하지 않았다.

## 구현

- 하단 탐색은 **홈 / 프로젝트 / 에이전트 / 활동** 4개. 선택 탭의 `aria-current`, 44px 이상 터치 영역,
  키보드 포커스, safe-area, 마지막 콘텐츠용 하단 여백, 글자 대비를 적용했다.
- 홈은 **내 확인 필요 → 프로젝트 현황 → AI가 진행 중인 일 → 최근 활동 5건** 순서다.
  계정은 간결한 접기 영역에 있고, 연결·릴리스·상세 런타임 기록은 기본 접었다.
- 프로젝트 목록 → 프로젝트 상세 → 작업 상세를 연결했다. 목표·완료·진행·남은 일·확인 필요,
  제목·담당·상태·다음 할 일·선행 작업과 결과/테스트/검수/출처를 표시한다.
  단계는 확인한 근거만 표시하고 개발 완료 보고, 검수 결과, 업무 종료와 배포를 구분한다.
- 단일 업무 모델을 네 탭에서 공유한다. 실제 프로젝트는 유일한 `project:*` 라벨 또는 마일스톤으로만 묶는다.
  모호하거나 근거가 없으면 미분류, 목표가 없으면 미등록이다. 임의 프로젝트/진행률은 만들지 않는다.
  남은 일은 전체에서 업무 완료를 뺀 값이며 진행·검수 중인 일도 포함한다고 표시한다.
- 에이전트는 담당 프로젝트·현재 작업·대기 사항·최근 응답과 **배정 가능 여부 / 현재 실행 기록**을 따로 보여준다.
  기존 제어는 에이전트의 배정 설정으로 옮겼다. 샘플에서는 버튼을 비활성화하고 send도 방어하므로 실제 변경 요청이 없다.
  외부에서 시작한 작업은 이곳의 일시정지로 차단하지 못한다는 안내는 설정 상세에 남겼다.
- 활동은 시각·담당·작업명·변경 내용·출처를 표시하고 원문은 접었다. 원본 이벤트 ID/URL로 중복을 제거한다.
  GitHub 자기보고와 내부 기록은 별도 출처이며 실행 횟수로 합산하지 않는다.
- 샘플은 3개 프로젝트/10개 업무의 목표·담당·상태·완료 결과를 일관되게 담는다. 운영에서는 섞이지 않는다.
  `개발용 샘플 화면 · 실제 AI 실행 없음`과 고정 샘플 기준 시각을 표시한다.
  상단의 마지막 성공 시각은 실제 전역 새로고침 시각이다. 사용량 13%를 하드코딩하지 않았다.
- API는 읽기 데이터에 프로젝트 근거·업무 요구사항·기록 시각/테스트 결과를 추가할 뿐,
  인증·서명·상태 변경·dispatch·DB 구조를 바꾸지 않았다.

## 기존 URL과 기능

| 기존 URL | 연결 화면 |
| --- | --- |
| `/progress` | `/projects#work-details` (기존 진행 상세 유지) |
| `/tasks` | `/projects#work-details` (기존 작업 큐 유지) |
| `/evidence` | `/projects#results` (기존 검수 원문 유지) |
| `/control` | `/agents#assignment-settings` (기존 배정 제어 유지) |

아이디·비밀번호 로그인, 유지 선택, 로그아웃, 쿠키/CSRF, KST, 전역 새로고침,
기존 polling/공유 GET/마지막 정상 데이터 보존, 데모 격리와 변경 요청 차단은 유지했다.

## 실제 검증 결과

Node 22.23.5와 기존 lockfile의 설치 상태를 사용했다. 의존성/lockfile은 변경하지 않았다.

| 검사 | 결과 |
| --- | --- |
| `npm run typecheck` | 통과 |
| `npm test` | 280개 중 277 pass / 0 fail / 3 skip |
| 최종 샘플 보완 후 관련 업무 모델·데모 테스트 | 16 pass / 0 fail |
| `npm run build` | 통과 |
| `node --test scripts/login-smoke.test.mjs` | 3 pass / 0 fail |
| HTTPS Chromium 모바일 360/390/430px | 4탭, 프로젝트/작업 상세, 탭 선택, 터치 영역, 가로 넘침 없음, 마지막 콘텐츠 가림 없음 통과 |
| normal / empty / partial-failure / error | 통과; 오류 시 마지막 정상 프로젝트 유지 확인 |
| 로그인 유지·새로고침·로그아웃·KST·기존 URL | 통과 |
| 브라우저 외부 요청·데이터 변경 요청·페이지 오류 | 모두 0건 (로그인/로그아웃/시나리오 쿠키 API는 허용) |
| `git diff --check` | 통과 |

`npm test`는 이 클라우드의 PID 1이 고아 프로세스를 회수하지 않는 특성 때문에 기존 subreaper 래퍼에서
원래 명령/종료 코드를 보존해 실행했다. 테스트를 약화하거나 추가 skip 하지 않았다.
원래 skip: PostgreSQL 미설정 2개, PID namespace 권한 미지원 1개.

모바일 재현: 빌드 후 `MOBILE_EVIDENCE_DIR=/tmp/issue90-mobile python3 scripts/mobile-ui-smoke.py`.
Python Playwright·Chromium·OpenSSL이 필요하다. 임시 샘플 계정과 로컬 HTTPS 인증서만 쓰고 외부 요청을 차단한다.
최초 검증에서 로컬 프록시의 HTTPS 전달 헤더 문제를 수정한 뒤 URL 호환 검증도 통과했다. 앱 배포 문제는 아니다.

## 변경 파일과 검수 자료

주요 구현은 `src/components/workspace/`, `src/lib/github/mobile-workspace.ts`에 있다.
4탭 페이지·프로젝트 상세 경로, BottomNav/DemoBanner/GlobalRefresh/LiveStatus, 기존 제어·기술 상세의 연결,
읽기 모델(`work-queue.ts`, `control/service.ts`), 데모 픽스처, 모바일 스타일을 변경했다.
회귀 테스트는 `src/lib/github/mobile-workspace.test.ts`, 브라우저 재현은 `scripts/mobile-ui-smoke.py`다.
정확한 전체 목록은 최종 커밋의 `git show --stat`로 확인할 수 있다.

캡처는 `/workspace/exports/issue90/`에 너비별 4탭·작업 상세·4개 시나리오로 제공하고 ZIP으로 묶었다.
테스트 산출물과 임시 인증서는 소스 저장소에 포함하지 않는다.

## 제한 및 인계

- GitHub API 본문 대신 PM이 전달한 Issue #90 상세 요구사항을 사용했다. 실서비스/배포를 검증했다고 주장하지 않는다.
- 실데이터의 프로젝트 목표가 없으면 미등록, 자료/검수가 없으면 미확인으로 표시한다. 새로운 편집/승인 API는 만들지 않았다.
- 샘플 배정 설정은 읽기 전용이다. 실제 AI나 외부 데이터에 접근하지 않는다.
- 상세 기술 화면은 기존 기록을 유지하므로 기술 용어가 남아 있다. 기본 업무 화면에서는 숨겨 두었다.
- 기존 로그인 보안 및 배포·자동화 개선은 이번 범위 밖이다.
- Claude 호출, 실제 GitHub/DB/provider 작업 실행, main 병합, 운영 환경변수 변경, 배포는 수행하지 않았다.
- 후속 독립 검수와 개발계 배포는 GPT PM이 담당한다. 현재 브랜치는 게시 가능한 로컬 커밋으로 인계한다.

## 전체 변경 파일

- `docs/ISSUE90_MOBILE_UI.md`
- `scripts/mobile-ui-smoke.py`
- `src/app/activity/page.tsx`
- `src/app/agents/page.tsx`
- `src/app/control/page.tsx`
- `src/app/evidence/page.tsx`
- `src/app/globals.css`
- `src/app/layout.tsx`
- `src/app/page.tsx`
- `src/app/progress/page.tsx`
- `src/app/projects/[projectId]/page.tsx`
- `src/app/projects/[projectId]/tasks/[taskId]/page.tsx`
- `src/app/projects/page.tsx`
- `src/app/tasks/page.tsx`
- `src/components/BottomNav.tsx`
- `src/components/DemoBanner.tsx`
- `src/components/GlobalRefresh.tsx`
- `src/components/control/ControlDashboard.tsx`
- `src/components/live/LiveStatus.tsx`
- `src/components/overview/OverviewDashboard.tsx`
- `src/components/workspace/DemoContext.tsx`
- `src/components/workspace/TechnicalEvidence.tsx`
- `src/components/workspace/WorkspaceScreens.tsx`
- `src/components/workspace/useWorkspace.ts`
- `src/lib/control/service.ts`
- `src/lib/demo/fixtures.ts`
- `src/lib/github/mobile-workspace.test.ts`
- `src/lib/github/mobile-workspace.ts`
- `src/lib/github/work-queue.ts`
- `tailwind.config.ts`
