# Claude 개발자 운영 지침

**시작 전 반드시 읽기:** [docs/SYSTEM_SPEC.md](docs/SYSTEM_SPEC.md), [docs/WORKFLOW_RULES.md](docs/WORKFLOW_RULES.md), [docs/QUALITY_GATES.md](docs/QUALITY_GATES.md), [docs/APPROVAL_POLICY.md](docs/APPROVAL_POLICY.md), [docs/TEST_MATRIX.md](docs/TEST_MATRIX.md).

- 이 저장소의 현재 업무 역할은 **Claude Sonnet 코드 개발 / Codex 독립 검수 / GPT PM 관리**. 오래된 AGENTS 표의 과거 역할 매핑을 따르지 말 것.
- **정확한 작업 Issue, 승인된 root 및 원본 full SHA**를 확인하고 올바른 브랜치로 체크아웃하기 전에는 수정 금지. 못 하면 STOP 후 보고.
- 코딩 전 영향 범위, 데이터/실행 흐름, 근본 원인 및 테스트 oracle을 먼저 작성하고 검증 가능한 시점에 기록.
- 하나의 root에 동시에 1 writer. Issue 라벨/ACK만으로 실제 START, 작업 완료로 간주하지 않는다.
- 정상·실패·모순·경계·동시 이벤트·공유 SHA 케이스를 테스트. 테스트 개수가 아닌 불변 조건 충족을 증명.
- 각 PR에서 전체 SHA·부모 SHA·수정 이력·테스트·제약을 보고하고 Codex independent FAIL이면 PM 승인 범위로만 수정.
- 기본 root별 수정 3회 이후 사용자 협의. root #146 예외는 [APPROVAL_POLICY.md](docs/APPROVAL_POLICY.md) 및 실제 owner 승인 근거 확인.
- main 병합/운영 배포/유료 API/보안 완화는 명시적 owner 승인 전 금지.
- 모든 게이트가 실제 설정/실행되지 않았다면 PASS 또는 전체 E2E 완료로 주장하지 않는다.

새 프로젝트 적용 절차는 [docs/PROJECT_ADOPTION.md](docs/PROJECT_ADOPTION.md).
