#!/usr/bin/env node
// Apply pending migrations. SQLite is applied in process; Postgres is handed to psql, because
// adding a Postgres driver here would mean shipping two database clients to run one CLI.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { DATABASE_URL, DATA_DIR } from "../src/lib/config.mjs";
import { apply, migrationFiles, pending, currentVersion } from "../src/lib/migrate-core.mjs";

const dialect = /^postgres(ql)?:\/\//.test(DATABASE_URL) ? "postgres" : "sqlite";
const status = process.argv.includes("--status");

if (dialect === "postgres") {
  runPostgres();
} else {
  runSqlite();
}

function sqlitePath() {
  if (DATABASE_URL.startsWith("file:")) return DATABASE_URL.slice("file:".length);
  return path.join(DATA_DIR, "ubos.db");
}

function runSqlite() {
  const file = sqlitePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const before = currentVersion(db);
  const todo = pending(db, "sqlite");

  console.log(`  dialect  sqlite`);
  console.log(`  database ${file}`);
  console.log(`  version  ${before}`);

  if (!todo.length) {
    console.log(`  nothing to apply (${migrationFiles("sqlite").length} migration file(s) known)`);
    db.close();
    return;
  }

  if (status) {
    for (const m of todo) console.log(`  pending  ${m.file}`);
    db.close();
    return;
  }

  try {
    const applied = apply(db, "sqlite", { log: (line) => console.log(line) });
    console.log(`  now at version ${currentVersion(db)} (${applied.length} applied)`);
  } catch (error) {
    console.error(`  failed: ${error.message}`);
    db.close();
    process.exit(1);
  }
  db.close();
}

function runPostgres() {
  const probe = spawnSync("psql", ["--version"], { encoding: "utf8" });
  if (probe.status !== 0) {
    console.error("  psql is not installed, so the Postgres migrations cannot be applied here.");
    console.error("  Either install the Postgres client, or use the Supabase CLI:");
    console.error("    supabase db push");
    console.error("  Then apply the tenant policies, which are not optional:");
    console.error("    psql \"$DATABASE_URL\" -f supabase/policies/rls.sql");
    process.exit(1);
  }

  for (const migration of migrationFiles("postgres")) {
    console.log(`  applying ${migration.file}`);
    const result = spawnSync("psql", [DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-f", migration.path ?? ""], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      console.error(result.stderr || result.stdout);
      process.exit(1);
    }
  }

  console.log("  Postgres migrations applied. Now apply supabase/policies/rls.sql:");
  console.log(`    psql "$DATABASE_URL" -f supabase/policies/rls.sql`);
}
