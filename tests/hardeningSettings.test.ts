import { before, test } from "node:test";
import assert from "node:assert/strict";
import { getDatabase, initializeDatabase } from "../src/config/database";
import { createProject } from "../src/services/projectAdmin";
import { DEFAULT_HARDENING, getHardeningDefaults, isHardeningEnabled, setHardeningDefaults } from "../src/services/containerHardening";
import { isComposePolicyEnforced, isVolumesManaged } from "../src/services/projectDeploy";

before(() => { initializeDatabase(); });

test("the defaults are 512 processes and 1024 MB until an admin changes them", () => {
  assert.deepEqual(getHardeningDefaults(), DEFAULT_HARDENING);
});

test("saved defaults persist, and 0 turns a limit off", () => {
  assert.deepEqual(setHardeningDefaults({ pidsLimit: 256, memoryMb: 0 }), { pidsLimit: 256, memoryMb: 0 });
  assert.deepEqual(getHardeningDefaults(), { pidsLimit: 256, memoryMb: 0 });
  setHardeningDefaults(DEFAULT_HARDENING);
});

test("invalid defaults are refused and nothing is saved", () => {
  for (const bad of [{ pidsLimit: -1, memoryMb: 100 }, { pidsLimit: 1.5, memoryMb: 100 }, { pidsLimit: 10, memoryMb: "1g" }, { pidsLimit: 10 }, null]) {
    assert.throws(() => setHardeningDefaults(bad), /must be a whole number/);
  }
  assert.deepEqual(getHardeningDefaults(), DEFAULT_HARDENING);
});

test("a new project starts with every 1.3 protection on, an existing one with them off", () => {
  const created = createProject({ name: "hardening-new", sourceType: "github", githubRepo: "o/r" }).id;
  assert.equal(isHardeningEnabled(created), true);
  assert.equal(isVolumesManaged(created), true);
  assert.equal(isComposePolicyEnforced(created), true);

  getDatabase().prepare("UPDATE projects SET hardened_defaults = 0, volumes_managed = 0, compose_policy_enforced = 0 WHERE id = ?").run(created);
  assert.equal(isHardeningEnabled(created), false);
  assert.equal(isVolumesManaged(created), false);
  assert.equal(isComposePolicyEnforced(created), false);
});

test("the project exposes the hardened-defaults flag to the client", async () => {
  const { getProjectById } = await import("../src/services/projectDeploy");
  const id = createProject({ name: "hardening-entity", sourceType: "github", githubRepo: "o/r" }).id;
  assert.equal(getProjectById(id)?.hardenedDefaults, true);
  getDatabase().prepare("UPDATE projects SET hardened_defaults = 0 WHERE id = ?").run(id);
  assert.equal(getProjectById(id)?.hardenedDefaults, false);
});
