// Password hashing.
//
// The api-and-auth skill signs and verifies session tokens but deliberately ships no credential
// hashing, so this is written here. scrypt is used rather than bcrypt or argon2 because it is in
// node:crypto: no native build step, and nothing to fail at deploy time.
//
// The stored string carries its own parameters, so raising the cost later does not invalidate
// existing passwords. needsRehash() reports which ones are behind.

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };
const MAX_MEMORY = 64 * 1024 * 1024;

export const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 200;

export function hashPassword(password, params = PARAMS) {
  const value = String(password ?? "");
  if (value.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (value.length > MAX_PASSWORD_LENGTH) {
    throw new Error(`Password must be at most ${MAX_PASSWORD_LENGTH} characters.`);
  }

  const salt = randomBytes(16);
  const derived = scryptSync(value, salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: MAX_MEMORY,
  });

  return [
    "scrypt",
    params.N,
    params.r,
    params.p,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export function verifyPassword(password, stored) {
  const value = String(password ?? "");
  if (!value || value.length > MAX_PASSWORD_LENGTH) return false;

  const parsed = parse(stored);
  if (!parsed) return false;

  let derived;
  try {
    derived = scryptSync(value, parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: MAX_MEMORY,
    });
  } catch {
    return false;
  }

  if (derived.length !== parsed.hash.length) return false;
  return timingSafeEqual(derived, parsed.hash);
}

export function needsRehash(stored) {
  const parsed = parse(stored);
  if (!parsed) return true;
  return parsed.N !== PARAMS.N || parsed.r !== PARAMS.r || parsed.p !== PARAMS.p;
}

function parse(stored) {
  const parts = String(stored ?? "").split("$");
  if (parts.length !== 6) return null;

  const [scheme, n, r, p, salt, hash] = parts;
  if (scheme !== "scrypt") return null;

  const N = Number(n);
  const rr = Number(r);
  const pp = Number(p);
  if (!Number.isInteger(N) || !Number.isInteger(rr) || !Number.isInteger(pp)) return null;
  if (N < 1024 || rr < 1 || pp < 1) return null;

  let saltBuf;
  let hashBuf;
  try {
    saltBuf = Buffer.from(salt, "base64url");
    hashBuf = Buffer.from(hash, "base64url");
  } catch {
    return null;
  }
  if (!saltBuf.length || !hashBuf.length) return null;

  return { N, r: rr, p: pp, salt: saltBuf, hash: hashBuf };
}
