# GitHub 이벤트와 상태 전환 규칙 (v1)

## 단일 처리 계약
각 이벤트는 **알림/후보 힌트**다. payload 본문·작성자·SHA를 검증 없이 PASS 증거로 사용하지 않는다.

`event → authenticated live fetch → normalized evidence snapshot → affected PR set → invalidate all required contexts → common verdict → publish exact-head result → PM/action`

### 표준 자료 형태 (개념 계약)
- `EvidenceSnapshot`: root + 검증된 계보 PR/수정 Issue/댓글/증거 작성자·생성/수정 시각·HEAD + 수집 완전성 + fingerprint.
- `AffectedSet`: 이전 루트에 연결된 PR ∪ 신규 루트에 연결된 PR ∪ 직접 변경된 PR. 이전 루트를 증명할 수 없으면 **적용 대상 전체의 보수적 집합**을 선택하거나 BLOCKED로 보고한다.
- `Verdict`: `pass|fail|blocked|unknown`, 근거/누락/정확한 SHA/지문 포함.
- `Publication`: 상태가 실제 GitHub에서 성공적으로 기록됐는지 확인. 실패한 상태 쓰기를 성공으로 보고하지 않는다.

## 강제 불변 조건
1. 마커 삭제/변경, 링크 A→B 이동, 댓글 수정/삭제, 모순·조회 실패로 영향을 받는 PR의 과거 PASS가 그대로 남아 통과해서는 안 된다.
2. `quality-gate/pre-pr`, `quality-gate/final` 등 **모든 필수 컨텍스트를 증거 수집 전에 무효화**해야 한다. 한 단계가 끝나기까지 다른 단계가 오래된 green으로 남는 창을 없앤다.
3. 기존 루트 A + 신규 루트 B의 관련 PR 전체를 재평가한다. 이전 귀속 불명이면 보수적 집합 또는 명시적 BLOCKED. 빈 대상 목록을 안전의 증거로 간주하지 않는다.
4. 순서가 다른 이벤트/중복 이벤트/재시도에서 같은 스냅샷의 최종 판정은 동일해야 한다. HEAD 이동·경합·조회 실패는 PASS를 만들 수 없다.
5. SHA를 공유하는 **여러 PR**은 서로 다른 신뢰 증거를 요구할 수 있다. 공유 SHA 컨텍스트는 모든 적용 PR의 요구를 만족한 경우에만 green; 한 PR의 pass가 다른 PR의 fail을 덮어서는 안 된다. 가능하다면 PR 고유 체크와 커밋 상태의 의미를 분리한다.
6. 코드/보안/자체 테스트 PASS와 FAIL이 동일 SHA에 충돌하면 단일 과거 PASS를 골라 통과시키지 않는다. 증거 권위·시점·모순 규칙으로 fail-closed.
7. 상태 발행 시 정확한 live HEAD와 evidence fingerprint 재조회. 상태 기록 실패, 인가 실패, pagination 누락, 대상 수 상한 초과는 명시적 운영 BLOCKED.
8. 조건부 통과(보안 누락, required check 미설치, 기본 브랜치 이벤트 비활성)는 전체 PASS가 아니다.

## GitHub 이벤트
`pull_request_target`, `issue_comment`, `issues`의 supported action(created/edited/deleted/...)을 프로젝트별 워크플로에 명시한다. 각 이벤트에 대해 생성·수정·삭제·동시 변경·중복·역순을 테스트한다. GitHub가 default-branch 복사본으로만 실행하는 이벤트는 **해당 워크플로가 main에 없으면 미활성**이며 통합 브랜치의 파일만으로 E2E 입증 불가.

## 실행 증거
ACK/START는 provider 세션 URL + 정확한 checkout SHA + 후속 코드 변경/PR과 연결해 구분한다. 시작만 남고 세션 종료되면 `in-progress` 라벨을 실제 작업 중으로 해석하지 않는다. 오류 시 중복 writer를 만들지 않고 종료·권한·브랜치부터 진단한다.

## 경계
다른 작업/루트는 독립 진행 가능; 하나의 루트에는 동시에 한 명의 코드 writer만. 정책 변경 및 승인 이력을 댓글, 코드 상수 중 한쪽에만 적용하지 않는다.
