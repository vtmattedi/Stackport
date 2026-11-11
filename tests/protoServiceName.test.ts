import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHardeningOverride } from "../src/modules/deployments/compose/hardening";
import { buildVolumesOverride, planManagedVolumes } from "../src/modules/deployments/compose/managedVolumes";

// Compose allows a service called `__proto__`, and `docker compose config` prints it as an own key.
const resolved = JSON.parse('{"services":{"__proto__":{"image":"x","volumes":[{"type":"bind","source":"/app/data/repos/1-p/data","target":"/data"}]},"web":{"image":"y"}}}');

test("a service named __proto__ still gets the hardened defaults", () => {
  const yaml = buildHardeningOverride(resolved, { memoryMb: 512, pidsLimit: 100 });
  assert.ok(yaml);
  assert.match(yaml, /__proto__/);
  assert.match(yaml, /web/);
});

test("a service named __proto__ alone is not skipped", () => {
  const only = JSON.parse('{"services":{"__proto__":{"image":"x"}}}');
  assert.notEqual(buildHardeningOverride(only, { memoryMb: 512, pidsLimit: 100 }), null);
});

test("a service named __proto__ gets its managed mounts without a crash", () => {
  const plan = planManagedVolumes(resolved, { projectId: 1, projectDir: "/app/data/repos/1-p", roots: { containerDataRoot: "/app/data", hostDataRoot: "/var/lib/stackport/data" }, isFile: () => false });
  const yaml = buildVolumesOverride(plan);
  assert.ok(yaml);
  assert.match(yaml, /__proto__/);
  assert.match(yaml, /\/var\/lib\/stackport\/data\/volumes\//);
});
