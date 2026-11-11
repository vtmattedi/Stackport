import { before, test } from "node:test";
import assert from "node:assert/strict";
import { initializeDatabase, getDatabase } from "../src/config/database";
import { createProject } from "../src/modules/projects/operations";
import { addManagedDomain } from "../src/modules/ingress/managedDomains";

before(() => { initializeDatabase(); });

test("with no base domain a new project cannot be routed anywhere, and says to add one", () => {
  assert.throws(() => createProject({ name: "no-base", sourceType: "upload", domain: "anything.example.com" }), /Add a base domain in Settings > Domains/);
  assert.equal(getDatabase().prepare("SELECT id FROM projects WHERE name='no-base'").get(), undefined, "nothing is left behind");
  assert.equal(createProject({ name: "no-domain-asked", sourceType: "upload" }).name, "no-domain-asked", "a project with no hostname is still fine");
});

test("a new project can only be routed to a base domain or a subdomain of one", () => {
  addManagedDomain("example.com");
  const rejected = (domain: string, pattern: RegExp): void => {
    assert.throws(() => createProject({ name: "off-base", sourceType: "upload", domain }), pattern);
    assert.equal(getDatabase().prepare("SELECT id FROM projects WHERE name='off-base'").get(), undefined, "nothing is left behind");
  };
  rejected("other.org", /not on a base domain/);
  rejected("shop.other.org", /not on a base domain/);
  rejected("a.b.example.com", /more than one label/);
  rejected("notexample.com", /not on a base domain/);
  const bare = createProject({ name: "on-the-base", sourceType: "upload", domain: "EXAMPLE.com" });
  const row = getDatabase().prepare("SELECT domain, label, managed_domain_id FROM project_domains WHERE project_id=?").get(bare.id) as { domain: string; label: string; managed_domain_id: number | null };
  assert.deepEqual([row.domain, row.label, row.managed_domain_id !== null], ["example.com", "@", true]);
  const sub = createProject({ name: "on-a-subdomain", sourceType: "upload", domain: "Shop.Example.com" });
  const subRow = getDatabase().prepare("SELECT domain, label FROM project_domains WHERE project_id=?").get(sub.id) as { domain: string; label: string };
  assert.deepEqual([subRow.domain, subRow.label], ["shop.example.com", "shop"]);
});
