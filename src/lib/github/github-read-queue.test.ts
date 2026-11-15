import assert from "node:assert/strict";
import test from "node:test";
import {
  GitHubQueueConfigurationError,
  GitHubQueueReadError,
  readGitHubWorkQueue,
} from "./github-read-queue";
import type { GitHubIssue } from "./work-queue";

function issue(number: number): GitHubIssue {
  return { number, title: `Issue ${number}`, body: null, labels: ["agent:codex", "status:queued"], html_url: `https://github.test/issues/${number}` };
}

test("requires both configured environment variables without making a request", async () => {
  let called = false;
  const request = async () => { called = true; return new Response("[]"); };
  await assert.rejects(readGitHubWorkQueue({}, request as typeof fetch), GitHubQueueConfigurationError);
  assert.equal(called, false);
});

test("paginates without caching and sanitizes request failures", async () => {
  const pages: number[] = [];
  const request = async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    pages.push(Number(url.searchParams.get("page")));
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.headers && (init.headers as Record<string, string>).Authorization, "Bearer top-secret");
    return Response.json(pages.length === 1 ? Array.from({ length: 100 }, (_, index) => issue(index + 1)) : [issue(101)]);
  };
  const tasks = await readGitHubWorkQueue(
    { GITHUB_TOKEN: "top-secret", GITHUB_REPO: "owner/repo" },
    request as typeof fetch,
  );
  assert.deepEqual(pages, [1, 2]);
  assert.equal(tasks.length, 101);

  const failure = readGitHubWorkQueue(
    { GITHUB_TOKEN: "top-secret", GITHUB_REPO: "owner/repo" },
    async () => new Response("top-secret", { status: 401 }),
  );
  await assert.rejects(failure, (error: unknown) => {
    assert.ok(error instanceof GitHubQueueReadError);
    assert.equal(String(error).includes("top-secret"), false);
    return true;
  });
});
