import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPolicyViolation, validateComposePolicy } from "../src/services/composePolicy";

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
