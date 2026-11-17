# T6 (#161): event orchestration route diagnosis, Actions evidence, unmet items

Root request #146. Continuation of #156/#158; parent source PR160 exact `9088314f78f04034a4da17c715ad0689c59a199f` (not amended).

## Item 5 — event route (diagnosis and proposal; NOT enabled)
| Path | Observed | Status |
|---|---|---|
| `issues.opened` -> ClaudeRoutine | #162 wake started this run; #161 earlier run stopped before coding on scope ambiguity | works, but depends on the Issue text being unambiguous |
| PR-open -> Codex app review | PR160 got an official code review | works (structured `codex-review-state:v1`) |
| Actions `issue_comment` created/edited | GitHub runs this workflow only from the DEFAULT-branch copy | **blocked**: needs a workflow on `main`; main mutation is forbidden here |
| GPT PM created PR comments | supported, self-report only | works, not authenticated |

Isolated implementation without touching `main` is not possible for the `issue_comment` route. Proposal (needs owner approval + a `main` workflow change, no new secrets):
`on: issue_comment: types: [created, edited]` job restricted by `if: github.event.issue.pull_request && github.event.comment.user.id == 199175422`, running only `scripts/handoff/main.mjs` in dry-run, `permissions: contents: read, pull-requests: read, issues: write`, `concurrency` per PR, no `apply` flag. Required permission: owner merge of that workflow into `main` (or explicit approval to use the default-branch copy).

## Item 7 — Actions runs (authenticated read worked)
PR160 head `9088314f`: `ci` run 44077322821 success; `handoff-coordinator` run 44077323074 success (event pull_request). A successful plan run is not a review verdict and not a GPT PM run; the PM session `d16d70e6-b0e4-8331-a592-9f569bd1fc5b` has `latest_result` null, so no decision can be inferred. Run logs were not fetched (log permission not verified).
PR155 runs were not enumerated in this run.

## Item 6 — security entitlement
Security review is absent for PR160 (`security_review.commit_sha: null`). The planner now reports `security_capability` gates (`security_review_absent|blocked|invalid`) separately from CI/PM reasons and never treats null as PASS.

## Not done / unmet
- No actual A/B/C/D end-to-end receipts; all tests are unit fixtures.
- Root correction markers (`orch-root-correction:v1`) must be written by the PM into the root issue; nothing writes them automatically. Until #146 carries markers for PR153 (n=1) and PR160 (n=2), the counter falls back to chain depth / bot records.
- Mobile live status is a pure model + card; not verified on a device.
- Total PASS is not claimed.
