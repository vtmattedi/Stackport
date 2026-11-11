import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "net";
import type { Server } from "http";
import type os from "node:os";
import { getDatabase, initializeDatabase } from "../src/config/database";
import { issueAuthToken } from "../src/modules/identity/sessions";
import { createProject } from "../src/modules/projects/operations";
import { addProjectDomain } from "../src/modules/ingress/domains";
import { addManagedDomain, addManagedProjectDomain, listHostnames, listManagedDomains } from "../src/modules/ingress/managedDomains";
import {
  checkBaseDomain, checkHostname, checkName, detectPublicAddress, dnsGate, getServerAddress, isPublicIPv4, runDnsChecks, setServerAddress, type Resolver,
} from "../src/modules/ingress/dnsCheck";
import { certificateNotifications, EXPIRY_WARNING_DAYS } from "../src/modules/ingress/certificates/notify";
import type { CertbotEntry } from "../src/modules/ingress/certificates/operations";
import { enqueuePushEventTx } from "../src/modules/notifications/push/outbox";
import app from "../src/app";

const HERE = "203.0.113.10";
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

function reset(): void {
  getDatabase().prepare("DELETE FROM project_domains").run();
  getDatabase().prepare("DELETE FROM managed_domains").run();
  getDatabase().prepare("DELETE FROM app_meta WHERE key = 'server_public_address'").run();
}
const project = (name: string): number => createProject({ name, sourceType: "upload" }).id;

/** A resolver from a table of name to addresses; a name not in it does not resolve. */
const table = (records: Record<string, string[]>, wildcard?: { base: string; to: string[] }): Resolver => async (name) => {
  if (records[name]) return records[name];
  if (wildcard && name.endsWith(`.${wildcard.base}`) && name.startsWith("sp-check-")) return wildcard.to;
  return [];
};

// ---- this server's address

test("public IPv4: private, loopback, link-local, CGNAT and multicast ranges are not", () => {
  for (const ok of ["203.0.113.10", "8.8.8.8", "172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1"]) assert.equal(isPublicIPv4(ok), true, ok);
  for (const no of ["10.1.2.3", "127.0.0.1", "192.168.1.1", "172.16.0.1", "172.31.255.255", "169.254.1.1", "100.64.0.1", "100.127.255.255", "224.0.0.1", "0.0.0.0", "999.1.1.1", "1.2.3", "a.b.c.d", ""]) assert.equal(isPublicIPv4(no), false, no);
});

test("detection takes the first public IPv4 on a real interface, and finds nothing behind NAT", () => {
  const nic = (address: string, internal = false, family: "IPv4" | "IPv6" = "IPv4"): os.NetworkInterfaceInfo => ({ address, netmask: "", family, mac: "", internal, cidr: null } as os.NetworkInterfaceInfo);
  assert.equal(detectPublicAddress({ lo: [nic("127.0.0.1", true)], eth0: [nic("fe80::1", false, "IPv6"), nic("10.0.0.5"), nic(HERE)] }), HERE);
  assert.equal(detectPublicAddress({ lo: [nic("127.0.0.1", true)], eth0: [nic("10.0.0.5"), nic("192.168.1.2")] }), null);
  assert.equal(detectPublicAddress({}), null);
});

test("a saved address wins over detection, is validated, and clearing it returns to detection", () => {
  reset();
  setServerAddress(" 198.51.100.7 ");
  assert.deepEqual([getServerAddress().address, getServerAddress().source, getServerAddress().setting], ["198.51.100.7", "setting", "198.51.100.7"]);
  for (const bad of ["nope", "1.2.3", "300.1.1.1", 5]) assert.throws(() => setServerAddress(bad), /IPv4/, String(bad));
  assert.equal(getServerAddress().setting, "198.51.100.7", "a bad value changed nothing");
  setServerAddress(null);
  assert.equal(getServerAddress().setting, null);
  assert.notEqual(getServerAddress().source, "setting");
});

// ---- the checks

test("a name is ok, not resolving, pointing elsewhere or unknown", async () => {
  assert.equal((await checkName("a.example.com", HERE, table({ "a.example.com": [HERE] }))).status, "ok");
  assert.equal((await checkName("a.example.com", HERE, table({ "a.example.com": ["198.51.100.1", HERE] }))).status, "ok", "one of several is enough");
  const nothing = await checkName("a.example.com", HERE, table({}));
  assert.equal(nothing.status, "not-resolving");
  assert.match(nothing.detail, new RegExp(`A record pointing at ${HERE.replace(/\./g, "\\.")}`));
  const elsewhere = await checkName("a.example.com", HERE, table({ "a.example.com": ["198.51.100.1"] }));
  assert.equal(elsewhere.status, "points-elsewhere");
  assert.match(elsewhere.detail, /198\.51\.100\.1/);
  assert.equal((await checkName("a.example.com", null, table({}))).status, "unknown", "without this server's address there is nothing to compare");
  assert.equal((await checkName("a.example.com", HERE, async () => { throw new Error("SERVFAIL"); })).status, "unknown", "a failed lookup is not 'not resolving'");
});

test("a base domain with a wildcard record resolves a name nobody created; without one each hostname is checked by itself", async () => {
  const wild = await checkBaseDomain("example.com", HERE, table({}, { base: "example.com", to: [HERE] }));
  assert.equal(wild.status, "ok");
  assert.match(wild.detail, /wildcard/i);
  const none = await checkBaseDomain("example.com", HERE, table({}));
  assert.equal(none.status, "not-resolving");
  assert.match(none.detail, /each hostname needs its own record/);
  const elsewhere = await checkBaseDomain("example.com", HERE, table({}, { base: "example.com", to: ["198.51.100.1"] }));
  assert.equal(elsewhere.status, "points-elsewhere");
  const seen: string[] = [];
  await checkBaseDomain("example.com", HERE, async (name) => { seen.push(name); return []; });
  await checkBaseDomain("example.com", HERE, async (name) => { seen.push(name); return []; });
  assert.ok(seen.every((n) => /^sp-check-[0-9a-f]{10}\.example\.com$/.test(n)));
  assert.notEqual(seen[0], seen[1], "a fresh random name each time, so a cached answer cannot pass for a wildcard");
});

test("a hostname and the other name it answers (www, or the bare domain) are judged together: the worse result counts", async () => {
  const only = table({ "example.com": [HERE] });
  assert.equal((await checkHostname("example.com", null, HERE, only)).status, "ok");
  const lacking = await checkHostname("example.com", "www.example.com", HERE, only);
  assert.equal(lacking.status, "not-resolving");
  assert.match(lacking.detail, /www\.example\.com/);
  const both = table({ "example.com": [HERE], "www.example.com": [HERE] });
  assert.equal((await checkHostname("example.com", "www.example.com", HERE, both)).status, "ok");
  const wrong = table({ "example.com": [HERE], "www.example.com": ["198.51.100.1"] });
  assert.equal((await checkHostname("example.com", "www.example.com", HERE, wrong)).status, "points-elsewhere");
});

test("running the checks records the base domain's result and each hostname's, apex hostnames including www", async () => {
  reset();
  setServerAddress(HERE);
  const baseDomain = addManagedDomain("example.com");
  addManagedProjectDomain(project("dns-a"), baseDomain.id, "shop", "web", 80);
  addManagedProjectDomain(project("dns-b"), baseDomain.id, "@", "web", 80);
  const result = await runDnsChecks(baseDomain.id, table({ "shop.example.com": [HERE], "example.com": [HERE] }))!;
  assert.equal(result?.domain.status, "not-resolving", "no wildcard");
  const by = Object.fromEntries((result?.hostnames ?? []).map((h) => [h.domain, h.result.status]));
  assert.deepEqual(by, { "shop.example.com": "ok", "example.com": "not-resolving" }, "the bare domain needs www too");
  assert.equal(listManagedDomains()[0].dnsStatus, "not-resolving");
  assert.ok(listManagedDomains()[0].dnsCheckedAt);
  const overview = Object.fromEntries(listHostnames().map((h) => [h.domain, h.dnsStatus]));
  assert.deepEqual(overview, { "shop.example.com": "ok", "example.com": "not-resolving" });
  assert.equal(await runDnsChecks(999999), null);
});

// ---- gating certificates

test("a certificate is not asked for a managed hostname that does not resolve here, and the reason says what to do", async () => {
  reset();
  setServerAddress(HERE);
  const baseDomain = addManagedDomain("example.com");
  addManagedProjectDomain(project("gate-a"), baseDomain.id, "shop", "web", 80);
  const blocked = await dnsGate("shop.example.com", table({}));
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason ?? "", /does not resolve/);
  assert.match(blocked.reason ?? "", /Create the DNS record first/);
  assert.equal((await dnsGate("shop.example.com", table({ "shop.example.com": ["198.51.100.1"] }))).ok, false, "pointing elsewhere is refused too");
  assert.equal((await dnsGate("shop.example.com", table({ "shop.example.com": [HERE] }))).ok, true, "and passes as soon as the record exists");
});

test("the gate covers www for a bare domain, because the certificate does", async () => {
  reset();
  setServerAddress(HERE);
  const baseDomain = addManagedDomain("example.com");
  addManagedProjectDomain(project("gate-www"), baseDomain.id, "@", "web", 80);
  const gate = await dnsGate("example.com", table({ "example.com": [HERE] }));
  assert.equal(gate.ok, false);
  assert.match(gate.reason ?? "", /www\.example\.com/);
  assert.equal((await dnsGate("example.com", table({ "example.com": [HERE], "www.example.com": [HERE] }))).ok, true);

  reset();
  setServerAddress(HERE);
  const second = addManagedDomain("example.org");
  addManagedProjectDomain(project("gate-canonical"), second.id, "@", "web", 80, "www");
  const canonical = await dnsGate("www.example.org", table({ "www.example.org": [HERE] }));
  assert.equal(canonical.ok, false);
  assert.match(canonical.reason ?? "", /example\.org/, "with www canonical, the bare domain is the other name");
});

test("the gate stays out of the way for unmanaged hostnames, and when this server's address is not known", async () => {
  reset();
  addProjectDomain(project("gate-unmanaged"), "plain.org");
  setServerAddress(HERE);
  assert.equal((await dnsGate("plain.org", table({}))).ok, true, "unmanaged: unchanged behaviour");
  assert.equal((await dnsGate("not-a-hostname.example", table({}))).ok, true);
  const baseDomain = addManagedDomain("example.com");
  addManagedProjectDomain(project("gate-noaddr"), baseDomain.id, "shop", "web", 80);
  setServerAddress(null);
  if (getServerAddress().address === null) assert.equal((await dnsGate("shop.example.com", table({}))).ok, true, "nothing to compare with");
});

// ---- notifications

const entry = (domain: string, daysFromNow: number | null, hasCertificate = true): CertbotEntry => ({
  domain, type: "domain", hasCertificate, status: "valid", issuer: null, path: null,
  expiresAt: daysFromNow === null ? null : new Date(Date.UTC(2026, 10, 10, 12) + daysFromNow * 86_400_000).toISOString(),
});
const NOW = new Date(Date.UTC(2026, 10, 10, 12));

test("a certificate under 14 days from expiry is reported once per certificate and day; a healthy one is not", () => {
  const events = certificateNotifications([entry("soon.example.com", 5), entry("later.example.com", EXPIRY_WARNING_DAYS + 5), entry("edge.example.com", EXPIRY_WARNING_DAYS), entry("gone.example.com", 5, false), entry("unknown.example.com", null)], false, NOW);
  assert.deepEqual(events.map((e) => e.eventKey), ["certificate_expiring:soon_example_com:20261110"]);
  assert.match(events[0].title, /expires in 5 days/);
  assert.equal(events[0].severity, "warning");
  const urgent = certificateNotifications([entry("urgent.example.com", 2), entry("done.example.com", -1)], false, NOW);
  assert.deepEqual(urgent.map((e) => [e.severity, e.title.includes("now")]), [["error", false], ["error", true]]);
  assert.deepEqual(certificateNotifications([entry("soon.example.com", 5)], false, NOW).map((e) => e.eventKey), events.map((e) => e.eventKey), "the same key on the same day");
  assert.notEqual(certificateNotifications([entry("soon.example.com", 5)], false, new Date(NOW.getTime() + 86_400_000))[0].eventKey, events[0].eventKey, "a new day, a new notification");
});

test("a failed renewal sweep is its own notification, once a day", () => {
  const events = certificateNotifications([], true, NOW);
  assert.deepEqual(events.map((e) => [e.type, e.eventKey, e.url]), [["certificate_renewal_failed", "certificate_renewal_failed:20261110", "/settings/domains"]]);
  assert.deepEqual(certificateNotifications([], false, NOW), []);
});

test("the notifications pass the push outbox's identity and URL checks, and the same key is stored once", () => {
  const db = getDatabase();
  for (const event of [...certificateNotifications([entry("outbox.example.com", 3)], true, new Date())]) {
    const durable = { eventKey: event.eventKey as string, type: event.type as "certificate_expiring" | "certificate_renewal_failed", severity: event.severity, title: event.title, body: event.body, url: event.url, createdAt: event.createdAt };
    enqueuePushEventTx(db, durable);
    const second = enqueuePushEventTx(db, durable);
    assert.equal(second.inserted, false, `${event.type}: the same key is not stored twice`);
  }
});

// ---- over HTTP

const call = (method: string, path: string, body?: unknown, auth = true): Promise<Response> =>
  fetch(`${base}/api${path}`, { method, headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });

test("the settings and check endpoints need a login and validate", async () => {
  reset();
  assert.equal((await call("GET", "/domains/settings", undefined, false)).status, 401);
  assert.equal((await call("PUT", "/domains/settings", { publicAddress: HERE }, false)).status, 401);
  assert.equal((await call("POST", "/domains/1/check", undefined, false)).status, 401);
  assert.equal((await call("PUT", "/domains/settings", { publicAddress: "nope" })).status, 400);
  const saved = await call("PUT", "/domains/settings", { publicAddress: HERE });
  assert.equal(saved.status, 200);
  assert.equal(((await saved.json()) as { server: { address: string } }).server.address, HERE);
  assert.equal((await call("POST", "/domains/999999/check")).status, 404);
  const cleared = await call("PUT", "/domains/settings", { publicAddress: null });
  assert.equal(((await cleared.json()) as { server: { setting: string | null } }).server.setting, null);
});
