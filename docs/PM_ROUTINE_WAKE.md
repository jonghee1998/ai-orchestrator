# Claude Routine subscription wake-up — isolated contract (Phase 2B, INERT)

## Goal
Resolve the existing Issue #201 `issues.opened` lifecycle mismatch **without paid Claude Platform/model API**. Official endpoint: https://platform.claude.com/docs/en/api/claude-code/routines-fire

The Claude Code Routine `POST .../v1/claude_code/routines/{trig_id}/fire` uses a per-routine subscription-scoped bearer token. It consumes the existing Claude Code subscription allowance; it does NOT use a normal Anthropic `x-api-key` model request. Extra/overage usage must remain disabled. The owner must create the Routine API trigger and token at https://claude.ai/code/routines; no current connector can do so. Do NOT put token or fire URL in a GitHub issue, PR or CI log.

## What has actually been implemented
- `scripts/pm-bridge/routine-fire-contract.mjs` only: isolated one-shot HTTPS request with fixed official host/path and beta/version headers, bounded context, restricted successful session URL shape, and normalized nonsecret result.
- All error paths fail closed; a timeout, ambiguous server response, or invalid session response **must NOT** be automatically retried because every successful API POST creates a new session and Anthropic offers no idempotency key.
- HTTP 429 reports `subscription_limit_NO_OVERAGE`; does not initiate purchase, credits or upgrade.
- A 200 response only proves session creation, NOT authorized provider START, correct checkout SHA, application claim/lease, quiescence or completed code.
- No GitHub Actions/Next route/worker imports or calls this module. No actual API requests, credentials, controls, deployment or workflow activation have been added.

## Prerequisites BEFORE any live integration
1. Read and reconcile Issue #146/#194/#201 and latest PR #193 head, root ledger n1–n16, approved Phase B scope, PR #196 manuals.
2. Authenticate owner instructions independently (GitHub comments and the `approved` plain object are NOT authorization), dedupe by root and exact assignment, and record an atomic **pre-fire reservation**; otherwise multiple API calls can create multiple Claude sessions.
3. Only after an authorized `/api/collaboration` `assign` and exact dispatch persisted with control ON, call /fire once; prevent parallel workBranch writers and resolve unknown outcomes before any retry.
4. Ensure the cloud Routine's `ORCH_URL` ingress is legitimately authenticated to the still-protected Preview, its `x-orch-session-token` injected by network proxy, and its gate/claim runs against the *same* database and full SHA. A successful /fire does not solve the old Vercel HTTP 302.
5. Owner-approved repository-scoped GitHub Actions secret for fire URL + per-routine token; not installed in untrusted PR branch or automatically activated on default branch.
6. Verify actual session ID/URL, signed/verified claim, checkout SHA, PR, independent Codex code and security reviews, full Step 1→5 E2E; Codex usage quota currently blocked.

## Manual impact / gating
PR #196 WORKFLOW_RULES: event only hint, immutable evidence snapshot, no stale PASS, live SHA after submit; QUALITY_GATES: G0–G8 distinct; APPROVAL_POLICY: new secret, main workflow activation, protection changes/production deployment require owner, default 3 fixes and #146 history unchanged; PROJECT_ADOPTION: rules aren't magically enabled in other repos.

**This code-only PR is not live Claude execution and not project completion.**
