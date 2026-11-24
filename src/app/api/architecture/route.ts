// Other projects' structure documents for the 구조 tab.
//   GET (read) → { repos: [{ repo, architecture | null, error | null }] } for every repo in ORCH_REPOS except the
//                dashboard's own (ORCH_SELF_REPO or SELF_REPO; its content is built into the screen, so no file is read).
// architecture null + error null = the repo has no docs/architecture.json. One repo failing never hides the others.
import { NextResponse } from "next/server";
import { requireRead, NOSTORE } from "../_auth";
import { configuredRepos, isSelfRepo, type Architecture } from "@/lib/orch/model";
import { ArchitectureFormatError, describeGitHubError, readArchitecture, readToken } from "@/lib/orch/github";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export interface ArchitectureResult { repo: string; architecture: Architecture | null; error: string | null }

export async function GET(req: Request): Promise<Response> {
  const denied = requireRead(req);
  if (denied) return denied;
  const repos = configuredRepos(process.env).filter((r) => !isSelfRepo(r, process.env));
  const hasToken = Boolean(readToken(process.env));
  const results: ArchitectureResult[] = await Promise.all(repos.map(async (repo) => {
    if (!hasToken) return { repo, architecture: null, error: "읽기 토큰 없음" };
    try {
      return { repo, architecture: await readArchitecture(repo, process.env), error: null };
    } catch (e) {
      return { repo, architecture: null, error: e instanceof ArchitectureFormatError ? e.message : describeGitHubError(e) };
    }
  }));
  return NextResponse.json({ repos: results }, { headers: NOSTORE });
}
