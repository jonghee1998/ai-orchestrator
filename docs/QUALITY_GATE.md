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
