import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatPolicyViolation, validateComposePolicy, validateResolvedComposePolicy } from "../src/services/composePolicy";
import { dumpYamlDoc, loadYamlDoc } from "../src/services/composeYaml";
import { buildHardeningOverride, DEFAULT_HARDENING } from "../src/services/containerHardening";

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

test("S2: an override replaces a bind source and keeps the mount's other settings (merged by container path)", { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-override-"));
  const managed = path.join(dir, "managed-data");
  fs.mkdirSync(managed);
  fs.writeFileSync(path.join(dir, "compose.yml"), "services:\n  web:\n    image: alpine\n    volumes:\n      - ./data:/data\n      - ./conf:/conf:ro\n");
  fs.writeFileSync(path.join(dir, "override.yml"), dumpYamlDoc({ services: { web: { volumes: [{ type: "bind", source: managed, target: "/data" }] } } }));
  try {
    const out = execFileSync("docker", ["compose", "-f", "compose.yml", "-f", "override.yml", "config", "--format", "json"], { cwd: dir, encoding: "utf8" });
    const volumes = (JSON.parse(out) as { services: { web: { volumes: { source: string; target: string; read_only?: boolean }[] } } }).services.web.volumes;
    assert.equal(volumes.length, 2, "merged by target, not appended");
    const data = volumes.find((v) => v.target === "/data");
    assert.equal(path.normalize(data?.source ?? ""), path.normalize(managed));
    assert.equal(volumes.find((v) => v.target === "/conf")?.read_only, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("S8: the hardening override adds no-new-privileges and limits without dropping the file's own settings", { skip }, () => {
  const { dir, resolved } = resolve({
    "compose.yml": "services:\n  web:\n    image: alpine\n    security_opt: [\"label:type:foo_t\"]\n    mem_limit: 2g\n  worker:\n    image: alpine\n",
  });
  try {
    fs.writeFileSync(path.join(dir, "hardening.yml"), buildHardeningOverride(resolved, DEFAULT_HARDENING) ?? "");
    const out = execFileSync("docker", ["compose", "-f", "compose.yml", "-f", "hardening.yml", "config", "--format", "json"], { cwd: dir, encoding: "utf8" });
    const services = (JSON.parse(out) as { services: Record<string, { security_opt?: string[]; mem_limit?: string | number; pids_limit?: number }> }).services;
    assert.deepEqual([...(services["web"].security_opt ?? [])].sort(), ["label:type:foo_t", "no-new-privileges:true"]);
    assert.equal(Number(services["web"].mem_limit), 2 * 1024 * 1024 * 1024, "the file's own memory limit wins");
    assert.equal(services["web"].pids_limit, 512);
    assert.equal(Number(services["worker"].mem_limit), 1024 * 1024 * 1024);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
