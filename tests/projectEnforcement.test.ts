import { before, test } from "node:test";
import assert from "node:assert/strict";
import { getDatabase, initializeDatabase } from "../src/config/database";
import { createProject } from "../src/modules/projects/operations";
import { getProjectById, isComposePolicyEnforced } from "../src/modules/deployments/operations";
import { listProjectEnforcement, setComposePolicyEnforced } from "../src/modules/deployments/compose/enforcement";

before(() => { initializeDatabase(); });

test("the policy switch changes what a deploy checks, and reaches the project the client sees", () => {
  const id = createProject({ name: "enforce-switch", sourceType: "github", githubRepo: "o/r" }).id;
  getDatabase().prepare("UPDATE projects SET compose_policy_enforced = 0 WHERE id = ?").run(id);
  assert.equal(isComposePolicyEnforced(id), false);
  assert.equal(getProjectById(id)?.composePolicyEnforced, false);

  assert.equal(setComposePolicyEnforced(id, true), true);
  assert.equal(isComposePolicyEnforced(id), true);
  assert.equal(getProjectById(id)?.composePolicyEnforced, true);

  assert.equal(setComposePolicyEnforced(id, false), true);
  assert.equal(isComposePolicyEnforced(id), false);
});

test("switching a project that does not exist reports it instead of pretending", () => {
  assert.equal(setComposePolicyEnforced(999_999, true), false);
});

test("the overview lists every project with its flags, the least protected first", () => {
  const old = createProject({ name: "enforce-old", sourceType: "github", githubRepo: "o/r" }).id;
  const fresh = createProject({ name: "enforce-fresh", sourceType: "github", githubRepo: "o/r" }).id;
  getDatabase().prepare("UPDATE projects SET hardened_defaults = 0, volumes_managed = 0, compose_policy_enforced = 0 WHERE id = ?").run(old);

  const list = listProjectEnforcement();
  const oldEntry = list.find((p) => p.id === old);
  const freshEntry = list.find((p) => p.id === fresh);
  assert.deepEqual(oldEntry && { c: oldEntry.composePolicyEnforced, v: oldEntry.volumesManaged, h: oldEntry.hardenedDefaults }, { c: false, v: false, h: false });
  assert.deepEqual(freshEntry && { c: freshEntry.composePolicyEnforced, v: freshEntry.volumesManaged, h: freshEntry.hardenedDefaults }, { c: true, v: true, h: true });
  assert.ok(list.indexOf(oldEntry!) < list.indexOf(freshEntry!));
});
