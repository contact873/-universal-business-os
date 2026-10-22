import "./setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  hashPassword,
  verifyPassword,
  needsRehash,
  MIN_PASSWORD_LENGTH,
} from "../src/lib/passwords.mjs";

const PASSWORD = "correct-horse-battery";
const OTHER = "correct-horse-batterz";

test("a password is never stored in the clear", () => {
  const stored = hashPassword(PASSWORD);
  assert.ok(!stored.includes(PASSWORD), "the plaintext must not appear in the hash");
  assert.match(stored, /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
});

test("the same password hashes differently every time", () => {
  const a = hashPassword(PASSWORD);
  const b = hashPassword(PASSWORD);
  assert.notEqual(a, b, "two identical passwords must not produce identical hashes");
  assert.ok(verifyPassword(PASSWORD, a));
  assert.ok(verifyPassword(PASSWORD, b));
});

test("a wrong password is rejected", () => {
  const stored = hashPassword(PASSWORD);
  assert.equal(verifyPassword(OTHER, stored), false);
  assert.equal(verifyPassword(PASSWORD + " ", stored), false);
  assert.equal(verifyPassword("", stored), false);
});

test("a tampered hash is rejected rather than throwing", () => {
  const stored = hashPassword(PASSWORD);
  const parts = stored.split("$");

  const wrongHash = [...parts];
  wrongHash[5] = Buffer.from("x".repeat(64)).toString("base64url");
  assert.equal(verifyPassword(PASSWORD, wrongHash.join("$")), false);

  const wrongSalt = [...parts];
  wrongSalt[4] = Buffer.from("y".repeat(16)).toString("base64url");
  assert.equal(verifyPassword(PASSWORD, wrongSalt.join("$")), false);

  for (const junk of ["", "nonsense", "scrypt$x$y$z$a$b", "bcrypt$1$1$1$a$b", null, undefined]) {
    assert.equal(verifyPassword(PASSWORD, junk), false, `junk input ${String(junk)} must not throw`);
  }
});

test("the parameters travel with the hash, so they can be raised later", () => {
  const stored = hashPassword(PASSWORD);
  assert.equal(needsRehash(stored), false);

  const weaker = hashPassword(PASSWORD, { N: 4096, r: 8, p: 1, keylen: 64 });
  assert.ok(verifyPassword(PASSWORD, weaker), "an old hash must still verify after the cost rises");
  assert.equal(needsRehash(weaker), true);
  assert.equal(needsRehash("garbage"), true);
});

test("a password shorter than the minimum is refused at the point of hashing", () => {
  assert.throws(() => hashPassword("short"), /at least/);
  assert.doesNotThrow(() => hashPassword("a".repeat(MIN_PASSWORD_LENGTH)));
});

test("an absurdly long password is refused rather than used to exhaust memory", () => {
  assert.throws(() => hashPassword("a".repeat(5000)), /at most/);
  // Verification must not throw on the same input: an attacker controls it.
  assert.equal(verifyPassword("a".repeat(5000), hashPassword(PASSWORD)), false);
});
