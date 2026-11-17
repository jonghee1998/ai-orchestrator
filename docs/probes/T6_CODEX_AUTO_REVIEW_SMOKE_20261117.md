# T6 Codex automatic review smoke (2026-11-17)

This documentation-only, non-executable fixture tests whether GitHub PR creation automatically triggers Codex code review **without** an `@codex review` comment or manual run.

- Base: `codex/issue-92-mobile-v2`
- Expected base SHA before test: `072d899c705ed9c6b16b7c5b307e3fe60254b428`
- Expected result: a Codex-bot review linked to the PR and exact HEAD, or a clear record of no automatic review trigger
- Forbidden: deployment, main merge, live coordinator, Claude execution, API charges, or modifying runtime workflows

This file makes no behavioral changes. Its existence alone does **not** prove automatic review is configured.
