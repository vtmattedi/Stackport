import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "net";
import type { Server } from "http";
import app from "../src/app";
import { initializeDatabase, getDatabase } from "../src/config/database";
import { createProject, getProjectOrThrow, updateProject } from "../src/modules/projects/operations";
import { issueAuthToken } from "../src/modules/identity/sessions";
import { encryptSecret } from "../src/shared/crypto";

let server: Server; let base: string; let token: string;
before(async () => {
  initializeDatabase(); token = issueAuthToken("admin"); server = app.listen(0);
  await new Promise<void>(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects`;
});
after(() => { server.close(); });
const project = () => createProject({ name: "mutation-fixture", sourceType: "upload" });
function patch(id: number, data: object): Promise<Response> {
  return fetch(`${base}/${id}`, { method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(data) });
}

test("HTTP update preserves legacy name and interval normalization while direct operations stay strict", async () => {
  const source = project();
  assert.equal((await patch(source.id, { name: "", healthCheckIntervalS: "37" })).status, 200);
  assert.equal(getProjectOrThrow(source.id).name, "mutation-fixture");
  assert.equal(getProjectOrThrow(source.id).healthCheckIntervalS, 0);
  assert.throws(() => updateProject(source.id, { name: "" }));
  updateProject(source.id, { healthCheckIntervalS: "37" });
  assert.equal(getProjectOrThrow(source.id).healthCheckIntervalS, 37);
});

test("HTTP credential normalization preserves legacy numeric-prefix inputs without weakening direct operations", async () => {
  const source = project();
  const id = Number(getDatabase().prepare("INSERT INTO credentials (type,alias,secret_enc) VALUES ('api_key','mutation-key',?)").run(encryptSecret("test-key")).lastInsertRowid);
  assert.equal((await patch(source.id, { credentialId: `${id}-legacy` })).status, 200);
  assert.equal(getProjectOrThrow(source.id).credentialId, id);
  assert.throws(() => updateProject(source.id, { credentialId: `${id}-legacy` }));
  assert.equal((await patch(source.id, { credentialId: "" })).status, 400);
});

test("HTTP and direct updates retain their distinct empty branch and nginx validation contracts", async () => {
  const source = project();
  assert.equal((await patch(source.id, { autoDeployBranch: "   " })).status, 200);
  assert.equal(getProjectOrThrow(source.id).autoDeployBranch, "");
  updateProject(source.id, { autoDeployBranch: "   " });
  assert.equal(getProjectOrThrow(source.id).autoDeployBranch, null);
  assert.equal((await patch(source.id, { nginxExtraConfig: "  " })).status, 400);
  updateProject(source.id, { nginxExtraConfig: "  " });
  assert.equal(getProjectOrThrow(source.id).nginxExtraConfig, null);
});

test("HTTP invalid branch types keep the existing selection and object ports stay rejected", async () => {
  const source = project();
  updateProject(source.id, { autoDeployBranch: "release" });
  assert.equal((await patch(source.id, { autoDeployBranch: 42 })).status, 200);
  assert.equal(getProjectOrThrow(source.id).autoDeployBranch, "release");
  assert.equal((await patch(source.id, { internalPort: [8080] })).status, 400);
  assert.equal(getProjectOrThrow(source.id).internalPort, null);
});
