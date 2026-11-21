# 대시보드 사용성 (Issue #85)

## 1. 관리자 로그인 (Issue #87)
홈(또는 /control)에서 일반 아이디·비밀번호로 로그인한다. 단일 관리자 계정이며 기본값은 없다.
서버 `ADMIN_USERNAME`·`ADMIN_PASSWORD_HASH`와 내부용 `CONTROL_ADMIN_TOKEN` 설정, 최초 해시 생성,
로그인 상태 유지(선택 30일/미선택 브라우저 세션·최대 12시간), CSRF·시도 제한·폐기는
[관리자 로그인](./ADMIN_LOGIN.md)을 참고한다. 기존 토큰 입력 UI는 제거했으며 API 헤더 인증은 유지한다.

## 2. KST 표시
`src/lib/time/kst.ts` 의 `formatKst*` 가 유일한 포매터다(`YYYY-MM-DD HH:mm:ss KST`). 저장·API 는 UTC ISO 그대로.
DST 없는 고정 +9h 산술이라 실행 환경 TZ/ICU 와 무관하다. 전역 새로고침, 활동, 실행, GitHub 증거, 진행 화면 모두 사용.

## 3. 데모 모드
2026-11-21 삭제됨(#94·#95 정리).

## 검증 구분
- 실제: 단위/계약 테스트, `next build`, 실제 `next start` HTTP 스모크(세션/CSRF), Playwright(모바일 iPhone 13 뷰포트) 로그인·새로고침·로그아웃.
- 실제 Vercel 배포·실제 GitHub/DB 는 검증하지 않음.
