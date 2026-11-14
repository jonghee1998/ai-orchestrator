// Safe, credential-free classification of store/DB failures. Returns a category slug ONLY — never the error
// message (which can embed hostnames/usernames) — so it is safe to log and to show in the UI.
export type StoreErrorCategory =
  | "not_configured" | "tls_untrusted_cert" | "tls_other" | "auth_failed" | "dns_failed"
  | "connect_refused" | "timeout" | "pooler_limit" | "schema_or_permission" | "invalid_url" | "unknown";

const TLS_CERT_CODES = new Set(["SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_GET_ISSUER_CERT"]);

export function classifyStoreError(e: unknown): StoreErrorCategory {
  if (e instanceof Error && e.name === "RunStoreConfigurationError") return "not_configured";
  const err = (e ?? {}) as { code?: unknown; message?: unknown; name?: unknown };
  const code = typeof err.code === "string" ? err.code : "";
  const msg = typeof err.message === "string" ? err.message.toLowerCase() : "";
  if (TLS_CERT_CODES.has(code) || /self[- ]signed|unable to verify|certificate (has expired|chain)|issuer certificate/.test(msg)) return "tls_untrusted_cert";
  if (code.startsWith("ERR_SSL") || code.startsWith("ERR_TLS") || /\bssl\b|\btls\b/.test(msg)) return "tls_other";
  if (code === "28P01" || code === "28000" || /password authentication|authentication failed/.test(msg)) return "auth_failed";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns_failed";
  if (code === "ECONNREFUSED") return "connect_refused";
  if (code === "ETIMEDOUT" || code === "ECONNRESET" || /timeout|timed out|connection terminated/.test(msg)) return "timeout";
  if (code === "53300" || code === "XX000" || /too many (clients|connections)|max client|tenant or user not found/.test(msg)) return "pooler_limit";
  if (code === "42P01" || code === "42501" || code === "3D000" || /permission denied|does not exist/.test(msg)) return "schema_or_permission";
  if (code === "ERR_INVALID_URL" || /invalid url|invalid connection string/.test(msg)) return "invalid_url";
  return "unknown";
}

const HINT: Record<StoreErrorCategory, string> = {
  not_configured: "저장소(DATABASE_URL)가 설정되지 않았습니다.",
  tls_untrusted_cert: "DB TLS 인증서를 신뢰할 수 없습니다. 검증은 유지됩니다 — DATABASE_SSL_CA에 공급자 CA(PEM)를 설정하세요.",
  tls_other: "DB TLS 핸드셰이크 오류입니다.",
  auth_failed: "DB 인증 실패 — 사용자/비밀번호(DATABASE_URL)를 확인하세요.",
  dns_failed: "DB 호스트 이름을 확인할 수 없습니다.",
  connect_refused: "DB 연결이 거부되었습니다 (호스트/포트 확인).",
  timeout: "DB 연결 시간 초과/끊김.",
  pooler_limit: "DB 풀러 연결 한도 또는 프로젝트/사용자 식별 오류.",
  schema_or_permission: "스키마/권한 문제 — scripts/migrate.mjs 실행 및 권한을 확인하세요.",
  invalid_url: "DATABASE_URL 형식이 올바르지 않습니다.",
  unknown: "분류되지 않은 저장소 오류 — 서버 로그의 category를 확인하세요.",
};
export const storeErrorHint = (c: StoreErrorCategory): string => HINT[c];
