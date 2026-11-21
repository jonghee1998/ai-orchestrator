// 패치노트 데이터 (정적). 상황판 '패치노트' 탭이 그대로 보여 줍니다.
// 버전 규칙: 사소한 수정 +0.0.1, 큰 변화 +0.1, 아주 큰 변화 +1. v1.0.0 = 엔진 도입.
// 새 항목은 배열 맨 앞에 추가합니다 (최신순).

export type PatchNote = { version: string; date: string; pr?: number; title: string; items: string[] };

export const PATCH_NOTES: PatchNote[] = [
  { version: "1.7.1", date: "2026-11-21", pr: 234, title: "사용량 자동 최신화", items: ["상황판을 열 때 사용량이 1시간 넘게 지났으면 바로 새로 확인 요청 (GitHub 예약 실행 누락 대비)", "AI 팀 탭에 '↻ 지금 확인' 버튼 (관리자) — 누르면 바로 새로 확인", "확인 중이면 안내 표시"] },
  { version: "1.7.0", date: "2026-11-21", pr: 232, title: "ECC 2·3단계: 검수·계획 에이전트", items: ["Codex 대신 Opus가 검수할 때 code·security·typescript·react 검수 에이전트를 보조로 사용", "검수는 main의 설정만 사용해 구현자가 검수 지시를 바꿀 수 없음", "검수 댓글에 쓴 에이전트, 스텝 PR·수정 댓글에 구현 모델(승격 사유 포함) 표기", "PM 계획 작성용 planner·architect 에이전트"] },
  { version: "1.6.0", date: "2026-11-21", pr: 233, title: "패치노트 탭", items: ["하단에 '패치노트' 탭 추가", "버전·날짜·PR 번호와 핵심 변경을 최신순으로 표시"] },
  { version: "1.5.0", date: "2026-11-21", pr: 229, title: "데모·시뮬레이션 삭제", items: ["개발용 데모 모드·시뮬레이션·테스트 모드 기능 삭제", "상단 공통 머리글 제거, 실데이터 화면만 남김"] },
  { version: "1.4.1", date: "2026-11-21", pr: 225, title: "구현 Claude 파일 삭제 허용", items: ["구현 Claude가 git rm으로 파일 삭제 가능", "끝내기 전 검증 스킬 사용을 지시에 명시"] },
  { version: "1.4.0", date: "2026-11-21", pr: 222, title: "도구 사용 자동 기록", items: ["스텝 PR에 구현 Claude가 쓴 스킬·보조 에이전트·검증 명령을 자동 기록", "완공 보고서에 '스킬·보조 에이전트' 열 추가"] },
  { version: "1.3.0", date: "2026-11-21", pr: 221, title: "상황판 엔진 중심 정리", items: ["3개 탭을 엔진 패널(진행 상황·사용량·ON/OFF·결정 필요) 중심으로 정리", "이전 방식 화면 요소 제거"] },
  { version: "1.2.1", date: "2026-11-21", pr: 211, title: "Codex 한도 소진 대응", items: ["Codex가 한도 안내만 남기면 '사용 불가'로 판정", "Claude Opus가 바로 대체 검수"] },
  { version: "1.2.0", date: "2026-11-21", pr: 215, title: "ECC 1단계", items: ["구현 Claude가 끝내기 전 verification-loop로 타입·테스트·빌드 자체 검증", "TDD 스킬, 빌드·React 오류 전담 보조 에이전트 2종", "버전·해시 고정"] },
  { version: "1.1.2", date: "2026-11-21", pr: 216, title: "스킬·보조 에이전트 허용", items: ["구현 Claude가 저장소의 스킬과 보조 에이전트를 호출 가능"] },
  { version: "1.1.1", date: "2026-11-21", pr: 212, title: "Codex 폰 로그인", items: ["Codex 로그인 코드를 Actions 로그와 사용량 Issue 댓글에 바로 표시"] },
  { version: "1.1.0", date: "2026-11-21", pr: 93, title: "모바일 상황판", items: ["프로젝트 탭: 자동 진행 작업 현황", "AI 팀 탭: Claude·Codex 잔여 한도와 ON/OFF 스위치", "PM 브리핑 탭: 결정·승인 필요 항목"] },
  { version: "1.0.0", date: "2026-11-21", pr: 207, title: "오케스트레이터 엔진", items: ["계획 Issue 하나로 스텝별 구현→독립 검수→CI→자동 수정(최대 3회)→최종 PR·완공 보고서", "스텝마다 Sonnet/Opus 자동 선택", "Sonnet·Opus·Codex ON/OFF, 일시정지, 작동 시간대", "위험한 변경은 사용자 승인 후 머지", "Claude·Codex 사용량 수집", "운영 매뉴얼"] },
];

export const CURRENT_VERSION = PATCH_NOTES[0].version;
