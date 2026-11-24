import test from "node:test";
import assert from "node:assert/strict";
import { limitUntil, events } from "./limit.mjs";

const NOW = Date.parse("2026-11-24T07:34:00Z");
const ev = (status, five, seven, extra = {}) => JSON.stringify({ type: "rate_limit_event", rate_limit_info: {
  status, resetsAt: five?.resetsAt, unifiedWindows: { five_hour: five, seven_day: seven }, ...extra } });
const at = (iso) => Date.parse(iso) / 1000;

test("rejected 5h window -> its reset time", () => {
  const t = ev("rejected", { status: "rejected", resetsAt: at("2026-11-24T09:00:00Z") }, { status: "allowed", resetsAt: at("2026-11-28T00:00:00Z") });
  assert.equal(limitUntil(t, NOW), "2026-11-24T09:00:00.000Z");
});

test("both windows rejected -> the later reset (7d)", () => {
  const t = ev("rejected", { status: "rejected", resetsAt: at("2026-11-24T09:00:00Z") }, { status: "rejected", resetsAt: at("2026-11-27T03:00:00Z") });
  assert.equal(limitUntil(t, NOW), "2026-11-27T03:00:00.000Z");
});

test("allowed / allowed_warning -> no limit; a later allowed clears an earlier rejection", () => {
  assert.equal(limitUntil(ev("allowed", { status: "allowed", resetsAt: at("2026-11-24T09:00:00Z") }), NOW), null);
  assert.equal(limitUntil(ev("allowed_warning", { status: "allowed_warning", resetsAt: at("2026-11-24T09:00:00Z") }), NOW), null);
  const t = [ev("rejected", { status: "rejected", resetsAt: at("2026-11-24T09:00:00Z") }), ev("allowed", { status: "allowed", resetsAt: at("2026-11-24T09:00:00Z") })].join("\n");
  assert.equal(limitUntil(t, NOW), null);
});

test("no window details -> rate_limit_info.resetsAt", () => {
  const t = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: at("2026-11-24T10:00:00Z") } });
  assert.equal(limitUntil(t, NOW), "2026-11-24T10:00:00.000Z");
});

test("older CLI: error result 'usage limit reached|<epoch>'", () => {
  const t = JSON.stringify({ type: "result", subtype: "success", is_error: true, result: `Claude AI usage limit reached|${at("2026-11-24T12:00:00Z")}` });
  assert.equal(limitUntil(t, NOW), "2026-11-24T12:00:00.000Z");
});

test("JSON array transcript (claude-code-action execution output) works too", () => {
  const arr = JSON.stringify([{ type: "system", subtype: "init" }, JSON.parse(ev("rejected", { status: "rejected", resetsAt: at("2026-11-24T09:00:00Z") })), { type: "result", is_error: true }]);
  assert.equal(limitUntil(arr, NOW), "2026-11-24T09:00:00.000Z");
  assert.equal(events(arr).length, 3);
});

test("past reset, absurd future, other errors, empty or broken input -> null", () => {
  assert.equal(limitUntil(ev("rejected", { status: "rejected", resetsAt: at("2026-11-24T07:00:00Z") }), NOW), null, "already lifted");
  assert.equal(limitUntil(ev("rejected", { status: "rejected", resetsAt: at("2026-12-30T00:00:00Z") }), NOW), null, "> 8 days");
  assert.equal(limitUntil(JSON.stringify({ type: "result", is_error: true, result: "API Error: 500" }), NOW), null);
  assert.equal(limitUntil("", NOW), null);
  assert.equal(limitUntil("not json\n{broken", NOW), null);
});
