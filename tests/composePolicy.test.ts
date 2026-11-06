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

test("b: privileged chosen through a variable is caught once it is resolved", () => {
  // privileged: ${PRIV:-true} is a string in the file and the boolean true in the resolved config.
  assert.deepEqual(keys(resolvedWith({ privileged: true })), ["web.privileged"]);
  assert.deepEqual(keys(resolvedWith({ privileged: false })), []);
});

test("c: a named volume that bind-mounts the host through driver_opts is refused", () => {
  const doc = { services: { web: { image: "nginx" } }, volumes: { root: { name: "p_root", driver_opts: { type: "none", o: "bind", device: "/" } } } };
  const [v] = validateResolvedComposePolicy(doc, POSIX).violations;
  assert.equal(formatPolicyViolation(v).split(":")[0], "volumes.root.driver_opts");
  assert.equal(validateResolvedComposePolicy(doc, POSIX).violations.length, 1);
});

test("c: rbind, type bind and plugin drivers are refused too", () => {
  const volumes = (opts: Record<string, unknown>) => ({ services: {}, volumes: { v: opts } });
  assert.equal(validateResolvedComposePolicy(volumes({ driver_opts: { o: "rw,rbind", device: "/etc" } }), POSIX).ok, false);
  assert.equal(validateResolvedComposePolicy(volumes({ driver_opts: { type: "bind", device: "/etc" } }), POSIX).ok, false);
  assert.equal(validateResolvedComposePolicy(volumes({ driver: "rclone" }), POSIX).ok, false);
});

test("c: plain, local and network-backed volumes pass", () => {
  const doc = { services: {}, volumes: {
    plain: { name: "p_plain" },
    local: { driver: "local" },
    share: { driver: "local", driver_opts: { type: "nfs", o: "addr=10.0.0.5,rw", device: ":/exports/data" } },
  } };
  assert.equal(validateResolvedComposePolicy(doc, POSIX).ok, true);
});

test("e: capabilities outside the allowlist are refused, ordinary ones pass", () => {
  assert.deepEqual(keys(resolvedWith({ cap_add: ["SYS_PTRACE", "SYS_MODULE", "NET_BIND_SERVICE", "CAP_CHOWN"] })), ["web.cap_add", "web.cap_add"]);
  assert.deepEqual(keys(resolvedWith({ cap_add: ["NET_BIND_SERVICE", "CHOWN", "net_admin"] })), []);
});

test("e: SYS_ADMIN is reported once, not by both the denylist and the allowlist", () => {
  assert.deepEqual(keys(resolvedWith({ cap_add: ["SYS_ADMIN"] })), ["web.cap_add"]);
});

test("e: security_opt that switches confinement off is refused", () => {
  assert.deepEqual(keys(resolvedWith({ security_opt: ["seccomp:unconfined", "apparmor:unconfined", "label:disable"] })), ["web.security_opt", "web.security_opt", "web.security_opt"]);
  assert.deepEqual(keys(resolvedWith({ security_opt: ["no-new-privileges:true"] })), []);
});

test("e: sharing the host's user, UTS or cgroup namespace is refused", () => {
  assert.deepEqual(keys(resolvedWith({ userns_mode: "host", uts: "host", cgroup: "host" })), ["web.userns_mode", "web.uts", "web.cgroup"]);
});

test("f: a build context outside the project folder is refused", () => {
  assert.deepEqual(keys(resolvedWith({ build: { context: "/", dockerfile: "Dockerfile" } })), ["web.build"]);
  assert.deepEqual(keys(resolvedWith({ build: { context: "/srv/stackport", dockerfile: "Dockerfile" } })), ["web.build"]);
});

test("f: contexts inside the project, and remote contexts, pass", () => {
  assert.deepEqual(keys(resolvedWith({ build: { context: "/srv/stackport/7-app/api", dockerfile: "Dockerfile" } })), []);
  assert.deepEqual(keys(resolvedWith({ build: { context: "https://github.com/acme/app.git#main" } })), []);
});

test("f: an additional build context is held to the same rule", () => {
  const doc = resolvedWith({ build: { context: "/srv/stackport/7-app", additional_contexts: { secrets: "/etc", base: "docker-image://alpine", lib: "service:other" } } });
  const [v] = validateResolvedComposePolicy(doc, POSIX).violations;
  assert.match(v.problem, /additional_contexts\.secrets "\/etc"/);
  assert.equal(validateResolvedComposePolicy(doc, POSIX).violations.length, 1);
});

test("f: a Windows host path is recognised as a local build context", () => {
  assert.deepEqual(keys(resolvedWith({ build: { context: "C:\\Windows" } })), ["web.build"]);
});
