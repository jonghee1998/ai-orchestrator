import assert from "node:assert/strict";
import test from "node:test";
import { defaultIdeaRepo, filterIdeas, ideaFilterChips, type Idea } from "./model";

const mk = (repo: string, number: number, createdAt: string | null): Idea => ({ repo, number, url: "u", title: `t${number}`, mine: "", createdAt, closed: false, status: "collecting", review: null });
const repos = [
  { repo: "o/alpha", ideas: [mk("o/alpha", 1, "2026-11-01T00:00:00Z"), mk("o/alpha", 2, "2026-11-03T00:00:00Z")] },
  { repo: "o/beta", ideas: [mk("o/beta", 3, "2026-11-02T00:00:00Z")] },
  { repo: "o/empty", ideas: [] },
];

test("ideaFilterChips: 전체 + per-repo counts", () => {
  assert.deepEqual(ideaFilterChips(repos), [{ repo: null, count: 3 }, { repo: "o/alpha", count: 2 }, { repo: "o/beta", count: 1 }, { repo: "o/empty", count: 0 }]);
});

test("filterIdeas: 전체 = all newest first, repo = only that repo, unknown = none", () => {
  assert.deepEqual(filterIdeas(repos, null).map((i) => i.number), [2, 3, 1]);
  assert.deepEqual(filterIdeas(repos, "o/alpha").map((i) => i.number), [2, 1]);
  assert.deepEqual(filterIdeas(repos, "o/beta").map((i) => i.number), [3]);
  assert.deepEqual(filterIdeas(repos, "o/none"), []);
  assert.equal(repos[0].ideas[0].number, 1); // input not mutated
});

test("defaultIdeaRepo: filter if valid, else first repo", () => {
  assert.equal(defaultIdeaRepo(repos, "o/beta"), "o/beta");
  assert.equal(defaultIdeaRepo(repos, null), "o/alpha");
  assert.equal(defaultIdeaRepo(repos, "o/gone"), "o/alpha");
  assert.equal(defaultIdeaRepo([], null), "");
});

// scripts/screens/fixtures.mjs 의 아이디어 Issue 2개가 실제 파서에서 의도한 상태로 읽히는지 (화면 테스트 기대 문구의 근거).
test("screens fixtures: idea Issues parse as done + collecting", async () => {
  const { pathToFileURL } = await import("node:url");
  const path = await import("node:path");
  const { readRepo } = await import("./github");
  type Hit = { status: number; body: unknown } | null;
  type Fx = { githubFixtures: (n: Date) => (m: string, u: URL) => Hit; REPO: string };
  const mod = await (new Function("p", "return import(p)") as (p: string) => Promise<Fx>)(pathToFileURL(path.resolve("scripts/screens/fixtures.mjs")).href);
  const gh = mod.githubFixtures(new Date());
  const f = (async (url: string, init?: RequestInit) => {
    const hit = gh(init?.method ?? "GET", new URL(url));
    return new Response(JSON.stringify(hit?.body ?? { message: "Not Found" }), { status: hit ? hit.status : 404 });
  }) as typeof fetch;
  const view = await readRepo(mod.REPO, { ORCH_GITHUB_TOKEN: "fixture-token" }, f);
  assert.equal(view.ideasError, null);
  const byNo = Object.fromEntries(view.ideas.map((i) => [i.number, i]));
  assert.equal(view.ideas.length, 2);
  assert.equal(byNo[21].status, "done");
  assert.equal(byNo[21].review?.summary, "묻고 답하는 흐름을 먼저 붙이면 효과가 큽니다");
  assert.equal(byNo[22].status, "collecting");
});
