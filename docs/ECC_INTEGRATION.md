# ECC 통합 (Issue #198) — slice 1

- **범위 원본:** Issue #198
- **G2 사전 분석:** [#198 comment 6979838699](https://github.com/jonghee1998/ai-orchestrator/issues/198#issuecomment-6979838699) (첫 코드 커밋 이전에 게시함)
- **적용 기준:** PR #196(`d6604a5a13fdef5df22e5f745af2a10c32426930`)의 문서 8개. 명세로만 참조하며 코드 베이스로는 쓰지 않음.
- **베이스:** `codex/issue-92-mobile-v2` = `072d899c705ed9c6b16b7c5b307e3fe60254b428`
- **ECC 원본:** `affaan-m/ECC` @ `3f14a103a8694e51c1df9a806217a6d0b5f7a6f7` (v2.2.3, MIT). 고정 정보는 [`ecc/ecc.lock.json`](../ecc/ecc.lock.json)에 있음.

## 권위 관계
권위 게이트는 기존 **Codex 독립 검수**와 **GitHub Actions**(`ci.yml`, `handoff-coordinator.yml`)를 그대로 유지한다. 이 slice가 추가하는 것은 모두 **advisory**이다.
- `npm run ecc:check`는 CI에 연결하지 않았고 필수 체크도 아니다. 출력에는 `authoritative:false`가 명시된다.
- 로컬 `ecc-verify` 영수증(G3)은 CI, Codex, 보안, E2E 어느 것의 PASS도 대신하지 않는다.

## Slice 1 구성
| 파일 | 출처 | 역할 |
|---|---|---|
| `.claude/skills/ecc-verify/SKILL.md` | `skills/verification-loop` 각색 | 이 저장소의 실제 명령으로 G3 자체 검증 영수증을 남긴다. 정확한 HEAD에 묶이며 미실행 단계는 `NOT_RUN`으로 표시한다 |
| `.claude/skills/ecc-change-impact/SKILL.md` | `skills/change-impact` 각색 | G2 사전 분석 형식과 첫 커밋 이전 게시 규칙(E11). 구현 후에는 계획과 diff를 대조한다 |
| `ecc/ecc.lock.json` | 신규 | 원본 SHA, 버전, 라이선스, 도입 파일의 upstream/local sha256, `hooksEnabled: []`, 검토 결정 |
| `scripts/ecc/project-check.mjs` | 신규 (AgentShield 대체) | 선택 실행하는 읽기 전용 검사. 검사 항목은 아래에 정리 |
| `scripts/ecc/project-check.test.mjs` | 신규 | T1–T23 fixture 테스트. `npm test`에 포함됨 |

### project-check 판정 규칙
**검사 항목**
- **lock:** 스키마, 원본 SHA 고정, 경로가 저장소 밖으로 나가는지, 파일 해시. 활성 훅이 있으면 FAIL.
- **`.claude/settings*.json`:** hooks, `bypassPermissions`, 광범위 allow.
- **secrets:** 고신뢰 패턴만 검사하고 값은 출력하지 않는다.
- **Actions:** top-level permissions, `write-all`, `pull_request_target`에서 PR head checkout, `run:`에 untrusted 필드 보간, 3rd-party action의 SHA 미고정(WARN).
- **에이전트 지침 파일:** AGENTS.md, CLAUDE.md, `.claude/**/*.md`에서 프롬프트 무효화 지시, `curl|sh`, 권한 우회.

**판정**
- error가 하나라도 있으면 `fail` (exit 1).
- 그 외에 검사를 수행하지 못한 항목(git 실패, 빈 인벤토리, lock 없음 또는 파싱 실패)이 있으면 `blocked` (exit 2).
- 그 외에는 `pass` (exit 0).
- 빈 파일 목록은 안전의 증거가 아니다 (WORKFLOW_RULES 불변조건 3).

**HEAD와 입력 범위 (A8)**
- `git rev-parse HEAD`가 실패하면 `blocked`다.
- `worktree.scope`가 `commit`이면 입력은 HEAD의 추적 파일 그대로다. `working-tree`이면 로컬 수정본을 검사한 결과이며, 커밋을 검증한 것이 아니다.
- `git status`가 실패하면 `blocked`다.

**파일 읽기와 커버리지**
- 모든 읽기는 `safeRead()` 한 경로를 거친다.
  - 실제 경로(`realpath`)가 저장소 안이어야 하고, 경로 중 어느 구성요소든 symlink면 거부한다(상위 디렉터리 포함).
  - `O_NOFOLLOW`로 연다.
  - 일반 파일인지와 크기를 **읽기 전에** 확인한다.
  - 최대 `maxBytes+1` 바이트만 bounded read한다.
- **정책 제외 (`coverage.excluded`, 판정 유지):** git에 추적된 symlink 자체(따라가지 않음), NUL을 포함한 binary, 이름이 고정된 lockfile(secrets 검사 제외), 작업 트리에서 삭제된 파일(git status로 확인).
- **필수 대상 누락 (`coverage.missing`, 해당 검사 `blocked`):** too-large, unreadable, outside, not-file, symlink 상위 경로.
- lock 파일, 도입 파일, `.claude/settings*.json`이 symlink이거나 저장소 밖을 가리키면 **error**다.

**출력 마스킹:** 보고서의 모든 문자열 필드(경로, 상세, 사유 포함)는 반환 전에 SECRET_RULES로 전역 치환되어 `[REDACTED:<rule>]`이 되고, 길이도 제한된다. 저장소가 제어하는 어떤 필드도 자격증명 원문을 노출하지 않는다.

**읽기 전용 계약**
- 네트워크와 쓰기를 하지 않는다.
- 하위 프로세스는 `git rev-parse HEAD`, `git ls-files -s -z`, `git --no-optional-locks status --porcelain -z`뿐이다. 마지막 명령은 index를 갱신하는 쓰기를 하지 않는다.
- 파일 내용은 정규식 매칭만 하는 untrusted data로 취급한다.
- 읽기 전용 여부는 T13이 트리 해시를 비교해 확인한다.

### 수정 이력 (#198 일반 한도 3회)
| 회차 | 기준 HEAD | 반영 | 사전 기록 |
|---|---|---|---|
| 1 | `dc69c2c0a7e3fa4627a0c3688169832bf5ce82ed` | Codex P2 4건(r4615106878 symlink, r4615106897 커버리지, r4615106913 읽기 전 크기 제한, r4615106928 진단 출력 마스킹) + #198 요청 6980639080(3건)·6980813600. T15–T23 추가 | [#198 6981149461](https://github.com/jonghee1998/ai-orchestrator/issues/198#issuecomment-6981149461) |

## ECC 조사 (고정 SHA 기준)
| 영역 | 소스 경로 | 동작·의존성 | 결정 | 이유 |
|---|---|---|---|---|
| Skills (327개) | `skills/*/SKILL.md` | 지침 문서. 일부는 외부 CLI나 API를 호출함 | **선택 도입** | 검증 2종을 각색해 slice 1에 넣음. 나머지는 과제별로 따로 평가함 |
| verification-loop | `skills/verification-loop` | build, tsc, lint, test, grep, diff | **각색 도입** | `--coverage` 인자가 이 저장소의 test 스크립트와 맞지 않고, `grep sk-`는 오탐이 많음 |
| change-impact | `skills/change-impact` | 읽기 전용 영향 분석 | **각색 도입** | G2와 일치함 |
| security-scan | `skills/security-scan` | `npx ecc-agentshield`, `--opus`는 유료 API | **대체** | 외부 npm 공급망과 과금 문제 때문에 로컬 `project-check`로 대체함 |
| tdd-workflow | `skills/tdd-workflow` | RED/GREEN 절차, 커버리지 80% 목표 | 보류 | 커버리지 도구가 없음. slice 2 후보 |
| delivery-gate | `skills/delivery-gate` | 전역 `~/.claude` Stop 훅 | 거부 | 프로젝트 요구가 아니고 전역 훅임 |
| gateguard | `skills/gateguard` | PreToolUse에서 첫 수정을 거부 | 보류 | 무인 실행에서 데드락 위험. 별도 승인과 E2E가 필요함 |
| Hooks (28개) | `hooks/hooks.json` | 모든 이벤트에 걸린 `node -e` 부트스트랩. `~/.claude`와 plugin cache에서 코드를 동적으로 `require` | **전부 비활성** | lock으로 고정·검증할 수 없는 코드 실행임 |
| Agents, Commands, Rules | `agents/`, `commands/`, `rules/` | 언어별 리뷰어와 명령 프롬프트 | 미도입 | Codex 독립 검수와 역할이 겹침. 역할 분리(C2)를 유지하기 위함 |
| Memory / Continuous learning | `skills/continuous-learning*`, `hooks/memory-persistence`, `scripts/memory*.js` | 세션 훅이 전역에 저장함 | 미도입 (A1 대상) | 프로젝트 격리와 비밀 유입 차단 설계가 먼저 필요함 |
| Multi-agent, worktree | `scripts/orchestrate-worktrees.js`, `orchestrate-codex-worker.sh` | 로컬 병렬 실행 | 미도입 (B1 대상) | 1 writer 규칙과 #146 이벤트 자동화에 의존함 |
| Install, doctor, auto-update | `install.sh`, `scripts/doctor.js`, `auto-update.js` | 전역 설치와 자동 갱신 | 거부 | A7에 따라 버전을 고정하고 수동으로 갱신함 (아래 절차) |
| MCP configs | `mcp-configs/` | 외부 서버 | 미도입 | 외부 서비스를 추가하는 것은 #198 기본 범위 밖임 |
| Model routing, cost | `commands/model-route.md`, `skills/cost-*` | 모델 선택 지침 | 미도입 (B3/C4 대상) | 실제 가용성과 한도를 확인하는 경로가 필요함 |
| CI | `.github/workflows/*` | ECC 자체 릴리스와 검증 | 참고만 | 이 저장소 Actions는 변경하지 않음 |

## 업데이트·롤백 절차 (A7, 수동)
1. 새 ECC SHA를 고정한다. upstream 파일 diff를 검토한다.
2. 각색 파일을 수정하고, `ecc.lock.json`의 `commit`, `upstreamSha256`, `localSha256`를 갱신한다.
3. `npm test`와 `npm run ecc:check`를 실행한 뒤 PR을 연다. Codex 검수와 CI가 권위 게이트다.
4. **롤백:** 이전 lock과 파일로 되돌리는 revert PR을 연다. 파일 해시가 lock과 맞지 않으면 `ecc:check`가 `fail`을 낸다.

## 선행 의존성 (미병합)
- **D1:** ECC 검사를 Actions 품질 게이트에 연결하는 일. #194 / PR #193의 `quality-gate/pre-pr`·`final` 컨텍스트와 공유 SHA 집계 모델에 의존한다. slice 1에서는 **연결하지 않았다.**
- **D2:** AGENTS.md와 CLAUDE.md의 역할 정정. PR #196 병합에 의존한다. 이 slice에서는 수정하지 않았다.
- **D3:** A1–C6의 실제 E2E. #146 T6 이벤트 자동화와 Codex 개발 경로(#147 blocker)에 의존한다.

## A1–C6 상태 (slice 1 시점)
`partial`은 일부만 구현됐다는 뜻이다. E2E가 없으므로 어느 항목도 완료가 아니다.

| 항목 | 상태 | 근거 |
|---|---|---|
| A6 방어적 보안 검사 | partial | secrets, Actions 권한·주입, 위험 지시, 외부 확장 훅 검사(로컬). 의존성 감사는 아직 없음 |
| A7 버전 고정·업데이트·롤백 | partial | lock과 해시 검증, 수동 절차. 신규 프로젝트 자동 적용은 아직 없음 |
| A8 실행 증거 | partial | `ecc-verify` 영수증에 HEAD 고정, `project-check`의 `head` 필드 |
| C2 자체 테스트와 Codex 독립성 | partial | advisory 표기로 역할을 분리함. 강제는 D1에 의존함 |
| A1–A5, B1–B4, C1, C3–C6 | not_started | D1–D3에 의존하거나 이후 slice에서 다룸 |

#146의 기존 수정 기록, 마커, 카운터는 변경하지 않았다. 이 작업은 #198의 별도 범위이며 일반 한도(3회)를 적용한다.
