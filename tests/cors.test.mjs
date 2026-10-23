import "./setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { allowedOrigin, rejectDisallowedOrigin, preflight } from "../src/lib/cors.mjs";

const SITE = ["https://connect.raschident.com"];

test("only origins on the allowlist are echoed back", () => {
  assert.equal(allowedOrigin("https://connect.raschident.com", SITE), "https://connect.raschident.com");
  assert.equal(allowedOrigin("https://connect.raschident.com/", SITE), "https://connect.raschident.com/", "a trailing slash still matches");
  assert.equal(allowedOrigin("HTTPS://CONNECT.RASCHIDENT.COM", SITE), "HTTPS://CONNECT.RASCHIDENT.COM", "case is not a loophole");
  assert.equal(allowedOrigin("https://evil.example", SITE), null);
  assert.equal(allowedOrigin("https://connect.raschident.com.evil.example", SITE), null, "a prefix is not a match");
  assert.equal(allowedOrigin("http://connect.raschident.com", SITE), null, "the scheme matters");
  assert.equal(allowedOrigin("https://connect.raschident.com:8443", SITE), null, "so does the port");
  assert.equal(allowedOrigin(null, SITE), null);
});

test("a caller that is not a browser is allowed through", () => {
  // curl, a script, a server-side integration: no Origin, so no third-party page is involved.
  assert.equal(rejectDisallowedOrigin(null, SITE), null);
  assert.equal(rejectDisallowedOrigin(undefined, SITE), null);
  assert.equal(rejectDisallowedOrigin("", SITE), null);
});

test("the website is allowed, and a stranger's page is refused with 403", async () => {
  assert.equal(rejectDisallowedOrigin("https://connect.raschident.com", SITE), null);

  const blocked = rejectDisallowedOrigin("https://evil.example", SITE);
  assert.ok(blocked, "a disallowed origin must be refused, not merely left without headers");
  assert.equal(blocked.status, 403);

  const body = await blocked.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "origin_not_allowed");
  assert.match(body.error.message, /connect\.raschident\.com/, "the message should say where to go instead");
});

test("a wildcard is honoured only when it is configured", () => {
  assert.equal(rejectDisallowedOrigin("https://anything.example", ["*"]), null);
  assert.equal(allowedOrigin("https://anything.example", ["*"]), "https://anything.example");
});

test("a refused preflight is a 403, and an allowed one advertises no credentials", () => {
  assert.equal(preflight("https://evil.example", SITE).status, 403);

  const ok = preflight("https://connect.raschident.com", SITE);
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get("access-control-allow-origin"), "https://connect.raschident.com");
  assert.equal(ok.headers.get("access-control-allow-credentials"), null, "the session cookie must never travel from a public page");
  assert.equal(ok.headers.get("vary"), "origin");
});
