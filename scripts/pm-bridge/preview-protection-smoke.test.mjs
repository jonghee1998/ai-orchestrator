import test from "node:test";
import assert from "node:assert/strict";
import { validatePreviewUrl, classifyProtection, auditPreview } from "./preview-protection-smoke.mjs";

const origin = "https://ai-orchestrator-743pcatgj-jonghee1998.vercel.app/";
test("only bare HTTPS Vercel origins accepted", () => {
  assert.equal(validatePreviewUrl(origin), origin);
  for (const url of ["http://foo.vercel.app/", "https://foo.vercel.app/api/gate",
    "https://foo.vercel.app/?token=secret", "https://user:pass@foo.vercel.app/",
    "https://foo.vercel.app.evil.org/", "https://foo.vercel.app:444/"]) {
    assert.throws(() => validatePreviewUrl(url));
  }
});
test("only recognized Vercel auth redirect is proof; denied/public/ambiguous fail closed", () => {
  assert.equal(classifyProtection(401, null).ok, false);
  assert.equal(classifyProtection(403, null).ok, false);
  assert.equal(classifyProtection(302, "https://vercel.com/login").ok, true);
  for (const [status, loc] of [[200,null],[500,null],[302,"https://evil.com/login"],
    [302,"https://vercel.com/other"],[302,"https://vercel.com/deployment"],[302,null]]) {
    assert.equal(classifyProtection(status,loc).ok,false);
  }
});
test("smoke sends no auth and does not follow redirects", async () => {
  const result = await auditPreview(origin, async (url, options) => {
    assert.equal(url, origin);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers.authorization, undefined);
    return {status: 302, headers: new Headers({location:"https://vercel.com/login"})};
  });
  assert.deepEqual(result, {ok:true,basis:"vercel_auth_redirect"});
});
test("network failure is not mistaken for protected", async () => {
  assert.deepEqual(await auditPreview(origin, async () => { throw Error("blocked"); }),
    {ok:false,reason:"network_unknown"});
});
