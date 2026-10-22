#!/usr/bin/env node
// The request boundary: validation, session tokens, rate limiting, and a route handler that runs them
// in the correct order. No dependencies so it runs in any Next.js, Express or PHP-adjacent runtime.
//
//   node guard.mjs --selftest
//
// Import the pieces you need:
//   import { validate, signToken, verifyToken, createRateLimiter, createRouteHandler } from "./guard.mjs";

import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";

/* ------------------------------------------------------------------ errors */

const fail = (status, code, message, extra = {}) => ({ ok: false, status, error: { code, message, ...extra } });
const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });

/* ------------------------------------------------------------------ validation */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;

/** Validate input against a schema. Returns { ok, value, errors }. Never throws on bad input. */
export function validate(schema, input, { strict = true } = {}) {
  const errors = [];
  const value = {};
  const src = input && typeof input === "object" && !Array.isArray(input) ? input : {};

  for (const [field, rule] of Object.entries(schema)) {
    let v = src[field];

    if (v === undefined && rule.default !== undefined) v = typeof rule.default === "function" ? rule.default() : rule.default;

    const missing = v === undefined || v === null || v === "";
    if (missing) {
      if (rule.required) { errors.push({ code: "required", message: `${label(field)} is required.`, field }); continue; }
      if (rule.nullable) value[field] = null;
      continue;
    }

    if (rule.type === "number" || rule.type === "integer") {
      const n = typeof v === "number" ? v : Number(v);
      if (typeof v === "boolean" || !Number.isFinite(n)) { errors.push({ code: "type", message: `${label(field)} must be a number.`, field }); continue; }
      if (rule.type === "integer" && !Number.isInteger(n)) { errors.push({ code: "type", message: `${label(field)} must be a whole number.`, field }); continue; }
      if (rule.min !== undefined && n < rule.min) { errors.push({ code: "min", message: `${label(field)} must be at least ${rule.min}.`, field }); continue; }
      if (rule.max !== undefined && n > rule.max) { errors.push({ code: "max", message: `${label(field)} must be at most ${rule.max}.`, field }); continue; }
      value[field] = n;
      continue;
    }

    if (rule.type === "boolean") {
      if (typeof v !== "boolean") { errors.push({ code: "type", message: `${label(field)} must be true or false.`, field }); continue; }
      value[field] = v;
      continue;
    }

    if (rule.type === "array") {
      if (!Array.isArray(v)) { errors.push({ code: "type", message: `${label(field)} must be a list.`, field }); continue; }
      if (rule.maxItems !== undefined && v.length > rule.maxItems) { errors.push({ code: "max", message: `${label(field)} allows at most ${rule.maxItems} items.`, field }); continue; }
      value[field] = v;
      continue;
    }

    if (rule.type === "object") {
      if (typeof v !== "object" || Array.isArray(v)) { errors.push({ code: "type", message: `${label(field)} must be an object.`, field }); continue; }
      value[field] = v;
      continue;
    }

    // everything else is a string
    if (typeof v !== "string") { errors.push({ code: "type", message: `${label(field)} must be text.`, field }); continue; }
    let s = rule.trim === false ? v : v.trim();
    if (rule.max !== undefined && s.length > rule.max) { errors.push({ code: "max", message: `${label(field)} must be ${rule.max} characters or fewer.`, field }); continue; }
    if (rule.min !== undefined && s.length < rule.min) { errors.push({ code: "min", message: `${label(field)} must be at least ${rule.min} characters.`, field }); continue; }
    if (rule.type === "email" && !EMAIL.test(s)) { errors.push({ code: "format", message: `${label(field)} is not a valid email address.`, field }); continue; }
    if (rule.type === "uuid" && !UUID.test(s)) { errors.push({ code: "format", message: `${label(field)} is not a valid id.`, field }); continue; }
    if (rule.type === "isoDate" && !ISO_DATE.test(s)) { errors.push({ code: "format", message: `${label(field)} is not a valid date.`, field }); continue; }
    if (rule.pattern && !rule.pattern.test(s)) { errors.push({ code: "format", message: `${label(field)} is not in the expected format.`, field }); continue; }
    if (rule.enum && !rule.enum.includes(s)) { errors.push({ code: "enum", message: `${label(field)} must be one of: ${rule.enum.join(", ")}.`, field }); continue; }
    value[field] = s;
  }

  if (strict) {
    for (const key of Object.keys(src)) {
      if (!(key in schema)) errors.push({ code: "unknown_field", message: `${label(key)} is not accepted here.`, field: key });
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, value, errors: [] };
}

const label = (f) => f.replace(/[_-]/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/* ------------------------------------------------------------------ session tokens */

const b64 = (buf) => Buffer.from(buf).toString("base64url");

/** Sign a payload. HMAC, so it is tamper-proof but NOT secret: never put confidential data in it. */
export function signToken(payload, secret, { ttlMs = 86_400_000, now = Date.now() } = {}) {
  if (!secret) throw new Error("refusing to sign without a secret");
  const body = b64(JSON.stringify({ ...payload, iat: Math.floor(now / 1000), exp: Math.floor((now + ttlMs) / 1000) }));
  const mac = b64(createHmac("sha256", secret).update(body).digest());
  return `${body}.${mac}`;
}

export function verifyToken(token, secret, { now = Date.now() } = {}) {
  if (!secret) throw new Error("refusing to verify without a secret");
  if (typeof token !== "string") return { ok: false, reason: "missing" };
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const [body, mac] = parts;

  const expected = Buffer.from(b64(createHmac("sha256", secret).update(body).digest()));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad_signature" };

  let payload;
  try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); }
  catch { return { ok: false, reason: "malformed" }; }

  if (typeof payload.exp !== "number") return { ok: false, reason: "no_expiry" };
  if (payload.exp * 1000 <= now) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}

/* ------------------------------------------------------------------ rate limiting */

/** Sliding window, keyed by identity. The clock is injectable so it can be tested. */
export function createRateLimiter({ limit, windowMs, now = () => Date.now() }) {
  if (!limit || !windowMs) throw new Error("rate limit needs a limit and a window");
  const hits = new Map();
  return {
    check(key) {
      const t = now();
      const recent = (hits.get(key) ?? []).filter((at) => t - at < windowMs);
      const allowed = recent.length < limit;
      if (allowed) recent.push(t);
      hits.set(key, recent);
      const oldest = recent[0] ?? t;
      return {
        allowed,
        remaining: Math.max(0, limit - recent.length),
        retryAfterMs: allowed ? 0 : Math.max(0, windowMs - (t - oldest)),
        limit,
      };
    },
    reset() { hits.clear(); },
  };
}

/* ------------------------------------------------------------------ request reading */

export async function readJson(request, { maxBytes = 32 * 1024 } = {}) {
  const type = request.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) return fail(415, "unsupported_type", "Send JSON with content-type: application/json.");

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared && declared > maxBytes) return fail(413, "too_large", "That request is too large.");

  let text;
  try { text = await request.text(); } catch { return fail(400, "unreadable_body", "The request body could not be read."); }
  if (Buffer.byteLength(text, "utf8") > maxBytes) return fail(413, "too_large", "That request is too large.");
  if (!text.trim()) return fail(400, "empty_body", "A request body is required.");

  try { return { ok: true, data: JSON.parse(text) }; }
  catch { return fail(400, "malformed_json", "The request body is not valid JSON."); }
}

/* ------------------------------------------------------------------ request helpers */

export function clientKey(request, identity) {
  if (identity?.sub) return `user:${identity.sub}`;
  const fwd = request.headers.get("x-forwarded-for");
  const ip = (fwd ? fwd.split(",")[0] : request.headers.get("x-real-ip")) || "local";
  return `ip:${ip.trim()}`;
}

export function cookieValue(request, name) {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function bearerToken(request) {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : null;
}

/* ------------------------------------------------------------------ the route handler */

/**
 * Wire the boundary in the correct order. Fails closed: without a secret, auth cannot be enabled
 * by accident, and construction throws rather than serving open routes.
 */
export function createRouteHandler({
  handler,
  schema = null,
  secret = null,
  auth = "required",        // "required" | "optional" | "none"
  cookieName = "sid",
  rateLimit = null,         // pre-auth, keyed by IP. Stops an unauthenticated flood.
  rateLimitByIdentity = null, // post-auth, keyed by identity. Stops a signed-in client's runaway loop.
  authorize = null,
  onError = null,
  maxBytes = 32 * 1024,
  now = () => Date.now(),
}) {
  if (typeof handler !== "function") throw new Error("a handler is required");
  if (auth !== "none" && !secret) throw new Error("refusing to start: auth is on but no secret is set");
  const limiter = rateLimit ? createRateLimiter({ ...rateLimit, now }) : null;
  const identityLimiter = rateLimitByIdentity ? createRateLimiter({ ...rateLimitByIdentity, now }) : null;

  const tooMany = (result) =>
    json(429,
      { ok: false, error: { code: "rate_limited", message: "Too many requests. Try again shortly." } },
      { "retry-after": String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))), "ratelimit-limit": String(result.limit), "ratelimit-remaining": "0" });

  return async function route(request) {
    // 1 and 2: content type and size, before anything is read.
    let data = {};
    if (request.method !== "GET" && request.method !== "HEAD") {
      const body = await readJson(request, { maxBytes });
      if (!body.ok) return json(body.status, { ok: false, error: body.error });
      data = body.data;
    }

    // 3: rate limit by IP BEFORE authenticating. An unauthenticated flood must be stopped before it
    // costs us a signature verification, and before it can be used to hammer a login route.
    if (limiter) {
      const result = limiter.check(clientKey(request, null));
      if (!result.allowed) return tooMany(result);
    }

    // 4: authenticate.
    let identity = null;
    if (auth !== "none") {
      const token = bearerToken(request) ?? cookieValue(request, cookieName);
      if (token) {
        const result = verifyToken(token, secret, { now: now() });
        if (!result.ok) return json(401, { ok: false, error: { code: "unauthorized", message: "Your session has ended. Sign in again." } });
        identity = result.payload;
      } else if (auth === "required") {
        return json(401, { ok: false, error: { code: "unauthorized", message: "Sign in to continue." } });
      }
    }

    // 5: a second limit, now keyed by who they are rather than where they are.
    if (identityLimiter && identity) {
      const result = identityLimiter.check(clientKey(request, identity));
      if (!result.allowed) return tooMany(result);
    }

    // 6: validate strictly.
    if (schema) {
      const result = validate(schema, data);
      if (!result.ok) {
        const first = result.errors[0];
        return json(400, { ok: false, error: { code: "invalid_input", message: first.message, field: first.field, errors: result.errors } });
      }
      data = result.value;
    }

    // 7: authorize against the specific resource, not merely "is signed in".
    if (authorize) {
      let permitted;
      try { permitted = await authorize({ identity, data, request }); }
      catch { permitted = false; }
      if (!permitted) return json(403, { ok: false, error: { code: "forbidden", message: "You do not have access to that." } });
    }

    // 8: work.
    try {
      const result = await handler({ data, identity, request });
      if (result instanceof Response) return result;
      if (result && result.ok === false && result.error) {
        // The documented envelope is { ok, error }. Strip the transport status so it never leaks into
        // the body, which is what the api contract promises.
        const { status, ...envelope } = result;
        return json(status ?? 400, envelope);
      }
      return json(200, { ok: true, data: result?.data ?? result ?? null });
    } catch (err) {
      if (onError) onError(err, { request, identity });
      // Generic to the client. The real error goes to the log, never into the response.
      return json(500, { ok: false, error: { code: "server_error", message: "Something went wrong on our side." } });
    }
  };
}

/* ------------------------------------------------------------------ selftest */

async function selftest() {
  let pass = 0, fail = 0;
  const t = (n, c, got) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n} (got ${JSON.stringify(got)})`); } };
  console.log("\n  selftest\n");

  /* validation */
  const schema = {
    name: { type: "string", required: true, max: 120 },
    email: { type: "email", required: true },
    age: { type: "integer", min: 0, max: 130 },
    plan: { type: "string", enum: ["free", "pro"] },
    tags: { type: "array", maxItems: 5 },
    note: { type: "string", nullable: true },
    ref: { type: "string", default: "none" },
  };

  const good = validate(schema, { name: "  Ali  ", email: "a@b.co", age: 30, plan: "pro", tags: ["x"] });
  t("accepts a valid payload", good.ok, good.errors);
  t("trims strings", good.value.name === "Ali", good.value.name);
  t("applies a default", good.value.ref === "none", good.value.ref);
  t("rejects a missing required field", validate(schema, { email: "a@b.co" }).errors[0].field === "name");
  t("rejects an invalid email", validate(schema, { name: "a", email: "nope" }).errors[0].field === "email");
  t("rejects a string that is too long", validate(schema, { name: "x".repeat(121), email: "a@b.co" }).errors[0].code === "max");
  t("rejects a non-integer for an integer field", validate(schema, { name: "a", email: "a@b.co", age: 1.5 }).errors[0].field === "age");
  t("rejects an out-of-range number", validate(schema, { name: "a", email: "a@b.co", age: 200 }).errors[0].code === "max");
  t("rejects a value outside the enum", validate(schema, { name: "a", email: "a@b.co", plan: "gold" }).errors[0].code === "enum");
  t("rejects too many array items", validate(schema, { name: "a", email: "a@b.co", tags: [1,2,3,4,5,6] }).errors[0].field === "tags");
  t("rejects an unknown field by default", validate(schema, { name: "a", email: "a@b.co", admin: true }).errors[0].code === "unknown_field");
  t("allows an unknown field when not strict", validate(schema, { name: "a", email: "a@b.co", admin: true }, { strict: false }).ok);
  t("a boolean is not accepted as a number", !validate({ n: { type: "number" } }, { n: true }).ok);
  t("numbers sent as strings are coerced", validate({ n: { type: "number" } }, { n: "42" }).value.n === 42);
  t("nullable empty stays null", validate(schema, { name: "a", email: "a@b.co", note: null }).value.note === null);
  t("collects every error, not just the first", validate(schema, {}).errors.length === 2, validate(schema, {}).errors);

  /* tokens */
  const secret = "test-secret";
  const now = 1_800_000_000_000;
  const token = signToken({ sub: "user_1", role: "admin" }, secret, { ttlMs: 60_000, now });
  const verified = verifyToken(token, secret, { now });
  t("round trips a token", verified.ok && verified.payload.sub === "user_1", verified);
  t("verifies within the ttl", verifyToken(token, secret, { now: now + 59_000 }).ok);
  t("rejects an expired token", verifyToken(token, secret, { now: now + 61_000 }).reason === "expired");
  t("rejects a different secret", verifyToken(token, "other", { now }).reason === "bad_signature");
  t("rejects a tampered payload", (() => {
    const [body, mac] = token.split(".");
    const forged = b64(JSON.stringify({ sub: "user_1", role: "superadmin", exp: Math.floor((now + 60_000) / 1000) }));
    return verifyToken(`${forged}.${mac}`, secret, { now }).reason === "bad_signature";
  })());
  t("rejects a token with no expiry", (() => {
    const body = b64(JSON.stringify({ sub: "x" }));
    const mac = b64(createHmac("sha256", secret).update(body).digest());
    return verifyToken(`${body}.${mac}`, secret, { now }).reason === "no_expiry";
  })());
  t("rejects a malformed token", verifyToken("garbage", secret, { now }).reason === "malformed");
  t("rejects a missing token", verifyToken(null, secret, { now }).reason === "missing");
  t("signing without a secret throws", (() => { try { signToken({}, ""); return false; } catch { return true; } })());
  t("verifying without a secret throws", (() => { try { verifyToken(token, ""); return false; } catch { return true; } })());
  t("detects a length-mismatch signature without crashing", verifyToken(`${token.split(".")[0]}.AAA`, secret, { now }).reason === "bad_signature");

  /* rate limiter */
  let clock = 1_000_000;
  const limiter = createRateLimiter({ limit: 3, windowMs: 1000, now: () => clock });
  t("allows up to the limit", [1,2,3].every(() => limiter.check("k").allowed));
  const blocked = limiter.check("k");
  t("blocks past the limit", !blocked.allowed, blocked);
  t("reports retry-after", blocked.retryAfterMs === 1000, blocked.retryAfterMs);
  t("keys are independent", limiter.check("other").allowed);
  clock += 1001;
  t("allows again after the window", limiter.check("k").allowed);
  t("counts remaining", (() => { const l = createRateLimiter({ limit: 2, windowMs: 1000, now: () => 0 }); l.check("a"); return l.check("a").remaining === 0; })());

  /* request reading */
  const req = (body, headers = {}) => new Request("https://x.test/api", { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  t("reads a valid JSON body", (await readJson(req('{"a":1}'))).data.a === 1);
  t("rejects a non-JSON content type", (await readJson(req("{}", { "content-type": "text/plain" }))).status === 415);
  t("rejects malformed JSON", (await readJson(req("{nope"))).status === 400);
  t("rejects an empty body", (await readJson(req(""))).status === 400);
  t("rejects an oversized body", (await readJson(req('{"a":"' + "x".repeat(5000) + '"}'), { maxBytes: 100 })).status === 413);

  /* the route handler, end to end against real Request and Response objects */
  // No rate limit on this fixture: each assertion below tests one thing, and a shared IP limit
  // would turn later calls into 429s and hide what is actually being verified.
  const handler = createRouteHandler({
    secret,
    schema: { name: { type: "string", required: true, max: 60 } },
    authorize: ({ identity }) => identity.role === "admin",
    handler: async ({ data }) => ({ data: { hello: data.name } }),
  });

  const call = (body, headers = {}) => handler(new Request("https://x.test/api", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${signToken({ sub: "u1", role: "admin" }, secret, { ttlMs: 60_000 })}`, ...headers },
    body: JSON.stringify(body),
  }));

  const okRes = await call({ name: "Ali" });
  t("a valid request succeeds", okRes.status === 200, okRes.status);
  t("the success envelope is present", (await okRes.json()).ok === true);

  const noAuth = await handler(new Request("https://x.test/api", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
  t("a missing token is 401", noAuth.status === 401, noAuth.status);

  const badToken = await handler(new Request("https://x.test/api", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer nope.nope" }, body: "{}" }));
  t("a bad token is 401", badToken.status === 401, badToken.status);

  const invalid = await call({});
  const invalidBody = await invalid.json();
  t("invalid input is 400", invalid.status === 400, invalid.status);
  t("the invalid field is named", invalidBody.error.field === "name", invalidBody.error);

  const forbidden = await handler(new Request("https://x.test/api", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${signToken({ sub: "u2", role: "viewer" }, secret, { ttlMs: 60_000 })}` },
    body: JSON.stringify({ name: "Ali" }),
  }));
  t("a signed-in user without permission is 403, not 200", forbidden.status === 403, forbidden.status);

  const limited = createRouteHandler({
    secret, schema: { name: { type: "string" } }, rateLimit: { limit: 1, windowMs: 60_000 },
    handler: async () => ({ data: 1 }),
  });
  const hit = () => limited(new Request("https://x.test/api", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
  await hit();
  const second = await hit();
  t("the rate limit returns 429", second.status === 429, second.status);
  t("the rate limit sets Retry-After", Number(second.headers.get("retry-after")) > 0, second.headers.get("retry-after"));
  t("the rate limit sets RateLimit-Limit", second.headers.get("ratelimit-limit") === "1", second.headers.get("ratelimit-limit"));

  const boom = createRouteHandler({
    secret, auth: "none",
    handler: async () => { throw new Error("UNIQUE constraint failed: users.email_index"); },
  });
  const boomRes = await boom(new Request("https://x.test/api", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
  const boomText = await boomRes.text();
  t("a handler crash is a 500", boomRes.status === 500, boomRes.status);
  t("the crash does not leak internals", !boomText.includes("UNIQUE") && !boomText.includes("users.email_index"), boomText);

  t("auth none needs no secret", typeof createRouteHandler({ auth: "none", handler: async () => ({}) }) === "function");
  t("fail closed: auth on with no secret throws at construction", (() => {
    try { createRouteHandler({ auth: "required", handler: async () => ({}) }); return false; } catch { return true; }
  })());

  const optional = createRouteHandler({ secret, auth: "optional", handler: async ({ identity }) => ({ data: { signedIn: !!identity } }) });
  const anonRes = await optional(new Request("https://x.test/api", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
  t("optional auth allows an anonymous caller", (await anonRes.json()).data.signedIn === false);

  // A second tier, keyed by identity, for a signed-in client that loops.
  const twoTier = createRouteHandler({
    secret,
    rateLimit: { limit: 100, windowMs: 60_000 },
    rateLimitByIdentity: { limit: 1, windowMs: 60_000 },
    handler: async () => ({ data: 1 }),
  });
  const tierCall = () => twoTier(new Request("https://x.test/api", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${signToken({ sub: "u9" }, secret, { ttlMs: 60_000 })}` },
    body: "{}",
  }));
  await tierCall();
  const tierBlocked = await tierCall();
  t("the identity limit fires for a signed-in client", tierBlocked.status === 429, tierBlocked.status);

  const getRoute = createRouteHandler({ secret, auth: "none", handler: async () => ({ data: "ok" }) });
  t("GET does not require a body", (await getRoute(new Request("https://x.test/api", { method: "GET" }))).status === 200);

  t("clientKey prefers the identity", clientKey(new Request("https://x.test", { headers: { "x-forwarded-for": "1.2.3.4" } }), { sub: "u1" }) === "user:u1");
  t("clientKey falls back to the first forwarded IP", clientKey(new Request("https://x.test", { headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } }), null) === "ip:1.2.3.4");
  t("cookieValue reads a cookie", cookieValue(new Request("https://x.test", { headers: { cookie: "a=1; sid=abc.def" } }), "sid") === "abc.def");

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  return fail === 0 ? 0 : 1;
}

const isMain = process.argv[1] && process.argv[1].endsWith("guard.mjs");
if (isMain) {
  if (process.argv[2] === "--selftest") selftest().then((c) => process.exit(c));
  else console.log("usage: node guard.mjs --selftest");
}
