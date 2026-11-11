import { before, test } from "node:test";
import assert from "node:assert/strict";
import { getDatabase, initializeDatabase } from "../src/config/database";
import { certificateNotifications, EXPIRY_WARNING_DAYS } from "../src/modules/ingress/certificates/notify";
import type { CertbotEntry } from "../src/modules/ingress/certificates/operations";
import { enqueuePushEventTx } from "../src/modules/notifications/push/outbox";

before(() => { initializeDatabase(); });

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
