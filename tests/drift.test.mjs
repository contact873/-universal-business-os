import "./setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { report, compare, parseSchema, parseTenantTables, checkTenantCoverage } from "../scripts/drift.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const sqliteSql = read("supabase/migrations/sqlite/0001_init.sql");
const postgresSql = read("supabase/migrations/postgres/0001_init.sql");
const rlsSql = read("supabase/policies/rls.sql");

test("the parser reads tables and ignores constraint lines", () => {
  const schema = parseSchema(
    "create table if not exists t (\n  a text,\n  b integer,\n  primary key (a),\n  unique (b)\n);",
  );
  assert.deepEqual(schema.get("t"), ["a", "b"]);
  assert.equal(parseSchema("-- nothing here").size, 0);
});

test("the two dialects describe the same schema", () => {
  const result = report(sqliteSql, postgresSql, rlsSql);
  assert.deepEqual(result.failures, [], "sqlite and postgres have drifted");
  assert.equal(result.ok, true);
  assert.ok(result.drift.tableCount >= 15, "the schema should have all its tables");
});

test("every tenant table carries an RLS policy", () => {
  const coverage = checkTenantCoverage(sqliteSql, rlsSql);
  assert.deepEqual(coverage.unprotected, [], "a tenant table with no policy is readable by anyone");
  assert.deepEqual(coverage.listedButMissing, []);
  assert.ok(coverage.tenantTables.length >= 8);
});

test("identity uniqueness is per organisation, in both dialects", () => {
  // The single-tenant skill's UNIQUE(kind, value_normalized) would stop two businesses from
  // ever holding the same customer. Both migration files must scope it.
  for (const [dialect, sql] of [
    ["sqlite", sqliteSql],
    ["postgres", postgresSql],
  ]) {
    assert.ok(
      /unique \(organization_id, kind, value_normalized\)/.test(sql),
      `${dialect} must scope identity uniqueness to the organisation`,
    );
    assert.ok(
      !/[^,\w]unique \(kind, value_normalized\)/.test(sql),
      `${dialect} must not keep the global unique key`,
    );
  }
});

test("the policy file is not empty, and names its tables", () => {
  const declared = parseTenantTables(rlsSql);
  assert.ok(declared.length >= 8);
  assert.ok(declared.includes("contacts"));
  assert.ok(declared.includes("leads"));
  assert.ok(/enable row level security/.test(rlsSql));
});

test("the checker actually fails on a deliberate break", () => {
  // A verification step that cannot fail is worse than none, because it reads as proof.
  const droppedColumn = postgresSql.replace(/\n  payload_hash    text,/, "");
  assert.equal(report(sqliteSql, droppedColumn, rlsSql).ok, false);

  const droppedTable = postgresSql.replace(/create table if not exists leads \([\s\S]*?\n\);\n/, "");
  assert.equal(report(sqliteSql, droppedTable, rlsSql).ok, false);

  const extraColumn = postgresSql.replace("  message         text,", "  message         text,\n  invented text,");
  const extra = compare(sqliteSql, extraColumn);
  assert.deepEqual(extra.columnDiffs.map((d) => d.table), ["leads"]);

  const droppedPolicy = rlsSql.replace(/'subscriptions',\n/, "");
  assert.equal(report(sqliteSql, postgresSql, droppedPolicy).ok, false);
});
