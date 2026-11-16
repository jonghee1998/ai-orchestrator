# Claude Routine trigger probe (Issue #130)

Goal: exercise the Routine `issues.opened` trigger once, with no main mutation.

## Trigger semantics
- The Routine fires from a GitHub **webhook** (`issues.opened`, repo-level). It is independent of any workflow
  registration; it only needs an issue to be opened with labels `agent:claude` + `status:ready`.
- A `push` workflow runs from the workflow file **at the pushed commit**, so a branch push can run
  `claude-routine-probe.yml` without it existing on the default branch. (`workflow_dispatch`, `schedule`,
  `issue_comment` need the default branch — not used here.)
- Issues created with `GITHUB_TOKEN` do fire `issues.opened` webhooks to external receivers (the
  "no recursive workflows" rule only suppresses *Actions* workflow runs). **Unverified until the real run** — PM should
  treat this as the main thing the probe confirms; if the Routine does not fire, the fallback is a user-created issue.

## Inertness guards (implementation PR cannot run it)
1. `on.push.branches` = `probe/claude-routine-t4` only; `paths` = the activation file only.
2. Job `if`: repo, exact ref, actor `jonghee1998`.
3. Script refuses to write unless `.github/probe/claude-routine-t4.activate` contains
   `ACTIVATE claude-routine-probe t4-v1`; otherwise dry-run (no API calls).
4. Dedupe via body marker search (open or closed) + `concurrency`.
5. Permissions: `issues: write`, `contents: read`; no secrets, no paid API.

## Dry-run / test
`node --test scripts/probe/routine-probe.test.mjs` (no network). Local: `PROBE_DRY_RUN=true node scripts/probe/routine-probe.mjs`.

## Activation (PM/owner only)
```
git fetch origin <merged integration or this PR head>
git switch -c probe/claude-routine-t4 <sha containing workflow + script>
mkdir -p .github/probe
echo "ACTIVATE claude-routine-probe t4-v1" > .github/probe/claude-routine-t4.activate
git add .github/probe && git commit -m "activate T4 probe" && git push origin probe/claude-routine-t4
```
Expect one new issue "[Sonnet] T4 probe …" with `agent:claude`, `status:ready`. Re-pushing creates no second issue (dedupe).

## Cleanup
`git push origin --delete probe/claude-routine-t4`; close the probe issue; optionally remove the workflow + `scripts/probe` in a later PR.

## If impossible (main-only alternative)
A workflow with only `workflow_dispatch`/`issue_comment` would have to be merged to `main`. Merging to `main`
triggers Vercel **production auto-deploy** (even for workflow-only changes unless an ignored-build-step is set), so prefer the branch path.
