import assert from "node:assert/strict";
import test from "node:test";
import { classifyStoreError, storeErrorHint } from "./store-errors";
import { buildPgConfig } from "./pg-store";
import { RunStoreConfigurationError } from "./store";

const e = (code?: string, message = "x") => Object.assign(new Error(message), code ? { code } : {});

test("classifies common failures", () => {
  assert.equal(classifyStoreError(new RunStoreConfigurationError("x")), "not_configured");
  assert.equal(classifyStoreError(e("SELF_SIGNED_CERT_IN_CHAIN")), "tls_untrusted_cert");
  assert.equal(classifyStoreError(e(undefined, "self-signed certificate in certificate chain")), "tls_untrusted_cert");
  assert.equal(classifyStoreError(e("28P01")), "auth_failed");
  assert.equal(classifyStoreError(e("ENOTFOUND")), "dns_failed");
  assert.equal(classifyStoreError(e("ECONNREFUSED")), "connect_refused");
  assert.equal(classifyStoreError(e(undefined, "timeout expired")), "timeout");
  assert.equal(classifyStoreError(e("42P01")), "schema_or_permission");
  assert.equal(classifyStoreError("weird"), "unknown");
  assert.equal(classifyStoreError(undefined), "unknown");
});
test("category and hint never contain error message text", () => {
  const c = classifyStoreError(e("28P01", "password authentication failed for user postgres.SECRETREF at db.host.example"));
  assert.ok(!c.includes("SECRETREF") && !storeErrorHint(c).includes("SECRETREF"));
});
test("buildPgConfig keeps TLS verification on and strips sslmode override", () => {
  const c = buildPgConfig("postgresql://u:p@h:6543/db?sslmode=require&application_name=a", {});
  assert.deepEqual(c.ssl, { rejectUnauthorized: true });
  assert.ok(!c.connectionString.includes("sslmode") && c.connectionString.includes("application_name"));
});
test("buildPgConfig adds CA without weakening verification; disable only via explicit flag", () => {
  const c = buildPgConfig("postgresql://u:p@h/db", { DATABASE_SSL_CA: "-----BEGIN CERTIFICATE-----\\nAAA\\n-----END CERTIFICATE-----" });
  assert.equal((c.ssl as { rejectUnauthorized: boolean }).rejectUnauthorized, true);
  assert.ok((c.ssl as { ca: string }).ca.includes("\nAAA\n"));
  assert.equal(buildPgConfig("postgresql://u:p@h/db", { DATABASE_SSL: "disable" }).ssl, false);
});

test("buildPgConfig bundles Supabase CA only for Supabase hosts, verification on", async () => {
  const { SUPABASE_ROOT_CA_2021 } = await import("./supabase-ca");
  const a = buildPgConfig("postgresql://u:p@aws-0-ap.pooler.supabase.com:6543/db", {});
  assert.equal((a.ssl as { rejectUnauthorized?: boolean }).rejectUnauthorized, true);
  assert.equal(a.ssl && (a.ssl as { ca?: string }).ca, SUPABASE_ROOT_CA_2021);
  const b = buildPgConfig("postgresql://u:p@evil.example.com/db", {});
  assert.equal((b.ssl as { ca?: string }).ca, undefined);
  const c = buildPgConfig("postgresql://u:p@notsupabase.com/db", {});
  assert.equal((c.ssl as { ca?: string }).ca, undefined);
});
