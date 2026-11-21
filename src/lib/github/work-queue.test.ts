import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeIssues,
  parseDependencies,
  planDispatch,
  type GitHubIssue,
  type WorkQueueTask,
} from "./work-queue";

function issue(number: number, labels: string[], body: string | null = null): GitHubIssue {
  return { number, title: `Issue ${number}`, body, labels, html_url: `https://github.test/issues/${number}` };
}

test("parses, de-duplicates, and orders explicit dependency references", () => {
  assert.deepEqual(parseDependencies("Depends on: #9, #2 #9\nOther: #1"), ["2", "9"]);
});

test("normalizes issues deterministically and drops pull requests and duplicates", () => {
  const duplicate = issue(2, ["agent:codex", "status:queued"]);
  const pullRequest = { ...issue(3, ["agent:codex", "status:queued"]), pull_request: {} };
  assert.deepEqual(normalizeIssues([duplicate, issue(1, ["agent:claude", "status:done"]), duplicate, pullRequest]).map((task) => task.id), ["1", "2"]);
});

test("fails closed for multiple, missing, and unsupported namespaced labels", () => {
  const tasks = normalizeIssues([
    issue(1, ["agent:codex", "agent:claude", "status:queued"]),
    issue(2, ["agent:pickle", "status:waiting"]),
  ]);
  assert.deepEqual(tasks.map(({ agent, status }) => ({ agent, status })), [
    { agent: "unknown", status: "queued" },
    { agent: "unknown", status: "unknown" },
  ]);
});

test("only queued tasks with known agents and completed dependencies are eligible", () => {
  const tasks = normalizeIssues([
    issue(1, ["agent:opus", "status:done"]),
    issue(2, ["agent:codex", "status:queued"], "Depends on: #1"),
  ]);
  const plans = planDispatch(tasks);
  assert.equal(plans.find((plan) => plan.task.id === "2")?.eligible, true);
  assert.equal(plans.find((plan) => plan.task.id === "1")?.eligible, false);
});

test("cycles, missing dependencies, and unmet dependencies are ineligible", () => {
  const tasks: WorkQueueTask[] = [
    { id: "1", title: "one", agent: "codex", status: "queued", dependsOn: ["2"], url: "" },
    { id: "2", title: "two", agent: "claude", status: "queued", dependsOn: ["1"], url: "" },
    { id: "3", title: "three", agent: "opus", status: "queued", dependsOn: ["4", "99"], url: "" },
    { id: "4", title: "four", agent: "codex", status: "queued", dependsOn: [], url: "" },
  ];
  const plans = planDispatch(tasks);
  assert.ok(plans[0].reasons.includes("dependency_cycle"));
  assert.ok(plans[1].reasons.includes("dependency_cycle"));
  assert.ok(plans[2].reasons.includes("unmet_dependency:4"));
  assert.ok(plans[2].reasons.includes("missing_dependency:99"));
});

test("accepts actual repo labels (ready/in-progress/review) and treats closed issues as done", () => {
  const tasks = normalizeIssues([
    { ...issue(1, ["agent:claude", "status:in-progress"]), state: "closed" },
    issue(2, ["agent:claude", "status:ready"], "Depends on: #1"),
    issue(3, ["agent:codex", "status:review"]),
    issue(4, ["agent:codex", "status:in-progress"]),
  ]);
  assert.deepEqual(tasks.map((t) => t.status), ["done", "ready", "review", "in-progress"]);
  const plans = planDispatch(tasks);
  assert.equal(plans[1].eligible, true);
  assert.equal(plans[2].eligible, false);
});

test("dispatch planning and idempotency hints are deterministic", () => {
  const tasks = normalizeIssues([issue(7, ["agent:codex", "status:queued"])]);
  assert.deepEqual(planDispatch(tasks), planDispatch([...tasks]));
  assert.equal(planDispatch(tasks)[0].idempotencyKey, "github-issue:7:agent:codex");
});

test("agent aliases claude-sonnet/claude-opus map to canonical queue agents; real project ids keep label:/milestone: form (#119)", () => {
  const tasks = normalizeIssues([
    issue(1, ["agent:claude-sonnet", "status:ready", "project:알파 프로젝트"]),
    issue(2, ["agent:claude-opus", "status:ready"]),
    { ...issue(3, ["agent:codex", "status:ready"]), milestone: { number: 7, title: "M7", description: null } } as GitHubIssue,
  ]);
  assert.deepEqual(tasks.map(t => t.agent), ["claude", "opus", "codex"]);
  assert.deepEqual(tasks.map(t => t.project?.id), ["label:알파 프로젝트", undefined, "milestone:7"]);
});
