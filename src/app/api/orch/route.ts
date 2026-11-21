// Orchestrator engine status + ON/OFF switches for the mobile dashboard.
//   GET  (read)          → runs and switches for every repo in ORCH_REPOS
//   POST (admin + CSRF)  → { repo, key, value } writes one ORCH_* repository variable and wakes the engine
// The engine (GitHub Actions) reads the same variables before every new dispatch, so OFF is enforced
// even when this app is down.
import { NextResponse } from "next/server";
import { authorize } from "@/lib/session/guard";
import { requireRead, NOSTORE } from "../_auth";
import { configuredRepos, switchChange } from "@/lib/orch/model";
import { GitHubError, describeGitHubError, readRepo, readToken, refreshUsageIfStale, writeSwitch, writeToken } from "@/lib/orch/github";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: Request): Promise<Response> {
  const denied = requireRead(req);
  if (denied) return denied;
  const repos = configuredRepos(process.env);
  if (!repos.length || !readToken(process.env)) return NextResponse.json({ mode: "unconfigured" }, { headers: NOSTORE });
  const views = await Promise.all(repos.map(async (r) => {
    const v = await readRepo(r, process.env);
    return v.usage ? { ...v, usageRefresh: await refreshUsageIfStale(r, v.usage, process.env) } : v;
  }));
  return NextResponse.json(
    { mode: "live", generatedAt: new Date().toISOString(), canWrite: Boolean(writeToken(process.env)), repos: views },
    { headers: NOSTORE },
  );
}

export async function POST(req: Request): Promise<Response> {
  const auth = authorize(req.method, req.headers, "admin");
  if (!auth.ok) return NextResponse.json({ error: auth.status === 503 ? "auth_unconfigured" : "unauthorized", reason: auth.reason }, { status: auth.status, headers: NOSTORE });
  const raw = await req.text();
  if (raw.length > 2048) return NextResponse.json({ error: "too_large" }, { status: 413, headers: NOSTORE });
  let b: Record<string, unknown>;
  try { b = JSON.parse(raw); } catch { return NextResponse.json({ error: "bad_request" }, { status: 400, headers: NOSTORE }); }
  const repo = typeof b?.repo === "string" ? b.repo : "";
  if (!configuredRepos(process.env).includes(repo)) return NextResponse.json({ error: "unknown_repo" }, { status: 400, headers: NOSTORE });
  const change = switchChange(b.key, b.value);
  if (!change.ok) return NextResponse.json({ error: change.error }, { status: 400, headers: NOSTORE });
  try {
    const r = await writeSwitch(repo, change.name, change.value, process.env);
    return NextResponse.json({ ok: true, name: change.name, value: change.value, woke: r.woke }, { headers: NOSTORE });
  } catch (e) {
    const cfg = e instanceof GitHubError && e.status === 503;
    return NextResponse.json({ error: cfg ? "write_unconfigured" : "github_error", detail: describeGitHubError(e) }, { status: cfg ? 503 : 502, headers: NOSTORE });
  }
}
