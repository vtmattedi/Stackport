import { test } from "node:test";
import assert from "node:assert/strict";
import { runEnvEncryption, type EncryptEnvDeps, type PlainEnvRow } from "../src/legacyMigrations/encryptEnvValues";

function harness(rows: PlainEnvRow[]) {
  const saved: { id: number; encrypted: string }[] = [];
  let atomic = 0;
  const deps: EncryptEnvDeps = {
    rows: () => rows,
    save: (id, encrypted) => { saved.push({ id, encrypted }); },
    atomic: (work) => { atomic += 1; return work(); },
    encrypt: (plain) => `enc(${plain})`,
  };
  return { deps, saved, atomic: () => atomic };
}

const row = (id: number, json: string): PlainEnvRow => ({ id, projectName: "shop", relativePath: ".env", variablesJson: json });
const vars = JSON.stringify([{ key: "A", value: "1" }, { key: "B", value: "2" }]);

test("with nothing plain it says so", () => {
  assert.match(runEnvEncryption("execute", harness([]).deps).summary, /Nothing to encrypt/);
});

test("a dry run counts the files and writes nothing", () => {
  const h = harness([row(1, vars)]);
  const report = runEnvEncryption("dry-run", h.deps);
  assert.match(report.summary, /1 env file would be encrypted, 0 skipped/);
  assert.match(report.items[0].detail ?? "", /2 variables would be encrypted/);
  assert.deepEqual(h.saved, []);
});

test("execute encrypts the stored JSON in one atomic step", () => {
  const h = harness([row(1, vars), row(2, JSON.stringify([{ key: "C", value: "3" }]))]);
  runEnvEncryption("execute", h.deps);
  assert.deepEqual(h.saved.map((s) => s.id), [1, 2]);
  assert.equal(h.saved[0].encrypted, `enc(${vars})`);
  assert.equal(h.atomic(), 1);
});

test("a file that is not valid is skipped and reported, the rest are still done", () => {
  const h = harness([row(1, "not json"), row(2, vars), row(3, JSON.stringify([{ key: "bad key", value: "x" }]))]);
  const report = runEnvEncryption("execute", h.deps);
  assert.match(report.summary, /1 env file encrypted, 2 skipped/);
  assert.deepEqual(h.saved.map((s) => s.id), [2]);
});
