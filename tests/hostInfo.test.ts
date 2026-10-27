import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import * as os from "os";
import * as path from "path";
import { readDiskSpace, readHostname, readNetworkTotals } from "../src/services/hostInfo";
import { networkRates } from "../src/services/hardwareSampler";

const root = mkdtempSync(path.join(os.tmpdir(), "hostinfo-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** A fake /sys/class/net: `device` marks a physical interface. */
function fakeSys(name: string, ifaces: Record<string, { rx: number; tx: number; device?: boolean }>): string {
  const sys = path.join(root, name);
  for (const [iface, { rx, tx, device }] of Object.entries(ifaces)) {
    const dir = path.join(sys, "class", "net", iface);
    mkdirSync(path.join(dir, "statistics"), { recursive: true });
    writeFileSync(path.join(dir, "statistics", "rx_bytes"), `${rx}\n`);
    writeFileSync(path.join(dir, "statistics", "tx_bytes"), `${tx}\n`);
    if (device) mkdirSync(path.join(dir, "device"));
  }
  return sys;
}

test("network totals count only interfaces backed by a device", async () => {
  const sys = fakeSys("physical", {
    eth0: { rx: 1000, tx: 500, device: true },
    eth1: { rx: 10, tx: 5, device: true },
    lo: { rx: 99999, tx: 99999 },
    docker0: { rx: 700, tx: 700 },
    veth1a2b: { rx: 700, tx: 700 },
  });
  assert.deepEqual(await readNetworkTotals(sys), { rxBytes: 1010, txBytes: 505, interfaces: ["eth0", "eth1"] });
});

test("without device links, virtual interfaces are left out by name", async () => {
  const sys = fakeSys("named", {
    ens3: { rx: 300, tx: 200 },
    lo: { rx: 5, tx: 5 },
    "br-abc123": { rx: 50, tx: 50 },
    veth9: { rx: 50, tx: 50 },
  });
  assert.deepEqual(await readNetworkTotals(sys), { rxBytes: 300, txBytes: 200, interfaces: ["ens3"] });
});

test("no host /sys mounted means no network data", async () => {
  assert.equal(await readNetworkTotals(path.join(root, "missing")), null);
});

test("rates between readings, and none across a reset or an interface change", () => {
  const at = (rx: number, tx: number, ms: number, interfaces = ["eth0"]) => ({ totals: { rxBytes: rx, txBytes: tx, interfaces }, at: ms });
  assert.deepEqual(networkRates(at(1000, 2000, 0), at(16000, 5000, 15000)), { rxBps: 1000, txBps: 200 });
  assert.equal(networkRates(null, at(1, 1, 0)), null);
  assert.equal(networkRates(at(5000, 5000, 0), at(10, 10, 15000)), null);
  assert.equal(networkRates(at(1, 1, 0), at(2, 2, 15000, ["eth0", "eth1"])), null);
});

test("hostname from the mounted file, else the container's own", async () => {
  const file = path.join(root, "hostname");
  writeFileSync(file, "vps-01\n");
  assert.equal(await readHostname(file), "vps-01");
  assert.equal(await readHostname(path.join(root, "nope")), os.hostname());
});

test("disk space of an existing directory, null for a missing one", async () => {
  const space = await readDiskSpace(root);
  assert.ok(space && space.totalBytes > 0 && space.freeBytes <= space.totalBytes);
  assert.equal(await readDiskSpace(path.join(root, "missing")), null);
});
