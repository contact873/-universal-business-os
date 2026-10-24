#!/usr/bin/env node
// Dependency audit with a policy, rather than a command somebody remembers to run.
//
// The rule: an advisory that can be exploited in this application blocks a release. An advisory that
// cannot, because the vulnerable code path is not reachable here, is recorded in ACCEPTED below with
// the reason and a date, so it is a decision rather than an oversight. Anything not listed and not
// critical is reported as a warning, because a failing build that everybody ignores is worse than a
// warning somebody reads.
//
//   node scripts/audit.mjs
//   node scripts/audit.mjs --json

import { spawnSync } from "node:child_process";

// Every entry needs a reason and the date it was accepted. An entry without either is not an exception,
// it is a wish.
const ACCEPTED = [
  {
    advisory: "postcss",
    package: "postcss",
    severity: "high",
    reason:
      "Path traversal when loading a source map from an untrusted CSS file. This application compiles only " +
      "our own stylesheets at build time and serves no user supplied CSS, so the vulnerable path is not " +
      "reachable. The fix requires Next 16, which is a breaking upgrade; scheduled rather than ignored.",
    accepted: "2026-10-24",
    expires: "2027-01-31",
  },
];

const json = process.argv.includes("--json");
const run = spawnSync("npm", ["audit", "--json"], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });

let report;
try {
  report = JSON.parse(run.stdout || "{}");
} catch (error) {
  console.error("  Could not read the audit output. Run npm audit by hand.");
  process.exit(1);
}

const findings = Object.entries(report.vulnerabilities ?? {}).map(([name, data]) => ({
  name,
  severity: data.severity,
  direct: Boolean(data.isDirect),
  fixAvailable: data.fixAvailable === true || (data.fixAvailable && data.fixAvailable.name) || false,
  advisory: data.via?.map((v) => (typeof v === "string" ? v : v.title)).filter(Boolean) ?? [],
}));

const accepted = [];
const blocking = [];
const warnings = [];

for (const finding of findings) {
  const exception = ACCEPTED.find((entry) => entry.package === finding.name);
  if (exception) {
    const expired = exception.expires && Date.parse(exception.expires) < Date.now();
    accepted.push({ ...finding, exception, expired });
  } else if (finding.severity === "critical") {
    blocking.push(finding);
  } else {
    warnings.push(finding);
  }
}

if (json) {
  console.log(JSON.stringify({ accepted, blocking, warnings }, null, 2));
} else {
  console.log("");
  for (const finding of blocking) console.log(`  BLOCKING  ${finding.name} (${finding.severity})${finding.fixAvailable ? "  fix available" : ""}`);
  for (const finding of warnings) console.log(`  warning   ${finding.name} (${finding.severity})${finding.fixAvailable ? "  fix available" : ""}`);
  for (const entry of accepted) {
    console.log(`  accepted  ${entry.name} (${entry.severity}) until ${entry.exception.expires}${entry.expired ? "  EXPIRED, decide again" : ""}`);
    console.log(`            ${entry.exception.reason.slice(0, 120)}...`);
  }
  const totals = report.metadata?.vulnerabilities ?? {};
  console.log("");
  console.log(`  totals: ${totals.critical ?? 0} critical, ${totals.high ?? 0} high, ${totals.moderate ?? 0} moderate, ${totals.low ?? 0} low`);
  console.log(`  accepted: ${accepted.length}, blocking: ${blocking.length}, warnings: ${warnings.length}`);
  console.log("");
}

const expired = accepted.filter((entry) => entry.expired);
if (blocking.length || expired.length) {
  if (expired.length) console.error("  An accepted advisory has expired. Decide again: fix it, or record why not.");
  process.exit(1);
}
