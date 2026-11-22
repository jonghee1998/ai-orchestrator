---
name: AI Orchestrator
description: 폰으로 보는 개인 AI 오케스트레이터 상황판 (밝은 테마, Operate 모드)
colors:
  "bg": "#F6F7F9"
  "bg.raised": "#F6F7F9"
  "bg.card": "#FFFFFF"
  "border": "#ECEEF1"
  "border.subtle": "#F1F3F5"
  "text": "#111418"
  "text.muted": "#5F6773"
  "text.faint": "#7A828E"
  "accent": "#2563D9"
  "accent.dim": "#EEF3FD"
  "ok": "#17703C"
  "warn": "#8A5A00"
  "danger": "#C5221F"
  "unknown": "#7A828E"
rounded:
  base: "4px"
  lg: "8px"
  xl: "12px"
  card: "18px"
  full: "9999px"
---

# Design System: AI Orchestrator

2026-11-22 사용자가 확정한 밝은 디자인입니다. 정답 시안은 **`docs/design/projects-mock.html`**(HTML)과 `docs/design/projects-mock.png`(390px 캡처)입니다. 값(색·크기·간격·문구)은 시안에서 그대로 옮깁니다. 시안의 #285·#267·#268은 예시 데이터입니다. 문서와 코드가 다르면 코드가 기준입니다. `scripts/design-docs.test.mjs`가 색 토큰과 globals.css 고정값이 코드와 같은지 검사합니다.

출처 약어:

- `tailwind.config.ts` — 색 토큰, `max-w-app`
- `src/app/globals.css` — 전역 고정값
- `src/app/layout.tsx` — 페이지 틀, 글꼴 import, themeColor
- `src/components/ui.tsx` — Card, PageTitle, 상태 배지
- `src/components/icons.tsx` — 공용 SVG 아이콘, 상태 아이콘
- `src/components/BottomNav.tsx` — 하단 탭
- `src/components/orch/OrchPanels.tsx` — 작업 카드, tone 함수, 버튼, 스위치, 접기, 사용량 막대

## Overview

**Creative North Star: 흰 바탕에 숫자와 남은 할 일이 먼저 읽히는 조용한 상황판**

밝은 회백색 바탕 위에 흰 카드를 얹은 모바일 상황판입니다. 화면 폭은 최대 520px, 한 열로 위에서 아래로 훑어봅니다. Operate 모드: 훑어보기 쉬움 · 일관성 · 모바일 우선이 표현보다 먼저입니다.

**규칙:**

- 숫자는 검정(`text`), 0·없음은 회색(`text.faint`). 숫자는 `tabular-nums`.
- 포인트 색은 파랑(`accent`) 하나.
- 상태색(warn 노랑=사용자 확인 필요, danger 빨강=멈춤·실패, ok 초록=통과)은 뜻이 있을 때만 씁니다.
- 단계별로 다른 색을 주거나 지하철 노선 같은 표현을 쓰지 않습니다(사용자가 거절).
- 카드 안에 카드를 넣지 않습니다. 한쪽 테두리 강조, 그라데이션 글자도 쓰지 않습니다.
- 아이콘은 SVG(굵기 1.8, round)입니다. 유니코드 문자·이모지를 아이콘으로 쓰지 않습니다.
- 터치 영역 44px 이상.

## Colors

밝은 바탕 3단계(`bg`·`bg.raised`는 같은 값, `bg.card`는 흰색), 글자 3단계, 파란 포인트 1개, 상태색 4개입니다. 모두 `tailwind.config.ts`의 `theme.extend.colors`에 있습니다. Tailwind 클래스에서는 점 대신 하이픈을 씁니다(`bg.card` → `bg-bg-card`, `text.muted` → `text-text-muted`). `DEFAULT`는 이름만 씁니다(`bg` → `bg-bg`, `border` → `border-border`).

대비 기준: 본문·라벨 글자(`text`, `text.muted`, `accent`, `ok`, `warn`, `danger`)는 흰색·`bg`·`accent.dim` 위에서 4.5:1 이상입니다. `text.faint`(약 3.5~3.9:1)는 글자 본문에 쓰지 않고 0·'–'·보조 숫자('/16')·아이콘처럼 정보가 아닌 자리에만 씁니다.

### 색 토큰

| 토큰 | 값 | 쓰임 | 출처 |
| --- | --- | --- | --- |
| `bg` | `#F6F7F9` | 앱 바탕(body 배경, themeColor), 선택 안 된 세부 과정 칩 | tailwind.config.ts |
| `bg.raised` | `#F6F7F9` | 상태 메시지 상자, 입력칸, 보류된 작업 카드 | tailwind.config.ts |
| `bg.card` | `#FFFFFF` | Card 바탕, 하단 탭 바탕 | tailwind.config.ts |
| `border` | `#ECEEF1` | 버튼·입력칸·접기 테두리, 하단 탭 위 선, 진행 막대 바탕 (Card는 테두리 없음) | tailwind.config.ts |
| `border.subtle` | `#F1F3F5` | 정의만 있고 쓰는 곳 없음 | tailwind.config.ts |
| `text` | `#111418` | 기본 글자, 숫자, 선택된 하단 탭 | tailwind.config.ts |
| `text.muted` | `#5F6773` | 부제, 보조 설명, 비활성 하단 탭, 갱신 시각 | tailwind.config.ts |
| `text.faint` | `#7A828E` | 0·'–'·'/16' 같은 보조 숫자, 대기 상태 아이콘 (글자 본문 금지) | tailwind.config.ts |
| `accent` | `#2563D9` | 링크, 진행 중 표시, 진행 막대 채움, 켜진 스위치 | tailwind.config.ts |
| `accent.dim` | `#EEF3FD` | 현재 위치 칩·항목 바탕 | tailwind.config.ts |
| `ok` | `#17703C` | 통과·완료·연결됨 | tailwind.config.ts |
| `warn` | `#8A5A00` | 사용자 확인 필요, 일시중지, 승인 대기 | tailwind.config.ts |
| `danger` | `#C5221F` | 멈춤·실패·오류 | tailwind.config.ts |
| `unknown` | `#7A828E` | 값을 모를 때 테두리·막대, 연결 안 됨·대기 배지 바탕(`/10`) | tailwind.config.ts |

### 투명도 규칙 (출처: `src/components/ui.tsx`, `src/components/orch/OrchPanels.tsx`)

- 상태 배경은 옅게(`bg-ok/10`, `bg-warn/10`, `bg-danger/10`, `bg-unknown/10`, `bg-accent-dim`), 글자는 같은 상태색(`text-ok`·`text-warn`·`text-danger`).
- 확인 필요 표시와 승인 확인 버튼은 `bg-warn/15 text-warn`.
- 작업 카드 테두리는 상태색 30~50%, 바탕은 10%.

### globals.css 고정값

| 항목 | 값 | 출처 |
| --- | --- | --- |
| 색 모드 | `color-scheme: light` | src/app/globals.css |
| body 배경 | `background-color: #F6F7F9` | src/app/globals.css |
| body 글자색 | `color: #111418` | src/app/globals.css |
| 글꼴 | `"Pretendard Variable", Pretendard, -apple-system, sans-serif` | src/app/globals.css |
| 본문 자간 | `letter-spacing: -0.01em` | src/app/globals.css |
| 숫자 | `font-variant-numeric: tabular-nums` | src/app/globals.css |
| 선택 영역 | `::selection { background: #EEF3FD; color: #111418; }` | src/app/globals.css |
| 포커스 링 | `outline: 2px solid #2563D9` | src/app/globals.css |
| 포커스 링 간격 | `outline-offset: 3px` | src/app/globals.css |
| 스크롤바 | `scrollbar-color: #ECEEF1 #F6F7F9` | src/app/globals.css |
| 접기 제목 높이 | `summary { min-height: 44px; }` | src/app/globals.css |
| 하단 스크롤 여유 | `scroll-padding-bottom: calc(7rem + env(safe-area-inset-bottom))` | src/app/globals.css |
| 가로 넘침 방지 | `overflow-wrap: anywhere` | src/app/globals.css |

### Named Rules

**The Same State, Same Tone Rule.** 같은 상태는 어느 탭에서든 같은 상태색으로 보여 줍니다. 새 상태색을 만들지 말고 ok·warn·danger·unknown·accent 안에서 고릅니다. Tailwind 기본 색(`red-200`, `slate-700` 등)과 `white/5` 같은 다크 전용 색은 쓰지 않습니다.

## Typography

**글꼴: Pretendard** — `"Pretendard Variable", Pretendard, -apple-system, sans-serif`. `pretendard` 패키지의 `dist/web/variable/pretendardvariable-dynamic-subset.css`를 `src/app/layout.tsx`에서 import 합니다. 숫자는 `font-variant-numeric: tabular-nums`. 자간은 본문 `-0.01em`, 제목 `-0.02~-0.03em`.

- **Page title** (700, 22px, `-0.03em`): 탭 맨 위 제목. `PageTitle`
- **Section title, 큰 것** (700, `text-lg` 18px, `-0.02em`): 카드 제목
- **Section title, 작은 것** (600, `text-sm` 14px, `text.muted`)
- **Body** (400~500, `text-sm` 14px)
- **Meta** (`text-xs` 12px): 저장소·스텝 수, 배지, 버튼
- **Fine print** (`text-[11px]`): 갱신 시각, 하단 탭 이름

## Layout

- 한 열. `mx-auto max-w-app`(520px), `min-h-dvh`.
- 본문 좌우 여백 `px-4`(16px), 위 `pt-[calc(1rem+env(safe-area-inset-top))]`, 아래 `pb-[calc(7rem+env(safe-area-inset-bottom))]`. 하단 탭은 `viewportFit: cover` + `pb-[max(6px,calc(env(safe-area-inset-bottom)-14px))]` 로 아이폰 홈 표시줄과 겹치지 않을 만큼만 올린다.
- 세로 간격: 탭 화면 블록 사이 `space-y-4`, 카드 안 `space-y-2~3`.
- Card 안쪽 여백 18px 16px. 작업·계획 항목 `p-3`.

## Elevation & Depth

Card만 옅은 그림자를 씁니다: `0 1px 2px rgba(17,20,24,.04), 0 4px 16px rgba(17,20,24,.04)`. 테두리는 버튼·입력칸·접기 안쪽 항목에만 씁니다(`border`, 1px).

## Shapes

- Card: `rounded-[18px]`
- 작업 카드·입력칸: `rounded-xl`(12px). 버튼·접기: `rounded-lg`(8px)
- 배지·스위치·진행 막대: `rounded-full`

## Components

### Card (`src/components/ui.tsx`)

- `rounded-[18px] bg-bg-card px-4 py-[18px]` + 위 그림자. 테두리 없음. 카드 안에 Card를 넣지 않습니다.

### PageTitle (`src/components/ui.tsx`)

- 시안 header 모양: 왼쪽 제목 `text-[22px] font-[750] tracking-[-0.03em]` + 아래 한 줄 `mt-[3px] text-xs text-text-muted tabular-nums`(갱신 시각·부제), 오른쪽 `actions`(간격 6px). 아래 여백 `mb-4`.
- 프로젝트 탭: 부제 = '11/22(일) 16:50 KST 갱신'(누른 뒤 '방금 갱신 …'), actions = 새로고침 아이콘 버튼 + 'PM에게 말하기'.
- 카드 제목 `CARD_TITLE`(`text-base font-[750]`), 카드 밖 구역 제목 `text-lg font-[750]`.
- 카드 안 목록은 `ROW`(`border-t border-border py-3`) 줄 구분선 하나. 승인 대기 계획·아이디어함·결정 필요·ON/OFF·패치노트·구조가 이 모양입니다.
- 아이디어함 한 줄: 제목(굵게) · '날짜 · 저장소 · 상태' 한 줄 · 오른쪽 '#번호' accent 링크(원문).

### 상태 배지 (`src/components/ui.tsx`)

- 모양: `inline-flex rounded-full px-2.5 py-1 text-xs font-medium`. 색: 상태색 10% 바탕 + 상태색 글자. 꺼짐·대기·완료(프로젝트)는 `bg-unknown/10 text-text-muted`. 큐·검수 중은 `bg-accent-dim text-accent`.
- UnknownTag: `text-text-muted ring-1 ring-inset ring-unknown/30`.

### 아이콘 (`src/components/icons.tsx`)

- 모두 SVG, viewBox 24, `stroke-width 1.8`, round. 장식이면 `aria-hidden`, 뜻은 글자나 부모 `aria-label`이 맡습니다.
- 새로고침·뒤로·경고·체크·멈춤·편집·열쇠, 그리고 체크박스 모양 상태 `StateIcon`(통과 채운 초록 원+체크 · 진행 파란 테두리+점 · 멈춤 빨강 · 대기 빈 원 · 해당 없음 줄).
- 버튼 글자는 아이콘을 뺀 '새로고침'·'지금 확인'(접근성 이름도 같음).

### 작업 상태 배지 (`tone` 함수, PM 브리핑 '결정 필요' 줄)

| 상태 | 배지 |
| --- | --- |
| 막힘 (`blocked`) | `bg-danger/10 text-danger` |
| 반영 승인 대기 (`awaiting_merge`) | `bg-warn/10 text-warn` |
| 보류 (`held`) | `bg-unknown/10 text-text-muted` |
| 완료 (`done`) | `bg-ok/10 text-ok` |
| 그 밖 (진행 중 등) | `bg-accent-dim text-accent` |

### 계획 감사 배지 (`BADGE_TONE`)

- ok `bg-ok/10 text-ok`, warn `bg-warn/10 text-warn`, danger `bg-danger/10 text-danger`, muted `bg-unknown/10 text-text-muted`. 글자는 '감사 OK 2/3'처럼 기호 없이, 아이콘은 SVG.

### Buttons (`src/components/ui.tsx`)

- 아이콘 버튼 `ICON_BUTTON`: 40px 정사각 `rounded-xl border border-border bg-bg-card`, 아이콘 18px, 이름은 `aria-label`. 누르는 영역은 `after:-inset-0.5`로 44px.
- 진한 버튼 `PRIMARY_BUTTON`: `h-10 rounded-xl bg-text px-3.5 text-[13px] font-[650] text-white` ('PM에게 말하기', 로그인).
- 기본 `BUTTON`: `min-h-11 rounded-xl border border-border bg-bg-card px-3 text-[13px] font-semibold`. 확인 단계(승인): `bg-warn/15 text-warn font-semibold`.
- 링크는 `text-accent font-semibold`(밑줄 없음).
- 입력칸 `FIELD`: `rounded-xl border border-border bg-bg`. 결과 메시지 `STATUS_BOX`: `rounded-xl border border-border bg-bg-card`.
- 스위치: `role="switch"`, `aria-checked`, `min-h-11 min-w-20 rounded-full`, 켜짐 `bg-accent text-white`, 꺼짐 `bg-bg text-text-muted ring-1 ring-border`.
- 비활성: `disabled:opacity-50`.

### Navigation — 하단 탭 (`src/components/BottomNav.tsx`)

- 5탭: 프로젝트 · AI 팀 · PM 브리핑 · 패치노트 · 구조. 아이콘은 시안의 SVG(22px, 굵기 1.8, round).
- 바: `fixed inset-x-0 bottom-0 z-20 border-t border-border bg-bg-card`, 아래 `pb-[env(safe-area-inset-bottom)]`.
- 탭 하나: `min-h-14`(56px). 선택 `text-text font-bold` + `aria-current="page"`, 나머지 `text-text-muted`.

### 사용량 막대 (`Bar`)

- 바탕 `bg-border`. 채움: 90% 이상 `bg-danger`, 70% 이상 `bg-warn`, 그 밖 `bg-accent`, 모름 `bg-text-faint`.

### 접근성 규칙

- 터치 영역 44px 이상: 버튼·링크·입력·summary는 `min-h-11`, 하단 탭은 `min-h-14`.
- 결과 메시지는 `role="status"`. 아이콘만 있는 상태 표시는 `role="img"` + `aria-label`.
- 포커스는 `:focus-visible` 2px `#2563D9` 외곽선.

## Do's and Don'ts

### Do:

- **Do** 색은 토큰 클래스(`bg-bg-card`, `text-text-muted`, `text-accent`, `bg-ok/10` …)로 씁니다.
- **Do** 카드는 `Card`를 다시 씁니다. 누르는 것은 모두 `min-h-11` 이상으로 합니다.

### Don't:

- **Don't** 새 색 토큰이나 코드에 박은 색을 만들지 않습니다.
- **Don't** 단계별 다른 색, 지하철 노선, 카드 안 카드, 한쪽 테두리 강조, 그라데이션 글자, 유니코드·이모지 아이콘을 쓰지 않습니다.
- **Don't** `text.faint`를 글자 본문에 쓰지 않습니다.
- **Don't** 구조 탭 도표(`pre`)를 한글 글리프가 없는 고정폭 글꼴만으로 두지 않습니다. 고정폭 뒤에 Pretendard를 대체 글꼴로 둡니다.
