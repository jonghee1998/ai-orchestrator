---
name: PM 작업 요청 (품질 게이트 기본 포함)
about: 모든 AI Orchestrator 작업 요청의 기본 템플릿
labels: ''
---
<!-- orch-root-request:v1 #<root> -->
## 요구사항 / 범위 / 인수기준 (PM 영수증: `<!-- gate:pm-scope:v1 issue=<N> -->`)

## 공통 품질 게이트 (docs/QUALITY_GATE.md)
1. 개발자 코딩 전 분석 영수증 (`gate:dev-analysis`) — 코드 변경 전에 게시
2. 자체 테스트/영향 점검 (`gate:self-test`, exact head SHA)
3. 독립 Codex 리뷰 (코드 + 영향/테스트 누락, exact SHA)
4. PM 판정 비교 (`gate:pm-compare`)
5. 동일 클래스 FAIL 반복 시 RCA (`gate:rca`) 후 교정
