# 새로운 프로젝트에 공통 룰 적용하기

**중요:** ai-orchestrator 저장소에 문서를 추가했다고 다른 GitHub 저장소가 자동으로 따라야 하는 것은 아니다. 다른 프로젝트에 적용하려면 해당 프로젝트 저장소에 채택 단계가 필요하다.

## 채택 체크리스트
1. 새 저장소에 `AGENTS.md`를 두고 이 문서 집합의 채택 버전, 역할/권한/예외 및 링크를 명시한다. Claude Code 사용 시 `CLAUDE.md`에서 같은 규칙을 참조한다.
2. 프로젝트 목표/인수기준 `docs/PROJECT_SCOPE.md`를 작성하고 GitHub Issue에 root/작업/승인 조건을 연결한다.
3. 이 문서 5개 규약 `SYSTEM_SPEC / WORKFLOW_RULES / QUALITY_GATES / APPROVAL_POLICY / TEST_MATRIX`를 복사하거나 version-pinned 링크로 채택한다. 충돌 시 상위 승인/보안 규칙 우선; 예외는 owner 승인 기록.
4. 프로젝트 상황에 맞는 quality-gate 코드/CI/Actions/필수 branch ruleset을 설치한다. **문서 링크만으로 자동 강제 불가능**.
5. Claude 소스 체크아웃/사전 분석, Codex 독립 검수/정확한 SHA, 기본 수정3회·사용자 승인 대기 동작을 실제로 검증한다.
6. default branch 이벤트, required checks, security 리뷰, fail-closed 속성 테스트, 실제 E2E 수행 결과를 첨부한다.
7. 완료 전에는 `configured / enforced / live-verified`를 각각 구분해 보고한다.

## 신규 프로젝트 Issue 템플릿
```md
# [Project] <goal>
Common standard: ai-orchestrator docs v1 (commit SHA pinned: <sha>)
Owner-approved scope: <what / limits / forbidden actions>
Root Issue: #...
Acceptance criteria: <observable outcomes>
Impact: <old/new sources; data; API; status; security>
Pre-code test matrix: E01~E18 selected + project cases
Actors: GPT PM → Claude developer → Codex reviewer
Evidence: actual provider START, source SHA, CI, Codex, security, E2E
Merge/deploy: blocked pending owner explicit approval
```

## 운영 요령
- GPT PM은 새 작업을 배분할 때 공통 규약을 읽고 정확한 SHA/브랜치/완료 조건을 제공한다.
- Claude는 범위가 크거나 자료 접근에 실패하면 임의 코드 수정 대신 원인을 남긴다.
- Codex는 코드와 테스트 누락을 독립 확인한다.
- 프로젝트별 필수 조건이 구현되지 않았다면 '공통 룰 적용 완료'라고 주장하지 않는다.
