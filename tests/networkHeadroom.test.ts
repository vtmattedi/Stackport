import { test } from "node:test";
import assert from "node:assert/strict";
import { computeHeadroom, DEFAULT_ADDRESS_POOLS, poolCapacity, readNetworkHeadroom, slotsTaken } from "../src/modules/maintenance/networkHeadroom";

test("Docker's stock pools hold 31 networks", () => {
  assert.equal(DEFAULT_ADDRESS_POOLS.reduce((sum, pool) => sum + poolCapacity(pool), 0), 31);
});

test("a configured pool's capacity is the number of networks of its size that fit", () => {
  assert.equal(poolCapacity({ base: "10.20.0.0/14", size: 24 }), 1024);
  assert.equal(poolCapacity({ base: "10.0.0.0/16", size: 16 }), 1);
  assert.equal(poolCapacity({ base: "10.0.0.0/24", size: 16 }), 0); // asking for networks larger than the pool
  assert.equal(poolCapacity({ base: "not a cidr", size: 24 }), 0);
});

test("a subnet outside the pools costs nothing, one inside costs a slice, a wide one costs several", () => {
  assert.equal(slotsTaken("10.9.0.0/24", DEFAULT_ADDRESS_POOLS), 0);
  assert.equal(slotsTaken("172.20.0.0/16", DEFAULT_ADDRESS_POOLS), 1);
  assert.equal(slotsTaken("192.168.16.0/20", DEFAULT_ADDRESS_POOLS), 1);
  assert.equal(slotsTaken("192.168.0.0/16", [{ base: "192.168.0.0/16", size: 20 }]), 16);
  assert.equal(slotsTaken("garbage", DEFAULT_ADDRESS_POOLS), 0);
});

test("the level turns to warning with 6 slices left and critical with 2", () => {
  const subnets = (count: number): string[] => Array.from({ length: count }, (_, i) => `172.${17 + i}.0.0/16`);
  assert.equal(computeHeadroom(DEFAULT_ADDRESS_POOLS, subnets(10), true).level, "ok");
  const warn = computeHeadroom(DEFAULT_ADDRESS_POOLS, subnets(15).concat(Array.from({ length: 10 }, (_, i) => `192.168.${i * 16}.0/20`)), true);
  assert.equal(warn.free, 6);
  assert.equal(warn.level, "warning");
  assert.match(warn.advice ?? "", /default-address-pools/);
  const critical = computeHeadroom(DEFAULT_ADDRESS_POOLS, subnets(15).concat(Array.from({ length: 14 }, (_, i) => `192.168.${i * 16}.0/20`)), true);
  assert.equal(critical.free, 2);
  assert.equal(critical.level, "critical");
  assert.equal(computeHeadroom(DEFAULT_ADDRESS_POOLS, subnets(3), true).advice, null);
});

test("it reads the daemon's pools and the subnets of every network", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "info") return JSON.stringify([{ Base: "10.20.0.0/22", Size: 24 }]);
    if (args[1] === "ls") return "aaa\nbbb\nccc\n";
    return "10.20.0.0/24\n10.20.1.0/24\n172.17.0.0/16\n";
  };
  const result = await readNetworkHeadroom(run);
  assert.equal(result.poolsKnown, true);
  assert.equal(result.capacity, 4);
  assert.equal(result.used, 2); // 172.17 is outside the configured pool
  assert.equal(result.level, "critical");
  assert.deepEqual(calls[2].slice(0, 5), ["network", "inspect", "aaa", "bbb", "ccc"]);
});

test("with no custom pools the stock ones apply, and when the daemon cannot be asked that is said", async () => {
  const stock = await readNetworkHeadroom(async (args) => (args[0] === "info" ? "null" : args[1] === "ls" ? "" : ""));
  assert.equal(stock.capacity, 31);
  assert.equal(stock.poolsKnown, false);
  const broken = await readNetworkHeadroom(async (args) => { if (args[0] === "info") throw new Error("boom"); return ""; });
  assert.equal(broken.capacity, 31);
  assert.equal(broken.poolsKnown, false);
});
