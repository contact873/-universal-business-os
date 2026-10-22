#!/usr/bin/env node
// Pre-deploy gate. Fails on the things that actually cause outages. No dependencies.
//
//   node preflight.mjs .            gate the current directory
//   node preflight.mjs ../relcoai --env    also confirm the variables are set in this environment
//   node preflight.mjs . --json     for CI
//   node preflight.mjs --selftest

import { readFileSync, existsSync, readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative, basename } from "node:path";

/* ------------------------------------------------------------------ helpers */

const SKIP = new Set(["node_modules", ".git", ".next", "dist", "build", "out", "coverage", ".turbo", ".vercel", "vendor"]);

const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };

function walk(root, { maxFiles = 4000, depth = 6 } = {}) {
  const out = [];
  const visit = (dir, d) => {
    if (d > depth || out.length >= maxFiles) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      if (SKIP.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) visit(full, d + 1);
      else out.push(full);
    }
  };
  visit(root, 0);
  return out;
}

const git = (root, args) => {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  return r.status === 0 ? { ok: true, out: r.stdout.trim() } : { ok: false, out: (r.stderr || "").trim() };
};

const PUBLIC_PREFIX = /^(NEXT_PUBLIC_|VITE_|REACT_APP_|PUBLIC_|GATSBY_|NUXT_PUBLIC_)/;
const SECRETISH = /(secret|password|passwd|token|private|api[_-]?key|apikey|service[_-]?role|signing|salt|credential|access[_-]?key)/i;

export function declaredEnvNames(root) {
  for (const name of [".env.example", ".env.sample", ".env.template", ".env.local.example"]) {
    const text = read(join(root, name));
    if (text) {
      const names = [...text.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map((m) => m[1]);
      if (names.length) return { file: name, names: [...new Set(names)] };
    }
  }
  return { file: null, names: [] };
}

/* ------------------------------------------------------------------ checks */

const fail = (id, message, detail) => ({ id, level: "fail", message, detail });
const warn = (id, message, detail) => ({ id, level: "warn", message, detail });
const pass = (id, message) => ({ id, level: "pass", message });

export function checkEnvironment(root, { checkLive = false, env = process.env } = {}) {
  const results = [];
  const { file, names } = declaredEnvNames(root);

  if (!file) {
    results.push(warn("env-manifest", "No .env.example to declare the variables. Add one with keys and no values."));
  } else {
    results.push(pass("env-manifest", `${names.length} variable(s) declared in ${file}`));
  }

  // A secret wearing a public prefix is shipped to every visitor in the bundle.
  const leaking = names.filter((n) => PUBLIC_PREFIX.test(n) && SECRETISH.test(n));
  for (const n of leaking) {
    results.push(fail("env-public-secret", `${n} is public-prefixed but looks like a secret. It will ship in the client bundle.`));
  }
  if (!leaking.length && names.length) results.push(pass("env-public-secret", "no secret carries a public prefix"));

  if (checkLive && names.length) {
    const missing = names.filter((n) => !env[n]);
    if (missing.length) results.push(fail("env-missing", `${missing.length} declared variable(s) are not set here: ${missing.join(", ")}`));
    else results.push(pass("env-missing", `all ${names.length} declared variable(s) are set`));
  }

  return results;
}

export function checkSecretFiles(root) {
  const results = [];
  const candidates = [".env", ".env.local", ".env.production", ".env.development", ".env.production.local", ".env.development.local"];
  const present = candidates.filter((f) => existsSync(join(root, f)));

  if (present.length) {
    const tracked = git(root, ["ls-files", "--error-unmatch", ...present]);
    const inRepo = git(root, ["rev-parse", "--is-inside-work-tree"]).ok;
    if (inRepo && tracked.ok) {
      results.push(fail("secret-files", `git is tracking ${present.join(", ")}. Ignoring a file does not untrack it. Run: git rm --cached ${present.join(" ")}`));
    } else if (inRepo) {
      results.push(pass("secret-files", `${present.length} env file(s) present and not tracked by git`));
    } else {
      results.push(warn("secret-files", `${present.length} env file(s) present. Confirm they are ignored once this is a repo.`));
    }
  } else {
    results.push(pass("secret-files", "no local env file in the tree"));
  }
  return results;
}

export function checkClientEnvLeak(root) {
  const files = walk(root).filter((f) => /\.(tsx|jsx|ts|js|vue|svelte)$/.test(f));
  const offenders = [];

  for (const f of files) {
    const text = read(f);
    if (!text) continue;
    const head = text.slice(0, 600);
    const isClient = /^\s*(['"])use client\1/m.test(head) || /export\s+default\s+defineComponent/.test(text) || /<script[^>]*setup/.test(text);
    if (!isClient) continue;
    for (const m of text.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      if (!PUBLIC_PREFIX.test(m[1])) offenders.push(`${relative(root, f)} reads process.env.${m[1]}`);
    }
    for (const m of text.matchAll(/import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const name = m[1];
      if (name !== "MODE" && name !== "DEV" && name !== "PROD" && name !== "SSR" && !PUBLIC_PREFIX.test(name)) {
        offenders.push(`${relative(root, f)} reads import.meta.env.${name}`);
      }
    }
  }

  if (offenders.length) {
    return [fail("client-env-leak", `${offenders.length} server-only variable(s) read inside a client component.`, offenders.slice(0, 8))];
  }
  return [pass("client-env-leak", "no server-only variable is read in a client component")];
}

export function checkBuildConfig(root) {
  const results = [];
  const pkgPath = join(root, "package.json");
  const pkg = read(pkgPath);

  if (!pkg) {
    results.push(warn("build-config", "no package.json. Skip this check for a static or WordPress deploy."));
    return results;
  }

  let parsed = null;
  try { parsed = JSON.parse(pkg); } catch (e) { return [fail("build-config", `package.json is not valid JSON: ${e.message}`)]; }

  if (!parsed.scripts?.build) results.push(fail("build-config", "package.json has no build script. The platform will guess and may guess wrong."));
  else results.push(pass("build-config", `build script present: ${parsed.scripts.build}`));

  const lock = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"].find((f) => existsSync(join(root, f)));
  if (!lock) results.push(warn("lockfile", "no lockfile. Deploys will resolve different dependency versions than your machine."));
  else results.push(pass("lockfile", `${lock} present`));

  const pinned = existsSync(join(root, ".nvmrc")) || parsed.engines?.node;
  if (!pinned) results.push(warn("node-version", "no .nvmrc and no engines.node. The build runtime may differ from local."));
  else results.push(pass("node-version", "node version pinned"));

  return results;
}

export function checkMigrations(root) {
  const results = [];
  const dirs = ["migrations", "migration", "db/migrations", "src/db/migrations", "prisma/migrations", "drizzle", "sql"];
  const found = dirs.map((d) => join(root, d)).filter((d) => existsSync(d) && statSync(d).isDirectory());

  if (!found.length) {
    results.push(pass("migrations", "no migration directory, nothing to sequence"));
    return results;
  }

  const files = found.flatMap((d) => readdirSync(d).filter((f) => /\.(sql|ts|js|mjs|py)$/.test(f)).map((f) => join(d, f)));
  // Read the number from the filename only. A path containing digits, which is most machines, would
  // otherwise be read as a duplicate migration number.
  const numbers = files.map((f) => (basename(f).match(/(\d{3,})/) ?? [])[1]).filter(Boolean);
  const dupes = numbers.filter((n, i) => numbers.indexOf(n) !== i);

  if (dupes.length) results.push(fail("migrations", `duplicate migration number(s): ${[...new Set(dupes)].join(", ")}. Two migrations will not apply in a reproducible order.`));
  else if (numbers.length) results.push(pass("migrations", `${files.length} migration(s), numbering is unique`));

  const destructive = [];
  for (const f of files) {
    const text = read(f) ?? "";
    const hit = text.match(/\b(drop\s+column|drop\s+table|truncate|delete\s+from)\b/i);
    if (hit) destructive.push(`${relative(root, f)} contains ${hit[1].toUpperCase()}`);
  }
  if (destructive.length) {
    results.push(warn("migrations-destructive", `${destructive.length} migration(s) destroy data. This is the contract step: run it a release later, with a backup.`, destructive.slice(0, 6)));
  }

  return results;
}

export function checkHealthEndpoint(root) {
  const candidates = walk(root).filter((f) => /health|healthz/i.test(f) && /\.(ts|js|tsx|jsx|php|py)$/.test(f) && !/\.(test|spec)\./.test(f));
  if (candidates.length) return [pass("health", `health endpoint found: ${relative(root, candidates[0])}`)];
  return [warn("health", "no health endpoint found. Without one there is no reliable trigger for an automatic rollback.")];
}

export function checkGitState(root) {
  const inRepo = git(root, ["rev-parse", "--is-inside-work-tree"]).ok;
  if (!inRepo) return [warn("git", "not a git repository. There is no commit to record and no clean rollback target.")];

  const results = [];
  const head = git(root, ["rev-parse", "--short", "HEAD"]);
  results.push(pass("git-commit", head.ok ? `deploying ${head.out}` : "no commits yet"));

  const dirty = git(root, ["status", "--porcelain"]);
  const changed = dirty.ok && dirty.out ? dirty.out.split("\n").filter(Boolean) : [];
  if (changed.length) {
    results.push(warn("git-dirty", `${changed.length} uncommitted change(s). Deploying uncommitted work means the live site cannot be reproduced from the repository.`, changed.slice(0, 8)));
  } else {
    results.push(pass("git-dirty", "working tree is clean"));
  }

  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch.ok && ["main", "master"].includes(branch.out)) {
    results.push(warn("git-branch", `on ${branch.out}. A protected main branch is a safer deploy source than a local branch.`));
  }
  return results;
}

/* ------------------------------------------------------------------ runner */

export function preflight(root, options = {}) {
  const results = [
    ...checkEnvironment(root, options),
    ...checkSecretFiles(root),
    ...checkClientEnvLeak(root),
    ...checkBuildConfig(root),
    ...checkMigrations(root),
    ...checkHealthEndpoint(root),
    ...checkGitState(root),
  ];
  const failures = results.filter((r) => r.level === "fail");
  const warnings = results.filter((r) => r.level === "warn");
  return { root, checkedAt: new Date().toISOString(), results, failures, warnings, ok: failures.length === 0 };
}

export function formatReport(report) {
  const icon = { fail: "FAIL", warn: "WARN", pass: " ok " };
  const lines = ["", `  Preflight: ${report.root}`, ""];
  for (const r of report.results) {
    if (r.level === "pass" && !process.env.PREFLIGHT_VERBOSE) continue;
    lines.push(`  [${icon[r.level]}] ${r.message}`);
    for (const d of r.detail ?? []) lines.push(`           ${d}`);
  }
  lines.push("");
  lines.push(`  ${report.results.length} check(s): ${report.failures.length} failing, ${report.warnings.length} warning(s)`);
  lines.push(report.ok ? "  CLEAR TO DEPLOY" : "  DO NOT DEPLOY: fix the failures first");
  lines.push("");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ selftest */

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "preflight-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

async function selftest() {
  let pass$ = 0, fail$ = 0;
  const t = (n, c, got) => { if (c) { pass$++; console.log(`  PASS  ${n}`); } else { fail$++; console.log(`  FAIL  ${n} (got ${JSON.stringify(got)})`); } };
  console.log("\n  selftest\n");

  /* declared names */
  const clean = fixture({
    ".env.example": "DATABASE_URL=\nSESSION_SECRET=\nNEXT_PUBLIC_SITE_URL=\n# a comment\nSTRIPE_KEY=\n",
    "package.json": JSON.stringify({ scripts: { build: "next build" } }),
    "package-lock.json": "{}",
    ".nvmrc": "22",
    "app/api/health/route.ts": "export const GET = () => Response.json({ ok: true });",
    "app/page.tsx": "'use client';\nexport default () => <div>{process.env.NEXT_PUBLIC_SITE_URL}</div>;",
    "migrations/0001_init.sql": "create table t (id integer);",
    "migrations/0002_add.sql": "alter table t add column n text;",
  });

  const d = declaredEnvNames(clean);
  t("reads declared names from .env.example", d.names.length === 4 && d.names.includes("SESSION_SECRET"), d);

  const r1 = preflight(clean);
  t("a clean project passes", r1.ok, r1.failures.map((f) => f.message));
  t("no secret wears a public prefix", !r1.failures.some((f) => f.id === "env-public-secret"));
  t("a public var in a client component is fine", !r1.failures.some((f) => f.id === "client-env-leak"));
  t("the health endpoint is found", r1.results.some((r) => r.id === "health" && r.level === "pass"));
  t("migration numbering is reported unique", r1.results.some((r) => r.id === "migrations" && r.level === "pass"));

  /* the dangerous project */
  const bad = fixture({
    ".env.example": "NEXT_PUBLIC_STRIPE_SECRET=\nNEXT_PUBLIC_API_TOKEN=\nDATABASE_URL=\n",
    ".env": "DATABASE_URL=postgres://real\n",
    "package.json": JSON.stringify({ name: "x" }),
    "components/Widget.tsx": "'use client';\nconst key = process.env.DATABASE_URL;\nexport default () => <p>{key}</p>;",
    "migrations/0001_a.sql": "create table a (id integer);",
    "migrations/0001_b.sql": "create table b (id integer);",
    "migrations/0003_drop.sql": "alter table a drop column legacy;",
  });

  const r2 = preflight(bad);
  t("a secret with a public prefix fails", r2.failures.some((f) => f.id === "env-public-secret"), r2.failures.map((f) => f.message));
  t("both public-prefixed secrets are caught", r2.failures.filter((f) => f.id === "env-public-secret").length === 2);
  t("a missing build script fails", r2.failures.some((f) => f.id === "build-config"));
  t("a server-only read in a client component fails", r2.failures.some((f) => f.id === "client-env-leak"), r2.failures.map((f) => f.id));
  t("duplicate migration numbers fail", r2.failures.some((f) => f.id === "migrations"));
  t("a destructive migration is warned, not failed", r2.warnings.some((w) => w.id === "migrations-destructive"));
  t("the bad project does not pass", !r2.ok);
  t("a missing lockfile is warned", r2.warnings.some((w) => w.id === "lockfile"));

  /* live env check */
  const missingEnv = checkEnvironment(clean, { checkLive: true, env: { DATABASE_URL: "x" } });
  t("a declared variable missing from the environment fails", missingEnv.some((r) => r.id === "env-missing" && r.level === "fail"));
  const fullEnv = checkEnvironment(clean, { checkLive: true, env: { DATABASE_URL: "x", SESSION_SECRET: "y", NEXT_PUBLIC_SITE_URL: "z", STRIPE_KEY: "s" } });
  t("all variables set passes", fullEnv.some((r) => r.id === "env-missing" && r.level === "pass"), fullEnv);

  /* a real git repository, so the tracking check is genuinely exercised */
  const repo = fixture({ ".env": "SECRET=real\n", "package.json": JSON.stringify({ scripts: { build: "x" } }) });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "t@t.t"]);
  git(repo, ["config", "user.name", "t"]);
  git(repo, ["add", ".env", "package.json"]);
  git(repo, ["commit", "-qm", "init"]);

  t("a .env tracked by git fails", checkSecretFiles(repo).some((r) => r.level === "fail"), checkSecretFiles(repo));
  t("the failure names the fix", /git rm --cached/.test(checkSecretFiles(repo)[0].message), checkSecretFiles(repo)[0].message);
  t("a committed tree reports clean", checkGitState(repo).some((r) => r.id === "git-dirty" && r.level === "pass"), checkGitState(repo).map((r) => [r.id, r.level]));
  writeFileSync(join(repo, "app.ts"), "export const x = 1;\n");
  t("an uncommitted change is warned about", checkGitState(repo).some((r) => r.id === "git-dirty" && r.level === "warn"), checkGitState(repo).map((r) => [r.id, r.level]));
  t("the commit being deployed is recorded", checkGitState(repo).some((r) => r.id === "git-commit" && r.level === "pass"));

  git(repo, ["rm", "--cached", "-q", ".env"]);
  writeFileSync(join(repo, ".gitignore"), ".env\n");
  t("untracking the env file clears the failure", !checkSecretFiles(repo).some((r) => r.level === "fail"), checkSecretFiles(repo));

  /* static and WordPress projects must not be nagged about node */
  const wp = fixture({ "wp-content/themes/x/style.css": "/* */", "index.php": "<?php" });
  const r3 = preflight(wp);
  t("a non-node project warns rather than fails on package.json", r3.warnings.some((w) => w.id === "build-config"), r3.failures.map((f) => f.message));

  t("the report renders a verdict", /CLEAR TO DEPLOY|DO NOT DEPLOY/.test(formatReport(r1)), formatReport(r1).split("\n").slice(-4));

  console.log(`\n  ${pass$} passed, ${fail$} failed\n`);
  return fail$ === 0 ? 0 : 1;
}

/* ------------------------------------------------------------------ main */

if (process.argv[2] === "--selftest") {
  selftest().then((c) => process.exit(c));
} else {
  const target = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : ".";
  const report = preflight(target, { checkLive: process.argv.includes("--env") });
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else console.log(formatReport(report));
  process.exit(report.ok ? 0 : 1);
}
