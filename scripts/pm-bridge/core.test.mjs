import test from "node:test";
import assert from "node:assert/strict";
import { eventCandidate,parseInstruction,verifySnapshot,REPO,PM_USER } from "./core.mjs";
const a={agent:"claude-sonnet",issueNumber:201,sourceBranch:"claude/determined-carson-s55tbd",sourcePr:193,
sourceSha:"88bd2c4c791fda4afaa7ab0b4ce9b25b96be464e",workBranch:"claude/phase-b-oracle-201"};
const marker=x=>"<!-- gpt-pm-bridge:v1 "+JSON.stringify(x)+" -->";
const event=()=>({action:"created",repository:{full_name:REPO},sender:{...PM_USER},comment:{id:123,user:{...PM_USER},body:marker(a)},issue:{number:201,state:"open"}});
const evidence=()=>({comment:{id:123,user:{...PM_USER},body:marker(a),
issue_url:"https://api.github.com/repos/"+REPO+"/issues/201"},issue:{number:201,state:"open"},
pr:{number:193,state:"open",head:{repo:{full_name:REPO},ref:a.sourceBranch,sha:a.sourceSha},
base:{repo:{full_name:REPO},ref:"codex/issue-92-mobile-v2"}},branch:{name:a.sourceBranch,commit:{sha:a.sourceSha}}});
test("owner event with independent live evidence is only a dry run",()=>{
const v=verifySnapshot(eventCandidate(event()),evidence());
assert.equal(v.ok,true);assert.equal(v.plan.readyForSubmission,false);assert.equal(v.plan.mode,"dry_run");
});
test("forged sender or author rejected",()=>{
const e=event();e.sender.id=2;assert.equal(eventCandidate(e).ok,false);
const f=event();f.comment.user.id=2;assert.equal(eventCandidate(f).ok,false);
});
test("PR comment, edited event and different issue rejected",()=>{
let e=event();e.issue.pull_request={url:"x"};assert.equal(eventCandidate(e).ok,false);
e=event();e.action="edited";assert.equal(eventCandidate(e).ok,false);
e=event();e.issue.number=202;assert.equal(eventCandidate(e).ok,false);
});
test("prose, extra attributes, weak SHA, unsafe branch and Opus rejected",()=>{
assert.equal(parseInstruction("run now"),null);
assert.equal(parseInstruction(marker({...a,scope:"prod"})),null);
assert.equal(parseInstruction(marker({...a,sourceSha:"abc"})),null);
assert.equal(parseInstruction(marker({...a,workBranch:"main"})),null);
assert.equal(parseInstruction(marker({...a,workBranch:"../main"})),null);
assert.equal(parseInstruction(marker({...a,agent:"claude-opus"})),null);
});
test("edited comment, stale PR, moved source branch, wrong repo and closed issue blocked",()=>{
const c=eventCandidate(event());
let x=evidence();x.comment.body="";assert.equal(verifySnapshot(c,x).ok,false);
x=evidence();x.pr.head.sha="f".repeat(40);assert.equal(verifySnapshot(c,x).ok,false);
x=evidence();x.branch.commit.sha="f".repeat(40);assert.equal(verifySnapshot(c,x).ok,false);
x=evidence();x.pr.head.repo.full_name="attacker/repo";assert.equal(verifySnapshot(c,x).ok,false);
x=evidence();x.issue.state="closed";assert.equal(verifySnapshot(c,x).ok,false);
});
