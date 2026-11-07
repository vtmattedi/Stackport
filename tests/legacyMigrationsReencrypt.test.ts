import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeyring } from "../src/utils/crypto";
import { runReencryption, type ReencryptDeps, type SecretColumn, type SecretRow } from "../src/legacyMigrations/reencryptSecrets";

const COLUMNS: SecretColumn[] = [
  { table: "credentials", column: "secret_enc", idColumn: "id", label: "Credentials" },
  { table: "projects", column: "hook_secret_enc", idColumn: "id", label: "Webhook secrets" },
];

function harness(ring: ReturnType<typeof createKeyring>, data: Record<string, SecretRow[]>, options: { failSaveOn?: number } = {}) {
  const saved: { table: string; id: number | string; value: string }[] = [];
  let atomicRuns = 0;
  const deps: ReencryptDeps = {
    columns: COLUMNS,
    rows: (column) => data[column.table] ?? [],
    save: (column, id, value) => {
      if (options.failSaveOn !== undefined && saved.length === options.failSaveOn) throw new Error("disk full");
      saved.push({ table: column.table, id, value });
    },
    atomic: (work) => { atomicRuns += 1; return work(); },
    currentKeyId: ring.currentKeyId,
    keyIdOf: ring.keyIdOf,
    decrypt: ring.decrypt,
    encrypt: ring.encrypt,
  };
  return { deps, saved, atomicRuns: () => atomicRuns };
}

const jwt = { jwtSecret: "jwt-for-tests" };
const oldRing = createKeyring(jwt);
const newRing = createKeyring({ ...jwt, encryptionKey: "key-one" });

test("without an encryption key it explains how to get one and does nothing", () => {
  const h = harness(oldRing, { credentials: [{ id: 1, value: oldRing.encrypt("a") }] });
  const report = runReencryption("execute", h.deps);
  assert.match(report.summary, /No ENCRYPTION_KEY/);
  assert.deepEqual(h.saved, []);
});

test("a dry run counts what is under which key and writes nothing", () => {
  const h = harness(newRing, { credentials: [{ id: 1, value: oldRing.encrypt("a") }, { id: 2, value: newRing.encrypt("b") }] });
  const report = runReencryption("dry-run", h.deps);
  assert.match(report.summary, /1 secret would be re-encrypted, 1 already current, 0 could not be changed/);
  assert.deepEqual(h.saved, []);
});

test("execute moves old-format secrets to the current key and the values survive", () => {
  const h = harness(newRing, {
    credentials: [{ id: 1, value: oldRing.encrypt("github-token") }, { id: 2, value: newRing.encrypt("already") }],
    projects: [{ id: 9, value: oldRing.encrypt("hook-secret") }],
  });
  const report = runReencryption("execute", h.deps);
  assert.match(report.summary, /2 secrets re-encrypted, 1 already current/);
  assert.deepEqual(h.saved.map((s) => `${s.table}#${s.id}`), ["credentials#1", "projects#9"]);
  assert.equal(newRing.decrypt(h.saved[0].value), "github-token");
  assert.equal(newRing.keyIdOf(h.saved[0].value), newRing.currentKeyId);
  assert.equal(newRing.decrypt(h.saved[1].value), "hook-secret");
});

test("a previous key's secrets are moved too, and empty values are skipped", () => {
  const rotated = createKeyring({ ...jwt, encryptionKey: "key-two", previousKeys: ["key-one"] });
  const h = harness(rotated, { credentials: [{ id: 1, value: newRing.encrypt("x") }, { id: 2, value: "" }] });
  runReencryption("execute", h.deps);
  assert.equal(h.saved.length, 1);
  assert.equal(rotated.keyIdOf(h.saved[0].value), rotated.currentKeyId);
});

test("one secret that cannot be read leaves its whole column untouched", () => {
  const unknown = createKeyring({ ...jwt, encryptionKey: "key-lost" }).encrypt("orphan");
  const h = harness(newRing, { credentials: [{ id: 1, value: oldRing.encrypt("fine") }, { id: 2, value: unknown }] });
  const report = runReencryption("execute", h.deps);
  assert.deepEqual(h.saved, [], "all or nothing per column");
  assert.match(report.summary, /1 could not be changed/);
  assert.match(report.items.map((i) => i.detail ?? "").join("\n"), /ENCRYPTION_KEY_PREVIOUS/);
});

test("the column is written inside one atomic step", () => {
  const h = harness(newRing, { credentials: [{ id: 1, value: oldRing.encrypt("a") }, { id: 2, value: oldRing.encrypt("b") }] });
  runReencryption("execute", h.deps);
  assert.equal(h.atomicRuns(), 1);
});

test("a value that is not a ciphertext is reported and left alone", () => {
  const h = harness(newRing, { credentials: [{ id: 1, value: "plain-text-oops" }] });
  const report = runReencryption("execute", h.deps);
  assert.deepEqual(h.saved, []);
  assert.equal(report.items[0].status, "error");
});
