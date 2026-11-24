// "Apply to every project": write one ON/OFF switch (or the work window) to every registered repo.
// Pure orchestration over an injected writer so the route logic is testable without GitHub.
import { switchChange } from "./model";

/** Saves one repository variable then wakes the engine. Throws = not saved; { woke: false } = saved, wake failed. */
export type SwitchWriter = (repo: string, name: string, value: string) => Promise<{ woke: boolean }>;

export interface SwitchAllRepoResult { repo: string; saved: boolean; woke: boolean; error?: string }
/** Body of POST /api/orch { key, value, scope: "all" } (HTTP 200). ok = every repo saved. */
export interface SwitchAllResult { ok: boolean; results: SwitchAllRepoResult[] }

export type SwitchAllOutcome =
  | { kind: "invalid"; error: string }
  | { kind: "done"; name: string; value: string; result: SwitchAllResult };

/**
 * Validate once (switchChange) — invalid input never calls the writer — then write repo by repo.
 * A failing repo is recorded and the rest continue. No repos → ok false, results [].
 */
export async function applySwitchAll(
  repos: readonly string[],
  key: unknown,
  value: unknown,
  writer: SwitchWriter,
  describe: (e: unknown) => string = () => "저장 실패",
): Promise<SwitchAllOutcome> {
  const change = switchChange(key, value);
  if (!change.ok) return { kind: "invalid", error: change.error };
  const results: SwitchAllRepoResult[] = [];
  for (const repo of repos) {
    try {
      const r = await writer(repo, change.name, change.value);
      results.push({ repo, saved: true, woke: r?.woke === true });
    } catch (e) {
      results.push({ repo, saved: false, woke: false, error: describe(e) });
    }
  }
  return { kind: "done", name: change.name, value: change.value, result: { ok: results.length > 0 && results.every((r) => r.saved), results } };
}
