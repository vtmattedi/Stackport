import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatPolicyViolation, validateComposePolicy, validateResolvedComposePolicy } from "../src/services/composePolicy";
import { loadYamlDoc } from "../src/services/composeYaml";

/** These run real `docker compose config`, the same command a deploy resolves the file
 *  with, so they prove the policy sees what Compose will run. Skipped without Docker. */
function composeAvailable(): boolean {
  try { execFileSync("docker", ["compose", "version"], { stdio: "ignore" }); return true; } catch { return false; }
}
const skip = composeAvailable() ? false : "docker compose is not installed";

function resolve(files: Record<string, string>, env: NodeJS.ProcessEnv = {}): { dir: string; raw: unknown; resolved: unknown } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-resolved-"));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  const out = execFileSync("docker", ["compose", "-f", "compose.yml", "config", "--format", "json"], {
    cwd: dir, encoding: "utf8", env: { ...process.env, ...env },
  });
  return { dir, raw: loadYamlDoc(files["compose.yml"]), resolved: JSON.parse(out) };
}

test("d: a dangerous service in an included file is checked once the includes are merged", { skip }, () => {
  const { dir, raw, resolved } = resolve({
    "compose.yml": "include: [extra.yml]\nservices:\n  web:\n    image: alpine\n",
    "extra.yml": "services:\n  evil:\n    image: alpine\n    privileged: true\n",
  });
  try {
    assert.equal(validateComposePolicy(raw).ok, true, "the top file alone looks clean");
    const violations = validateResolvedComposePolicy(resolved, { projectDir: dir }).violations;
    assert.deepEqual(violations.map(formatPolicyViolation).map((line) => line.split(":")[0]), ["services.evil.privileged"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a: ${HOSTROOT:-/} resolves to the host root and is refused", { skip }, () => {
  const { dir, raw, resolved } = resolve({
    "compose.yml": "services:\n  web:\n    image: alpine\n    volumes: [\"${HOSTROOT:-" + (process.platform === "win32" ? "C:/" : "/") + "}:/host\"]\n",
  });
  try {
    assert.equal(validateComposePolicy(raw).ok, true, "the raw string is not a recognisable host path");
    assert.equal(validateResolvedComposePolicy(resolved, { projectDir: dir }).ok, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
