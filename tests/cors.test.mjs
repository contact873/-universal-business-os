import "./setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { allowedOrigin, withCors, preflight } from "../src/lib/cors.mjs";

const ALLOW = ["https://connect.raschident.com"];

test("only an allowlisted origin is offered CORS", () => {
  assert.equal(allowedOrigin("https://connect.raschident.com", ALLOW), "https://connect.raschident.com");
  // The function echoes whatever origin was sent, so a trailing slash stays as sent. Browsers never
  // send one, but the comparison still has to ignore it rather than reject the request.
  assert.equal(allowedOrigin("https://connect.raschident.com/", ALLOW), "https://connect.raschident.com/");
  assert.equal(allowedOrigin("https://CONNECT.raschident.com", ALLOW), "https://CONNECT.raschident.com", "case is not a way in");
  assert.equal(allowedOrigin("https://evil.example", ALLOW), null);
  assert.equal(allowedOrigin("https://connect.raschident.com.evil.example", ALLOW), null, "a prefix is not a match");
  assert.equal(allowedOrigin(null, ALLOW), null, "no origin means no header");
});

test("a wildcard is only used when configured explicitly", () => {
  assert.equal(allowedOrigin("https://anything.example", ["*"]), "https://anything.example");
  assert.equal(allowedOrigin("https://anything.example", []), null);
});

test("the CORS response keeps the body and status, and adds the headers", async () => {
  const original = new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  const wrapped = withCors(original, "https://connect.raschident.com", ALLOW);
  assert.equal(wrapped.status, 200);
  assert.equal(wrapped.headers.get("access-control-allow-origin"), "https://connect.raschident.com");
  assert.equal(wrapped.headers.get("vary"), "origin");
  assert.equal(await wrapped.text(), JSON.stringify({ ok: true }), "the body survives the wrapper");
});

test("no credentials header is ever sent, because a public page must not use the session cookie", () => {
  const wrapped = withCors(new Response("{}"), "https://connect.raschident.com", ALLOW);
  assert.equal(wrapped.headers.get("access-control-allow-credentials"), null);
});

test("a non-allowlisted origin gets no headers at all", () => {
  const original = new Response("{}", { status: 200 });
  const wrapped = withCors(original, "https://evil.example", ALLOW);
  assert.equal(wrapped.headers.get("access-control-allow-origin"), null);
});

test("the preflight answers 204 for an allowed origin and 403 for anyone else", () => {
  const allowed = preflight("https://connect.raschident.com", ALLOW);
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("access-control-allow-methods"), "POST, OPTIONS");
  assert.equal(allowed.headers.get("access-control-allow-headers"), "content-type");

  assert.equal(preflight("https://evil.example", ALLOW).status, 403);
  assert.equal(preflight(null, ALLOW).status, 403);
});
