# 공통 개발 품질 게이트 (Issue #172, 기본 ON)

모든 AI Orchestrator 작업(신규 기능·결함 교정 모두)에 적용된다. 구현: `scripts/gate/quality-gate.mjs`, 테스트: `scripts/gate/gate.test.mjs`.

| 단계 | 담당 | 기계 검증 영수증 (`<!-- gate:<name>:v1 … -->`) | 누락 시 |
|---|---|---|---|
| 1 요구·범위·인수기준 | PM | `pm-scope issue=<N>` (trusted PM) | BLOCKED |
| 2 코딩 전 분석 (아키텍처·데이터·제어 흐름·시나리오 매트릭스) | 개발자 | `dev-analysis issue=<N>`, **첫 코드 커밋보다 먼저** | BLOCKED / 시각 불명=UNKNOWN |
| 3 PR 전 자체 테스트·영향 점검 | 개발자 | `self-test issue=<N> sha=<head> typecheck=pass test=pass build=pass` | BLOCKED |
| 4 독립 Codex 리뷰(코드+보안) | Codex | exact-SHA `codex-review-state` (미해결 0, 보안 completed) | BLOCKED (보안 부재 ≠ PASS) |
| 5 영향·테스트 누락 리뷰 | Codex→PM 기록 | `codex-impact issue=<N> sha=<head> verdict=pass` | UNKNOWN |
| 6 PM이 원 인수기준과 판정 비교 | PM | `pm-compare issue=<N> sha=<head> verdict=pass` | UNKNOWN |

- 같은 클래스 FAIL이 2회 이상 반복되면 다음 교정 전 `rca issue=<N> class=<c>` (trusted PM) 영수증이 필요하다. 없으면 BLOCKED.
- 기능 변경과 결함 교정은 구분하되, **라벨은 교정 횟수 상한을 우회할 수 없다.** 교정 카운터는 증거(supersedes ancestry + 리뷰 FAIL)로 산출하며 `classifyChange`가 재라벨을 `relabel_ignored`로 보고한다.
- 영수증은 trusted 신원(login+id+type), exact head SHA, 시간 순서로만 인정한다. 위조·불일치·오래된 SHA는 PASS가 될 수 없다.
- **한계**: 이 게이트는 영수증의 존재·신원·순서·SHA를 기계적으로 검증할 뿐, 분석의 품질 자체를 증명하지 않는다. 마크다운 체크리스트만으로 강제되지 않으며, 강제력은 부정(negative) 테스트로 증명한다. CI/워크플로 연결(필수 체크화)은 후속 과제이며 현재는 판정 함수와 문서/템플릿까지만 제공된다(dry-run, 쓰기 없음).

## Issue #174 보완 (Correction 8)

- **공유 검증기**: 코드/보안 판정은 `scripts/handoff/review-verdict.mjs#selectReviewVerdict` 하나만 사용한다(lifecycle `reviewEvidence`와 게이트 `codex_review` 단계 동일). 상반된 completed 플래그, 다중/불량 마커, 보안 누락, 오래된 SHA, 순서 역전, 중복 영수증은 BLOCKED이며 clean 영수증이 모순 증거를 덮을 수 없다.
- **교정 요청 의미**: `resolveRootCorrections(..., {request, destination})` — PR 실행 전 요청은 다음 카운트(count+1), 해당 PR의 durable `n` 마커가 생긴 뒤 재평가는 그 PR 자신의 n. 목적지 PR+SHA와 검증된 ancestry가 일치할 때만 인정하며 중복 이벤트/과거 PR 재생은 카운트를 낮추지 못한다.
- **분석 시각**: `created_at`만으로는 불충분. `updated_at`(최종 수정)도 첫 코드 커밋보다 엄격히 앞서야 한다. 수정 이력 불명/형식 오류=UNKNOWN, 코드 커밋 이후 수정=BLOCKED.
- **CI 강제**: `scripts/gate/check.mjs`(실제 GitHub 증거 수집, 비-pass면 종료코드 1) + `.github/workflows/quality-gate.yml`(`pull_request_target`: **베이스 브랜치**의 스크립트로 실행되어 PR 코드가 체커를 위조/비활성화할 수 없음). 단계 분리: `pre-pr`(1~3단계)와 `final`(전체); 결과는 커밋 상태 `quality-gate/pre-pr`, `quality-gate/final`로 게시되어 Codex 리뷰 전 최종 게이트가 모든 PR을 교착시키지 않는다(final은 pending/failure로 남는다).
- **강제 한계(주장 금지)**: 위 상태 컨텍스트를 GitHub **브랜치 보호/ruleset의 Required status check**로 등록해야만 병합이 실제로 막힌다. 이는 저장소 소유자(admin) 설정이며 코드로 할 수 없다. 현재 해당 설정 증거가 없으므로 "완전 강제"라고 주장하지 않는다. 워크플로 파일은 대상 베이스 브랜치에 먼저 병합되어야 `pull_request_target`에서 신뢰 코드로 동작한다(부트스트랩 한계). 첫 코드 커밋 시각은 git committer date라 위조 가능성이 남는다.
- **교정 상한**: root #146 예외를 #174 소유자 상시 승인에 따라 7→8로 올렸다(root 한정, 9번째는 PM이 별도 승인을 영속화해야 함). 다른 root는 기본 3/상한 5 유지.
