// Process configuration. Every value is read once, here, so that nothing else in the app
// reaches into process.env and drifts.

import path from "node:path";

const env = process.env;

function list(value) {
  return String(value ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export const NODE_ENV = env.NODE_ENV ?? "development";
export const IS_PRODUCTION = NODE_ENV === "production";
export const IS_SERVERLESS = Boolean(env.VERCEL || env.AWS_LAMBDA_FUNCTION_NAME);

export const APP_URL = env.APP_URL?.trim() || "http://127.0.0.1:3000";

// Signs session cookies. Empty in development is survivable; empty in production is not, and
// assertServerConfig() is called on the paths that matter rather than trusted to be called.
export const SESSION_SECRET = env.SESSION_SECRET?.trim() ?? "";

export const DATABASE_URL = env.DATABASE_URL?.trim() ?? "";
// process.cwd() rather than a URL relative to this file: the bundler tries to resolve a module
// path from `new URL(..., import.meta.url)` at build time and fails the build.
export const DATA_DIR = env.DATA_DIR?.trim() || path.join(process.cwd(), "data");

export const PLATFORM_ADMIN_EMAILS = list(env.PLATFORM_ADMIN_EMAILS);

export const RESEND_API_KEY = env.RESEND_API_KEY?.trim() ?? "";
export const EMAIL_FROM = env.EMAIL_FROM?.trim() || "Business OS <onboarding@resend.dev>";

export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;
export const RATE_LIMITS = {
  login: { limit: 10, windowMs: 60_000 },
  signup: { limit: 5, windowMs: 60_000 },
  write: { limit: 120, windowMs: 60_000 },
  read: { limit: 300, windowMs: 60_000 },
};

// __Host- requires Secure, path=/ and no Domain attribute, so it cannot be set over plain http.
// On localhost that would silence the cookie entirely, hence the development fallback.
export const SESSION_COOKIE = IS_PRODUCTION ? "__Host-ubos_sid" : "ubos_sid";

export function isPlatformAdmin(email) {
  return PLATFORM_ADMIN_EMAILS.includes(String(email ?? "").trim().toLowerCase());
}

export function assertServerConfig() {
  const missing = [];
  if (!SESSION_SECRET) missing.push("SESSION_SECRET");
  if (IS_SERVERLESS && !DATABASE_URL) missing.push("DATABASE_URL");
  if (missing.length) {
    throw new Error(
      `Refusing to start: missing ${missing.join(", ")}. See .env.example. ` +
        (missing.includes("DATABASE_URL")
          ? "A serverless filesystem is read-only and /tmp is per-instance, so storing customer data there would lose it silently."
          : ""),
    );
  }
}
