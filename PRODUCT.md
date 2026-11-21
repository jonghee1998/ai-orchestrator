# Product

<!-- impeccable:product-schema 1 -->

> 사람이 없는 실행에서 Impeccable `init` 형식으로 작성했습니다. 계획 Issue에 적힌 제품 맥락만 근거로 했고, 저장소에서 읽어 낸 내용에는 '(추론)'을 붙였습니다. 모르는 항목은 '미정'입니다.

## Platform

web

(모바일 웹. 폰 브라우저에서 쓰는 Next.js 앱이며 네이티브 앱이 아닙니다.)

## Users

- 사용자는 소유자 1명입니다.
- 주로 폰으로 AI 오케스트레이터의 진행 상황을 확인합니다.
- 하는 일: 진행 상황 보기, AI ON/OFF, 사용량 확인, 계획 승인.
- 다른 사용자층: 미정.

## Product Purpose

- 개인 AI 오케스트레이터(Claude PM, Sonnet/Opus 구현, Codex 검수, GitHub Actions 엔진)의 상황판입니다.
- 폰에서 지금 무엇이 돌고 있는지, 사용자가 판단할 일이 무엇인지 바로 알 수 있게 합니다.
- 성공 기준: 미정. (추론: 확인·결정이 필요한 일을 폰에서 놓치지 않고 처리할 수 있으면 성공.)

## Positioning

미정.

## Operating Context

- 하단 5탭: 프로젝트 · AI 팀 · PM 브리핑 · 패치노트 · 구조.
- 흐름: PM(Claude)이 계획 Issue 작성 → 사용자 승인(orch:go) → 엔진이 스텝마다 구현·검수·CI → 최종 PR. (추론: `src/components/workspace/ArchitectureScreen.tsx`)
- 기록과 설정은 GitHub(Issue·PR·저장소 변수)에 남고, 상황판은 이를 읽고 바꿉니다. (추론: `src/components/orch/OrchPanels.tsx`)
- 설정은 가급적 폰에서 합니다.

## Capabilities and Constraints

- 확정 기능: 작업 진행 보기, AI ON/OFF, 사용량 확인, 계획 승인.
- 조작(ON/OFF·승인·사용량 새로 확인)은 관리자 로그인에서만 됩니다. (추론: `src/components/orch/OrchPanels.tsx`)
- 화면 모드: **Operate** — 훑어보기 쉬움 · 일관성 · 모바일 우선이 표현보다 먼저입니다.
- 화면 언어: 한국어. (`src/app/layout.tsx`의 `lang="ko"`)
- 용어: '반영'(머지 대신), '스텝', '계획', '검수', '완공 보고서'. (추론: `src/lib/patchnotes.ts`)
- 미정: 사용자 수 확대, 알림 방식, 데스크톱 전용 화면.

## Brand Commitments

- 이름: AI Orchestrator. (`src/app/layout.tsx`의 metadata)
- 말투: 짧고 직접적인 한국어.
- 로고·브랜드 자산: 없음(미정).

## Evidence on Hand

- 실제 데이터: GitHub 기록(Issue·PR·Actions)과 사용량 스냅샷. (추론: `src/components/orch/OrchPanels.tsx`)
- 패치노트: `src/lib/patchnotes.ts`.
- 화면 스크린샷: CI 화면 테스트 결과. (추론: `scripts/screens/`)
- 없음: 고객 후기, 사용자 수, 매출, 브랜드 이야기. 만들어 넣지 않습니다.

## Product Principles

1. 판단이 필요한 것을 먼저 보여 줍니다 (승인 대기·막힘·확인 필요).
2. 폰 한 손으로 끝낼 수 있어야 합니다 (설정도 폰에서).
3. 짧고 직접적으로 말합니다. 같은 상태는 늘 같은 말과 같은 색으로 보여 줍니다.
4. 실제 기록만 보여 줍니다. 모르면 '확인 불가'로 표시합니다. (추론: `src/components/orch/OrchPanels.tsx`)

## Accessibility & Inclusion

- 터치 영역 44px 이상. (추론: `src/app/globals.css`의 `summary { min-height: 44px; }`, 버튼의 `min-h-11`)
- 그 밖의 기준(WCAG 등급 등): 미정.
