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
    { id: "github", label: "GitHub 쓰기 토큰 (GITHUB_TOKEN, GITHUB_REPO)", state: env.GITHUB_TOKEN && env.GITHUB_REPO ? "ok" : "missing", detail: env.GITHUB_TOKEN && env.GITHUB_REPO ? "설정됨" : "dispatch(라벨 부착)에 필요" },
    { id: "callback", label: "콜백 서명 비밀 (RUN_CALLBACK_SECRET_*)", state: secrets.length ? "ok" : "missing", detail: secrets.length ? `${secrets.length}개 에이전트 설정됨` : "미설정 — agent ACK/heartbeat 수신 불가(상태는 unknown)" },
    { id: "cron", label: "Reconcile 스케줄 (CRON_SECRET + vercel.json)", state: long(env.CRON_SECRET) ? "ok" : "missing", detail: long(env.CRON_SECRET) ? "시크릿 설정됨 (실제 실행은 배포 후 확인 필요)" : "미설정 — GET /api/reconcile 인증 불가" },
    { id: "external", label: "외부 GitHub 트리거/루틴 게이트", state: "blocked", detail: "코드로 제어·검증 불가. 라벨(agent:*+status:ready) 기반 외부 루틴은 OFF를 우회함 — 소유자가 비활성화하거나 게이트 확인을 구성해야 함" },
    { id: "live", label: "실제 provider 라이브 스모크", state: "blocked", detail: "미실행 — 유료 호출 승인 및 운영 자격증명 필요" },
  ];
  return { items, releaseBlocked: items.some((i) => i.state === "blocked") || items.some((i) => i.state === "missing" && ["database", "admin", "github", "callback", "cron"].includes(i.id)) };
}
