#!/usr/bin/env node
// #34 — routine-side gate client. Exit 0 ONLY if the orchestrator signed an allow for exactly (agent, issue).
// Usage: ORCH_URL=https://<preview> GATE_SECRET=<RUN_CALLBACK_SECRET_<AGENT> value> node scripts/gate-check.mjs <agent-key> <issueNumber>
// Prints {"allow":true,"dispatchId":"..."} on success (use dispatchId for /api/runs/callback). Any doubt => exit 1.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const [agent, issueArg] = process.argv.slice(2);
const url = process.env.ORCH_URL, secret = process.env.GATE_SECRET;
const fail = (why) => { console.error(`GATE DENY: ${why}`); process.exit(1); };
if (!url || !secret || !agent || !/^\d+$/.test(issueArg ?? "")) fail("usage / missing ORCH_URL or GATE_SECRET");
const body = JSON.stringify({ v: 2, agent, issueNumber: Number(issueArg) });
const ts = String(Math.floor(Date.now() / 1000)), eventId = `gate-${randomUUID()}`;
const hmac = (s) => createHmac("sha256", secret).update(s).digest("hex");
let res;
try {
  res = await fetch(`${url.replace(/\/$/, "")}/api/gate`, {
    method: "POST", signal: AbortSignal.timeout(10000),
    headers: { "content-type": "application/json", "x-agent-key": agent, "x-timestamp": ts, "x-event-id": eventId, "x-signature": hmac(`${ts}.${eventId}.${body}`) },
    body,
  });
} catch { fail("network"); }
const text = await res.text();
if (res.status !== 200) fail(`http ${res.status} ${text.slice(0, 200)}`);
const want = Buffer.from(hmac(`${JSON.parse(text).at}.${eventId}.${text}`), "hex");
const got = Buffer.from(res.headers.get("x-signature") ?? "", "hex");
if (got.length !== want.length || !timingSafeEqual(got, want)) fail("bad response signature");
const j = JSON.parse(text);
if (j.eventId !== eventId || j.agent !== agent || j.issueNumber !== Number(issueArg)) fail("response not bound to this request");
if (j.allow !== true) fail(`reason=${j.reason}`);
console.log(JSON.stringify({ allow: true, dispatchId: j.dispatchId }));
