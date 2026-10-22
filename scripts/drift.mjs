#!/usr/bin/env node
// Schema drift and tenant-coverage checker.
//
// Two hand-maintained dialects WILL diverge. A column added to the SQLite file and forgotten in
// the Postgres file is invisible until someone deploys to Supabase, at which point a query
// fails in production. This script makes that a build failure instead.
//
// It also catches the other easy mistake: creating a tenant table and forgetting to put it in
// supabase/policies/rls.sql, which would leave it readable by anyone holding the anon key.
//
//   node scripts/drift.mjs            check the two dialects against each other
//   node scripts/drift.mjs --selftest prove the checker actually fails on a deliberate break

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrationFileParity } from "../src/lib/migrate-core.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SQLITE = path.join(ROOT, "supabase", "migrations", "sqlite", "0001_init.sql");
const POSTGRES = path.join(ROOT, "supabase", "migrations", "postgres", "0001_init.sql");
const RLS = path.join(ROOT, "supabase", "policies", "rls.sql");

const CONSTRAINTS = /^(primary|unique|foreign|constraint|check|exclude|key)\b/i;

export function parseSchema(sql) {
  const tables = new Map();
  const re = /create table if not exists\s+(\w+)\s*\(([\s\S]*?)\n\);/gi;

  let match;
  while ((match = re.exec(sql)) !== null) {
    const [, name, body] = match;
    const columns = body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("--"))
      .map((line) => line.match(/^([a-z_][a-z0-9_]*)\s/i))
      .filter((m) => m && !CONSTRAINTS.test(m[1]))
      .map((m) => m[1].toLowerCase());

    tables.set(name.toLowerCase(), columns);
  }
  return tables;
}

export function parseTenantTables(rlsSql) {
  const block = rlsSql.match(/tenant_tables text\[\]\s*:=\s*array\[([\s\S]*?)\]/i);
  if (!block) return [];
  return [...block[1].matchAll(/'([a-z_]+)'/gi)].map((m) => m[1].toLowerCase()).sort();
}

export function compare(sqliteSql, postgresSql) {
  const a = parseSchema(sqliteSql);
  const b = parseSchema(postgresSql);

  const onlySqlite = [...a.keys()].filter((t) => !b.has(t)).sort();
  const onlyPostgres = [...b.keys()].filter((t) => !a.has(t)).sort();

  const columnDiffs = [];
  for (const table of [...a.keys()].filter((t) => b.has(t)).sort()) {
    const ac = new Set(a.get(table));
    const bc = new Set(b.get(table));
    const missingInPostgres = [...ac].filter((c) => !bc.has(c)).sort();
    const missingInSqlite = [...bc].filter((c) => !ac.has(c)).sort();
    if (missingInPostgres.length || missingInSqlite.length) {
      columnDiffs.push({ table, missingInPostgres, missingInSqlite });
    }
  }

  return { onlySqlite, onlyPostgres, columnDiffs, tableCount: a.size };
}

export function checkTenantCoverage(sqliteSql, rlsSql) {
  const schema = parseSchema(sqliteSql);
  const declared = parseTenantTables(rlsSql);

  const tenantTables = [...schema.entries()]
    .filter(([, cols]) => cols.includes("organization_id"))
    .map(([name]) => name)
    .sort();

  return {
    tenantTables,
    declared,
    // A tenant table with no policy is the dangerous direction, so it is separated out.
    unprotected: tenantTables.filter((t) => !declared.includes(t)),
    listedButMissing: declared.filter((t) => !schema.has(t)),
  };
}

export function report(sqliteSql, postgresSql, rlsSql) {
  const drift = compare(sqliteSql, postgresSql);
  const coverage = checkTenantCoverage(sqliteSql, rlsSql);
  const parity = migrationFileParity();
  const failures = [];

  if (drift.onlySqlite.length) failures.push(`only in sqlite: ${drift.onlySqlite.join(", ")}`);
  if (drift.onlyPostgres.length) failures.push(`only in postgres: ${drift.onlyPostgres.join(", ")}`);
  for (const d of drift.columnDiffs) {
    if (d.missingInPostgres.length) {
      failures.push(`${d.table}: postgres is missing ${d.missingInPostgres.join(", ")}`);
    }
    if (d.missingInSqlite.length) {
      failures.push(`${d.table}: sqlite is missing ${d.missingInSqlite.join(", ")}`);
    }
  }
  if (coverage.unprotected.length) {
    failures.push(`tenant tables with no RLS policy: ${coverage.unprotected.join(", ")}`);
  }
  if (coverage.listedButMissing.length) {
    failures.push(`rls.sql lists tables that do not exist: ${coverage.listedButMissing.join(", ")}`);
  }
  if (parity.onlySqlite.length) {
    failures.push(`migrations missing from postgres: ${parity.onlySqlite.join(", ")}`);
  }
  if (parity.onlyPostgres.length) {
    failures.push(`migrations missing from sqlite: ${parity.onlyPostgres.join(", ")}`);
  }

  return { drift, coverage, parity, failures, ok: failures.length === 0 };
}

function selftest() {
  let passed = 0;
  let failed = 0;
  const check = (label, condition) => {
    if (condition) {
      passed += 1;
      console.log(`  ok    ${label}`);
    } else {
      failed += 1;
      console.log(`  FAIL  ${label}`);
    }
  };

  const sqliteSql = fs.readFileSync(SQLITE, "utf8");
  const postgresSql = fs.readFileSync(POSTGRES, "utf8");
  const rlsSql = fs.readFileSync(RLS, "utf8");

  const parse = parseSchema("create table if not exists t (\n  a text,\n  primary key (a)\n);");
  check("constraint lines are not mistaken for columns", parse.get("t").join() === "a");

  const clean = report(sqliteSql, postgresSql, rlsSql);
  check("the real pair is in sync", clean.ok);
  check("both dialects define tables", clean.drift.tableCount > 10);
  check("tenant tables are found", clean.coverage.tenantTables.length >= 8);
  check("every migration exists in both dialects", clean.parity.onlySqlite.length === 0 && clean.parity.onlyPostgres.length === 0);
  check("more than one migration has been applied", clean.parity.sqlite.length >= 2);

  // A checker that cannot fail is worthless, so break each rule deliberately.
  const droppedColumn = postgresSql.replace(/\n  payload_hash    text,/, "");
  const driftBreak = report(sqliteSql, droppedColumn, rlsSql);
  check("a column missing from postgres is reported", !driftBreak.ok);
  check(
    "and it names the column",
    driftBreak.failures.some((f) => f.includes("payload_hash")),
  );

  const droppedTable = postgresSql.replace(/create table if not exists leads \([\s\S]*?\n\);\n/, "");
  const tableBreak = report(sqliteSql, droppedTable, rlsSql);
  check("a table missing from postgres is reported", !tableBreak.ok);

  const droppedPolicy = rlsSql.replace(/'subscriptions',\n/, "");
  const policyBreak = report(sqliteSql, postgresSql, droppedPolicy);
  check("a tenant table with no policy is reported", !policyBreak.ok);
  check(
    "and it names the table",
    policyBreak.failures.some((f) => f.includes("subscriptions")),
  );

  console.log(`\n  drift selftest: ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

// Only run as a CLI. The tests import the comparison functions above, and an unguarded
// top-level block would make importing this file print a report and possibly exit the runner.
const isMain = process.argv[1] && process.argv[1].endsWith("drift.mjs");
const args = process.argv.slice(2);

if (isMain && args.includes("--selftest")) {
  selftest();
} else if (isMain) {
  const result = report(
    fs.readFileSync(SQLITE, "utf8"),
    fs.readFileSync(POSTGRES, "utf8"),
    fs.readFileSync(RLS, "utf8"),
  );

  console.log(`  tables: ${result.drift.tableCount} in sqlite`);
  console.log(`  tenant tables with policies: ${result.coverage.declared.length}`);

  if (result.ok) {
    console.log("\n  SCHEMAS IN SYNC\n");
  } else {
    console.log("\n  DRIFT FOUND\n");
    for (const failure of result.failures) console.log(`    ${failure}`);
    console.log("");
    process.exit(1);
  }
}
