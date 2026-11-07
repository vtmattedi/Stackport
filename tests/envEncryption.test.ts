import { before, test } from "node:test";
import assert from "node:assert/strict";
import { getDatabase, initializeDatabase } from "../src/config/database";
import { createProject } from "../src/services/projectAdmin";
import { createProjectEnvFile, listProjectEnvFiles, updateProjectEnvFile } from "../src/services/projectDeploy";
import { collectSecrets } from "../src/services/actionLog";
import { readEnvVariables, sealEnvVariables } from "../src/services/projectEnvValues";

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
