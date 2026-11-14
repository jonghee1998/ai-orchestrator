// Real-Postgres integration test. Runs only when TEST_DATABASE_URL is set (skipped otherwise — reported as skipped, not passed).
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PG_SCHEMA, PgRunStore, createPgPool } from "./pg-store";
import { MemoryRunStore, type StoreData } from "./store";
import { defaultControl } from "../control/model";
import { requestDispatch } from "./service";

const url = process.env.TEST_DATABASE_URL;
const empty = (): StoreData => ({ records: {}, events: {}, control: defaultControl(), audit: [], blocked: {} });
const norm = (raw: Partial<StoreData>): StoreData => ({ ...empty(), ...raw, control: { ...defaultControl(), ...(raw.control ?? {}) } });

test("migration file matches PG_SCHEMA", () => {
  const sql = readFileSync(path.join(process.cwd(), "db/migrations/001_orchestrator_state.sql"), "utf8").replace(/^--.*$/gm, "").replace(/\s+/g, " ").trim();
  assert.equal(sql.replace(/;$/, ""), PG_SCHEMA.replace(/\s+/g, " ").trim());
});

test("postgres: durable across store instances + serialized concurrent transactions", { skip: !url && "TEST_DATABASE_URL not set" }, async () => {
  process.env.DATABASE_SSL = "disable";
  const pool = await createPgPool(url!);
  await pool.withTransaction((tx) => tx.query("DROP TABLE IF EXISTS orchestrator_state"));
  const a = new PgRunStore(pool, empty, norm);
  await Promise.all(Array.from({ length: 20 }, (_, i) => a.transact((d) => { d.blocked[`k${i}`] = 1; d.events["counter"] = String(Number(d.events["counter"] ?? 0) + 1); })));
  const b = new PgRunStore(await createPgPool(url!), empty, norm); // "restart": fresh pool + store
  const d = await b.read();
  assert.equal(d.events["counter"], "20", "no lost updates under concurrency (SELECT FOR UPDATE)");
  assert.equal(Object.keys(d.blocked).length, 20);
  assert.equal(d.control.preset, "all-paused", "default control is fail-closed after fresh init");
});

test("postgres: rollback on error leaves state unchanged", { skip: !url && "TEST_DATABASE_URL not set" }, async () => {
  const s = new PgRunStore(await createPgPool(url!), empty, norm);
  await assert.rejects(s.transact((d) => { d.blocked["boom"] = 1; throw new Error("x"); }));
  assert.equal((await s.read()).blocked["boom"], undefined);
});
void MemoryRunStore; void requestDispatch;
