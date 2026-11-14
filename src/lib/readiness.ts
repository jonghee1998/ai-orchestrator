// Release-readiness report from server env. Pure; reports presence/validity only — NEVER values.
export type ReadyState = "ok" | "missing" | "blocked";
export interface ReadyItem { id: string; label: string; state: ReadyState; detail: string }
type Env = Readonly<Record<string, string | undefined>>;

const long = (v: string | undefined) => !!v && v.length >= 16;

export function computeReadiness(env: Env): { items: ReadyItem[]; releaseBlocked: boolean } {
  const secrets = Object.keys(env).filter((k) => k.startsWith("RUN_CALLBACK_SECRET_") && env[k]);
  const items: ReadyItem[] = [
    { id: "database", label: "Postgres (DATABASE_URL)", state: env.DATABASE_URL ? "ok" : "missing", detail: env.DATABASE_URL ? "설정됨 (연결/마이그레이션은 scripts/migrate.mjs로 별도 확인)" : "미설정 — 서버리스에서는 파일 저장소 사용 불가" },
    { id: "admin", label: "관리자 토큰 (CONTROL_ADMIN_TOKEN)", state: long(env.CONTROL_ADMIN_TOKEN) ? "ok" : "missing", detail: long(env.CONTROL_ADMIN_TOKEN) ? "설정됨" : "16자 이상 필요" },
    { id: "read", label: "읽기 토큰 (CONTROL_READ_TOKEN)", state: long(env.CONTROL_READ_TOKEN) ? "ok" : "missing", detail: long(env.CONTROL_READ_TOKEN) ? "설정됨" : "선택 — 없으면 관리자 토큰으로 읽기" },
    { id: "github", label: "GitHub 큐 읽기 (GITHUB_REPO + GITHUB_READ_TOKEN 권장, 대체: GITHUB_TOKEN)", state: (env.GITHUB_READ_TOKEN || env.GITHUB_TOKEN) && env.GITHUB_REPO ? "ok" : "missing", detail: (env.GITHUB_READ_TOKEN || env.GITHUB_TOKEN) && env.GITHUB_REPO ? "설정됨 (live 여부는 /api/readiness 프로브로 확인)" : "미설정 — 작업 큐는 live가 아닌 unconfigured로 표시됨" },
    { id: "github_write", label: "GitHub 쓰기 토큰 (GITHUB_TOKEN) — dispatch 전용", state: env.GITHUB_TOKEN && env.GITHUB_REPO ? "ok" : "missing", detail: env.GITHUB_TOKEN && env.GITHUB_REPO ? "설정됨 (라벨 부착 가능 — 승인 전 사용 금지)" : "dispatch(라벨 부착)에 필요. 미설정이면 dispatch는 503 fail-closed" },
    { id: "callback", label: "콜백 서명 비밀 (RUN_CALLBACK_SECRET_*)", state: secrets.length ? "ok" : "missing", detail: secrets.length ? `${secrets.length}개 에이전트 설정됨` : "미설정 — agent ACK/heartbeat 수신 불가(상태는 unknown)" },
    { id: "cron", label: "Reconcile 스케줄 (CRON_SECRET + vercel.json)", state: long(env.CRON_SECRET) ? "ok" : "missing", detail: long(env.CRON_SECRET) ? "시크릿 설정됨 (실제 실행은 배포 후 확인 필요)" : "미설정 — GET /api/reconcile 인증 불가" },
    { id: "external", label: "외부 GitHub 트리거/루틴 게이트", state: "blocked", detail: "코드로 제어·검증 불가(POST/GET /api/gate 서명 게이트 확인 증거가 있어도 루틴이 호출했다는 것만 증명). 라벨(agent:*+status:ready) 기반 외부 루틴은 OFF를 우회함 — 소유자가 비활성화하거나 게이트 확인을 구성해야 함" },
    { id: "live", label: "실제 provider 라이브 스모크", state: "blocked", detail: "미실행 — 유료 호출 승인 및 운영 자격증명 필요" },
  ];
  return { items, releaseBlocked: items.some((i) => i.state === "blocked") || items.some((i) => i.state === "missing" && ["database", "admin", "github", "github_write", "callback", "cron"].includes(i.id)) };
}
