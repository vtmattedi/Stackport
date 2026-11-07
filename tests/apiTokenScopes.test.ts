import { before, test } from "node:test";
import assert from "node:assert/strict";
import { initializeDatabase } from "../src/config/database";
import { ApiTokenError, createApiToken, verifyApiToken } from "../src/services/apiTokens";

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
