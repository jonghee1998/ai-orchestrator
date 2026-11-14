// Durable run store. Atomic per-record transitions via transact(); replay protection via event IDs.
// No in-memory fallback in production: getRunStore() throws unless RUN_STORE_PATH is set.
import { promises as fs } from "node:fs";
import path from "node:path";
import type { DispatchRecord } from "./run-tracking";
import { defaultControl, type AuditEntry, type ControlState } from "../control/model";

export interface StoreData {
  records: Record<string, DispatchRecord>;
  /** processed callback event IDs -> processed-at ISO (replay/idempotency) */
  events: Record<string, string>;
  /** Phase 4 control plane lives in the SAME serialized store so gate checks are atomic with dispatch records. */
  control: ControlState;
  audit: AuditEntry[];
  /** count of dispatches/provider calls suppressed by the gate, per agent key */
  blocked: Record<string, number>;
}

export interface RunStore {
  /** Serialized read-modify-write; the mutation is committed durably before resolving. */
  transact<T>(fn: (data: StoreData) => T): Promise<T>;
  read(): Promise<StoreData>;
}

export class RunStoreConfigurationError extends Error { name = "RunStoreConfigurationError"; }

const empty = (): StoreData => ({ records: {}, events: {}, control: defaultControl(), audit: [], blocked: {} });

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
    try { const raw = JSON.parse(await fs.readFile(this.file, "utf8")); return { ...empty(), ...raw, control: { ...defaultControl(), ...(raw.control ?? {}) } }; }
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

const normalize = (raw: Partial<StoreData>): StoreData => ({ ...empty(), ...raw, control: { ...defaultControl(), ...(raw.control ?? {}) } });

const isServerless = (env: Readonly<Record<string, string | undefined>>) => !!(env.VERCEL || env.AWS_LAMBDA_FUNCTION_NAME || env.NETLIFY || env.K_SERVICE);

/** Lazily-connected store wrapper so getRunStore stays synchronous. */
class LazyPgStore implements RunStore {
  private inner?: Promise<RunStore>;
  constructor(private url: string) {}
  private get(): Promise<RunStore> {
    // A failed init must not be cached forever (a transient/TLS error would otherwise poison this instance).
    const p = (this.inner ??= import("./pg-store").then(async (m) => new m.PgRunStore(await m.createPgPool(this.url), empty, normalize)));
    p.catch(() => { if (this.inner === p) this.inner = undefined; });
    return p;
  }
  transact<T>(fn: (d: StoreData) => T) { return this.get().then((s) => s.transact(fn)); }
  read() { return this.get().then((s) => s.read()); }
}

/** DATABASE_URL => Postgres. Else RUN_STORE_PATH file (NEVER in serverless: ephemeral FS). Else fail closed. */
export function getRunStore(env: Readonly<Record<string, string | undefined>> = process.env): RunStore {
  if (env.DATABASE_URL) return new LazyPgStore(env.DATABASE_URL);
  if (isServerless(env)) throw new RunStoreConfigurationError("serverless runtime requires DATABASE_URL; file store is not allowed");
  const p = env.RUN_STORE_PATH;
  if (!p) throw new RunStoreConfigurationError("DATABASE_URL or RUN_STORE_PATH is not configured (durable store required)");
  return new FileRunStore(p);
}
