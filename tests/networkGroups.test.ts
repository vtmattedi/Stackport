import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "net";
import type { Server } from "http";
import app from "../src/app";
import { initializeDatabase, getDatabase } from "../src/config/database";
import { createProject, getProjectOrThrow } from "../src/modules/projects/operations";
import { issueAuthToken } from "../src/modules/identity/sessions";
import { getNetworkGroup, listNetworkGroupPeers, setNetworkGroup } from "../src/modules/projects/networkGroups";
import { groupAlias, groupNetworkName, isServiceName, normalizeNetworkGroup } from "../src/shared/networkGroups";
import { syncGroupNetwork, type GroupDocker } from "../src/modules/deployments/compose/groupNetworks";

let server: Server; let base: string; let token: string;
before(async () => {
  initializeDatabase(); token = issueAuthToken("admin"); server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects`;
});
after(() => { server.close(); });

test("names: a group is a short lower-case name, and the hostname carries the project id", () => {
  assert.equal(normalizeNetworkGroup("  Team-A "), "team-a");
  assert.equal(normalizeNetworkGroup(""), null);
  assert.equal(normalizeNetworkGroup(null), null);
  for (const bad of ["a b", "-x", "a/b", "x".repeat(41), "../x", 5]) assert.equal(normalizeNetworkGroup(bad), undefined, String(bad));
  assert.equal(groupNetworkName("team-a"), "stackport-group-team-a");
  assert.equal(groupAlias(7, "db"), "db.p7");
  assert.notEqual(groupAlias(7, "db"), groupAlias(8, "db"));
  assert.equal(isServiceName("web_1"), true);
  assert.equal(isServiceName("--rm"), false);
});

test("membership: stored per project, services cleared with the group, separate from the visual group", () => {
  const a = createProject({ name: "ng-a", sourceType: "upload", groupName: "Visual" });
  const b = createProject({ name: "ng-b", sourceType: "upload" });
  assert.deepEqual(getNetworkGroup(a.id), { group: null, services: [] });
  setNetworkGroup(a.id, "team", ["db", "api"]);
  setNetworkGroup(b.id, "team", ["cache"]);
  assert.deepEqual(getNetworkGroup(a.id), { group: "team", services: ["api", "db"] });
  assert.equal(getProjectOrThrow(a.id).networkGroup, "team");
  assert.equal(getProjectOrThrow(a.id).groupName, "Visual", "the list grouping is untouched");
  assert.deepEqual(listNetworkGroupPeers("team", a.id), [{ projectId: b.id, name: "ng-b", services: ["cache"] }]);
  setNetworkGroup(a.id, null, ["db"]);
  assert.deepEqual(getNetworkGroup(a.id), { group: null, services: [] });
  assert.equal((getDatabase().prepare("SELECT COUNT(*) AS n FROM network_group_services WHERE project_id = ?").get(a.id) as { n: number }).n, 0);
});

test("membership: deleting the project removes its services", () => {
  const p = createProject({ name: "ng-gone", sourceType: "upload" });
  setNetworkGroup(p.id, "team", ["db"]);
  getDatabase().prepare("DELETE FROM projects WHERE id = ?").run(p.id);
  assert.equal((getDatabase().prepare("SELECT COUNT(*) AS n FROM network_group_services WHERE project_id = ?").get(p.id) as { n: number }).n, 0);
});

/** A Docker with a few containers and the networks they are on; records what was asked of it. */
function fakeDocker(containers: Record<string, { service: string; networks: Record<string, string[]> }>, existingNetworks: string[] = []) {
  const calls: string[][] = [];
  const networks = new Set(existingNetworks);
  const docker: GroupDocker = async (args) => {
    calls.push(args);
    if (args[0] === "ps") return Object.keys(containers).join("\n");
    if (args[0] === "inspect") {
      const c = containers[args[args.length - 1]];
      return `${c.service}|${JSON.stringify(Object.fromEntries(Object.entries(c.networks).map(([n, aliases]) => [n, { Aliases: aliases }])))}`;
    }
    if (args[0] === "network" && args[1] === "inspect" && args.includes("{{.Id}}")) {
      if (!networks.has(args[2])) throw new Error(`Error: No such network: ${args[2]}`);
      return "id";
    }
    if (args[0] === "network" && args[1] === "create") { networks.add(args[args.length - 1]); return ""; }
    if (args[0] === "network" && args[1] === "ls") return [...networks].join("\n");
    if (args[0] === "network" && args[1] === "inspect") {
      const name = args[2];
      return String(Object.values(containers).filter((c) => name in c.networks).length);
    }
    if (args[0] === "network" && args[1] === "rm") { networks.delete(args[2]); return ""; }
    if (args[0] === "network" && args[1] === "connect") {
      const alias = args[args.indexOf("--alias") + 1];
      containers[args[args.length - 1]].networks[args[args.length - 2]] = [alias];
      return "";
    }
    if (args[0] === "network" && args[1] === "disconnect") { delete containers[args[3]].networks[args[2]]; return ""; }
    throw new Error(`unexpected docker ${args.join(" ")}`);
  };
  return { docker, calls, containers, networks };
}
const connects = (calls: string[][]) => calls.filter((c) => c[0] === "network" && c[1] === "connect");

test("sync: only the joined services are connected, each under its alias, and the network is created", async () => {
  const f = fakeDocker({ c1: { service: "db", networks: { "7-a_default": [] } }, c2: { service: "web", networks: { "7-a_default": [] } } });
  await syncGroupNetwork({ projectId: 7, composeProject: "7-a", group: "team", services: ["db"] }, f.docker);
  assert.deepEqual(connects(f.calls), [["network", "connect", "--alias", "db.p7", "stackport-group-team", "c1"]]);
  assert.equal(f.networks.has("stackport-group-team"), true);
  assert.equal("stackport-group-team" in f.containers["c2"].networks, false, "a service that did not join stays off");
});

test("sync: running it again changes nothing", async () => {
  const f = fakeDocker({ c1: { service: "db", networks: { "7-a_default": [], "stackport-group-team": ["db.p7"] } } }, ["stackport-group-team"]);
  await syncGroupNetwork({ projectId: 7, composeProject: "7-a", group: "team", services: ["db"] }, f.docker);
  assert.deepEqual(connects(f.calls), []);
  assert.deepEqual(f.calls.filter((c) => c[1] === "disconnect"), []);
});

test("sync: leaving the group disconnects the container and removes the empty network", async () => {
  const f = fakeDocker({ c1: { service: "db", networks: { "7-a_default": [], "stackport-group-team": ["db.p7"] } } }, ["stackport-group-team"]);
  await syncGroupNetwork({ projectId: 7, composeProject: "7-a", group: null, services: [] }, f.docker);
  assert.equal("stackport-group-team" in f.containers["c1"].networks, false);
  assert.equal(f.networks.has("stackport-group-team"), false);
});

test("sync: a service dropped from the list, or a changed group, is moved off the old network", async () => {
  const f = fakeDocker({
    c1: { service: "db", networks: { "stackport-group-old": ["db.p7"] } },
    c2: { service: "api", networks: { "stackport-group-team": ["api.p7"] } },
  }, ["stackport-group-old", "stackport-group-team"]);
  await syncGroupNetwork({ projectId: 7, composeProject: "7-a", group: "team", services: ["db"] }, f.docker);
  assert.deepEqual(Object.keys(f.containers["c1"].networks), ["stackport-group-team"]);
  assert.deepEqual(Object.keys(f.containers["c2"].networks), []);
});

test("sync: a network another project still uses is kept", async () => {
  const f = fakeDocker({
    c1: { service: "db", networks: { "stackport-group-team": ["db.p7"] } },
    c9: { service: "cache", networks: { "stackport-group-team": ["cache.p9"] } },
  }, ["stackport-group-team"]);
  // c9 belongs to another Compose project, which this sync does not list; the fake lists everything, so give it a project filter.
  const only = { ...f, docker: (async (args: string[]) => (args[0] === "ps" ? "c1" : f.docker(args))) as GroupDocker };
  await syncGroupNetwork({ projectId: 7, composeProject: "7-a", group: null, services: [] }, only.docker);
  assert.deepEqual(Object.keys(f.containers["c9"].networks), ["stackport-group-team"]);
  assert.equal(f.networks.has("stackport-group-team"), true);
});

function put(id: number, body: object): Promise<Response> {
  return fetch(`${base}/${id}/network-group`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("HTTP: the group is saved, listed with hostnames and peers, and cleared by an empty group", async () => {
  const a = createProject({ name: "ng-http-a", sourceType: "upload" });
  const b = createProject({ name: "ng-http-b", sourceType: "upload" });
  assert.equal((await put(b.id, { group: "Shared", services: ["cache"] })).status, 200);
  const saved = await put(a.id, { group: "shared", services: ["db", "db", "api"] });
  assert.equal(saved.status, 200);
  const view = await saved.json() as { group: string; services: string[]; hostnames: { hostname: string }[]; peers: { name: string; hostnames: { hostname: string }[] }[] };
  assert.equal(view.group, "shared");
  assert.deepEqual(view.services, ["api", "db"]);
  assert.deepEqual(view.hostnames.map((h) => h.hostname), [`api.p${a.id}`, `db.p${a.id}`]);
  assert.deepEqual(view.peers.map((p) => [p.name, p.hostnames[0].hostname]), [["ng-http-b", `cache.p${b.id}`]]);
  const cleared = await put(a.id, { group: "", services: ["db"] });
  assert.deepEqual(((await cleared.json()) as { services: string[] }).services, []);
});

test("HTTP: a bad group name or service name is refused and nothing changes", async () => {
  const p = createProject({ name: "ng-http-bad", sourceType: "upload" });
  assert.equal((await put(p.id, { group: "has space" })).status, 400);
  assert.equal((await put(p.id, { group: "ok", services: ["--rm"] })).status, 400);
  assert.equal((await put(p.id, { group: "ok", services: "db" })).status, 400);
  assert.equal((await put(99999, { group: "ok" })).status, 404);
  assert.deepEqual(getNetworkGroup(p.id), { group: null, services: [] });
});
