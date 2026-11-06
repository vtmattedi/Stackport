import { before, test } from "node:test";
import assert from "node:assert/strict";
import { getDatabase, initializeDatabase } from "../src/config/database";
import { config } from "../src/config/env";
import { issueAuthToken, refreshAuthToken, sessionWindow, verifyStoredAuthToken } from "../src/services/authTokens";

before(() => { initializeDatabase(); });

const HOUR = 3_600_000;

test("the defaults are 24 hours idle and 12 hours in all", () => {
  assert.equal(config.sessionIdleHours, 24);
  assert.equal(config.sessionMaxHours, 12);
});

test("a session slides forward while in use but never past its cap", () => {
  const created = Date.parse("2026-01-01T00:00:00Z");
  const early = sessionWindow(created, created + HOUR);
  assert.equal(early.capMs, created + 12 * HOUR);
  assert.equal(early.expiresAtMs, created + 12 * HOUR, "24 h idle would be later than the cap, so the cap wins");
  assert.equal(sessionWindow(created, created + 13 * HOUR).expiresAtMs, created + 12 * HOUR);
});

test("a session that has reached its cap is refused and removed, even if it was just used", () => {
  const token = issueAuthToken("admin");
  const verified = verifyStoredAuthToken(token);
  assert.ok(verified, "a fresh session is accepted");

  const old = new Date(Date.now() - 13 * HOUR).toISOString();
  getDatabase().prepare("UPDATE auth_tokens SET created_at = ? WHERE id = ?").run(old, verified.tokenId);
  assert.equal(verifyStoredAuthToken(token), null, "past the cap");
  assert.equal((getDatabase().prepare("SELECT COUNT(*) AS n FROM auth_tokens WHERE id = ?").get(verified.tokenId) as { n: number }).n, 0, "the row is deleted");
});

test("refreshing a session past its cap throws instead of extending it", () => {
  const token = issueAuthToken("admin");
  const verified = verifyStoredAuthToken(token);
  assert.ok(verified);
  getDatabase().prepare("UPDATE auth_tokens SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 13 * HOUR).toISOString(), verified.tokenId);
  assert.throws(() => refreshAuthToken("admin", verified.tokenId), /maximum lifetime/);
});

test("refreshing a live session keeps it valid and never moves its expiry past the cap", () => {
  const token = issueAuthToken("admin");
  const verified = verifyStoredAuthToken(token);
  assert.ok(verified);
  const created = Date.now() - 11 * HOUR;
  getDatabase().prepare("UPDATE auth_tokens SET created_at = ? WHERE id = ?").run(new Date(created).toISOString(), verified.tokenId);
  const refreshed = refreshAuthToken("admin", verified.tokenId);
  assert.ok(verifyStoredAuthToken(refreshed));
  const row = getDatabase().prepare("SELECT expires_at FROM auth_tokens WHERE id = ?").get(verified.tokenId) as { expires_at: string };
  assert.ok(Date.parse(row.expires_at) <= created + 12 * HOUR + 1000, "expiry is at most the cap");
});

test("SQLite's own timestamp format (no zone) is read as UTC", () => {
  const token = issueAuthToken("admin");
  const verified = verifyStoredAuthToken(token);
  assert.ok(verified);
  const old = new Date(Date.now() - 13 * HOUR).toISOString().replace("T", " ").slice(0, 19);
  getDatabase().prepare("UPDATE auth_tokens SET created_at = ? WHERE id = ?").run(old, verified.tokenId);
  assert.equal(verifyStoredAuthToken(token), null);
});
