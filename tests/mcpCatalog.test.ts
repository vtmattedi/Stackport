import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { initializeDatabase } from "../src/config/database";
import { issueAuthToken } from "../src/modules/identity/sessions";
import { listMcpTools } from "../src/transports/mcp/catalog";
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

test("the catalog lists every tool with the scope it needs, and write tools are destructive and two-step", async () => {
  const tools = await listMcpTools();
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  for (const name of ["stackport_status", "stackport_list_projects", "stackport_get_project", "stackport_list_managed_domains", "stackport_list_github_repositories"]) {
    assert.equal(by[name]?.scope, "read", `${name} is available to a read token`);
    assert.equal(by[name].destructive, false);
    assert.equal(by[name].twoStep, false);
  }
  const write = tools.filter((t) => t.scope === "write").map((t) => t.name).sort();
  assert.deepEqual(write, ["stackport_create_project_from_repository", "stackport_deploy_project", "stackport_restart_project", "stackport_rollback_project", "stackport_set_network_group", "stackport_set_project_hostname", "stackport_stop_project"]);
  for (const t of tools.filter((x) => x.scope === "write")) {
    assert.equal(t.destructive, true, `${t.name} is marked destructive`);
    assert.equal(t.twoStep, true, `${t.name} takes two calls`);
    assert.ok(!t.parameters.some((p) => p.name === "confirmationId"), "the confirmation id is explained by twoStep, not listed");
  }
  assert.deepEqual(by["stackport_get_project"].parameters.map((p) => [p.name, p.type, p.required]), [["projectId", "integer", true]]);
});

test("the catalog is for the admin session only", async () => {
  assert.equal((await fetch(`${base}/api/api-tokens/tools`)).status, 401);
  const res = await fetch(`${base}/api/api-tokens/tools`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { tools: { name: string }[] };
  assert.ok(body.tools.length >= 12);
});
