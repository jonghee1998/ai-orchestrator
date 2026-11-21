---
name: AI Orchestrator
description: 폰으로 보는 개인 AI 오케스트레이터 상황판 (다크, Operate 모드)
colors:
  "bg": "#0B1220"
  "bg.raised": "#101A2A"
  "bg.card": "#151F30"
  "border": "#29384D"
  "border.subtle": "#1e222a"
  "text": "#e6e8ec"
  "text.muted": "#9aa0ab"
  "text.faint": "#949ba8"
  "accent": "#5b8def"
  "accent.dim": "#2b3a5c"
  "ok": "#3fb950"
  "warn": "#d29922"
  "danger": "#f85149"
  "unknown": "#6e7681"
rounded:
  base: "4px"
  lg: "8px"
  xl: "12px"
  full: "9999px"
---

<!-- Impeccable document (scan mode)로 기존 코드에서 추출했습니다. 사람이 없는 실행이라 질문 단계(Step 3)는 건너뛰었고, 서술은 코드에 보이는 것만 적었습니다. .impeccable/design.json 사이드카는 만들지 않았습니다. -->

# Design System: AI Orchestrator

이 문서는 **지금 코드에 있는 값**을 기록합니다. 새 토큰을 제안하지 않습니다. 문서와 코드가 다르면 코드가 기준이고, 어긋남은 [불일치](#불일치) 절에 적습니다. `scripts/design-docs.test.mjs`가 색 토큰과 globals.css 고정값이 코드와 같은지 검사합니다.

출처 약어:

- `tailwind.config.ts` — 색 토큰, `max-w-app`
- `src/app/globals.css` — 전역 고정값
- `src/app/layout.tsx` — 페이지 틀, 여백, themeColor
- `src/components/ui.tsx` — Card, PageTitle, 상태 배지
- `src/components/BottomNav.tsx` — 하단 탭
- `src/components/orch/OrchPanels.tsx` — 작업 카드, tone 함수, 버튼, 스위치, 접기, 사용량 막대
- `src/components/workspace/*.tsx` — 탭 화면 구성, 계정 접기

## Overview

**Creative North Star: 미정** (사용자 확인 전이라 정하지 않음)

어두운 남색 바탕 위에 카드를 쌓은 모바일 상황판입니다. 화면 폭은 최대 520px로 고정하고, 한 열로 위에서 아래로 훑어봅니다. 장식은 거의 없고, 상태(진행·확인 필요·막힘·완료)는 색 톤과 짧은 한국어 문구로 구분합니다. Operate 모드: 훑어보기 쉬움 · 일관성 · 모바일 우선이 표현보다 먼저입니다.

**Key Characteristics:**

- 다크 전용 (`color-scheme: dark`, `src/app/globals.css`)
- 한 열, 최대 폭 520px (`max-w-app`, `tailwind.config.ts`)
- 그림자 없이 테두리와 배경 단계로 구분
- 상태 색 4가지(ok·warn·danger·unknown) + 강조색 1가지(accent)
- 터치 영역 44px 이상

## Colors

어두운 남색 바탕 3단계, 회색 글자 3단계, 파란 강조색 1개, 상태색 4개입니다. 모두 `tailwind.config.ts`의 `theme.extend.colors`에 있습니다. Tailwind 클래스에서는 점 대신 하이픈을 씁니다(`bg.raised` → `bg-bg-raised`, `text.muted` → `text-text-muted`). `DEFAULT`는 이름만 씁니다(`bg` → `bg-bg`, `border` → `border-border`).

### 색 토큰

| 토큰 | 값 | 쓰임 | 출처 |
| --- | --- | --- | --- |
| `bg` | `#0B1220` | 앱 바탕 (클래스로는 거의 안 쓰고 body 배경과 themeColor가 같은 값) | tailwind.config.ts |
| `bg.raised` | `#101A2A` | 하단 탭 바(`bg-bg-raised/95`), 상태 메시지 상자, 입력칸, 보류된 작업 카드 | tailwind.config.ts |
| `bg.card` | `#151F30` | Card 바탕, 계정 접기 바탕 | tailwind.config.ts |
| `border` | `#29384D` | Card·버튼·입력칸·스텝 접기 테두리, 하단 탭 위 선, 진행 막대 바탕 | tailwind.config.ts |
| `border.subtle` | `#1e222a` | 정의만 있고 쓰는 곳 없음 | tailwind.config.ts |
| `text` | `#e6e8ec` | 기본 글자 (body 글자색과 같은 값) | tailwind.config.ts |
| `text.muted` | `#9aa0ab` | 부제, 섹션 제목, 보조 설명, 비활성 상태 배지 글자 | tailwind.config.ts |
| `text.faint` | `#949ba8` | 갱신 시각, 빈 목록 안내, 선택 안 된 하단 탭 | tailwind.config.ts |
| `accent` | `#5b8def` | 선택된 하단 탭, 링크, 버전 번호, 진행 막대 채움, 진행 중 작업 테두리(`/40`) | tailwind.config.ts |
| `accent.dim` | `#2b3a5c` | 정의만 있고 쓰는 곳 없음 | tailwind.config.ts |
| `ok` | `#3fb950` | 연결됨·완료·진행 배지, 끝난 작업 테두리(`/30`) | tailwind.config.ts |
| `warn` | `#d29922` | 진행 중·일시중지 배지, 반영 승인 대기 작업, 확인 필요 표시, 로그인 필요 안내 | tailwind.config.ts |
| `danger` | `#f85149` | 오류·막힘 배지, 막힌 작업 카드 | tailwind.config.ts |
| `unknown` | `#6e7681` | 값을 모를 때(UnknownTag), 연결 안 됨·대기 배지 바탕 | tailwind.config.ts |

### 투명도 규칙 (출처: `src/components/ui.tsx`, `src/components/orch/OrchPanels.tsx`)

- 배지 바탕은 상태색 15% (`bg-ok/15`, `bg-warn/15`, `bg-danger/15`, `bg-unknown/15`, `bg-accent/15`), 글자는 상태색 그대로.
- 확인 필요 표시와 승인 확인 버튼은 `bg-warn/20`.
- 작업 카드 테두리는 상태색 30~50%, 바탕은 10% (아래 tone 함수).

### globals.css 고정값

토큰이 아닌 값이 `src/app/globals.css`에 직접 적혀 있습니다. CSS 사용자 정의 속성(`--x`)은 없습니다.

| 항목 | 값 | 출처 |
| --- | --- | --- |
| 색 모드 | `color-scheme: dark` | src/app/globals.css |
| body 배경 (첫 선언) | `background-color: #0a0b0e` | src/app/globals.css |
| body 배경 (다시 덮어쓴 값, 실제 적용) | `background-color: #0b1220` | src/app/globals.css |
| body 글자색 | `color: #e6e8ec` | src/app/globals.css |
| 포커스 링 | `outline: 2px solid #8db5ff` | src/app/globals.css |
| 포커스 링 간격 | `outline-offset: 3px` | src/app/globals.css |
| 접기 제목 높이 | `summary { min-height: 44px; }` | src/app/globals.css |
| 하단 스크롤 여유 | `scroll-padding-bottom: calc(6rem + env(safe-area-inset-bottom))` | src/app/globals.css |
| 가로 넘침 방지 | `overflow-wrap: anywhere` | src/app/globals.css |

### Named Rules

**The Same State, Same Tone Rule.** 같은 상태는 어느 탭에서든 같은 상태색으로 보여 줍니다. 새 상태색을 만들지 말고 ok·warn·danger·unknown·accent 안에서 고릅니다.

## Typography

**글꼴:** 시스템 글꼴 — `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif` (출처: `src/app/globals.css`). 웹 폰트는 불러오지 않습니다.

### Hierarchy (Tailwind 기본 크기, 출처는 각 파일)

- **Page title** (600, `text-xl` 20px, `tracking-tight`): 탭 맨 위 제목. `PageTitle` (`src/components/ui.tsx`)
- **Section title, 큰 것** (600, `text-lg` 18px): AI 팀 탭의 'AI 사용량', 'AI ON/OFF', 구조 탭 제목 (`src/components/orch/OrchPanels.tsx`, `src/components/workspace/ArchitectureScreen.tsx`)
- **Section title, 작은 것** (600, `text-sm` 14px, `text.muted`): '자동 진행 작업', '승인 대기 계획' 등 (`src/components/orch/OrchPanels.tsx`)
- **Body** (400~500, `text-sm` 14px 또는 기본 16px): 카드 본문, 작업 목표(`font-medium`)
- **Meta** (`text-xs` 12px): 저장소·스텝 수, 배지, 버튼 일부
- **Fine print** (`text-[11px]`): 갱신 시각, 리셋 시각, 하단 탭 이름 (`src/components/BottomNav.tsx`)

## Layout

- 한 열. 페이지 틀은 `mx-auto max-w-app`(520px, `tailwind.config.ts`)이고 `min-h-dvh` (`src/app/layout.tsx`).
- 본문 좌우 여백 `px-4`(16px), 위 `pt-[calc(1rem+env(safe-area-inset-top))]`, 아래 `pb-[calc(6rem+env(safe-area-inset-bottom))]` — 하단 탭에 가리지 않게 (`src/app/layout.tsx`).
- 세로 간격: 탭 화면 블록 사이 `space-y-4`(16px), 섹션 안 카드 사이 `space-y-2`(8px), 카드 안 `space-y-3`(12px) (`src/components/workspace/LiveScreens.tsx`, `src/components/orch/OrchPanels.tsx`).
- 안쪽 여백: Card `p-4`(16px), 작업·계획 카드 `p-3`(12px), 상태 메시지 `p-2`(8px).
- 반응형 분기점은 쓰지 않습니다. 폭이 늘어도 520px에서 멈춥니다.

## Elevation & Depth

그림자를 쓰지 않습니다. 깊이는 배경 단계(`bg` → `bg.raised` → `bg.card`)와 1px 테두리(`border`)로 나타냅니다. 하단 탭만 `backdrop-blur`와 95% 불투명 배경을 씁니다 (`src/components/BottomNav.tsx`).

## Shapes

- 카드·상자: `rounded-xl`(12px) — Card, 작업 카드, 계획 카드, 상태 메시지, 입력칸 (`src/components/ui.tsx`, `src/components/orch/OrchPanels.tsx`)
- 버튼·스텝 접기·작은 상자: `rounded-lg`(8px)
- 배지·스위치·진행 막대: `rounded-full`
- UnknownTag: `rounded`(4px)
- 테두리는 1px 한 가지입니다.

## Components

### Card (`src/components/ui.tsx`)

- `rounded-xl border border-border bg-bg-card p-4`. 탭의 기본 묶음입니다. `className`으로 `space-y-3` 등을 덧붙입니다.

### PageTitle (`src/components/ui.tsx`)

- 제목 `text-xl font-semibold tracking-tight`, 부제 `mt-1 text-sm text-text-muted`, 아래 여백 `mb-4`.

### 상태 배지 (`src/components/ui.tsx`)

- 모양: `inline-flex rounded-full px-2.5 py-1 text-xs font-medium`. ConnectionBadge는 앞에 `h-1.5 w-1.5` 점(`bg-current`).
- 색: 상태색 15% 바탕 + 상태색 글자. 꺼짐·대기·완료(프로젝트)는 `bg-unknown/15 text-text-muted`.
  - ConnectionBadge: 연결됨 ok, 연결 안 됨 unknown, 연결 중 warn, 오류 danger
  - TaskStatusBadge: 대기 unknown, 큐 accent, 진행 중 warn, 검수 중 accent, 완료 ok, 막힘 danger
  - ProjectStatusBadge: 진행 ok, 일시중지 warn, 완료 unknown
- 작업 카드 안 상태 문구는 `rounded-full bg-current/10 px-2 py-0.5 text-xs` (`src/components/orch/OrchPanels.tsx`).
- UnknownTag: `text-unknown ring-1 ring-inset ring-unknown/30`, 문구 'unknown'.

### 작업 카드 tone (`src/components/orch/OrchPanels.tsx`의 `tone` 함수)

| 상태 | 테두리·바탕 |
| --- | --- |
| 막힘 (`blocked`) | `border-danger/50 bg-danger/10` |
| 반영 승인 대기 (`awaiting_merge`) | `border-warn/50 bg-warn/10` |
| 보류 (`held`) | `border-border bg-bg-raised` |
| 완료 (`done`) | `border-ok/30` |
| 그 밖 (진행 중 등) | `border-accent/40` |

### 계획 감사 배지 (`src/components/orch/OrchPanels.tsx`의 `BADGE_TONE`)

- ok `bg-ok/15 text-green-200`, warn `bg-warn/20 text-yellow-100`, danger `bg-danger/15 text-red-200`, muted `bg-current/10 text-text-muted`.

### Buttons (`src/components/orch/OrchPanels.tsx`)

- 기본: `min-h-11 rounded-lg border border-border px-3` + `text-xs`(새로고침·지금 확인) 또는 `text-sm`. 바탕 없음.
- 확인 단계(두 번 누르는 승인): `bg-warn/20 text-yellow-100 font-semibold`, 문구 '정말 시작할까요? 승인'.
- 비활성: `disabled:opacity-50`. 진행 중 문구는 '불러오는 중…', '승인 중…', '요청 중…'.
- 스위치: `role="switch"`, `aria-checked`, `min-h-11 min-w-20 rounded-full`, 켜짐 `bg-blue-500`, 꺼짐 `bg-slate-700` (불일치 참고).

### Inputs (`src/components/orch/OrchPanels.tsx`의 `WindowEditor`)

- `min-h-11 rounded-xl border border-border bg-bg-raised px-3 text-sm`, `<label htmlFor>`로 이름을 붙입니다.

### details 접기 (`src/components/orch/OrchPanels.tsx`, `src/components/workspace/Account.tsx`)

- 제목(summary): `flex min-h-11 cursor-pointer items-center gap-2 py-2` (`SUMMARY` 상수). 전역으로 `summary { min-height: 44px; }`.
- 진행 중·확인 필요 작업과 지금 스텝은 기본으로 펼침(`open`).
- 스텝 접기: `rounded-lg border border-border`, 아이콘 ✅/▶/⛔/⬜에 `role="img"`와 `aria-label`.
- 진행 막대: `h-1.5 rounded-full bg-border`, 채움 `bg-accent`, `role="progressbar"`와 `aria-valuenow`.

### Navigation — 하단 탭 (`src/components/BottomNav.tsx`)

- 5탭: 프로젝트(▤) · AI 팀(◉) · PM 브리핑(◆) · 패치노트(✎) · 구조(⌘).
- 바: `fixed inset-x-0 bottom-0 z-20 border-t border-border bg-bg-raised/95 backdrop-blur`, 아래 `pb-[env(safe-area-inset-bottom)]`.
- 탭 하나: `min-h-14`(56px), 아이콘 `text-base`, 이름 `text-[11px]`. 선택 `text-accent` + `aria-current="page"`, 나머지 `text-text-faint`, 누를 때 `hover:text-text-muted`.
- `<nav aria-label="주 메뉴">`.

### 사용량 막대 (`src/components/orch/OrchPanels.tsx`의 `Bar`)

- 바탕 `h-2 rounded-full bg-slate-700`. 채움: 90% 이상 `bg-red-400`, 70% 이상 `bg-yellow-400`, 그 밖 `bg-blue-400`, 모름 `bg-slate-600` (불일치 참고).

### 접근성 규칙

- 터치 영역 44px 이상: 버튼·링크·입력·summary는 `min-h-11`(44px), 하단 탭은 `min-h-14`(56px), summary 전역 `min-height: 44px` (`src/app/globals.css`).
- 결과 메시지는 `role="status"` (`src/components/orch/OrchPanels.tsx`).
- 섹션은 `<section aria-label>`, 스위치는 `aria-label`에 저장소와 이름을 넣음.
- 아이콘만 있는 상태 표시는 `role="img"` + `aria-label`.
- 포커스는 `:focus-visible` 2px `#8db5ff` 외곽선 (`src/app/globals.css`).

## Do's and Don'ts

### Do:

- **Do** 색은 `tailwind.config.ts`의 토큰 클래스(`bg-bg-card`, `text-text-muted`, `border-border`, `text-accent`, `bg-ok/15` …)로 씁니다.
- **Do** 카드는 `Card`(`rounded-xl`, `p-4`)를 다시 씁니다.
- **Do** 누르는 것은 모두 `min-h-11` 이상으로 합니다.
- **Do** 작업 상태 색은 `tone` 함수를 따릅니다.

### Don't:

- **Don't** 코드에 없는 새 색 토큰이나 CSS 사용자 정의 속성을 만들지 않습니다.
- **Don't** 그림자로 깊이를 만들지 않습니다.
- **Don't** 같은 상태에 다른 색을 새로 쓰지 않습니다 (아래 불일치는 기존 예외이지 본보기가 아닙니다).

## 불일치

코드끼리 맞지 않는 곳입니다. 이번 스텝에서는 고치지 않고 기록만 합니다.

1. **body 배경 이중 선언** — `src/app/globals.css`에서 `html, body`의 배경을 `#0a0b0e`로 정한 뒤 바로 아래에서 `#0b1220`으로 다시 덮어씁니다. 첫 값은 쓰이지 않습니다.
2. **배경색 표기** — 같은 바탕색이 `tailwind.config.ts`(`bg` `#0B1220`)와 `src/app/layout.tsx`(themeColor `#0B1220`)에서는 대문자, `src/app/globals.css`에서는 소문자 `#0b1220`, 그리고 body는 토큰이 아니라 직접 값입니다.
3. **body 글자색 중복** — `src/app/globals.css`의 `color: #e6e8ec`는 `text` 토큰과 같은 값을 직접 적었습니다.
4. **포커스 링 색** — `#8db5ff`는 토큰에 없고 `accent`(`#5b8def`)와도 다릅니다 (`src/app/globals.css`).
5. **상태 글자색이 토큰 밖** — 위험·경고·정상 글자에 Tailwind 기본 색을 씁니다: `text-red-200`(오류·막힘 사유), `text-yellow-100`/`text-yellow-200`(보류·확인 단계·한도 소진), `text-green-200`(계획 감사 OK). 반면 `src/components/ui.tsx`의 배지는 `text-danger`/`text-warn`/`text-ok`를 씁니다 (`src/components/orch/OrchPanels.tsx`).
6. **스위치·사용량 막대 색** — 켜짐 스위치 `bg-blue-500`, 막대 채움 `bg-blue-400`/`bg-yellow-400`/`bg-red-400`, 바탕 `bg-slate-700`/`bg-slate-600`. 같은 역할의 `accent`·`warn`·`danger`·`border`·`unknown` 토큰을 쓰지 않습니다. 같은 파일의 작업 진행 막대는 `bg-border` 바탕에 `bg-accent` 채움입니다 (`src/components/orch/OrchPanels.tsx`).
7. **한도 소진 배지** — `bg-yellow-500/15 text-yellow-200`로, 다른 경고 배지(`bg-warn/15`·`bg-warn/20`)와 다릅니다 (`src/components/orch/OrchPanels.tsx`).
8. **다른 화면의 경고·상태 색** — `src/components/ScopeNotice.tsx`는 `border-yellow-700/50 bg-yellow-900/20 text-yellow-100`, `src/components/overview/OverviewDashboard.tsx`는 점에 `bg-green-500`/`bg-yellow-500`/`bg-red-500`, 켜짐 배지에 `bg-green-900/40 text-green-200`을 씁니다.
9. **쓰지 않는 토큰** — `border.subtle`(`#1e222a`), `accent.dim`(`#2b3a5c`)은 `tailwind.config.ts`에 있지만 `src`에서 쓰는 곳이 없습니다. `border.subtle`은 다른 바탕들과 달리 남색이 아닌 회색 계열입니다.
10. **글자 단계 차이** — `text.muted`(`#9aa0ab`)와 `text.faint`(`#949ba8`)의 밝기가 거의 같아 두 단계가 눈으로 잘 구분되지 않습니다 (`tailwind.config.ts`).
11. **둥근 모서리** — 계정 접기는 `rounded-2xl`(16px)이고 다른 카드는 `rounded-xl`(12px)입니다 (`src/components/workspace/Account.tsx`).
12. **버튼 모서리** — 같은 줄의 저장 버튼과 입력칸은 `rounded-xl`, 다른 버튼은 `rounded-lg`입니다 (`src/components/orch/OrchPanels.tsx`).
13. **계정 접기 제목** — `src/components/workspace/Account.tsx`의 summary는 `SUMMARY` 상수(`min-h-11`) 대신 `px-4 py-3`을 쓰고, 높이는 globals.css 전역 규칙에 기댑니다.
