import assert from "node:assert/strict";
import test from "node:test";
import { matchRouteId, safeDecode } from "./route";

const items = [{ id: "label:알파 프로젝트/α" }, { id: "milestone:3" }, { id: "label:100%" }, { id: "label:a%41" }, { id: "unclassified" }];
test("real project ids match raw, encodeURIComponent'd and Unicode-encoded params", () => {
  for (const it of items) {
    assert.equal(matchRouteId(items, it.id)?.id, it.id, "decoded param");
    assert.equal(matchRouteId(items, encodeURIComponent(it.id))?.id, it.id, "encoded param");
  }
  assert.equal(matchRouteId(items, "label%3A%EC%95%8C%ED%8C%8C%20%ED%94%84%EB%A1%9C%EC%A0%9D%ED%8A%B8%2F%CE%B1")?.id, "label:알파 프로젝트/α");
});
test("malformed encodings never throw; unknown ids stay unmatched", () => {
  assert.equal(safeDecode("%E0%A4%A"), "%E0%A4%A");
  assert.equal(matchRouteId(items, "%E0%A4%A"), undefined);
  assert.equal(matchRouteId(items, undefined), undefined);
  assert.equal(matchRouteId(items, "milestone:4"), undefined);
});
