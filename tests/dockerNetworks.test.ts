import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyNetwork, describeNetwork, readNetworkOverview, type RawNetwork } from "../src/modules/maintenance/networks";
import { DEFAULT_ADDRESS_POOLS } from "../src/modules/maintenance/networkHeadroom";

const projects = [{ id: 7, name: "Shop API" }, { id: 8, name: "blog" }];
const net = (name: string, extra: Partial<RawNetwork> = {}): RawNetwork => ({ Id: `${name}-id-0123456789abcdef`, Name: name, Driver: "bridge", Scope: "local", IPAM: { Config: [] }, Containers: {}, Labels: {}, ...extra });

test("a network is owned by Docker, Stackport, a project, a group, an isolated project, 1.3.0, or something else", () => {
  assert.deepEqual(classifyNetwork(net("bridge"), projects), { kind: "docker", label: "Docker", projectId: null });
  assert.equal(classifyNetwork(net("stackport-proxy"), projects).kind, "stackport");
  assert.equal(classifyNetwork(net("stackport_default", { Labels: { "com.docker.compose.project": "stackport" } }), projects).kind, "stackport");
  assert.deepEqual(classifyNetwork(net("7-shop-api_default", { Labels: { "com.docker.compose.project": "7-shop-api" } }), projects), { kind: "project", label: "Shop API", projectId: 7 });
  assert.deepEqual(classifyNetwork(net("stackport-group-payments"), projects), { kind: "group", label: "payments", projectId: null });
  assert.deepEqual(classifyNetwork(net("stackport-iso-8"), projects), { kind: "isolated", label: "blog", projectId: 8 });
  assert.match(classifyNetwork(net("stackport-iso-99"), projects).label, /gone/);
  assert.equal(classifyNetwork(net("stackport-ingress-3"), projects).kind, "legacy");
  assert.deepEqual(classifyNetwork(net("dokimos_default", { Labels: { "com.docker.compose.project": "dokimos" } }), projects), { kind: "other", label: "Compose project dokimos", projectId: null });
  assert.equal(classifyNetwork(net("my-own-net"), projects).kind, "other");
});

test("a network's slices come from the pools: a /16 in the pool is one, a range of Stackport's own costs none; containers are listed by name", () => {
  const inPool = describeNetwork(net("7-shop-api_default", { IPAM: { Config: [{ Subnet: "172.20.0.0/16" }] }, Containers: { bbbb0000000000: { Name: "web-1" }, aaaa0000000000: { Name: "db-1" } } }), projects, DEFAULT_ADDRESS_POOLS);
  assert.equal(inPool.slices, 1);
  assert.deepEqual(inPool.containers.map((c) => c.name), ["db-1", "web-1"]);
  assert.equal(describeNetwork(net("stackport-iso-7", { IPAM: { Config: [{ Subnet: "10.212.0.0/27" }] } }), projects, DEFAULT_ADDRESS_POOLS).slices, 0);
});

test("the overview is read from docker's own output, with the headroom computed from the same networks", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "info") return "null";
    if (args[0] === "network" && args[1] === "ls") return "id1\nid2\nid3\n";
    return [
      JSON.stringify(net("bridge", { IPAM: { Config: [{ Subnet: "172.17.0.0/16" }] } })),
      JSON.stringify(net("7-shop-api_default", { IPAM: { Config: [{ Subnet: "172.18.0.0/16" }] }, Containers: { c1: { Name: "web-1" } }, Labels: { "com.docker.compose.project": "7-shop-api" } })),
      "not json",
      JSON.stringify(net("stackport-group-payments", { IPAM: { Config: [{ Subnet: "172.19.0.0/16" }] } })),
    ].join("\n");
  };
  const overview = await readNetworkOverview(run, projects);
  assert.deepEqual(overview.networks.map((n) => [n.name, n.owner.kind, n.slices, n.containers.length]), [["7-shop-api_default", "project", 1, 1], ["bridge", "docker", 1, 0], ["stackport-group-payments", "group", 1, 0]]);
  assert.equal(overview.headroom.used, 3);
  assert.equal(overview.headroom.capacity, 31);
  assert.ok(calls.every((c) => c[0] === "info" || (c[0] === "network" && (c[1] === "ls" || c[1] === "inspect"))), "only reads: info, network ls, network inspect");
});
