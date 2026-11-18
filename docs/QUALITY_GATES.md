# 개발/독립 검수 공통 품질 게이트 (v1)

> “CI 성공” ≠ “Codex PASS” ≠ “보안 PASS” ≠ “실제 E2E PASS”. 게이트는 코드와 필수 체크 설정에 실제 연결되었을 때만 강제된다.

| 순서 | 책임 | 요구 증거 | 통과 기준 |
|---|---|---|---|
| G0 PM scope | GPT PM | 최초 요구사항, 변경 범위, 영향·인수 기준, 정확한 root/issue | 모호한 요청 없음 |
| G1 Source | Claude | 실제 repo/branch/HEAD/session, 원본·부모 SHA | 소스 틀리면 개발 중단 |
| G2 Pre-code analysis | Claude + PM | 호출·데이터 흐름, 신뢰 경계, 전체 영향, 실패 조합과 테스트 표 | **첫 코드 커밋 이전 존재** 검증; 뒤늦게 편집된 기록은 미인정 |
| G3 Self verification | Claude | 테스트, typecheck, build, 부정 테스트, 실행 로그/정확한 SHA | 실패·모순된 자체 테스트 영수증이 없는지 검사 |
| G4 CI / route | Actions | 해당 HEAD의 CI, 필수 컨텍스트, 증거 변경시 자동 재실행 | CI와 상태 무효화가 실제 작동 |
| G5 Code impact review | Codex | 동일 SHA 독립 리뷰, 영향 범위/테스트 누락 검토 | 미해결 P1/P2 등 actionable findings 없음 |
| G6 Security | 실제 지원되는 독립 보안 검수 | 동일 SHA의 검증 결과 | 없거나 충돌하면 BLOCKED; 보안 기능 미지원이면 미검증 |
| G7 E2E | GPT PM | 실제 GitHub 이벤트·에이전트·PR·재작업·승인 대기 로그 | 프로젝트별 시나리오 모두 증명 |
| G8 Owner gate | 사용자 | 최종 승인 기록 | main 병합/배포 전에 명시 승인 |

### 안전 규칙
- 같은 SHA에 불일치 코드·보안·자체 테스트 영수증이 있으면 임의 PASS 선택 금지.
- `trustedWriter`, 검수자, PM 표식은 API에서 확인한 신원과 연결해야 한다. 단순 댓글 텍스트만으로 실제 Codex 영향 분석을 증명할 수 없다.
- 모든 게이트의 provenance, created/updated 시각, 정확한 SHA, 중복/충돌/조회 실패를 처리한다.
- 다음 수정의 전제가 되는 독립 검수는 정확한 SHA의 실제 결과로 판단한다. 최신 SHA가 바뀌면 과거 PASS는 현 코드의 PASS가 아니다.
- G0~G3은 PR 작성 전 검사 가능. PR 생성 후에만 가능한 리뷰·보안은 PR 단계에서 검사해 데드락을 피한다.
- 구현하지 않은 게이트는 `not_enforced`로 보고하고 승인 대기 완료를 주장하지 않는다.
- 반복 FAIL일 때는 기존 지적만 고치지 않고 동일 데이터 흐름·증거 출처·상태 전환 전반의 누락을 재분석한다.

### 기존 저장소 기술 매핑 (예시이며 실행 보증 아님)
`scripts/gate/quality-gate.mjs`, `check.mjs`, `event-route.mjs`, `.github/workflows/quality-gate*.yml`. 코드 구현과 이 명세가 다르면 FAIL/미검증으로 보고하고 별도 승인된 PR로 조정한다.
