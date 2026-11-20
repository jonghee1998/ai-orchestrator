import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { preflightRoutineSecrets } from "./routine-secret-preflight.mjs";

const valid = {
  ROUTINE_FIRE_URL:"https://api.anthropic.com/v1/claude_code/routines/trig_01ABCDEFGHJKLMNOPQRSTUVW/fire",
  ROUTINE_FIRE_TOKEN:"sk-ant-oat01-FAKE-SECRET-NEVER-USE-0000000"
};
test("syntactic preflight only accepts two configured values, without making network requests",()=>{
  assert.deepEqual(preflightRoutineSecrets(valid),{ok:true,reason:"syntax_only_UNVERIFIED_auth"});
  assert.equal(preflightRoutineSecrets({}).reason,"ROUTINE_FIRE_URL_missing");
  assert.equal(preflightRoutineSecrets({ROUTINE_FIRE_URL:valid.ROUTINE_FIRE_URL}).reason,"ROUTINE_FIRE_TOKEN_missing");
  assert.equal(preflightRoutineSecrets({...valid,ROUTINE_FIRE_URL:"https://evil.example/fire"}).reason,"ROUTINE_FIRE_SECRETS_invalid_format");
  assert.equal(preflightRoutineSecrets({...valid,ROUTINE_FIRE_TOKEN:"not-a-routine-token"}).reason,"ROUTINE_FIRE_SECRETS_invalid_format");
});
test("CLI prints no token or URL even when invalid, and never contacts the provider",()=>{
  for(const vars of [valid,{...valid,ROUTINE_FIRE_TOKEN:"bad"}]){
    const out=spawnSync(process.execPath,["scripts/pm-bridge/routine-secret-preflight.mjs"],{
      env:{...process.env,...vars},encoding:"utf8",timeout:4000
    });
    assert.equal(out.status,vars.ROUTINE_FIRE_TOKEN==="bad"?1:0);
    const combined=out.stdout+out.stderr;
    assert.equal(combined.includes(vars.ROUTINE_FIRE_TOKEN),false);
    assert.equal(combined.includes(vars.ROUTINE_FIRE_URL),false);
    assert.equal(combined.includes("api.anthropic.com"),false);
  }
});
