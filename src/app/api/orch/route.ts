// Orchestrator engine status + ON/OFF switches for the mobile dashboard.
//   GET  (read)          → runs and switches for every repo in ORCH_REPOS
//   POST (admin + CSRF)  → { repo, key, value } writes one ORCH_* repository variable and wakes the engine
//                          { action: "refresh-usage" } runs usage.yml now in every configured repo (2-minute throttle)
//                          { action: "approve", repo, issue, hash } re-checks a pending '[plan]' Issue and adds 'orch:go'
//                          { action: "idea", repo, title, body } creates one '[idea] title' Issue (title 1~80, body ≤4000)
// The engine (GitHub Actions) reads the same variables before every new dispatch, so OFF is enforced
// even when this app is down.
import { NextResponse } from "next/server";
import { authorize } from "@/lib/session/guard";
import { requireRead, NOSTORE } from "../_auth";
import { configuredRepos, switchChange } from "@/lib/orch/model";
import { GitHubError, approvePlan, checkIdea, createIdea, describeGitHubError, readRepo, readToken, refreshUsageIfStale, requestUsageRun, writeSwitch, writeToken } from "@/lib/orch/github";

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
  // An idea body may be 4000 chars (JSON-escaped up to 6 chars each); every other action stays under 2 KB.
  if (raw.length > 32_768) return NextResponse.json({ error: "too_large" }, { status: 413, headers: NOSTORE });
  let b: Record<string, unknown>;
  try { b = JSON.parse(raw); } catch { return NextResponse.json({ error: "bad_request" }, { status: 400, headers: NOSTORE }); }
  if (b?.action !== "idea" && raw.length > 2048) return NextResponse.json({ error: "too_large" }, { status: 413, headers: NOSTORE });
  if (b?.action === "idea") {
    const repo = typeof b.repo === "string" ? b.repo : "";
    if (!configuredRepos(process.env).includes(repo)) return NextResponse.json({ error: "unknown_repo" }, { status: 400, headers: NOSTORE });
    const input = checkIdea(b.title, b.body);
    if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400, headers: NOSTORE });
    if (!writeToken(process.env)) return NextResponse.json({ error: "write_unconfigured" }, { status: 503, headers: NOSTORE });
    try {
      const r = await createIdea(repo, input.title, input.body, process.env);
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400, headers: NOSTORE });
      return NextResponse.json({ ok: true, issue: r.issue, url: r.url }, { headers: NOSTORE });
    } catch (e) {
      const cfg = e instanceof GitHubError && e.status === 503;
      return NextResponse.json({ error: cfg ? "write_unconfigured" : "github_error", detail: describeGitHubError(e) }, { status: cfg ? 503 : 502, headers: NOSTORE });
    }
  }
  if (b?.action === "refresh-usage") {
    const repos = configuredRepos(process.env);
    if (!writeToken(process.env)) return NextResponse.json({ error: "write_unconfigured" }, { status: 503, headers: NOSTORE });
    const results = await Promise.all(repos.map(async (r) => ({ repo: r, result: await requestUsageRun(r, process.env) })));
    return NextResponse.json({ ok: results.some((x) => x.result !== "unavailable"), results }, { headers: NOSTORE });
  }
  if (b?.action === "approve") {
    const repo = typeof b.repo === "string" ? b.repo : "";
    if (!configuredRepos(process.env).includes(repo)) return NextResponse.json({ error: "unknown_repo" }, { status: 400, headers: NOSTORE });
    const issue = b.issue;
    if (typeof issue !== "number" || !Number.isSafeInteger(issue) || issue <= 0) return NextResponse.json({ error: "bad_issue" }, { status: 400, headers: NOSTORE });
    if (typeof b.hash !== "string" || !/^[0-9a-f]{16}$/.test(b.hash)) return NextResponse.json({ error: "bad_hash" }, { status: 400, headers: NOSTORE });
    if (!writeToken(process.env)) return NextResponse.json({ error: "write_unconfigured" }, { status: 503, headers: NOSTORE });
    try {
      const r = await approvePlan(repo, issue, b.hash, process.env);
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 409, headers: NOSTORE });
      return NextResponse.json({ ok: true, issue: r.issue }, { headers: NOSTORE });
    } catch (e) {
      const cfg = e instanceof GitHubError && e.status === 503;
      return NextResponse.json({ error: cfg ? "write_unconfigured" : "github_error", detail: describeGitHubError(e) }, { status: cfg ? 503 : 502, headers: NOSTORE });
    }
  }
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
