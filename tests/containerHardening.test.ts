import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHardeningOverride, DEFAULT_HARDENING } from "../src/services/containerHardening";
import { loadYamlDoc } from "../src/services/composeYaml";

const parse = (text: string | null) => loadYamlDoc(text ?? "") as { services: Record<string, Record<string, unknown>> };
const build = (resolved: unknown, defaults = DEFAULT_HARDENING) => parse(buildHardeningOverride(resolved, defaults));

test("every service gets no-new-privileges and the default limits", () => {
  const out = build({ services: { web: { image: "x" }, db: { image: "y" } } });
  assert.deepEqual(out.services["web"], { security_opt: ["no-new-privileges:true"], mem_limit: "1024m", pids_limit: 512 });
  assert.deepEqual(Object.keys(out.services), ["web", "db"]);
});

test("a limit the service declares itself is kept, in either spelling", () => {
  const out = build({ services: {
    a: { mem_limit: "4g", pids_limit: 2000 },
    b: { deploy: { resources: { limits: { memory: "2g", pids: 100 } } } },
    c: { mem_limit: "512m" },
  } });
  assert.deepEqual(out.services["a"], { security_opt: ["no-new-privileges:true"] });
  assert.deepEqual(out.services["b"], { security_opt: ["no-new-privileges:true"] });
  assert.deepEqual(out.services["c"], { security_opt: ["no-new-privileges:true"], pids_limit: 512 });
});

test("a default of 0 turns that limit off", () => {
  const out = build({ services: { web: {} } }, { pidsLimit: 0, memoryMb: 2048 });
  assert.deepEqual(out.services["web"], { security_opt: ["no-new-privileges:true"], mem_limit: "2048m" });
  assert.deepEqual(build({ services: { web: {} } }, { pidsLimit: 0, memoryMb: 0 }).services["web"], { security_opt: ["no-new-privileges:true"] });
});

test("no services, no override", () => {
  assert.equal(buildHardeningOverride({ services: {} }, DEFAULT_HARDENING), null);
  assert.equal(buildHardeningOverride(null, DEFAULT_HARDENING), null);
});
