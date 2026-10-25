// The one place a database handle is created.
//
// Three pragmas are set that the existing relcoai app does not set, each for a reason:
//   foreign_keys = ON   Without it every REFERENCES clause in the schema is decorative.
//   journal_mode = WAL  Readers do not block the writer, which matters once requests overlap.
//   busy_timeout        Wait for a lock instead of throwing SQLITE_BUSY immediately.

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DATABASE_URL, DATA_DIR, IS_SERVERLESS, assertServerConfig } from "./config.mjs";
import { apply, currentVersion } from "./migrate-core.mjs";
import { reconcileEntitlementsToPlan } from "./accounts.mjs";

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

  // Migrations run here as well as in the release command, and the reason is a deploy-ordering
  // trap that cost a failed deployment to find.
  //
  // `release_command` runs on its own machine. On a first deploy the volume is still uninitialised
  // at that moment, so the release machine mounts nothing, migrates a throwaway filesystem, and
  // reports success. The app machine then starts against an empty database. Here it is the process
  // that owns the file doing the work, on the machine the volume is actually attached to.
  //
  // Safe to run every boot: migrations are versioned, and a database already at the current version
  // costs one select. A failure is fatal rather than tolerated, because a half-migrated schema
  // serving customers is worse than an app that will not start.
  try {
    const applied = apply(db, "sqlite", { log: (line) => console.log(`[db] ${line}`) });
    if (applied.length) console.log(`[db] applied ${applied.length} migration(s), now at version ${currentVersion(db)}`);
  } catch (error) {
    db.close();
    throw new Error(`Refusing to start: the database could not be migrated. ${error.message}`);
  }

  // Limits live in rows, and the catalogue can move after those rows were written. Reconciling here
  // means a price or allowance change reaches workspaces that already exist, which is the difference
  // between correcting the catalogue and only correcting the future.
  try {
    const { workspaces, changes } = reconcileEntitlementsToPlan(db);
    if (changes.length) {
      console.log(`[db] reconciled ${changes.length} entitlement(s) across ${workspaces} workspace(s)`);
    }
  } catch (error) {
    console.log(`[db] entitlement reconciliation skipped: ${error.message}`);
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
