# GPT PM → GitHub Actions bridge — Phase 1 (dry-run only)

## Goal, boundary, and source
GPT PM commands should eventually be verifiably delivered to the existing authenticated Vercel collaboration API. This first slice is a read-only verifier and **does not dispatch anything**. Based on main f1f615d7e3d4ba044d2dd9e3d621f62dedd6b3a3; separate from root #146 Phase B/#201, whose correction history n1–n16 remains unchanged.

## Input
A new comment on an open GitHub issue, from the verified repository owner (GitHub login, numeric user ID and User type), containing exactly one JSON marker:

    <!-- gpt-pm-bridge:v1 {"agent":"claude-sonnet","issueNumber":201,"sourceBranch":"claude/determined-carson-s55tbd","sourcePr":193,"sourceSha":"88bd2c4c791fda4afaa7ab0b4ce9b25b96be464e","workBranch":"claude/phase-b-oracle-201"} -->

This is an example only: **do not post it to authorize an execution**. Phase 1 cannot authorize execution and future live controls must not replay old comments.

Event data is a wake-up hint only. The runner independently fetches comment, issue, PR and branch and checks exact ownership, unchanged comment, open issue, same-repository source PR, exact current PR and branch HEAD SHA. Any mismatch or lookup failure blocks. The workflow is dry-run and has read-only GitHub permissions. No credentials beyond the ephemeral read-only GitHub Actions token, no Vercel API call, no external writes, no Claude run.

## Existing code and manual consistency
- Reuse src/lib/runs/collaboration-http.ts action=assign, src/lib/runs/service.ts authorizeSubmission, and src/lib/runs/external-gate.ts, in a later, separately approved Phase 2.
- The existing handoff-coordinator manages Codex review handoffs; this new component does not overwrite its responsibilities.
- PR #196 WORKFLOW_RULES: event only hint; live HEAD and evidence checks required.
- PR #196 QUALITY_GATES: CI pass is neither code/security review nor live E2E.
- PR #196 APPROVAL_POLICY: root #146 n1–n16 and other-root default 3 corrections retained; no main merge, secrets, activation, paid API, or deployment without approval.

## Phase 2 requirements / remaining blockers
1. Cryptographic or otherwise independently authenticated authorization by PM, root-specific approval scope and correction budget (verified GitHub account alone must NEVER grant administrator execution).
2. A separately approved GitHub Actions Secret and narrowly scoped HTTPS ingress into Vercel; maintain Vercel protection. No reuse of temporary project-wide bypass key as a permanent credential.
3. Prevent duplicate events, changed SHAs, stale reviews, concurrent writers and stale start/finish evidence, with durable server-side transaction protection.
4. Ensure the Vercel admin API authenticates the assignment; Sonnet enabled for the single authorized run only; then wake the external Claude Routine AFTER approval (the existing routine watches issues.opened, not label changes).
5. Explicitly test OFF/no-record denials, valid gate/claim/lease/finish, real provider START and exact checkout SHA, independent Codex review, security and the full fail→revise→owner approval E2E.

## Deployment
The GitHub issue_comment workflow must be on the default branch before it can execute; presence only on this PR branch is not live evidence. Main merge is a separate owner decision. Unit tests and CI are distinct from independent review.
