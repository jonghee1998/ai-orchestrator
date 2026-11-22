// '구조' 탭: 오케스트레이터 아키텍처와 붙어 있는 보조 도구(ECC, Impeccable, claudex, Playwright) 설명. 정적 내용.
import { CARD_TITLE, Card, PageTitle } from "@/components/ui";

const H2 = "px-1 text-lg font-[750] tracking-[-0.02em]";

const DIAGRAM = `사용자 (폰)
 │ 요청
 ▼
▌PM · Claude ─ 계획 Issue 작성
 ▼
▌계획 감사 (claudex) ─ Codex ⇄ PM, 최대 3회
 ▼ orch:go (사용자 승인)
▌엔진 (GitHub Actions) ─ 이벤트·20분 순찰
 ▼ 스텝마다 반복
┃ 구현  Sonnet/Opus    ← ECC · Impeccable
┃  ↓ 스텝 PR
┃ 검수  Codex → Opus   ← ECC 검수 에이전트
┃ CI   test·build·화면 ← Playwright
┃  ↺ 실패하면 수정 (최대 3회)
 ▼
▌최종 PR + 완공 보고서
 ├ 위험 낮음 → 자동 반영
 └ 위험 높음 → 사용자 승인
 ▼
▌main → Vercel 배포 → 이 상황판`;

const FLOW: [string, string][] = [
  ["요청", "사용자가 하고 싶은 일을 말하면 PM(Claude)이 스텝·완료 기준이 있는 계획 Issue를 씁니다."],
  ["계획 감사", "승인 전에 Codex가 계획을 감사하고 PM이 고칩니다 (최대 3회)."],
  ["승인", "사용자가 Issue에 orch:go 라벨을 붙이면 엔진이 시작합니다."],
  ["스텝 반복", "구현 → 스텝 PR → 독립 검수 + CI. 실패하면 지적을 받아 최대 3회 자동 수정, 2회 실패 시 Opus로 승격."],
  ["완공", "모든 스텝이 통과하면 최종 PR과 완공 보고서. 위험한 변경(로그인·DB·Actions 등)만 사용자 승인."],
  ["관리", "ON/OFF·일시정지·작동 시간대는 AI 팀 탭에서. 끄면 새 작업만 막고 돌던 일은 마칩니다."],
];

type Tool = { name: string; what: string; where: string; how: string[]; files: string };
const TOOLS: Tool[] = [
  {
    name: "ECC (Everything Claude Code)",
    what: "Claude Code용 스킬·에이전트 모음(2.2.3). 필요한 10개만 골라 원문 그대로 넣었습니다.",
    where: "구현 · 검수 · 계획",
    how: [
      "구현: verification-loop로 끝내기 전 타입·테스트·빌드 자체 검증, tdd-workflow로 테스트 먼저",
      "빌드 오류: build-error-resolver · react-build-resolver 보조 에이전트",
      "검수(Opus 대체 시): code · security · typescript · react-reviewer",
      "계획: planner · architect (PM 전용)",
      "쓴 스킬·에이전트는 스텝 PR과 완공 보고서에 자동 기록",
    ],
    files: ".claude/skills, .claude/agents · ecc/ecc.lock.json",
  },
  {
    name: "Impeccable",
    what: "디자인 스킬(pbakaus, 4.10.0). 흔한 AI 화면 티를 막고 품질 하한을 강제합니다.",
    where: "구현 (화면 스텝)",
    how: [
      "화면을 고치는 스텝에서 구현 Claude가 따름",
      "상황판은 Operate 모드: 훑어보기·일관성·모바일 우선",
      "고치기 직전 craft-floor(금지 항목) 확인, 기존 디자인 유지가 기본",
    ],
    files: ".claude/skills/impeccable · ecc/third-party.lock.json",
  },
  {
    name: "claudex 루프",
    what: "Claude가 쓰고 Codex가 감사하는 계획 검토 루프. PM용입니다.",
    where: "계획 (승인 전)",
    how: [
      "[plan] Issue가 열리거나 계획이 바뀌면 자동 감사 (plan-review 워크플로)",
      "코드 일치·스텝 분할·완료 기준·위험·모델 선택 점검 → Issue 댓글",
      "최대 3라운드, orch:go를 붙이면 멈춤",
      "Codex를 못 쓰면 Opus + planner·architect가 대신",
    ],
    files: ".github/workflows/plan-review.yml · scripts/orch/plan-review.mjs",
  },
  {
    name: "Playwright",
    what: "브라우저 자동화. 실제 앱을 띄워 결과 화면을 사람처럼 눌러 봅니다.",
    where: "CI (모든 PR)",
    how: [
      "실제 빌드 + 실제 로그인으로 탭을 폰 폭 360·390·430px로 열기",
      "기대 문구·가로 넘침·페이지 오류·외부 요청 검사",
      "스크린샷은 CI Artifacts → screens, 실패하면 자동 수정 루프로",
    ],
    files: "scripts/screens · .github/workflows/ci.yml (screens)",
  },
];

const MODELS: [string, string][] = [
  ["Claude (PM)", "요청 정리, 계획, 진행 보고"],
  ["Claude Sonnet", "일반 구현 (기본)"],
  ["Claude Opus", "위험한 구현, 2회 실패 시 승격, Codex 대신 검수·감사"],
  ["Codex", "독립 검수, 계획 감사 (기본)"],
  ["GitHub Actions", "엔진·CI·사용량 확인, PC가 꺼져도 동작"],
];

export function LiveArchitectureScreen() {
  return (
    <div className="space-y-4">
      <PageTitle title="구조" subtitle="오케스트레이터가 일하는 방식과 붙어 있는 도구" />

      <section aria-label="아키텍처" className="space-y-2">
        <h2 className={H2}>아키텍처</h2>
        <Card>
          <pre className="overflow-x-auto text-[11px] leading-[1.45] text-text" style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Pretendard Variable", Pretendard, monospace' }} data-testid="arch-diagram">{DIAGRAM}</pre>
        </Card>
        <Card className="py-1.5">
          <ol>
            {FLOW.map(([k, v], i) => (
              <li key={k} className={`flex gap-2 py-3 text-sm ${i ? "border-t border-border" : ""}`}>
                <span className="w-3.5 shrink-0 text-[13px] font-semibold tabular-nums text-text-muted">{i + 1}</span>
                <p className="min-w-0"><span className="font-bold">{k}</span> <span className="text-text-muted">— {v}</span></p>
              </li>
            ))}
          </ol>
        </Card>
      </section>

      <section aria-label="역할" className="space-y-2">
        <h2 className={H2}>누가 무엇을</h2>
        <Card className="py-1.5">
          {MODELS.map(([k, v], i) => (
            <p key={k} className={`py-3 text-sm ${i ? "border-t border-border" : ""}`}><span className="font-bold">{k}</span> <span className="text-text-muted">· {v}</span></p>
          ))}
        </Card>
      </section>

      <section aria-label="보조 도구" className="space-y-2">
        <h2 className={H2}>보조 도구</h2>
        {TOOLS.map((t) => (
          <Card key={t.name} className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2">
              <h3 className={CARD_TITLE}>{t.name}</h3>
              <span className="text-xs font-semibold text-accent">{t.where}</span>
            </div>
            <p className="text-sm text-text-muted">{t.what}</p>
            <ul className="list-disc space-y-1 pl-5 text-sm marker:text-text-faint">
              {t.how.map((h) => <li key={h}>{h}</li>)}
            </ul>
            <p className="break-all border-t border-border pt-2.5 text-[11px] text-text-muted">{t.files}</p>
          </Card>
        ))}
      </section>
    </div>
  );
}
