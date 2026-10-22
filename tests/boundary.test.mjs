import "./setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRouteHandler, createRateLimiter, validate } from "../src/lib/guard.mjs";

// The api-and-auth skill was corrected once because it authenticated before rate limiting, which
// left a login route open to unlimited guessing. These assertions keep that order fixed.

const SECRET = "test-secret-not-for-production";

function request(body, headers = {}) {
  return new Request("https://app.example.test/api/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("the IP rate limit fires before authentication is attempted", async () => {
  let handlerCalls = 0;

  const handle = createRouteHandler({
    secret: SECRET,
    auth: "required",
    rateLimit: { limit: 3, windowMs: 60_000 },
    schema: { email: { type: "email", required: true } },
    handler: async () => {
      handlerCalls += 1;
      return { data: { ok: true } };
    },
  });

  const statuses = [];
  for (let i = 0; i < 5; i += 1) {
    const response = await handle(request({ email: "a@b.co" }));
    statuses.push(response.status);
  }

  assert.deepEqual(statuses.slice(0, 3), [401, 401, 401], "unsigned requests are unauthorised");
  assert.equal(statuses[3], 429, "the fourth attempt must be refused by the IP tier");
  assert.equal(statuses[4], 429);
  assert.equal(handlerCalls, 0, "the handler must never run, so no password is ever hashed");
});

test("a sliding window lets traffic through again once the window passes", () => {
  let clock = 1_000_000;
  const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: () => clock });

  assert.equal(limiter.check("ip:1").allowed, true);
  assert.equal(limiter.check("ip:1").allowed, true);
  assert.equal(limiter.check("ip:1").allowed, false);
  assert.equal(limiter.check("ip:2").allowed, true, "one caller must not limit another");

  clock += 1001;
  assert.equal(limiter.check("ip:1").allowed, true, "the window must slide");
});

test("validation rejects unknown fields instead of quietly ignoring them", () => {
  const schema = { email: { type: "email", required: true }, name: { type: "string", max: 20 } };

  const good = validate(schema, { email: "a@b.co", name: "Ali" });
  assert.equal(good.ok, true);

  const extra = validate(schema, { email: "a@b.co", role: "owner" });
  assert.equal(extra.ok, false, "a field the schema does not know is how privilege escalation starts");

  assert.equal(validate(schema, { name: "Ali" }).ok, false, "a required field must be required");
  assert.equal(validate(schema, { email: "not-an-email" }).ok, false);
  assert.equal(validate(schema, { email: "a@b.co", name: "x".repeat(21) }).ok, false);
});

test("a body that is not JSON, or is too large, is refused before parsing", async () => {
  const handle = createRouteHandler({
    secret: SECRET,
    auth: "none",
    maxBytes: 64,
    schema: { message: { type: "string", max: 200 } },
    handler: async ({ data }) => ({ data }),
  });

  const wrongType = await handle(
    new Request("https://app.example.test/api/x", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello",
    }),
  );
  assert.ok(wrongType.status >= 400);

  const tooBig = await handle(
    new Request("https://app.example.test/api/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "z".repeat(500) }),
    }),
  );
  assert.equal(tooBig.status, 413);
});

test("asking for authentication without a secret fails at construction, not at runtime", () => {
  assert.throws(() => createRouteHandler({ auth: "required", handler: async () => ({}) }));
});
