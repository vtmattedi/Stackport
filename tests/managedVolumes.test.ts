import { test } from "node:test";
import assert from "node:assert/strict";
import { buildVolumesOverride, managedVolumesRoot, planManagedVolumes, type PlanOptions } from "../src/modules/deployments/compose/managedVolumes";
import { loadYamlDoc } from "../src/modules/deployments/compose/yaml";

const options: PlanOptions = {
  projectId: 7,
  projectDir: "/app/data/repos/7-shop",
  roots: { containerDataRoot: "/app/data", hostDataRoot: "/var/lib/stackport/data" },
  isFile: (source) => source.endsWith(".db") || source.endsWith(".conf"),
};
const bind = (source: string, target: string, readOnly = false) => ({ type: "bind", source, target, ...(readOnly ? { read_only: true } : {}) });
const doc = (volumes: unknown[], service = "web") => ({ services: { [service]: { image: "x", volumes } } });

test("a writable directory in the checkout becomes a managed directory on the host's data path", () => {
  const [entry] = planManagedVolumes(doc([bind("/app/data/repos/7-shop/data", "/data")]), options);
  assert.equal(entry.action, "managed");
  assert.equal(entry.name, "data");
  assert.equal(entry.managedContainerPath, "/app/data/volumes/7/data");
  assert.equal(entry.managedHostPath, "/var/lib/stackport/data/volumes/7/data");
});

test("a nested path gets a flat, safe name", () => {
  const [entry] = planManagedVolumes(doc([bind("/app/data/repos/7-shop/var/lib/my db", "/x")]), options);
  assert.equal(entry.name, "var__lib__my_db");
});

test("two services mounting the same directory share one managed directory", () => {
  const resolved = { services: {
    web: { volumes: [bind("/app/data/repos/7-shop/uploads", "/u")] },
    worker: { volumes: [bind("/app/data/repos/7-shop/uploads", "/u")] },
  } };
  const plan = planManagedVolumes(resolved, options);
  assert.deepEqual(plan.map((p) => p.name), ["uploads", "uploads"]);
});

test("paths that differ only by a separator get different names without any suffix", () => {
  const plan = planManagedVolumes(doc([bind("/app/data/repos/7-shop/a-b", "/1"), bind("/app/data/repos/7-shop/a/b", "/2")]), options);
  assert.deepEqual(plan.map((p) => p.name), ["a-b", "a__b"]);
});

test("names that really collide each get a hash of their own path, whatever the order", () => {
  const first = bind("/app/data/repos/7-shop/my db", "/1");
  const second = bind("/app/data/repos/7-shop/my_db", "/2");
  const forward = planManagedVolumes(doc([first, second]), options);
  const reversed = planManagedVolumes(doc([second, first]), options);
  const byTarget = (plan: ReturnType<typeof planManagedVolumes>) => Object.fromEntries(plan.map((p) => [p.target, p.name]));
  assert.deepEqual(byTarget(forward), byTarget(reversed), "reordering does not swap their directories");
  assert.match(String(byTarget(forward)["/1"]), /^my_db-[0-9a-f]{8}$/);
  assert.notEqual(byTarget(forward)["/1"], byTarget(forward)["/2"]);
});

test("a read-only mount stays in the checkout with its path translated to the host", () => {
  const [entry] = planManagedVolumes(doc([bind("/app/data/repos/7-shop/nginx", "/etc/nginx", true)]), options);
  assert.equal(entry.action, "repository");
  assert.equal(entry.hostSource, "/var/lib/stackport/data/repos/7-shop/nginx");
});

test("what cannot move is kept, translated, and says why", () => {
  const plan = planManagedVolumes(doc([bind("/app/data/repos/7-shop", "/app"), bind("/app/data/repos/7-shop/app.db", "/db")]), options);
  assert.deepEqual(plan.map((p) => p.action), ["keep", "keep"]);
  assert.match(plan[0].reason ?? "", /whole checkout/);
  assert.match(plan[1].reason ?? "", /file/);
  assert.equal(plan[1].hostSource, "/var/lib/stackport/data/repos/7-shop/app.db");
});

test("named volumes, tmpfs and mounts outside the checkout are not planned", () => {
  const plan = planManagedVolumes(doc([
    { type: "volume", source: "pg", target: "/pg" }, { type: "tmpfs", target: "/tmp" }, bind("/srv/elsewhere", "/e"),
  ]), options);
  assert.deepEqual(plan, []);
});

test("the override points each mount at its host path and nothing else", () => {
  const plan = planManagedVolumes(doc([bind("/app/data/repos/7-shop/data", "/data"), bind("/app/data/repos/7-shop/nginx", "/n", true)]), options);
  const override = loadYamlDoc(buildVolumesOverride(plan) ?? "") as { services: { web: { volumes: unknown[] } } };
  assert.deepEqual(override.services.web.volumes, [
    { type: "bind", source: "/var/lib/stackport/data/volumes/7/data", target: "/data" },
    { type: "bind", source: "/var/lib/stackport/data/repos/7-shop/nginx", target: "/n", read_only: true },
  ]);
  assert.equal(buildVolumesOverride([]), null);
});

test("managed directories are per project", () => {
  assert.deepEqual(managedVolumesRoot(options.roots, 12), { container: "/app/data/volumes/12", host: "/var/lib/stackport/data/volumes/12" });
});
