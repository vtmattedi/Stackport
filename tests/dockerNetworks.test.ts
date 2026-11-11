import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyNetwork, describeNetwork, readNetworkOverview, removalBlocker, removeNetworks, type RawNetwork } from "../src/modules/maintenance/networks";
import { DEFAULT_ADDRESS_POOLS } from "../src/modules/maintenance/networkHeadroom";

const projects = [{ id: 7, name: "Shop API" }, { id: 8, name: "blog" }];
const compose = (project: string): Record<string, string> => ({ "com.docker.compose.project": project });
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

test("only networks with nothing attached, and of a kind Stackport does not rebuild itself, may be removed", () => {
  const info = (raw: RawNetwork) => describeNetwork(raw, projects, DEFAULT_ADDRESS_POOLS);
  assert.equal(removalBlocker(info(net("old_default", { Labels: { "com.docker.compose.project": "old" } }))), null);
  assert.equal(removalBlocker(info(net("stackport-ingress-3"))), null);
  assert.match(removalBlocker(info(net("my-own-net"))) ?? "", /Not made by Compose/, "a hand-made network may be external to a stopped stack, and nothing would make it again");
  assert.equal(removalBlocker(info(net("7-shop-api_default", { Labels: { "com.docker.compose.project": "7-shop-api" } }))), null, "a stopped project's network comes back when it starts");
  assert.match(removalBlocker(info(net("busy_default", { Containers: { c1: { Name: "web-1" }, c2: { Name: "db-1" } } }))) ?? "", /2 containers are attached/);
  assert.match(removalBlocker(info(net("bridge"))) ?? "", /Docker's own/);
  assert.match(removalBlocker(info(net("stackport-proxy"))) ?? "", /Part of Stackport/);
  assert.match(removalBlocker(info(net("stackport-group-payments"))) ?? "", /network group/);
  assert.match(removalBlocker(info(net("stackport-iso-8"))) ?? "", /isolation off/);
});

test("removal re-reads the networks and removes only what is still removable; a name that is not a network is refused", async () => {
  const removed: string[] = [];
  const lines = [
    net("bridge"), net("stackport-proxy", { Containers: { n: { Name: "stackport-nginx" } } }), net("old_default", { Labels: compose("old") }), net("stackport-ingress-3"),
    net("busy_default", { Containers: { c1: { Name: "web-1" } } }), net("stackport-group-payments"), net("stubborn", { Labels: compose("stubborn") }), net("handmade"),
  ].map((n) => JSON.stringify(n)).join("\n");
  const run = async (args: string[]): Promise<string> => {
    if (args[0] === "info") return "null";
    if (args[1] === "ls") return "x\n";
    if (args[1] === "inspect") return lines;
    if (args[1] === "rm") {
      if (args[2] === "stubborn") throw new Error("Error response from daemon: network stubborn has active endpoints\nsecond line");
      removed.push(args[2]);
      return "";
    }
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  const results = await removeNetworks(["bridge", "stackport-proxy", "old_default", "stackport-ingress-3", "busy_default", "stackport-group-payments", "stubborn", "handmade", "nope", "old_default"], run, projects);
  assert.deepEqual(removed, ["old_default", "stackport-ingress-3"], "removed by name");
  assert.deepEqual(results.map((r) => [r.name, r.removed]), [["bridge", false], ["stackport-proxy", false], ["old_default", true], ["stackport-ingress-3", true], ["busy_default", false], ["stackport-group-payments", false], ["stubborn", false], ["handmade", false], ["nope", false]], "a repeated name is handled once");
  assert.match(results.find((r) => r.name === "stubborn")?.reason ?? "", /active endpoints$/, "only the first line of Docker's error");
  assert.equal(results.find((r) => r.name === "nope")?.reason, "No such network.");
  assert.match(results.find((r) => r.name === "handmade")?.reason ?? "", /Not made by Compose/);
});

test("a network that disappears between the list and the inspect does not fail the whole overview", async () => {
  const run = async (args: string[]): Promise<string> => {
    if (args[0] === "info") return "null";
    if (args[1] === "ls") return "a\nb\nc\n";
    if (args[1] === "inspect" && args.length > 5) throw new Error("Error: No such network: b");
    if (args[1] === "inspect" && args[2] === "b") throw new Error("Error: No such network: b");
    return JSON.stringify(net(`net-${args[2]}`));
  };
  const overview = await readNetworkOverview(run, projects);
  assert.deepEqual(overview.networks.map((n) => n.name), ["net-a", "net-c"], "the one that is gone is left out, the rest are read");
});
