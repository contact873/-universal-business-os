import "./setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { complete, configuredProviders, providerOrder, modelFor } from "../src/lib/llm.mjs";

const ENV_BOTH = { ANTHROPIC_API_KEY: "a-key", OPENAI_API_KEY: "o-key" };
const ENV_NONE = {};

function reply(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

test("with no keys it refuses before touching the network", async () => {
  let called = false;
  const result = await complete({
    system: "be brief",
    user: "hello",
    env: ENV_NONE,
    fetchImpl: async () => { called = true; return reply({}); },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "not_configured");
  assert.equal(called, false, "no key means no request");
  assert.deepEqual(configuredProviders(ENV_NONE), []);
});

test("with an Anthropic key it calls Claude, the same model Mia uses", async () => {
  let seen = null;

  const result = await complete({
    system: "You are a front desk.",
    user: "Do you have anything Thursday?",
    env: { ANTHROPIC_API_KEY: "a-key" },
    fetchImpl: async (url, options) => {
      seen = { url, body: JSON.parse(options.body), headers: options.headers };
      return reply({ content: [{ type: "text", text: "  Thursday at 6:15pm.  " }] });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.text, "Thursday at 6:15pm.", "the answer is trimmed");
  assert.equal(result.provider, "anthropic");
  assert.equal(result.model, "claude-sonnet-4-20250514");
  assert.equal(seen.url, "https://api.anthropic.com/v1/messages");
  assert.equal(seen.headers["anthropic-version"], "2023-06-01");
  assert.equal(seen.body.system, "You are a front desk.");
  assert.deepEqual(seen.body.messages, [{ role: "user", content: "Do you have anything Thursday?" }]);
});

test("an Anthropic failure falls through to OpenAI rather than failing the request", async () => {
  const calls = [];

  const result = await complete({
    system: "s",
    user: "u",
    env: ENV_BOTH,
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes("anthropic")) return reply({ error: { message: "overloaded" } }, { ok: false, status: 529 });
      return reply({ choices: [{ message: { content: "answered by the fallback" } }] });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.provider, "openai");
  assert.equal(result.text, "answered by the fallback");
  assert.equal(calls.length, 2, "both providers were tried");
});

test("when every provider fails, the caller gets the reasons rather than an exception", async () => {
  const result = await complete({
    system: "s",
    user: "u",
    env: ENV_BOTH,
    fetchImpl: async () => reply({ error: { message: "down" } }, { ok: false, status: 503 }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "all_providers_failed");

  // Moonshot has no key here, so it is recorded as not_configured rather than as a failure. Only
  // the providers that were actually tried should carry the provider's error message.
  const tried = result.attempts.filter((a) => a.error !== "not_configured");
  assert.equal(tried.length, 2);
  assert.ok(tried.every((a) => a.error.includes("down")));
  assert.ok(result.attempts.some((a) => a.provider === "moonshot" && a.error === "not_configured"));
});

test("a network throw is caught, and the next provider is still tried", async () => {
  const result = await complete({
    system: "s",
    user: "u",
    env: { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" },
    fetchImpl: async (url) => {
      if (url.includes("anthropic")) throw new Error("socket hang up");
      return reply({ choices: [{ message: { content: "recovered" } }] });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.provider, "openai");
});

test("an empty answer is a failure, not an empty message to the customer", async () => {
  const result = await complete({
    system: "s",
    user: "u",
    env: { ANTHROPIC_API_KEY: "a" },
    fetchImpl: async () => reply({ content: [{ type: "text", text: "   " }] }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "all_providers_failed");
  assert.match(result.attempts[0].error, /empty/);
});

test("the provider order can be changed, and unknown names are ignored", () => {
  assert.deepEqual(providerOrder({}), ["anthropic", "openai", "moonshot"]);
  assert.deepEqual(providerOrder({ LLM_PROVIDER_ORDER: "openai,anthropic" }), ["openai", "anthropic"]);
  assert.deepEqual(providerOrder({ LLM_PROVIDER_ORDER: "nonsense" }), ["anthropic", "openai", "moonshot"]);
});

test("model names can be overridden without touching code", () => {
  assert.equal(modelFor("anthropic", { ANTHROPIC_MODEL: "claude-x" }), "claude-x");
  assert.equal(modelFor("openai", {}), "gpt-4o-mini");
  assert.equal(modelFor("nonsense", {}), "");
});

test("an incomplete request is refused before any provider is called", async () => {
  let called = false;
  const result = await complete({ system: "", user: "u", env: ENV_BOTH, fetchImpl: async () => { called = true; } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "incomplete");
  assert.equal(called, false);
});
