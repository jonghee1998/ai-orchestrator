import test from "node:test";
import assert from "node:assert/strict";
import { validateRoutineConfig, validateRoutineContext, fireRoutine } from "./routine-fire-contract.mjs";
const config = {
  url: "https://api.anthropic.com/v1/claude_code/routines/trig_01ABCDEFGHJKLMNOPQRSTUVW/fire",
  token: "sk-ant-oat01-placeholder-routine-token-not-real"
};
const context = "Issue #201, approved dispatch w-example; verify exact HEAD before start";

test("routine trigger allows ONLY the Anthropic subscription endpoint", () => {
  assert.equal(validateRoutineConfig(config), null);
  for (const url of [
    "https://evil.example/v1/claude_code/routines/trig_01ABCDEFGHJKLMNOPQRSTUVW/fire",
    "http://api.anthropic.com/v1/claude_code/routines/trig_01ABCDEFGHJKLMNOPQRSTUVW/fire",
    "https://api.anthropic.com/v1/messages",
    "https://api.anthropic.com/v1/claude_code/routines/trig_01ABCDEFGHJKLMNOPQRSTUVW/fire?x=1",
    "https://api.anthropic.com@evil.example/v1/claude_code/routines/trig_01ABCDEFGHJKLMNOPQRSTUVW/fire"
  ]) assert.equal(validateRoutineConfig({ ...config, url }), "invalid_url");
  assert.equal(validateRoutineConfig({ ...config, token: "api-key" }), "invalid_routine_token");
});
test("never send empty or oversized context", async () => {
  assert.equal(validateRoutineContext(""), "invalid_context");
  assert.equal(validateRoutineContext("a".repeat(65537)), "invalid_context");
  assert.equal(validateRoutineContext("한".repeat(22000)), "invalid_context");
  let count = 0;
  const request = async () => { count++; throw new Error("must not be called"); };
  assert.equal((await fireRoutine({config, context: "", request})).reason, "invalid_context");
  assert.equal((await fireRoutine({config: {...config, token: ""}, context, request})).reason, "invalid_routine_token");
  assert.equal(count, 0);
});
test("single fire request uses routine bearer token and returns only session creation evidence", async () => {
  let count = 0;
  const request = async (url, init) => {
    count++;
    assert.equal(url, config.url);
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.authorization, "Bearer " + config.token);
    assert.equal(init.headers["anthropic-beta"], "experimental-cc-routine-2026-04-01");
    assert.deepEqual(JSON.parse(init.body), {text:context});
    return {status:200, json:async()=>({
      type:"routine_fire",claude_code_session_id:"session_01HJKLMNOPQRSTUVWXYZ",
      claude_code_session_url:"https://claude.ai/code/session_01HJKLMNOPQRSTUVWXYZ"
    })};
  };
  const result = await fireRoutine({config, context, request});
  assert.equal(count, 1);
  assert.deepEqual(result, {
    ok:true,sessionId:"session_01HJKLMNOPQRSTUVWXYZ",
    sessionUrl:"https://claude.ai/code/session_01HJKLMNOPQRSTUVWXYZ",
    sessionCreated:true,authorizedStartVerified:false
  });
});
test("unknown and usage-limit outcomes do NOT cause retries or overage", async () => {
  let n = 0;
  const network = async () => { n++; throw new Error("timeout"); };
  assert.equal((await fireRoutine({config,context,request:network})).reason, "fire_outcome_unknown_DO_NOT_RETRY");
  assert.equal(n, 1);
  const limit = async () => ({status:429});
  assert.equal((await fireRoutine({config,context,request:limit})).reason, "subscription_limit_NO_OVERAGE");
  const mismatch = async()=>({status:200,json:async()=>({
    type:"routine_fire",claude_code_session_id:"session_01HJKLMNOPQRSTUVWXYZ",
    claude_code_session_url:"https://evil.example/code/session_01HJKLMNOPQRSTUVWXYZ"
  })});
  assert.equal((await fireRoutine({config,context,request:mismatch})).reason,"response_mismatch_DO_NOT_RETRY");
  const unavailable = async()=>({status:503});
  assert.equal((await fireRoutine({config,context,request:unavailable})).reason,"fire_rejected_or_unknown_DO_NOT_RETRY");
});

test("reject mismatched session URL even on trusted Claude host", async () => {
  const request = async () => ({status:200,json:async()=>({
    type:"routine_fire",claude_code_session_id:"session_01HJKLMNOPQRSTUVWXYZ",
    claude_code_session_url:"https://claude.ai/code/session_01OTHERSESSIONXYZ"
  })});
  const result = await fireRoutine({config,context,request});
  assert.equal(result.ok, false);
  assert.equal(result.reason, "response_mismatch_DO_NOT_RETRY");
});
