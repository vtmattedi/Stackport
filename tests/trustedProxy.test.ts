import { test } from "node:test";
import assert from "node:assert/strict";
import { createTrustedProxy, isLoopback, normalizeAddress } from "../src/modules/ingress/trustedProxy";

test("loopback is trusted in every spelling", () => {
  for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.0.1.1"]) assert.equal(isLoopback(address), true, address);
  assert.equal(isLoopback("10.0.0.1"), false);
});

test("only nginx's resolved address is trusted, not the rest of the private range", async () => {
  const proxy = createTrustedProxy({ host: "stackport-nginx", lookup: async () => ["172.18.0.3"] });
  await proxy.refresh();
  assert.equal(proxy.trust("172.18.0.3"), true);
  assert.equal(proxy.trust("::ffff:172.18.0.3"), true);
  assert.equal(proxy.trust("172.18.0.9"), false, "another container on the same network");
  assert.equal(proxy.trust("10.0.0.5"), false);
  assert.equal(proxy.trust("192.168.1.20"), false);
});

test("before the first lookup only loopback is trusted", () => {
  const proxy = createTrustedProxy({ host: "stackport-nginx", lookup: async () => ["172.18.0.3"] });
  assert.equal(proxy.trust("172.18.0.3"), false);
  assert.equal(proxy.trust("127.0.0.1"), true);
});

test("a new address after nginx restarts is picked up, and the old one is dropped", async () => {
  let current = ["172.18.0.3"];
  const proxy = createTrustedProxy({ host: "n", lookup: async () => current });
  await proxy.refresh();
  current = ["172.18.0.7"];
  await proxy.refresh();
  assert.equal(proxy.trust("172.18.0.7"), true);
  assert.equal(proxy.trust("172.18.0.3"), false);
});

test("a failed lookup keeps the last known address and reports the error", async () => {
  let fail = false;
  const errors: unknown[] = [];
  const proxy = createTrustedProxy({
    host: "n",
    lookup: async () => { if (fail) throw new Error("ENOTFOUND"); return ["172.18.0.3"]; },
    onError: (error) => errors.push(error),
  });
  await proxy.refresh();
  fail = true;
  await proxy.refresh();
  assert.equal(proxy.trust("172.18.0.3"), true);
  assert.equal(errors.length, 1);
});

test("start waits for the first lookup, so nginx is trusted before the server takes requests", async () => {
  const proxy = createTrustedProxy({ host: "n", lookup: async () => ["172.18.0.3"] });
  assert.equal(proxy.trust("172.18.0.3"), false);
  await proxy.start();
  assert.equal(proxy.trust("172.18.0.3"), true);
  proxy.stop();
});

test("start gives up waiting after the limit when the lookup hangs, and a later success is still picked up", async () => {
  let release: (addresses: string[]) => void = () => {};
  const proxy = createTrustedProxy({ host: "n", lookup: () => new Promise<string[]>((resolveLookup) => { release = resolveLookup; }) });
  const started = Date.now();
  await proxy.start(50);
  assert.ok(Date.now() - started < 1000, "did not hang");
  assert.equal(proxy.trust("172.18.0.3"), false);
  release(["172.18.0.3"]);
  await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  assert.equal(proxy.trust("172.18.0.3"), true);
  proxy.stop();
});

test("addresses are normalised", () => {
  assert.equal(normalizeAddress("::ffff:10.1.2.3"), "10.1.2.3");
  assert.equal(normalizeAddress("fd00::1"), "fd00::1");
});
