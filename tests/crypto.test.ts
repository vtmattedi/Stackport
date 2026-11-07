import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeyring, LEGACY_KEY_ID } from "../src/shared/crypto";

const base = { jwtSecret: "jwt-secret-for-tests" };

test("with an encryption key, ciphertext is versioned and names its key", () => {
  const ring = createKeyring({ ...base, encryptionKey: "key-one" });
  const stored = ring.encrypt("hunter2");
  assert.match(stored, /^v2:[0-9a-f]{8}:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);
  assert.equal(ring.keyIdOf(stored), ring.currentKeyId);
  assert.equal(ring.decrypt(stored), "hunter2");
  assert.notEqual(ring.encrypt("hunter2"), stored, "a fresh IV every time");
});

test("rotating the session secret no longer breaks secrets encrypted under the encryption key", () => {
  const before = createKeyring({ ...base, encryptionKey: "key-one" });
  const stored = before.encrypt("api-key");
  const after = createKeyring({ jwtSecret: "a-completely-new-jwt-secret", encryptionKey: "key-one" });
  assert.equal(after.decrypt(stored), "api-key");
});

test("old-format ciphertext is read with the JWT-derived key and reported as legacy", () => {
  const legacyRing = createKeyring(base);
  const stored = legacyRing.encrypt("old-secret");
  assert.equal(stored.split(":").length, 3, "no encryption key configured: the old format is still written");
  assert.equal(legacyRing.currentKeyId, LEGACY_KEY_ID);

  const upgraded = createKeyring({ ...base, encryptionKey: "key-one" });
  assert.equal(upgraded.decrypt(stored), "old-secret");
  assert.equal(upgraded.keyIdOf(stored), LEGACY_KEY_ID);
  assert.notEqual(upgraded.currentKeyId, LEGACY_KEY_ID);
});

test("a previous key keeps old ciphertext readable during a rotation", () => {
  const stored = createKeyring({ ...base, encryptionKey: "key-one" }).encrypt("rotating");
  const rotated = createKeyring({ ...base, encryptionKey: "key-two", previousKeys: ["key-one"] });
  assert.equal(rotated.decrypt(stored), "rotating");
  assert.notEqual(rotated.keyIdOf(stored), rotated.currentKeyId, "it still needs re-encrypting");
  assert.equal(rotated.keyIdOf(rotated.encrypt("x")), rotated.currentKeyId);
});

test("a key that is no longer configured fails clearly instead of returning garbage", () => {
  const stored = createKeyring({ ...base, encryptionKey: "key-one" }).encrypt("lost");
  const without = createKeyring({ ...base, encryptionKey: "key-two" });
  assert.throws(() => without.decrypt(stored), /No encryption key with id/);
});

test("tampered or malformed values are refused", () => {
  const ring = createKeyring({ ...base, encryptionKey: "key-one" });
  const stored = ring.encrypt("secret");
  const tampered = stored.slice(0, -2) + (stored.endsWith("00") ? "11" : "00");
  assert.throws(() => ring.decrypt(tampered));
  assert.throws(() => ring.decrypt("not-a-secret"), /Malformed/);
  assert.throws(() => ring.keyIdOf("a:b"), /Malformed/);
});
