// Provenance: this is the pure-function half of the tested audience store shipped with the
// lead-capture skill (83 assertions, `node lead-store.mjs --selftest`).
//
//   source: ~/.commandcode/skills/lead-capture/scripts/lead-store.mjs
//   vendored unmodified at: ../vendor/lead-store.mjs
//
// Only the identity helpers are re-exported. The skill's own SQLite half is not used here:
// this app stores through better-sqlite3, and the skill's sqlite layer patches
// process.emitWarning globally, which is not wanted inside a Next.js server process.
//
// One deliberate change from the single-tenant skill, applied in the schema rather than here:
// its UNIQUE(kind, value_normalized) is global, so two businesses could never both hold the
// same customer. The identity table in this app is therefore unique per organisation.

export {
  id,
  nowIso,
  normalizeEmail,
  normalizeHandle,
  normalizePhone,
  extractIdentities,
  identityHash,
  payloadHashOf,
} from "../vendor/lead-store.mjs";
