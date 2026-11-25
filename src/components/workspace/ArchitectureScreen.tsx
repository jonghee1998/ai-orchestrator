// '구조' 탭: 오케스트레이터 아키텍처를 컨설팅 보고서 형식(요약 → 구조도 → 프로세스 → 역할 → 통제 → 자동 루틴 → 보조 도구)으로 설명합니다. 정적 내용.
import type { ReactNode } from "react";
import { CARD_TITLE, Card } from "@/components/ui";
import { DEPLOY_SVG, LAYER1_SVG, LAYER2_SVG, LAYER3_SVG } from "./archDiagrams";

const KICKER = "text-[11px] font-semibold uppercase tracking-[0.08em] text-accent";
const H2 = "text-lg font-[750] leading-snug tracking-[-0.02em]";

export function Section({ no, kicker, title, children }: { no: string; kicker: string; title: string; children: ReactNode }) {
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
  ["1곳", "사람이 결정하는 지점 (대화로 방향 · 사람 할 일). 자동 모드를 끄면 계획 승인 · 위험 변경 반영도"],
  ["3중", "자동 품질 확인 (만든 AI와 다른 AI의 검수 · CI · 결과 화면)"],
  ["0대", "켜 둘 서버 (GitHub Actions 위에서 동작)"],
];
type Layer = { name: string; who: string; svg: string; note: string };
const LAYERS: Layer[] = [
  { name: "1층 · 방향 정하기", who: "사용자 + PM", svg: LAYER1_SVG, note: "대화로 로드맵(전체 단계)을 정하고 기록합니다. 사람만 할 수 있는 일은 '사람 할 일' Issue에 쌓였다가 대화할 때 처리합니다." },
  { name: "2층 · 단계 진행", who: "PM + Codex · 단계마다 반복", svg: LAYER2_SVG, note: "계획을 하나씩 써서 실행하고, 반영되면 다음 계획을 씁니다. 단계가 끝나 보이면 Codex가 통합 검수한 뒤 다음 단계로 넘어갑니다." },
  { name: "3층 · 계획 1개 실행", who: "엔진 · 스텝마다 반복", svg: LAYER3_SVG, note: "스텝마다 구현 → 독립 검수 + CI → 통합. Claude 한도면 Codex가 대신 만들고, 그 스텝은 main 반영 전에 Claude가 다시 검수합니다." },
];

type Stage = { name: string; owner: string; out: string; control: string };
const PROCESS: Stage[] = [
  { name: "대화 · 로드맵", owner: "사용자 → PM", out: "roadmap.json 단계 · PM_HANDOFF", control: "방향과 단계 순서는 사용자와 대화로 결정" },
  { name: "다음 계획", owner: "Codex 분석 → PM", out: "계획 Issue (스텝 · 완료 기준 · 위험)", control: "Claude 한도면 Codex가 작성 · 하루 8개 상한" },
  { name: "감사 · 시작", owner: "Codex → PM", out: "감사 의견 · 자동 orch:go", control: "최대 3회, 지적은 PM이 반영 · 자동 모드면 OK·고칠 것 없음 판단·마지막 라운드(반영 결과와 상관없이) 때 재감사 없이 시작 · OFF면 사용자 승인" },
  { name: "스텝 실행", owner: "엔진 → 구현 AI", out: "스텝 PR", control: "독립 검수 + CI, 실패 시 최대 3회 자동 수정 · 2회 실패 시 Opus 승격" },
  { name: "통합", owner: "엔진", out: "최종 PR + 완공 보고서", control: "충돌 자동 정리(패치노트) · 위험 판정" },
  { name: "반영 · 배포", owner: "엔진 → deploy 워크플로", out: "main 반영 → (10건마다) Vercel", control: "엔진은 main 반영까지(임시 통과는 Claude 재검수 · 자동 모드면 자동 반영) · 운영 배포는 deploy 워크플로가 main 10건마다(수동 즉시 가능)" },
  { name: "단계 넘기기", owner: "Codex → PM", out: "단계 통합 검수", control: "빠진 것이 있으면 그것부터 계획, 없을 때만 다음 단계" },
];

type Role = { who: string; does: string; not: string };
const ROLES: Role[] = [
  { who: "사용자", does: "대화로 방향 · 단계 결정, 사람 할 일(운영 배포 · 비밀값 · 외부 콘솔)", not: "코드 작성 · 검수 · 매번 승인 (자동 모드)" },
  { who: "PM · Claude", does: "로드맵, 다음 계획 작성, 감사 지적 반영, 막힘 진단, 엔진 수정 PR", not: "운영 배포 · 비밀값 변경" },
  { who: "Claude Sonnet", does: "일반 구현 (기본)", not: ".github · 엔진 파일 수정" },
  { who: "Claude Opus", does: "위험 작업 구현, 2회 실패 시 승격, Codex 대신 검수, 임시 통과 재검수", not: "자기 작업 검수" },
  { who: "Codex", does: "독립 검수 · 계획 감사 (기본), Claude 한도면 구현 · 수정 · 계획, 반복 실패 원인 분석, 단계 통합 검수 · 멈춘 작업 즉시 진단·가능하면 재개(PM 대리, 자동 모드)", not: "임시 통과를 main에 바로 반영" },
  { who: "GitHub Actions", does: "엔진 · CI · 사용량 확인 · 배포 호출 (PC 꺼져도 동작)", not: "판단 (규칙대로만 실행)" },
];

const CONTROLS: [string, string][] = [
  ["자동 모드", "켜면 감사 OK·고칠 것 없음 판단·마지막 라운드 때 자동 시작 · 최종 자동 반영(CI 필수). 끄면 계획 승인과 위험 변경 반영을 사용자가."],
  ["독립 검수", "만든 AI와 다른 AI가 검수. Codex가 만들고 Codex가 검수한 스텝은 임시 통과 → main 반영 전 Claude 재검수."],
  ["한도 대응", "Claude 한도면 Codex가 이어서 개발(스위치로 끄면 풀리는 시각까지 대기). 중단하지 않음."],
  ["재시도 · 승격", "스텝마다 최대 3회 자동 수정, 2회 실패하면 Opus로 올림. 그래도 안 되면 멈추고 PM이 원인 보고."],
  ["보호 파일", "구현 AI는 .github · scripts/orch(엔진)를 고칠 수 없음. 고치면 푸시가 거부됨."],
  ["스위치", "Sonnet · Opus · Codex · Codex 개발 대체 · 자동 모드 ON/OFF, 일시정지, 시간대. 끄면 새 작업만 막음."],
  ["자동 계획 상한", "하루 8개, 열린 계획 · 진행 · 중단된 run이 있으면 새 계획을 쓰지 않음."],
  ["비밀 정보", "토큰 · 비밀번호는 GitHub · Vercel 비밀 설정에만. 코드 · 로그 · 테스트에 넣지 않음."],
  ["작업 한도", "구현 1회당 150동작. 무한 반복을 막는 안전장치."],
];

const ROUTINES: [string, string][] = [
  ["이벤트 즉시", "PR · 검수 · CI · 머지 결과가 나오면 엔진이 바로 다음 단계로, run이 끝나면 다음 계획"],
  ["매시 7·27·47분", "엔진 순찰: 멈춘 작업 재시도 · 최종 PR 충돌 확인 · 할 일 없으면 다음 계획 요청"],
  ["멈추면 바로", "자동 모드·Codex 켜짐일 때 Codex PM 이 바로 원인 진단 → 자동으로 풀 수 있으면 계획에 [PM 지시]를 붙여 재개(run당 3회), 아니면 Issue 에 사람 판단 요청. 최종 PR 문제·3회 소진·모드 꺼짐은 사람 판단"],
  ["한도 해제 시각", "wait가 그 시각에 엔진을 깨워 이어감 (재검수 · Codex 대체 OFF일 때)"],
  ["사용량", "Claude · Codex 남은 사용량 자동 확인, 상황판에서 즉시 확인 가능"],
  ["10건마다", "main에 10건 쌓이면 Vercel 운영 배포 (수동 즉시 배포도 가능)"],
];

const REPO_SETTINGS: [string, string][] = [
  ["Secrets", "CLAUDE_CODE_OAUTH_TOKEN · BOT_PAT(소유자 토큰) · CODEX_AUTH_KEY(Codex 로그인 암호화) · NTFY_TOPIC(폰 알림). 두 저장소 같음"],
  ["Variables", "ORCH_AUTO · ORCH_CODEX_DEV · ORCH_SONNET · ORCH_OPUS · ORCH_CODEX · ORCH_PAUSED · ORCH_WINDOW. 상황판 스위치가 모든 저장소에 한 번에 씀"],
  ["필수 검사", "ai-orchestrator: test · screens / Personal-dashboard: test · screens · db · pii"],
  ["main 규칙", "자동 머지 허용 · 필수 검사 통과해야 반영 · 브랜치 삭제 금지 · 강제 push 금지"],
  ["Codex 앱", "저장소 Code review 켜짐. Actions의 Codex는 로그인을 캐시에 암호화해 씀"],
  ["멈춤 해제", "pm-unblock 워크플로: 중단되면 바로 Codex 가 PM 대리로 진단, 풀 수 있으면 재개 (자동 모드·Codex 켜짐, 최종 PR 문제 제외)"],
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

/** ai-orchestrator 자체 구조 섹션 01~09 (정적). 프로젝트 카드를 펼치면 보인다. */
export function SelfArchitectureSections() {
  return (
    <div className="space-y-7">
      <Section no="01" kicker="요약" title="사람은 대화로 방향만, 나머지는 GitHub 위의 AI 팀이 이어서 처리합니다">
        <Card className="space-y-0 py-1.5">
          {KPIS.map(([n, t], i) => (
            <div key={n} className={`flex items-baseline gap-3 py-3 ${i ? "border-t border-border" : ""}`}>
              <span className="w-12 shrink-0 text-2xl font-[750] tabular-nums tracking-[-0.03em]">{n}</span>
              <span className="text-[13px] leading-snug text-text-muted">{t}</span>
            </div>
          ))}
        </Card>
      </Section>

      <Section no="02" kicker="아키텍처" title="대화에서 배포까지, 3층으로 돕니다">
        <div className="space-y-3">
          {LAYERS.map((l, i) => (
            <Card key={l.name} className="space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                <h3 className={CARD_TITLE}>{l.name}</h3>
                <span className="text-[12px] text-text-muted">{l.who}</span>
              </div>
              <p className="text-[13px] leading-snug text-text-muted">{l.note}</p>
              <div data-testid={i === 0 ? "arch-diagram" : `arch-layer-${i + 1}`} dangerouslySetInnerHTML={{ __html: l.svg }} />
            </Card>
          ))}
          <Legend items={[["bg-text", "사람 · 시작"], ["bg-ok", "통과 · 반영"], ["bg-danger", "실패 · 멈춤"], ["bg-accent", "Claude 한도일 때 Codex"], ["bg-warn", "사람 할 일"], ["dash", "반복"]]} />
        </div>
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

      <Section no="04" kicker="프로세스" title="일곱 단계, 단계마다 산출물과 통제가 있습니다">
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

      <Section no="06" kicker="통제 장치" title="사고를 막는 아홉 가지 안전장치">
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

      <Section no="09" kicker="저장소 설정" title="저장소마다 해 둔 설정">
        <Card className="py-1.5">
          {REPO_SETTINGS.map(([k, v], i) => (
            <div key={k} className={`grid grid-cols-[5.5rem_1fr] gap-x-2 py-3 text-[13px] ${i ? "border-t border-border" : ""}`}>
              <span className="font-bold">{k}</span>
              <span className="break-words text-text-muted">{v}</span>
            </div>
          ))}
        </Card>
      </Section>
    </div>
  );
}
