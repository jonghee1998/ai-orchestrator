// Durable run store. Atomic per-record transitions via transact(); replay protection via event IDs.
// No in-memory fallback in production: getRunStore() throws unless RUN_STORE_PATH is set.
import { promises as fs } from "node:fs";
import path from "node:path";
import type { DispatchRecord } from "./run-tracking";

export interface StoreData {
  records: Record<string, DispatchRecord>;
  /** processed callback event IDs -> processed-at ISO (replay/idempotency) */
  events: Record<string, string>;
}

export interface RunStore {
  /** Serialized read-modify-write; the mutation is committed durably before resolving. */
  transact<T>(fn: (data: StoreData) => T): Promise<T>;
  read(): Promise<StoreData>;
}

export class RunStoreConfigurationError extends Error {}

const empty = (): StoreData => ({ records: {}, events: {} });

abstract class SerialStore implements RunStore {
  private chain: Promise<unknown> = Promise.resolve();
  protected abstract load(): Promise<StoreData>;
  protected abstract save(d: StoreData): Promise<void>;
  transact<T>(fn: (data: StoreData) => T): Promise<T> {
    const run = this.chain.then(async () => {
      const d = await this.load();
      const out = fn(d);
      await this.save(d);
      return out;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
  read(): Promise<StoreData> { return this.transact((d) => structuredClone(d)); }
}

/** Test-only. Never returned by getRunStore(). */
export class MemoryRunStore extends SerialStore {
  constructor(private data: StoreData = empty()) { super(); }
  protected async load() { return structuredClone(this.data); }
  protected async save(d: StoreData) { this.data = structuredClone(d); }
}

/** Durable JSON file store: write temp + fsync + atomic rename. Point at a persistent volume. */
export class FileRunStore extends SerialStore {
  constructor(private file: string) { super(); }
  protected async load(): Promise<StoreData> {
    try { return { ...empty(), ...JSON.parse(await fs.readFile(this.file, "utf8")) }; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return empty(); throw e; }
  }
  protected async save(d: StoreData): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const fh = await fs.open(tmp, "w", 0o600);
    try { await fh.writeFile(JSON.stringify(d)); await fh.sync(); } finally { await fh.close(); }
    await fs.rename(tmp, this.file);
  }
}

export function getRunStore(env: Readonly<Record<string, string | undefined>> = process.env): RunStore {
  const p = env.RUN_STORE_PATH;
  if (!p) throw new RunStoreConfigurationError("RUN_STORE_PATH is not configured (durable store required)");
  return new FileRunStore(p);
}
