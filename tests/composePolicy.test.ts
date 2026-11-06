import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPolicyViolation, validateComposePolicy, validateResolvedComposePolicy } from "../src/services/composePolicy";

test("violations name the service, key and a fix", () => {
  const result = validateComposePolicy({
    services: {
      web: { image: "nginx", ports: ["80:80"], volumes: ["/var/run/docker.sock:/var/run/docker.sock", "data:/data"] },
      db: { image: "postgres", privileged: true, cap_add: ["NET_ADMIN", "SYS_ADMIN"], network_mode: "host" },
    },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.violations.map((v) => `${v.service}.${v.key}`), [
    "web.ports", "web.volumes", "db.privileged", "db.network_mode", "db.cap_add",
  ]);
  for (const v of result.violations) assert.ok(v.fix.length > 0, `${v.service}.${v.key} has a fix`);
  assert.match(result.violations[1].problem, /docker\.sock/);
});

test("the log line keeps the old services.<name>.<key> form", () => {
  const [v] = validateComposePolicy({ services: { web: { devices: ["/dev/kvm"] } } }).violations;
  assert.equal(formatPolicyViolation(v), "services.web.devices: device access is not allowed for managed projects. Remove \"devices:\".");
});

test("a clean file passes", () => {
  assert.deepEqual(validateComposePolicy({ services: { web: { image: "nginx", expose: ["80"], volumes: ["./data:/data"] } } }), { ok: true, violations: [] });
});

test("the resolved config is checked too, so a value only spelled indirectly in the file is caught", () => {
  // `privileged: ${PRIV:-true}` reaches the check as the boolean Compose will run.
  const result = validateResolvedComposePolicy({ services: { web: { image: "nginx", privileged: true } } }, { projectDir: "/srv/p" });
  assert.equal(result.ok, false);
  assert.deepEqual(result.violations.map((v) => `${v.service}.${v.key}`), ["web.privileged"]);
});

const POSIX = { projectDir: "/srv/stackport/7-app" };
const resolvedWith = (service: Record<string, unknown>) => ({ services: { web: { image: "nginx", ...service } } });
const keys = (doc: unknown, ctx = POSIX) => validateResolvedComposePolicy(doc, ctx).violations.map((v) => `${v.service}.${v.key}`);

test("a: a variable that resolves to the host root is refused as a host mount", () => {
  // volumes: ["${HOSTROOT:-/}:/host"] arrives resolved, as an absolute bind source.
  const doc = resolvedWith({ volumes: [{ type: "bind", source: "/", target: "/host" }] });
  assert.deepEqual(keys(doc), ["web.volumes"]);
  assert.match(validateResolvedComposePolicy(doc, POSIX).violations[0].problem, /not allowed/);
});

test("a: mounts inside the project folder, named volumes and tmpfs pass", () => {
  const doc = resolvedWith({ volumes: [
    { type: "bind", source: "/srv/stackport/7-app/data", target: "/data" },
    { type: "bind", source: "/srv/stackport/7-app", target: "/app" },
    { type: "volume", source: "pgdata", target: "/var/lib/postgresql" },
    { type: "tmpfs", target: "/tmp" },
  ] });
  assert.deepEqual(keys(doc), []);
});

test("a: a sibling folder that merely shares the project's prefix is outside it", () => {
  const doc = resolvedWith({ volumes: [{ type: "bind", source: "/srv/stackport/7-app-other/data", target: "/d" }] });
  assert.deepEqual(keys(doc), ["web.volumes"]);
});

test("a: paths are compared the Windows way when the project folder is a Windows path", () => {
  const ctx = { projectDir: "C:\\Deploy\\7-app" };
  assert.deepEqual(keys(resolvedWith({ volumes: [{ type: "bind", source: "c:\\deploy\\7-app\\data", target: "/d" }] }), ctx), []);
  assert.deepEqual(keys(resolvedWith({ volumes: [{ type: "bind", source: "C:\\Windows", target: "/d" }] }), ctx), ["web.volumes"]);
});

test("a: a mount type outside the allowlist is refused", () => {
  assert.deepEqual(keys(resolvedWith({ volumes: [{ type: "npipe", source: "\\\\.\\pipe\\docker_engine", target: "/p" }] })), ["web.volumes"]);
});

test("a: an ordinary host folder outside the project is refused with a message that says why", () => {
  const [v] = validateResolvedComposePolicy(resolvedWith({ volumes: [{ type: "bind", source: "/home/deploy", target: "/h" }] }), POSIX).violations;
  assert.match(v.problem, /\/home\/deploy.*outside the project folder/);
});
