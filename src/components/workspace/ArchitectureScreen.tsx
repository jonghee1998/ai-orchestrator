// '구조' 탭: 오케스트레이터 아키텍처를 컨설팅 보고서 형식(요약 → 구조도 → 프로세스 → 역할 → 통제 → 자동 루틴 → 보조 도구)으로 설명합니다. 정적 내용.
import type { ReactNode } from "react";
import { CARD_TITLE, Card, PageTitle } from "@/components/ui";
import { DEPLOY_SVG, FLOW_SVG } from "./archDiagrams";

const KICKER = "text-[11px] font-semibold uppercase tracking-[0.08em] text-accent";
const H2 = "text-lg font-[750] leading-snug tracking-[-0.02em]";

function Section({ no, kicker, title, children }: { no: string; kicker: string; title: string; children: ReactNode }) {
  return (
    <section aria-label={kicker} className="space-y-2.5">
      <div className="px-1">
        <p className={KICKER}><span className="tabular-nums">{no}</span> · {kicker}</p>
        <h2 className={H2}>{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Legend({ items }: { items: [string, string][] }) {
  return (
    <p className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-text-muted">
      {items.map(([c, t]) => (
        <span key={t} className="inline-flex items-center gap-1">
          <i aria-hidden="true" className={`inline-block h-2.5 w-2.5 rounded-[3px] ${c === "dash" ? "border border-dashed border-text-faint" : c}`} />{t}
        </span>
      ))}
    </p>
  );
}

const SECRET_RULES: [string, string][] = [
  ["보관 위치", "토큰 · 비밀번호는 GitHub Secrets와 Vercel 환경변수에만. 코드 · 로그 · 테스트 · Issue에는 넣지 않음."],
  ["다시 보기", "GitHub Secrets는 저장 후 값을 다시 볼 수 없음. 바꾸려면 새 값으로 덮어씀."],
  ["비밀번호", "관리자 비밀번호는 원문이 아니라 해시(ADMIN_PASSWORD_HASH)만 저장."],
  ["Codex 로그인", "로그인 정보는 CODEX_AUTH_KEY로 암호화해 Actions 캐시에 보관."],
  ["배포 경로", "Vercel의 GitHub 자동 배포는 꺼 둠. deploy 워크플로가 Deploy Hook을 불러야만 배포."],
  ["권한 분리", "상황판 토큰은 읽기 · 라벨 · 아이디어 · 사용량 확인까지만. 코드 푸시는 Actions의 BOT_PAT만."],
  ["구현 AI", ".github · 엔진 파일을 고칠 수 없어 비밀값을 쓰는 워크플로를 바꾸지 못함."],
];

const KPIS: [string, string][] = [
  ["2곳", "사람이 결정하는 지점 (계획 승인 · 위험 변경 반영)"],
  ["3중", "자동 품질 확인 (독립 검수 · CI · 결과 화면)"],
  ["0대", "켜 둘 서버 (GitHub Actions 위에서 동작)"],
];

type Stage = { name: string; owner: string; out: string; control: string };
const PROCESS: Stage[] = [
  { name: "아이디어", owner: "사용자 → Codex · PM", out: "의견 2개 + 종합 의견", control: "개발 여부는 사용자가 결정" },
  { name: "계획", owner: "PM (Claude)", out: "계획 Issue (스텝 · 완료 기준 · 위험)", control: "계획 감사 최대 3회 (claudex)" },
  { name: "승인", owner: "사용자", out: "orch:go", control: "감사 OK 뒤에만 승인 버튼" },
  { name: "스텝 실행", owner: "엔진 → 구현 AI", out: "스텝 PR", control: "독립 검수 + CI, 실패 시 최대 3회 자동 수정 · 2회 실패 시 Opus 승격" },
  { name: "통합", owner: "엔진", out: "최종 PR + 완공 보고서", control: "충돌 자동 정리(패치노트) · 위험 판정" },
  { name: "반영 · 배포", owner: "엔진 / 사용자", out: "main 반영 → Vercel", control: "위험 낮음 자동 반영 · 높음 사용자 승인 · 10건마다 배포" },
];

type Role = { who: string; does: string; not: string };
const ROLES: Role[] = [
  { who: "사용자", does: "요청 · 아이디어, 계획 승인, 위험 변경 반영, 배포 실행", not: "코드 작성 · 검수" },
  { who: "PM · Claude", does: "요청 정리, 계획 Issue 작성, 감사 반영, 진행 보고, 막힘 진단", not: "main 반영 · 스위치 변경 · 실행 생성" },
  { who: "Claude Sonnet", does: "일반 구현 (기본)", not: ".github · 엔진 파일 수정" },
  { who: "Claude Opus", does: "위험 작업 구현, 2회 실패 시 승격, Codex 대신 검수 · 감사", not: "자기 작업 검수" },
  { who: "Codex", does: "독립 검수, 계획 감사, 아이디어 의견 (기본)", not: "구현" },
  { who: "GitHub Actions", does: "엔진 · CI · 사용량 확인 · 배포 호출 (PC 꺼져도 동작)", not: "판단 (규칙대로만 실행)" },
];

const CONTROLS: [string, string][] = [
  ["승인 게이트", "계획은 사용자 승인(orch:go) 뒤에만 실행. 로그인 · DB · Actions · 의존성 같은 위험 변경은 최종 반영도 사용자 승인."],
  ["독립 검수", "만든 AI와 다른 AI(Codex, 없으면 Opus)가 검수. 검수 에이전트는 구현 단계에서 쓰지 않음."],
  ["재시도 · 승격", "스텝마다 최대 3회 자동 수정, 2회 실패하면 Opus로 올림. 그래도 안 되면 멈추고 PM이 원인 보고."],
  ["보호 파일", "구현 AI는 .github · scripts/orch(엔진)를 고칠 수 없음. 고치면 푸시가 거부됨."],
  ["스위치", "Sonnet · Opus · Codex ON/OFF, 전체 일시정지, 작동 시간대. 끄면 새 작업만 막고 돌던 일은 마침."],
  ["비밀 정보", "토큰 · 비밀번호는 GitHub · Vercel 비밀 설정에만. 코드 · 로그 · 테스트에 넣지 않음."],
  ["작업 한도", "구현 1회당 150동작. 무한 반복을 막는 안전장치."],
];

const ROUTINES: [string, string][] = [
  ["이벤트 즉시", "PR · 검수 · CI 결과가 나오면 엔진이 바로 다음 단계로"],
  ["20분마다", "엔진 순찰: 멈춘 작업 재시도 · 상태판 갱신 · 최종 PR 충돌 확인"],
  ["1시간마다", "PM 점검: 막힌 작업 원인 진단 후 Issue에 선택지 보고"],
  ["사용량", "Claude · Codex 남은 사용량 자동 확인, 상황판에서 즉시 확인 가능"],
  ["10건마다", "main에 10건 쌓이면 Vercel 운영 배포 (수동 즉시 배포도 가능)"],
];

type Tool = { name: string; role: string; where: string; how: string[]; files: string };
const TOOLS: Tool[] = [
  {
    name: "claudex 루프",
    role: "계획 감사",
    where: "계획 · 승인 전",
    how: [
      "[plan] Issue가 열리거나 계획이 바뀌면 자동 감사 (plan-review)",
      "코드 일치 · 스텝 분할 · 완료 기준 · 위험 · 모델 선택 점검 → Issue 댓글",
      "최대 3라운드, 승인하면 멈춤. Codex를 못 쓰면 Opus + planner · architect가 대신",
    ],
    files: ".github/workflows/plan-review.yml · scripts/orch/plan-review.mjs",
  },
  {
    name: "아이디어 검토",
    role: "의견 취합",
    where: "아이디어 · 개발 전",
    how: [
      "상황판 아이디어함에 적으면 [idea] Issue 생성",
      "Codex 의견 → Claude 의견 + 종합 의견을 Issue와 상황판에 표시",
      "개발 확정은 사용자가 계획 요청으로",
    ],
    files: ".github/workflows/idea-review.yml · scripts/orch/idea-review.mjs",
  },
  {
    name: "ECC (Everything Claude Code)",
    role: "구현 · 검수 보조",
    where: "구현 · 검수 · 계획",
    how: [
      "구현: verification-loop로 끝내기 전 타입 · 테스트 · 빌드 자체 검증, tdd-workflow로 테스트 먼저",
      "빌드 오류: build-error-resolver · react-build-resolver",
      "검수(Opus 대체 시): code · security · typescript · react-reviewer",
      "계획: planner · architect (PM 전용) · 쓴 도구는 PR과 완공 보고서에 기록",
    ],
    files: ".claude/skills · .claude/agents · ecc/ecc.lock.json (2.2.3, 10개)",
  },
  {
    name: "Impeccable",
    role: "디자인 기준",
    where: "구현 (화면 스텝)",
    how: [
      "화면 스텝에서 구현 AI가 따르는 디자인 스킬 (4.10.0)",
      "상황판은 Operate 모드: 훑어보기 · 일관성 · 모바일 우선",
      "고치기 직전 금지 항목(craft-floor) 확인, 기준은 DESIGN.md · 정답 시안",
    ],
    files: ".claude/skills/impeccable · ecc/third-party.lock.json · DESIGN.md",
  },
  {
    name: "Playwright",
    role: "결과 화면 시험",
    where: "CI (모든 PR)",
    how: [
      "실제 빌드 + 실제 로그인으로 5탭을 폰 폭 360 · 390 · 430px로 열기",
      "기대 문구 · 가로 넘침 · 페이지 오류 · 배경 · 글꼴 검사",
      "스크린샷은 CI Artifacts, 실패하면 자동 수정 루프로",
    ],
    files: "scripts/screens · .github/workflows/ci.yml (screens)",
  },
];

export function LiveArchitectureScreen() {
  return (
    <div className="space-y-7">
      <PageTitle title="구조" subtitle="오케스트레이터가 일하는 방식과 붙어 있는 도구" />

      <Section no="01" kicker="요약" title="사람은 요청과 승인만, 나머지는 GitHub 위의 AI 팀이 처리합니다">
        <Card className="space-y-0 py-1.5">
          {KPIS.map(([n, t], i) => (
            <div key={n} className={`flex items-baseline gap-3 py-3 ${i ? "border-t border-border" : ""}`}>
              <span className="w-12 shrink-0 text-2xl font-[750] tabular-nums tracking-[-0.03em]">{n}</span>
              <span className="text-[13px] leading-snug text-text-muted">{t}</span>
            </div>
          ))}
        </Card>
      </Section>

      <Section no="02" kicker="아키텍처" title="요청에서 배포까지 한 흐름">
        <Card>
          <div data-testid="arch-diagram" dangerouslySetInnerHTML={{ __html: FLOW_SVG }} />
          <Legend items={[["bg-text", "사람이 결정"], ["bg-ok", "통과"], ["bg-danger", "실패 · 멈춤"], ["dash", "반복"]]} />
        </Card>
      </Section>

      <Section no="03" kicker="배포 · 비밀값" title="비밀값은 GitHub와 Vercel 설정에만 있습니다">
        <Card className="space-y-3">
          <div data-testid="arch-deploy" dangerouslySetInnerHTML={{ __html: DEPLOY_SVG }} />
          <Legend items={[["bg-text", "실행 위치"], ["bg-accent", "GitHub 접근 · 배포 호출"]]} />
        </Card>
        <Card className="py-1.5">
          {SECRET_RULES.map(([k, v], i) => (
            <div key={k} className={`grid grid-cols-[5.5rem_1fr] gap-x-2 py-3 text-[13px] ${i ? "border-t border-border" : ""}`}>
              <span className="font-bold">{k}</span>
              <span className="text-text-muted">{v}</span>
            </div>
          ))}
        </Card>
      </Section>

      <Section no="04" kicker="프로세스" title="여섯 단계, 단계마다 산출물과 통제가 있습니다">
        <Card className="py-1.5">
          <ol>
            {PROCESS.map((s, i) => (
              <li key={s.name} className={`grid grid-cols-[1.25rem_1fr] gap-x-2 py-3 ${i ? "border-t border-border" : ""}`}>
                <span className="pt-px text-[13px] font-semibold tabular-nums text-text-muted">{i + 1}</span>
                <div className="min-w-0 space-y-1">
                  <p className="flex flex-wrap items-baseline justify-between gap-x-2"><span className="text-[15px] font-bold">{s.name}</span><span className="text-[12px] text-text-muted">{s.owner}</span></p>
                  <dl className="grid grid-cols-[3rem_1fr] gap-x-2 gap-y-0.5 text-[12.5px]">
                    <dt className="text-text-muted">산출물</dt><dd>{s.out}</dd>
                    <dt className="text-text-muted">통제</dt><dd>{s.control}</dd>
                  </dl>
                </div>
              </li>
            ))}
          </ol>
        </Card>
      </Section>

      <Section no="05" kicker="역할" title="누가 무엇을 하고, 무엇은 하지 않는지">
        <Card className="py-1.5">
          {ROLES.map((r, i) => (
            <div key={r.who} className={`space-y-1 py-3 ${i ? "border-t border-border" : ""}`}>
              <p className="text-[15px] font-bold">{r.who}</p>
              <dl className="grid grid-cols-[3rem_1fr] gap-x-2 gap-y-0.5 text-[12.5px]">
                <dt className="text-text-muted">한다</dt><dd>{r.does}</dd>
                <dt className="text-text-muted">안 한다</dt><dd className="text-text-muted">{r.not}</dd>
              </dl>
            </div>
          ))}
        </Card>
      </Section>

      <Section no="06" kicker="통제 장치" title="사고를 막는 일곱 가지 안전장치">
        <Card className="py-1.5">
          {CONTROLS.map(([k, v], i) => (
            <div key={k} className={`grid grid-cols-[5.5rem_1fr] gap-x-2 py-3 text-[13px] ${i ? "border-t border-border" : ""}`}>
              <span className="font-bold">{k}</span>
              <span className="text-text-muted">{v}</span>
            </div>
          ))}
        </Card>
      </Section>

      <Section no="07" kicker="자동 루틴" title="PC가 꺼져 있어도 도는 것들">
        <Card className="py-1.5">
          {ROUTINES.map(([k, v], i) => (
            <div key={k} className={`grid grid-cols-[5.5rem_1fr] gap-x-2 py-3 text-[13px] ${i ? "border-t border-border" : ""}`}>
              <span className="font-bold">{k}</span>
              <span className="text-text-muted">{v}</span>
            </div>
          ))}
        </Card>
      </Section>

      <Section no="08" kicker="보조 도구" title="각 단계에 붙어 품질을 올리는 도구">
        <div className="space-y-3">
          {TOOLS.map((t) => (
            <Card key={t.name} className="space-y-2">
              <div>
                <p className="text-[11px] font-semibold text-accent">{t.where}</p>
                <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                  <h3 className={CARD_TITLE}>{t.name}</h3>
                  <span className="text-[12px] text-text-muted">{t.role}</span>
                </div>
              </div>
              <ul className="space-y-1.5 text-[13px]">
                {t.how.map((h) => (
                  <li key={h} className="grid grid-cols-[0.75rem_1fr] gap-x-1.5"><span aria-hidden="true" className="mt-[7px] h-1 w-1 rounded-full bg-text-faint" />{h}</li>
                ))}
              </ul>
              <p className="break-all border-t border-border pt-2.5 text-[11px] text-text-muted">{t.files}</p>
            </Card>
          ))}
        </div>
      </Section>
    </div>
  );
}
