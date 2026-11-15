// Release-readiness report from server env. Pure; reports presence/validity only — NEVER values.
export type ReadyState = "ok" | "missing" | "blocked";
export interface ReadyItem { id: string; label: string; state: ReadyState; detail: string }
type Env = Readonly<Record<string, string | undefined>>;

const long = (v: string | undefined) => !!v && v.length >= 16;
const AGENTS = ["gpt", "claude-sonnet", "claude-opus", "codex"] as const;
const secretName = (a: string) => `RUN_CALLBACK_SECRET_${a.toUpperCase().replace(/-/g, "_")}`;

/** #34: per-agent signing secrets (gate + callback). Shared values across agents defeat agent binding. Never returns values. */
export function callbackSecretStatus(env: Env) {
  const present = AGENTS.filter((a) => (env[secretName(a)] ?? "").length >= 32);
  const weak = AGENTS.filter((a) => { const v = env[secretName(a)]; return !!v && v.length < 32; });
  const vals = present.map((a) => env[secretName(a)]);
  const shared = new Set(vals).size !== vals.length;
  const legacyOnly = ["CLAUDE", "CODEX", "GPT"].some((p) => !!env[`RUN_CALLBACK_SECRET_${p}`]) && present.length === 0;
  return { present: [...present], weak: [...weak], shared, legacyOnly };
}

export function computeReadiness(env: Env): { items: ReadyItem[]; releaseBlocked: boolean } {
  const cs = callbackSecretStatus(env);
  const csOk = cs.present.length > 0 && !cs.shared && cs.weak.length === 0;
  const csDetail = cs.shared ? "서로 다른 에이전트가 같은 비밀값을 공유함 — 에이전트 바인딩 무효. 에이전트별 고유 값 필요"
    : cs.weak.length ? `32자 미만 비밀: ${cs.weak.join(", ")}`
    : cs.present.length ? `에이전트별 고유 비밀 ${cs.present.length}/4 (${cs.present.join(", ")}) — 없는 에이전트는 게이트/콜백 503(fail closed)`
    : cs.legacyOnly ? "provider 공용 비밀(RUN_CALLBACK_SECRET_CLAUDE 등)만 있음 — #34부터 무시됨. RUN_CALLBACK_SECRET_CLAUDE_OPUS 등 에이전트별 비밀 필요"
    : "미설정 — 게이트 503, agent ACK/heartbeat 수신 불가(상태는 unknown)";
  const items: ReadyItem[] = [
    { id: "database", label: "Postgres (DATABASE_URL)", state: env.DATABASE_URL ? "ok" : "missing", detail: env.DATABASE_URL ? "설정됨 (연결/마이그레이션은 scripts/migrate.mjs로 별도 확인)" : "미설정 — 서버리스에서는 파일 저장소 사용 불가" },
    { id: "admin", label: "관리자 토큰 (CONTROL_ADMIN_TOKEN)", state: long(env.CONTROL_ADMIN_TOKEN) ? "ok" : "missing", detail: long(env.CONTROL_ADMIN_TOKEN) ? "설정됨" : "16자 이상 필요" },
    { id: "read", label: "읽기 토큰 (CONTROL_READ_TOKEN)", state: long(env.CONTROL_READ_TOKEN) ? "ok" : "missing", detail: long(env.CONTROL_READ_TOKEN) ? "설정됨" : "선택 — 없으면 관리자 토큰으로 읽기" },
    { id: "github", label: "GitHub 큐 읽기 (GITHUB_REPO + GITHUB_READ_TOKEN 권장, 대체: GITHUB_TOKEN)", state: (env.GITHUB_READ_TOKEN || env.GITHUB_TOKEN) && env.GITHUB_REPO ? "ok" : "missing", detail: (env.GITHUB_READ_TOKEN || env.GITHUB_TOKEN) && env.GITHUB_REPO ? "설정됨 (live 여부는 /api/readiness 프로브로 확인)" : "미설정 — 작업 큐는 live가 아닌 unconfigured로 표시됨" },
    { id: "github_write", label: "GitHub 쓰기 토큰 (GITHUB_TOKEN) — dispatch 전용", state: env.GITHUB_TOKEN && env.GITHUB_REPO ? "ok" : "missing", detail: env.GITHUB_TOKEN && env.GITHUB_REPO ? "설정됨 (라벨 부착 가능 — 승인 전 사용 금지)" : "dispatch(라벨 부착)에 필요. 미설정이면 dispatch는 503 fail-closed" },
    { id: "callback", label: "에이전트별 서명 비밀 (RUN_CALLBACK_SECRET_<AGENT>, 게이트+콜백)", state: csOk ? "ok" : cs.shared || cs.weak.length ? "blocked" : "missing", detail: csDetail },
    { id: "cron", label: "Reconcile 스케줄 (CRON_SECRET + vercel.json)", state: long(env.CRON_SECRET) ? "ok" : "missing", detail: long(env.CRON_SECRET) ? "시크릿 설정됨 (실제 실행은 배포 후 확인 필요)" : "미설정 — GET /api/reconcile 인증 불가" },
    { id: "external", label: "외부 GitHub 트리거/루틴 게이트", state: "blocked", detail: "코드로 제어·검증 불가. POST /api/gate(v2: 에이전트 서명+작업별 승인) 증거는 루틴이 질의했다는 것만 증명. 루틴 프롬프트에 게이트 선행을 넣고 OFF 거부를 실측해야 함 — 소유자 설정 필요" },
    { id: "live", label: "실제 provider 라이브 스모크", state: "blocked", detail: "미실행 — 유료 호출 승인 및 운영 자격증명 필요" },
  ];
  return { items, releaseBlocked: items.some((i) => i.state === "blocked") || items.some((i) => i.state === "missing" && ["database", "admin", "github", "github_write", "callback", "cron"].includes(i.id)) };
}

/** #65: GitHub read-only evidence scope, reported SEPARATELY from `releaseBlocked` (which still covers the
 *  unverified runtime: callbacks, external routine gate, live provider smoke). Ready only when the GitHub probe
 *  is live and an auth token gates the read API. Never implies runtime E2E. */
export interface GitHubEvidenceReadiness { ready: boolean; scope: "github_read_only"; runtimeVerified: false; detail: string }
export function githubEvidenceReadiness(items: ReadyItem[]): GitHubEvidenceReadiness {
  const gh = items.find((i) => i.id === "github"), admin = items.find((i) => i.id === "admin");
  const ready = gh?.state === "ok" && admin?.state === "ok";
  return {
    ready, scope: "github_read_only", runtimeVerified: false,
    detail: ready ? "GitHub 읽기 + 인증 확인 — 증거 대시보드(읽기 전용) 범위만 준비됨. 런타임(세션 콜백/외부 게이트/라이브 스모크)은 미검증이며 releaseBlocked 에 그대로 반영됨"
      : `미준비 — ${gh?.state !== "ok" ? "GitHub 읽기 미확인" : "관리자 토큰 미설정"}`,
  };
}
