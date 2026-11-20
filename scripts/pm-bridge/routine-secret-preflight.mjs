// Non-network, inert syntax-only verification of the two Actions Secrets.
// NEVER run untrusted PR code with real repository secrets. Run this CLI only
// inside a separately approved/trusted default-branch workflow.
import { pathToFileURL } from "node:url";
import { validateRoutineConfig } from "./routine-fire-contract.mjs";

export function preflightRoutineSecrets(env) {
  // Never echo, stringify, log or serialize either credential.
  if (typeof env?.ROUTINE_FIRE_URL !== "string" || !env.ROUTINE_FIRE_URL)
    return { ok: false, reason: "ROUTINE_FIRE_URL_missing" };
  if (typeof env?.ROUTINE_FIRE_TOKEN !== "string" || !env.ROUTINE_FIRE_TOKEN)
    return { ok: false, reason: "ROUTINE_FIRE_TOKEN_missing" };
  const error = validateRoutineConfig({url:env.ROUTINE_FIRE_URL,token:env.ROUTINE_FIRE_TOKEN});
  if (error) return { ok: false, reason: "ROUTINE_FIRE_SECRETS_invalid_format" };
  // A syntactically correct token is NOT proof that it exists/is accepted.
  // In particular, do NOT call POST /fire to 'test' it: that creates a session.
  return { ok: true, reason: "syntax_only_UNVERIFIED_auth" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result=preflightRoutineSecrets(process.env);
  // Stable output only. Never show the secret URL or token, even on failure.
  process.stdout.write(result.ok?"Routine secrets format OK (NOT authenticated).\n":
    "Routine secret preflight blocked: "+result.reason+"\n");
  process.exitCode=result.ok?0:1;
}
