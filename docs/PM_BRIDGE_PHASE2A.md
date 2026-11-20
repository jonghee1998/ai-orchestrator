# Phase 2A transport contract — NOT LIVE

**Parent:** Phase 1 PR #202 exact HEAD `1b461f8b45850f4dd15810f080fb6a835921b864`. This is a stacked code review against the Phase 1 branch. No default-branch merge, Vercel API call or model invocation.

## What this adds
- An inert `submitAssignment()` function with exact HTTPS/preview-host allowlist, admin-token presence check, and exact issue/PR/branch/SHA scope validation.
- A single `POST /api/collaboration` request when explicitly invoked from future trusted code, no retries on ambiguous failures, and a strict workflow-response check.
- Test cases for invalid URLs, absent secrets, wrong task, forged event-as-approval, timeout and mismatch. Included in existing CI.
- The response always reports `agentStarted:false`; accepted workflow is NOT proof of provider START.

## Crucial limitation
The `approved` object is **NOT cryptographic evidence or a genuine PM authorization**. It is an intentionally inert contract fixture, and must NEVER be populated from an Issue comment, JSON marker, GitHub Actions input, or untrusted workflow payload. No workflow calls this transport function. Before integrating, an independently authenticated authorization record with scope and audit provenance is required. A Vercel bypass token is NOT a permanent credential.

## Live-phase prerequisites (not implemented, not approved)
1. Define and independently verify trusted PM/user approval scope, repo/root/correction budget, expiry and evidence fingerprint before loading the contract.
2. Provide owner-approved **Actions Secrets** only to protected, default-branch workflow code with least privilege, never to untrusted PR checkouts; verify correct Vercel Preview environment / DB / GitHub write token.
3. Add durable atomic dedupe in the existing collaboration store for the *same approved instruction*, including transport timeout reconciliation; ensure `/api/collaboration` enforces `assign` constraints and control toggles.
4. Build actual provider wake-up **after** successful authorized submit; `issues.opened` cannot be assumed to re-fire for existing issues. Verify actual Claude Sonnet START and exact checkout SHA.
5. Codex latest-SHA independent review and required security review; fail→revise with root #146 n1–n16 preserved, default three corrections for other roots, single writer and quiescence fencing.
6. Owner must approve any new secrets/permissions, default-branch workflow activation, main merge or deployment.

## Manual/requirement impact
PR #196 WORKFLOW_RULES: event hints never authority; immutable evidence snapshots and changed SHA invalidate prior approval. QUALITY_GATES: CI, code/security review and E2E separate. APPROVAL_POLICY: no permission escalation by default. PROJECT_ADOPTION: no automatic rollout to other repos. Existing `handoff-coordinator` and #194 structure work untouched.

**Acceptance for Phase 2A only:** tests plus independent Codex review on current SHA. This does not constitute completion of GPT PM→Claude automatic execution.
