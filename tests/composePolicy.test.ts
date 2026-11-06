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
