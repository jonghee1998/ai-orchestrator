# Handoff coordinator (Issue #73)

The repository owns its Codex review handoffs. A GitHub Actions workflow turns a Codex review result
into exactly one mechanical step. It does not depend on GPT notification or write permissions.
GPT stays PM: it decides, approves, notifies and handles deploys. The coordinator writes **only**
these two records:

| Codex result on the **current PR head SHA** | Coordinator write (live mode only) |
|---|---|
| `has_unresolved_findings: true` | One fresh revision Issue, labelled `agent:<agent of the linked issue>` + `status:ready` |
| `has_unresolved_findings: false` | One PR comment saying `release-ready-for-validation` (this is **not** approval, merge or deploy) |

Status: **dry-run by default. Live events not yet observed** (see "Verified / not verified").

## Design

- **The event only wakes the coordinator.** The `issue_comment` (created/edited), `pull_request_review`
  (submitted) or `workflow_dispatch` event only picks which PR to re-check. The coordinator then reads
  the PR and its comments live from GitHub and makes its decision from that state alone.
- **Signal.** Only the connector's machine-readable marker counts:
  `<!-- codex-review-state:v1 {"code_review":{"commit_sha":…,"status":"completed","has_unresolved_findings":…}} -->`.
  This is the shape seen on PR #72 (comment 6890098358). The coordinator reads only those JSON
  fields, and any other shape fails closed (no action). Comment prose is never read as instructions.
- **Trusted identity.** The author must match `login == chatgpt-codex-connector[bot]` **and**
  `id == 199175422` **and** `type == Bot`. A marker copied into a comment from any other account is
  ignored.
- **Exact SHA.** `commit_sha` must equal the live `pr.head.sha`. The head is read again right before
  every write. If it moved, the run does nothing (`head_moved_before_write`).
- **Durable claim and dedupe.** The dedupe key is `pr<N>:<sha>:codex:{revise|release-ready}`. It is
  stored in a hidden marker that only the writer identity (`github-actions[bot]`) can claim:
  - revise: a claim comment (`state=claimed`), then an Issue with the marker in its body, then the
    claim is edited to `state=done issue=N`. If a run crashes at any step, a rerun finds the
    existing claim or Issue and does not create a duplicate.
  - release-ready: one comment (`state=done`) is both the claim and the record.
  - A forged claim comment from another account does not suppress the handoff.
- **No duplicate writers.**
  - Within the coordinator: `concurrency: handoff-<PR>` with `cancel-in-progress: false`. A queued run
    reads live state again, so nothing is lost if GitHub replaces it.
  - Against the GPT writer: if a GPT PM revise marker already exists for the same PR and exact SHA,
    the coordinator defers (`gpt_writer_already_handled`). Since Issue #75 this guard is hardened:
    - **Trusted author only.** The marker must be written by the PM writer identity
      (`login == jonghee1998` **and** `id == 129052128` **and** `type == User`). A marker posted by any
      other account is ignored, so it cannot suppress a revision.
    - **Complete structure only.** Accepted forms, every field anchored (full 40-char SHA, round ≥ 1):
      `<!-- gpt-pm-followup:pr<N>:<sha>[:<agent>]:revise:<round> -->`,
      `<!-- gpt-pm-event-state:v1 pr<N>:<sha>[:<agent>]:revise:<round> -->`, and, in an issue body
      only, `Dedupe pr<N>:<sha>:<agent>:revise:<round>` (the separate revision-issue form, e.g. #75).
    - **Issue side included.** Besides PR comments, the guard reads all repository issue comments and
      issue bodies created or updated since the PR was created. This covers the linked issue and
      separate revision issues. The scan runs only when the plan is `revise`, is paginated, and fails
      closed at its bound (2000 comments / 1000 issues): the run errors and writes nothing.
- **Bounded retry.** GET/PATCH requests retry up to 3 times with backoff on network errors, 429 and
  5xx. POST requests are never retried in-process; the claim resolves an ambiguous failure on the
  next run. Comment pagination is capped at 1000 comments and fails closed. The crash-recovery
  lookup for a pending claim (Issue #75) scans issues updated since the claim's `created_at` (the
  revision Issue is always created after its claim), paginates, and fails closed at 1000 issues
  instead of creating a possible duplicate. Each job has a 5-minute
  timeout. The coordinator does no polling.
- **Least privilege.**
  - The workflow default is `permissions: {}`.
  - The `plan` job has read-only permissions.
  - The `apply` job (`issues: write`) runs only when `vars.HANDOFF_COORDINATOR_MODE == 'live'`, and
    never for `pull_request_review`, because that event runs the workflow from the PR branch.
    Live writes therefore always run default-branch code.
  - No new secret is used, only `GITHUB_TOKEN`. There is no paid API, no checkout credential
    persistence, and only a sparse checkout of `scripts/handoff`.
- **Ambiguity → no action.** The coordinator does nothing in these cases:
  - zero linked issues, or several (`Refs/Closes/Fixes #N` in the PR body)
  - a missing or unknown `agent:` label
  - a closed PR
  - a review that has not completed

  The `plan` job summary shows the reason. These cases are left to the PM.

Files:
- `scripts/handoff/core.mjs` (pure decision logic)
- `scripts/handoff/execute.mjs` (idempotent writes)
- `scripts/handoff/github.mjs` (REST client)
- `scripts/handoff/main.mjs` (entry point)
- `scripts/handoff/coordinator.test.mjs`
- `.github/workflows/handoff-coordinator.yml`
- `.github/workflows/ci.yml`

## Verified / not verified

- Verified in this session:
  - `npm run typecheck` exit 0
  - `npm test` 209 tests (after Issue #75): 207 pass, 0 fail, 2 skipped (the existing Postgres integration tests,
    which need `TEST_DATABASE_URL`), exit 0
  - `npm run build` exit 0
  - Both workflow YAML files parse.
  - The coordinator tests cover:
    - duplicate, stale, forged-marker and forged-claim events
    - prose injection
    - a crash before the Issue is created, and a crash before the claim is finalized
    - the head moving before a write
    - bounded retry and the pagination bound
    - dry run writing nothing
    - deferring to the GPT writer (trusted PM author, complete marker, issue-side and separate revision issues — #75)
    - recovery lookup pagination past 100 issues and fail-closed bounds (#75)
- **Not verified (no live observation yet):**
  1. The workflow actually running on real Codex events. `issue_comment` and `workflow_dispatch`
     workflows only run once the file is on the **default branch** (`main`). Before merge, only
     `pull_request_review` from Codex on a PR whose branch contains this file can run the `plan`
     (dry-run) job.
  2. **Whether an Issue created with `GITHUB_TOKEN` (author `github-actions[bot]`) starts the
     external Claude "issue opened" routine. This was not assumed.** GitHub prevents
     `GITHUB_TOKEN` events from starting *other Actions workflows*. Whether the Claude GitHub App
     webhook or routine filter accepts such an Issue has not been observed. If it does not, live
     mode would create correctly labelled Issues that nobody picks up. See the proof step below.
  3. The connector editing its summary comment on completion, and so emitting an
     `issue_comment.edited` event. This was inferred from `updated_at` > `created_at` on PR #72 and
     has not been observed as an Actions run.

## Single-owner cutover (owner actions)

1. **Dry-run (default).** Merge to `main` only with explicit owner approval, as part of the normal
   release. Leave `HANDOFF_COORDINATOR_MODE` unset. GPT stays the only writer. For each Codex
   result, compare the `plan` job summary with what GPT did.
2. **Live proof of the routine trigger** (one time, owner):
   - Settings → Variables → set `HANDOFF_COORDINATOR_MODE=live`.
   - Run `workflow_dispatch` for a throwaway open PR that has a completed Codex findings state, or
     wait for the next real one.
   - Confirm that the external routine ACKs the Issue created by `github-actions[bot]`.
   - If it does not ACK, unset the variable again. The fallback is to add the routine trigger for
     `github-actions[bot]` authors on the routine side, or to use a GitHub App token. That would be
     a new secret, so only do it with explicit approval.
3. **Cutover.** With the variable still `live`, turn off the GPT automation that writes revision
   Issues and release-ready notes for Codex results. GPT keeps reading the coordinator records and
   still makes PM decisions. Both must not be writers at the same time; the GPT-marker guard only
   protects the transition.
4. **Rollback.** Unset `HANDOFF_COORDINATOR_MODE`, which immediately returns the coordinator to
   dry-run, and turn the GPT writer back on.

## T5 lifecycle planner (Issue #136) — dry-run only

`scripts/handoff/lifecycle.mjs` is a pure planner (no GitHub client, no writes; every plan carries
`mode: "dry-run"`, `live: false`). It does not dispatch, merge, label or enable live mode.

- Idempotency key `orch:v1:req<N>:pr<P>:<step>:r<n>`; `replay()` shows 3 evaluations collapse to one plan digest.
- Single mechanical writer: only records from `github-actions[bot]` count as claim/issue/done.
- Ambiguous POST: `recoverAmbiguousPost` adopts exactly one match from a complete scan; incomplete, duplicate
  or zero matches fail closed (no auto retry).
- Live head/base must equal expected SHAs; base must be the integration target (`main` etc. rejected);
  replacement PRs must target the integration branch directly (no stacks) with proven ancestry.
- Independent review = trusted reviewer, not the PR author, exact SHA, completed, no unresolved findings.
- PM acceptance marker `<!-- pm-accept:<key> sha=<sha> -->` bound to exact SHA. Posted from the owner account
  it is a **self-report**, never authenticated authority; completion stays `withheld` (T6 adds the real gate).
- Completion also requires green integration CI and a successful `dev` deployment on the exact SHA.
- Round cap `MAX_ROUNDS = 3`; completion/blocked events dedupe by key.
