#!/usr/bin/env node
// Issue #73 — coordinator entry point for GitHub Actions.
//   node scripts/handoff/main.mjs            -> dry run (default; no writes)
//   node scripts/handoff/main.mjs --apply    -> live writes (workflow only passes this when HANDOFF_COORDINATOR_MODE=live)
// The event payload only selects WHICH PR to re-evaluate; nothing in it is trusted for the decision.
import { readFileSync, appendFileSync } from "node:fs";
import { isTrustedCodex } from "./core.mjs";
import { createClient } from "./github.mjs";
import { run } from "./execute.mjs";
import { runLifecycle, configFromEnv } from "./lifecycle-run.mjs";

export function prFromEvent(name, payload, inputs = {}) {
  if (name === "workflow_dispatch") {
    const n = Number(inputs.pr);
    return Number.isInteger(n) && n > 0 ? { pr: n } : { skip: "invalid_dispatch_input" };
  }
  if (name === "issue_comment") {
    if (!payload.issue?.pull_request) return { skip: "not_a_pull_request" };
    if (!isTrustedCodex(payload.comment?.user)) return { skip: "untrusted_author" };
    return { pr: payload.issue.number };
  }
  if (name === "pull_request_review") {
    if (!isTrustedCodex(payload.review?.user)) return { skip: "untrusted_author" };
    return { pr: payload.pull_request.number };
  }
  return { skip: "unsupported_event" };
}

/** Entry logic, injectable for tests (gh client, env, output). main() only adds real process wiring. */
export async function handle({ name, payload, gh, apply = false, repo, env = {}, out }) {
  const target = prFromEvent(name, payload, payload.inputs ?? {});
  if (target.skip) return out({ mode: apply ? "live" : "dry-run", event: name, result: "skip", reason: target.skip });
  const result = await run(gh, target.pr, { apply, repo, writerLogin: env.HANDOFF_WRITER_LOGIN || undefined, log: out });
  out({ mode: apply ? "live" : "dry-run", event: name, pr: target.pr, ...result });
  // T5 lifecycle planner (Issue #138): dry-run only, read-only GitHub access, never runs in --apply mode.
  if (!apply) {
    const expectedHead = name === "pull_request_review" ? payload.pull_request?.head?.sha : undefined;
    const lifecycle = await runLifecycle(gh, target.pr, { config: configFromEnv(env), expectedHead });
    out({ mode: "dry-run", event: name, pr: target.pr, lifecycle });
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const payload = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const out = (o) => {
    const line = JSON.stringify(o);
    console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, "```json\n" + line + "\n```\n");
  };
  const repo = process.env.GITHUB_REPOSITORY;
  const gh = createClient({ token: process.env.GITHUB_TOKEN, repo });
  await handle({ name: process.env.GITHUB_EVENT_NAME, payload, gh, apply, repo, env: process.env, out });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(`handoff-coordinator: ${e.message}`); process.exit(1); });
}
