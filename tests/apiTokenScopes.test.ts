import { before, test } from "node:test";
import assert from "node:assert/strict";
import { initializeDatabase } from "../src/config/database";
import { ApiTokenError, createApiToken, verifyApiToken } from "../src/modules/identity/apiTokens";

before(() => { initializeDatabase(); });

test("a token is read-only unless it is created with the write scope", () => {
  const { token, record } = createApiToken({ name: "reader" });
  assert.deepEqual(record.scopes, ["read"]);
  assert.equal(record.projectGroup, null);
  assert.ok(verifyApiToken(token, "read"));
  assert.equal(verifyApiToken(token, "write"), null);
});

test("a write token also reads, and defaults to every project", () => {
  const { token, record } = createApiToken({ name: "deployer", scope: "write" });
  assert.deepEqual(record.scopes, ["read", "write"]);
  assert.equal(record.projectGroup, null);
  assert.ok(verifyApiToken(token, "write"));
  assert.ok(verifyApiToken(token, "read"));
});

test("a write token can be limited to one project group", () => {
  const { token, record } = createApiToken({ name: "staging", scope: "write", projectGroup: "staging" });
  assert.equal(record.projectGroup, "staging");
  assert.equal(verifyApiToken(token, "write")?.projectGroup, "staging");
  assert.equal(createApiToken({ name: "blank", scope: "write", projectGroup: "" }).record.projectGroup, null, "empty means every project");
});

test("a group on a read token, an unknown scope and a bad group are refused", () => {
  for (const input of [
    { name: "x", scope: "read", projectGroup: "staging" },
    { name: "x", scope: "admin" },
    { name: "x", scope: "write", projectGroup: 7 },
    { name: "x", scope: "write", projectGroup: "g".repeat(81) },
  ]) {
    assert.throws(() => createApiToken(input), ApiTokenError);
  }
});

test("a status token only opens the live status stream: it is not a read token, and read and write tokens are not status tokens", () => {
  const status = createApiToken({ name: "bridge", scope: "status" });
  assert.deepEqual(status.record.scopes, ["status"]);
  assert.ok(verifyApiToken(status.token, "status"));
  assert.equal(verifyApiToken(status.token, "read"), null, "no MCP with it");
  assert.equal(verifyApiToken(status.token, "write"), null);
  assert.equal(verifyApiToken(createApiToken({ name: "r" }).token, "status"), null);
  assert.equal(verifyApiToken(createApiToken({ name: "w", scope: "write" }).token, "status"), null);
});

test("a status token can be limited to a project group, a read token cannot", () => {
  assert.equal(createApiToken({ name: "g", scope: "status", projectGroup: "staging" }).record.projectGroup, "staging");
  assert.throws(() => createApiToken({ name: "bad", scope: "read", projectGroup: "staging" }), /only applies to write and status tokens/);
  assert.throws(() => createApiToken({ name: "bad", scope: "admin" }), /scope must be/);
});
