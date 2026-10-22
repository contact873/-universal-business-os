// The one place a database handle is created.
//
// Three pragmas are set that the existing relcoai app does not set, each for a reason:
//   foreign_keys = ON   Without it every REFERENCES clause in the schema is decorative.
//   journal_mode = WAL  Readers do not block the writer, which matters once requests overlap.
//   busy_timeout        Wait for a lock instead of throwing SQLITE_BUSY immediately.

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DATABASE_URL, DATA_DIR, IS_PRODUCTION, IS_SERVERLESS, assertServerConfig } from "./config.mjs";
import { apply, currentVersion } from "./migrate-core.mjs";

let handle = null;

export function dbPath() {
  if (DATABASE_URL.startsWith("file:")) return DATABASE_URL.slice("file:".length);
  return path.join(DATA_DIR, "ubos.db");
}

export function getDb() {
  if (handle) return handle;

  assertServerConfig();

  if (/^postgres(ql)?:\/\//.test(DATABASE_URL)) {
    throw new Error(
      "DATABASE_URL is a Postgres URL, but this build stores through better-sqlite3. " +
        "For Supabase, apply supabase/migrations/postgres and supabase/policies/rls.sql with " +
        "the Supabase CLI, then point the app at a libSQL URL. See README.",
    );
  }

  const file = dbPath();
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });

  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  if (currentVersion(db) === 0) {
    if (IS_PRODUCTION) {
      throw new Error("Database has no schema. Run `npm run migrate` before starting in production.");
    }
    apply(db, "sqlite");
  }

  handle = db;
  return handle;
}

// Wraps a function so it runs inside one transaction. better-sqlite3 rolls back on a throw.
export function tx(fn) {
  return getDb().transaction(fn);
}

// Tests need a throwaway database. Passing its own handle keeps every module that calls
// getDb() honest about which database it is talking to.
export function setDbForTests(db) {
  handle = db;
}

export function closeDb() {
  if (handle) {
    handle.close();
    handle = null;
  }
}

export function openTestDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  apply(db, "sqlite");
  return db;
}

export { IS_SERVERLESS };
