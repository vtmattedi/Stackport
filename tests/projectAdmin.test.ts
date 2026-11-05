import { before, test } from "node:test";
import assert from "node:assert/strict";
import { initializeDatabase, getDatabase } from "../src/config/database";
import { createProject } from "../src/services/projectAdmin";

before(() => { initializeDatabase(); });

test("invalid or conflicting initial domain rolls back project creation", () => {
  createProject({ name: "domain-owner", sourceType: "upload", domain: "owner.example.com" });
  for (const domain of ["not a valid hostname", "owner.example.com"]) {
    assert.throws(() => createProject({ name: "rejected-project", sourceType: "upload", domain }));
    assert.equal(getDatabase().prepare("SELECT id FROM projects WHERE name='rejected-project'").get(), undefined);
  }
});

test("initial project and domain commit together, including the selected health domain", () => {
  const project = createProject({ name: "with-domain", sourceType: "upload", domain: "new.example.com" });
  const domain = getDatabase().prepare("SELECT id FROM project_domains WHERE project_id=?").get(project.id) as { id: number };
  assert.equal(project.healthCheckDomainId, domain.id);
});

test("domain persistence failure cannot leave a partially created project", () => {
  const db = getDatabase();
  db.exec("CREATE TEMP TRIGGER domain_fail BEFORE INSERT ON project_domains BEGIN SELECT RAISE(ABORT,'domain write failed'); END");
  try {
    assert.throws(() => createProject({ name: "failed-domain-write", sourceType: "upload", domain: "failure.example.com" }), /domain write failed/);
    assert.equal(db.prepare("SELECT id FROM projects WHERE name='failed-domain-write'").get(), undefined);
  } finally { db.exec("DROP TRIGGER domain_fail"); }
});
