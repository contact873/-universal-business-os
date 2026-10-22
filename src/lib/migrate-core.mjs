// Migration core, shared by the `npm run migrate` CLI and by the lazy schema check in db.mjs.
//
// Numbered files, applied in order, recorded in schema_meta. A version lower than the newest
// applied version is refused rather than skipped: a migration that arrives after a newer one
// means two branches both claimed the same number, and guessing which is correct is worse
// than stopping.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const MIGRATIONS_DIR = path.join(ROOT, "supabase", "migrations");

export function migrationFiles(dialect) {
  const dir = path.join(MIGRATIONS_DIR, dialect);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
    .map((file) => ({
      file,
      path: path.join(dir, file),
      version: Number.parseInt(file.slice(0, 4), 10),
      sql: fs.readFileSync(path.join(dir, file), "utf8"),
    }));
}

// Both dialects must have the same migrations, or one of them is silently behind. The drift
// checker only compares 0001, so without this a migration added to one dialect alone would pass
// every other check and fail on the deployment that used the other.
export function migrationFileParity() {
  const sqlite = migrationFiles("sqlite").map((m) => m.file);
  const postgres = migrationFiles("postgres").map((m) => m.file);
  return {
    sqlite,
    postgres,
    onlySqlite: sqlite.filter((f) => !postgres.includes(f)),
    onlyPostgres: postgres.filter((f) => !sqlite.includes(f)),
  };
}

export function currentVersion(db) {
  const row = db
    .prepare(
      "select name from sqlite_master where type = 'table' and name = 'schema_meta'",
    )
    .get();
  if (!row) return 0;
  const max = db.prepare("select max(version) as v from schema_meta").get();
  return max?.v ?? 0;
}

export function pending(db, dialect) {
  const current = currentVersion(db);
  return migrationFiles(dialect).filter((m) => m.version > current);
}

export function apply(db, dialect, { log = () => {} } = {}) {
  const current = currentVersion(db);
  const applied = [];

  for (const migration of migrationFiles(dialect)) {
    if (migration.version <= current) continue;

    if (migration.version < current) {
      throw new Error(
        `Migration ${migration.file} has version ${migration.version}, lower than the ` +
          `already applied ${current}. Two branches probably used the same number.`,
      );
    }

    // Each migration is one transaction, so a failure leaves the version untouched and
    // re-running is safe.
    db.exec("begin");
    try {
      db.exec(migration.sql);
      db.prepare(
        "insert into schema_meta (version, dialect, applied_at) values (?, ?, ?)",
      ).run(migration.version, dialect, new Date().toISOString());
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw new Error(`${migration.file} failed: ${error.message}`);
    }

    applied.push(migration.version);
    log(`  applied ${migration.file} (version ${migration.version})`);
  }

  return applied;
}
