import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { getDatabase, initializeDatabase } from "../src/config/database";
import { issueAuthToken } from "../src/modules/identity/sessions";
import { createProject } from "../src/modules/projects/operations";
import { actionRegistry, projectRepoKey } from "../src/modules/actions/registry";
import { clearPendingAutoDeploy, requestAutoDeploy } from "../src/modules/automation/autoDeploy";
import app from "../src/app";

let server: Server;
let base: string;
let token: string;

before(async () => {
  initializeDatabase();
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  token = issueAuthToken("admin");
});
after(() => { server.close(); });

const put = (id: number, enabled: unknown): Promise<Response> =>
  fetch(`${base}/api/projects/${id}/ingress-isolation`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) });

/** Occupies the project's action slot, as a deploy or a network change would. */
function hold(projectId: number, kind: string): () => void {
  let release!: () => void;
  actionRegistry.tryStart(projectRepoKey(projectId), kind, { projectId }, () => new Promise((resolve) => { release = () => resolve({ ok: true, output: "" }); }));
  return release;
}

test("the switch needs a login and a boolean, and an unknown project is a 404", async () => {
  const { id } = createProject({ name: "iso-route-a", sourceType: "upload" });
  assert.equal((await fetch(`${base}/api/projects/${id}/ingress-isolation`, { method: "PUT" })).status, 401);
  assert.equal((await put(id, "yes")).status, 400);
  assert.equal((await put(999999, true)).status, 404);
});

test("it is refused while a deploy is running for the project, and nothing is changed", async () => {
  const { id } = createProject({ name: "iso-route-b", sourceType: "upload" });
  const release = hold(id, "deploy");
  const res = await put(id, true);
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error: string }).error, /running for this project/);
  assert.equal((getDatabase().prepare("SELECT ingress_isolated AS v FROM projects WHERE id = ?").get(id) as { v: number }).v, 0);
  release();
});

test("asking for the state the project is already in is answered without taking the slot", async () => {
  const { id } = createProject({ name: "iso-route-c", sourceType: "upload" });
  const res = await put(id, false);
  assert.equal(res.status, 200);
  assert.deepEqual(((await res.json()) as { steps: string[] }).steps, ["Already in that state."]);
  assert.equal(actionRegistry.get(projectRepoKey(id))?.status === "running", false);
});

test("a deploy that arrives while a network change holds the slot is queued, not run", () => {
  const { id } = createProject({ name: "iso-route-d", sourceType: "github", githubRepo: "o/r" });
  const release = hold(id, "network");
  assert.equal(requestAutoDeploy(id, { sha: "a".repeat(40), commitMessage: null, commitAuthor: null, commitAt: null }, "webhook"), "queued");
  assert.equal((getDatabase().prepare("SELECT pending_deploy_sha AS p FROM projects WHERE id = ?").get(id) as { p: string }).p, "a".repeat(40));
  clearPendingAutoDeploy(id);
  release();
});

test("a project with no routed domain gets a clear answer from the switch, recorded as a finished action", async () => {
  const { id } = createProject({ name: "iso-route-e", sourceType: "upload" });
  const res = await put(id, true);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; reason: string; isolated: boolean };
  assert.equal(body.ok, false);
  assert.match(body.reason, /no routed domain/);
  assert.equal(body.isolated, false);
  assert.equal(actionRegistry.get(projectRepoKey(id))?.kind, "network");
  assert.equal(actionRegistry.get(projectRepoKey(id))?.status !== "running", true, "the slot is released");
});
