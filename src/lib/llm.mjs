// The model layer, ported from the wrapper Mia already uses.
//
// Same providers, same order, same default models as the receptionist: Anthropic first
// (claude-sonnet-4-20250514), then OpenAI (gpt-4o-mini), then Moonshot. Keeping one implementation
// means the assistant in this platform and the receptionist on relcoai.com cannot drift into
// behaving differently for the same question.
//
// Two things are deliberate:
//
//   * Every call returns a result rather than throwing. A model outage must degrade to a handoff,
//     not to a 500 that the customer sees.
//   * fetch is injectable, so every failure path is tested without a network and without a key.

const DEFAULTS = {
  anthropic: "claude-sonnet-4-20250514",
  openai: "gpt-4o-mini",
  moonshot: "moonshot-v1-128k",
};

export const PROVIDERS = ["anthropic", "openai", "moonshot"];

export function providerOrder(env = process.env) {
  const explicit = String(env.LLM_PROVIDER_ORDER ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => PROVIDERS.includes(s));

  return explicit.length ? explicit : [...PROVIDERS];
}

export function keyFor(provider, env = process.env) {
  switch (provider) {
    case "anthropic":
      return env.ANTHROPIC_API_KEY?.trim() ?? "";
    case "openai":
      return env.OPENAI_API_KEY?.trim() ?? "";
    case "moonshot":
      return env.MOONSHOT_API_KEY?.trim() ?? "";
    default:
      return "";
  }
}

export function modelFor(provider, env = process.env) {
  switch (provider) {
    case "anthropic":
      return env.ANTHROPIC_MODEL?.trim() || DEFAULTS.anthropic;
    case "openai":
      return env.OPENAI_MODEL?.trim() || DEFAULTS.openai;
    case "moonshot":
      return env.MOONSHOT_MODEL?.trim() || DEFAULTS.moonshot;
    default:
      return "";
  }
}

export function configuredProviders(env = process.env) {
  return providerOrder(env).filter((provider) => Boolean(keyFor(provider, env)));
}

/**
 * Tries each configured provider in order. Returns the first usable answer, or every failure so
 * that the caller can log why and hand off to a person with something specific to say.
 *
 * With no keys configured it returns { ok: false, reason: "not_configured" } and never touches the
 * network. That is the honest state of a deployment before a model key is added.
 */
export async function complete({ system, user, maxTokens = 1024, env = process.env, fetchImpl = fetch }) {
  if (!system || !user) return { ok: false, reason: "incomplete" };

  const attempts = [];

  for (const provider of providerOrder(env)) {
    const key = keyFor(provider, env);
    if (!key) {
      attempts.push({ provider, error: "not_configured" });
      continue;
    }

    const result = await callProvider(provider, { system, user, maxTokens, key, env, fetchImpl });
    if (result.ok) return result;
    attempts.push({ provider, error: result.error });
  }

  const configured = attempts.filter((a) => a.error !== "not_configured");
  return {
    ok: false,
    reason: configured.length ? "all_providers_failed" : "not_configured",
    attempts,
  };
}

async function callProvider(provider, { system, user, maxTokens, key, env, fetchImpl }) {
  const model = modelFor(provider, env);

  try {
    if (provider === "anthropic") {
      const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: "user", content: user }],
        }),
      });

      const data = await readJson(response);
      if (!response.ok) {
        return { ok: false, error: data?.error?.message || `anthropic HTTP ${response.status}` };
      }

      const text = (data?.content ?? []).find((block) => block.type === "text")?.text?.trim() ?? "";
      if (!text) return { ok: false, error: "anthropic returned empty content" };
      return { ok: true, text, provider, model };
    }

    const baseUrl =
      provider === "moonshot"
        ? env.MOONSHOT_BASE_URL?.trim() || "https://api.moonshot.cn/v1"
        : "https://api.openai.com/v1";

    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });

    const data = await readJson(response);
    if (!response.ok) {
      return { ok: false, error: data?.error?.message || `${provider} HTTP ${response.status}` };
    }

    const text = data?.choices?.[0]?.message?.content?.trim() ?? "";
    if (!text) return { ok: false, error: `${provider} returned empty content` };
    return { ok: true, text, provider, model };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error).slice(0, 200) };
  }
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
