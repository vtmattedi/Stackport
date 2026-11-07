import { before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { getDatabase, initializeDatabase } from "../src/config/database";
import { createProject } from "../src/modules/projects/operations";
import { createProjectEnvFile, listProjectEnvFiles, updateProjectEnvFile, writeEnvFiles } from "../src/modules/deployments/operations";
import { collectSecrets } from "../src/modules/actions/log";
import { EnvFileUnreadableError, readEnvVariables, sealEnvVariables } from "../src/modules/projects/envFiles";

before(() => { initializeDatabase(); });

let projectId = 0;
function raw(id: number) {
  return getDatabase().prepare("SELECT variables_json, variables_enc FROM project_env_files WHERE id = ?").get(id) as { variables_json: string; variables_enc: string | null };
}

test("new env values are stored encrypted and read back unchanged", () => {
  projectId = createProject({ name: "env-enc", sourceType: "github", githubRepo: "o/r" }).id;
  const file = createProjectEnvFile(projectId, ".env", [{ key: "DB_PASSWORD", value: "correct-horse-battery" }]);
  const stored = raw(file.id);
  assert.equal(stored.variables_json, "[]", "no plain copy");
  assert.ok(stored.variables_enc);
  assert.equal(JSON.stringify(stored).includes("correct-horse-battery"), false, "the value is not in the row");
  assert.deepEqual(listProjectEnvFiles(projectId)[0].variables, [{ key: "DB_PASSWORD", value: "correct-horse-battery" }]);
});

test("an update replaces the ciphertext and leaves no plain copy", () => {
  const [file] = listProjectEnvFiles(projectId);
  const updated = updateProjectEnvFile(file.id, projectId, ".env", [{ key: "DB_PASSWORD", value: "second-value-here" }]);
  assert.deepEqual(updated?.variables, [{ key: "DB_PASSWORD", value: "second-value-here" }]);
  const stored = raw(file.id);
  assert.equal(stored.variables_json, "[]");
  assert.equal(JSON.stringify(stored).includes("second-value-here"), false);
});

test("a row written before the encryption is still readable", () => {
  const result = getDatabase().prepare("INSERT INTO project_env_files (project_id, relative_path, variables_json) VALUES (?, ?, ?)")
    .run(projectId, "legacy.env", JSON.stringify([{ key: "OLD", value: "plain-old-value" }]));
  const legacy = listProjectEnvFiles(projectId).find((f) => f.id === Number(result.lastInsertRowid));
  assert.deepEqual(legacy?.variables, [{ key: "OLD", value: "plain-old-value" }]);
});

test("the log masker still knows an encrypted project's values", () => {
  assert.ok(collectSecrets(projectId).includes("second-value-here"));
  assert.ok(collectSecrets(projectId).includes("plain-old-value"));
});

test("an unreadable value gives no variables instead of an error", () => {
  assert.deepEqual(readEnvVariables({ variables_json: "[]", variables_enc: "v2:deadbeef:00:00:00" }), []);
  assert.deepEqual(readEnvVariables({ variables_json: "not json" }), []);
  assert.equal(readEnvVariables(sealRow([{ key: "A", value: "1" }])).length, 1);
});

function sealRow(variables: { key: string; value: string }[]) {
  const sealed = sealEnvVariables(variables);
  return { variables_json: sealed.json, variables_enc: sealed.enc };
}

function unreadableFile(name: string): number {
  // Ciphertext under a key that is not configured, as after a key change without ENCRYPTION_KEY_PREVIOUS.
  const result = getDatabase().prepare("INSERT INTO project_env_files (project_id, relative_path, variables_json, variables_enc) VALUES (?, ?, '[]', ?)")
    .run(projectId, name, "v2:deadbeef:000000000000000000000000:00000000000000000000000000000000:00");
  return Number(result.lastInsertRowid);
}

test("a file whose values cannot be decrypted is reported as unreadable, not as empty", () => {
  const id = unreadableFile("lost.env");
  const file = listProjectEnvFiles(projectId).find((f) => f.id === id);
  assert.equal(file?.unreadable, true);
  assert.deepEqual(file?.variables, []);
  const readable = listProjectEnvFiles(projectId).find((f) => f.relativePath === ".env");
  assert.equal(readable?.unreadable, false);
});

test("saving over unreadable values is refused and leaves the ciphertext alone", () => {
  const id = unreadableFile("lost2.env");
  const before = raw(id).variables_enc;
  assert.throws(() => updateProjectEnvFile(id, projectId, "lost2.env", [{ key: "A", value: "1" }]), EnvFileUnreadableError);
  assert.equal(raw(id).variables_enc, before);
});

test("a deploy refuses to write a blank .env for values it cannot read", async () => {
  const id = unreadableFile("lost3.env");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-envwrite-"));
  try {
    const files = listProjectEnvFiles(projectId);
    await assert.rejects(writeEnvFiles(dir, files.filter((f) => f.id === id)), /cannot be decrypted/);
    assert.equal(fs.existsSync(path.join(dir, "lost3.env")), false, "nothing was written");
    const written = await writeEnvFiles(dir, files.filter((f) => f.relativePath === ".env"));
    assert.deepEqual(written, [".env"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
