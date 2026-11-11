import { before, test } from "node:test";
import assert from "node:assert/strict";
import { initializeDatabase } from "../src/config/database";
import { createProject } from "../src/modules/projects/operations";
import { addProjectDomain } from "../src/modules/ingress/domains";
import { checkProjectIngress, classifyProbe, type DockerExec } from "../src/modules/ingress/health";

before(() => { initializeDatabase(); });

/** A fake Docker: nginx state plus the probe's answer per alias. */
function fakeDocker(options: { running?: boolean; networks?: string[]; probe?: Record<string, { code: number; stdout?: string }> }): { exec: DockerExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: DockerExec = async (args) => {
    calls.push(args);
    if (args[0] === "inspect") return { code: 0, stdout: `${options.running ?? true} ${(options.networks ?? ["stackport-proxy"]).join(" ")} `, stderr: "" };
    const alias = args[args.length - 2];
    const answer = options.probe?.[alias] ?? { code: 0 };
    return { code: answer.code, stdout: answer.stdout ?? "", stderr: "" };
  };
  return { exec, calls };
}

test("a probe that connects is reachable; the ways it fails are told apart", () => {
  assert.deepEqual(classifyProbe({ code: 0, stdout: "", stderr: "" }), { failure: null, detail: "" });
  assert.equal(classifyProbe({ code: 10, stdout: "", stderr: "" }).failure, "name-does-not-resolve");
  assert.equal(classifyProbe({ code: 11, stdout: "", stderr: "" }).failure, "connection-refused");
  assert.equal(classifyProbe({ code: 12, stdout: "", stderr: "" }).failure, "timed-out");
  assert.equal(classifyProbe({ code: 127, stdout: "", stderr: "sh: nc: not found" }).failure, "probe-failed");
  assert.equal(classifyProbe({ code: 1, stdout: "", stderr: "Error response from daemon: No such container" }).failure, "probe-failed");
});

test("a project whose services all answer is ok, and each route is probed by its project-unique alias", async () => {
  const id = createProject({ name: "health-ok", sourceType: "github", githubRepo: "o/r" }).id;
  addProjectDomain(id, "health-ok.example.com", false, "web", 3000);
  const { exec, calls } = fakeDocker({});
  const health = await checkProjectIngress(id, exec);
  assert.equal(health.status, "ok");
  assert.equal(health.routes[0].alias, `sp${id}-web`);
  const probe = calls.find((c) => c[0] === "exec")!;
  assert.deepEqual(probe.slice(0, 3), ["exec", "stackport-nginx", "sh"]);
  assert.deepEqual(probe.slice(-3), ["sh", `sp${id}-web`, "3000"]);
  assert.ok(!probe[4].includes(`sp${id}`), "the alias is a positional argument, never spliced into the script");
});

test("the 1.3.0 failure: nginx is up but the name does not resolve, and the summary says what to do", async () => {
  const id = createProject({ name: "health-dns", sourceType: "github", githubRepo: "o/r" }).id;
  addProjectDomain(id, "health-dns.example.com", false, "web", 80);
  const { exec } = fakeDocker({ probe: { [`sp${id}-web`]: { code: 10 } } });
  const health = await checkProjectIngress(id, exec);
  assert.equal(health.status, "down");
  assert.equal(health.routes[0].failure, "name-does-not-resolve");
  assert.match(health.summary, /not on the stackport-proxy network/);
});

test("one of two routes failing is degraded, and a refused connection points at the service, not the network", async () => {
  const id = createProject({ name: "health-mixed", sourceType: "github", githubRepo: "o/r" }).id;
  addProjectDomain(id, "health-mixed-a.example.com", false, "web", 80);
  addProjectDomain(id, "health-mixed-b.example.com", false, "api", 8080);
  const { exec } = fakeDocker({ probe: { [`sp${id}-api`]: { code: 11 } } });
  const health = await checkProjectIngress(id, exec);
  assert.equal(health.status, "degraded");
  assert.match(health.summary, /does not answer/);
});

test("nginx off the shared network is reported once, without probing every route", async () => {
  const id = createProject({ name: "health-net", sourceType: "github", githubRepo: "o/r" }).id;
  addProjectDomain(id, "health-net.example.com", false, "web", 80);
  const { exec, calls } = fakeDocker({ networks: ["bridge"] });
  const health = await checkProjectIngress(id, exec);
  assert.equal(health.status, "nginx-unavailable");
  assert.equal(calls.filter((c) => c[0] === "exec").length, 0);
  const stopped = await checkProjectIngress(id, fakeDocker({ running: false }).exec);
  assert.equal(stopped.status, "nginx-unavailable");
});

test("a project with no routed domain, or a domain not yet pointed at a service, has no routes to check", async () => {
  const id = createProject({ name: "health-none", sourceType: "github", githubRepo: "o/r" }).id;
  addProjectDomain(id, "health-none.example.com");
  const health = await checkProjectIngress(id, fakeDocker({}).exec);
  assert.equal(health.status, "no-routes");
  assert.deepEqual(health.routes, []);
});
