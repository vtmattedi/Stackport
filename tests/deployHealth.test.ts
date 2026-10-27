import { before, test } from "node:test";
import assert from "node:assert/strict";
import { getDatabase, initializeDatabase } from "../src/config/database";
import { createProject, updateProject } from "../src/services/projectAdmin";
import { addProjectDomain } from "../src/services/projectDomains";
import { healthCheckUrl } from "../src/services/healthChecker";
import { verifyDeployHealth, type HealthGateDeps } from "../src/services/projectDeploy";
import { listProjectDeployments, markActiveDeploymentUnhealthy, recordSuccessfulDeployment } from "../src/services/projectDeployments";

before(() => { initializeDatabase(); });

let counter = 0;
function project(opts: { endpoint?: string | null; ssl?: boolean; graceS?: number } = {}): number {
  const { id } = createProject({ name: `health-${++counter}`, sourceType: "github", githubRepo: "o/r" });
  if (opts.endpoint !== null) {
    addProjectDomain(id, `app${counter}.example.com`, opts.ssl ?? true);
    updateProject(id, { healthCheckEndpoint: opts.endpoint ?? "/health", deployHealthGraceS: opts.graceS ?? 10 });
  }
  return id;
}

function row(id: number) {
  return getDatabase().prepare("SELECT id, paused, health_check_endpoint, health_check_domain_id FROM projects WHERE id = ?").get(id) as Parameters<typeof healthCheckUrl>[0];
}

/** A clock that only moves when the gate sleeps, and a probe that answers from a script. */
function fakeDeps(answers: ("up" | "down")[]): HealthGateDeps & { probes: number } {
  let t = 0;
  const deps = {
    probes: 0,
    probe: async () => {
      const status = answers[Math.min(deps.probes, answers.length - 1)];
      deps.probes++;
      return { status, responseMs: status === "up" ? 12 : null };
    },
    sleep: async (ms: number) => { t += ms; },
    now: () => t,
  };
  return deps;
}

test("the health URL uses the domain's scheme", () => {
  assert.equal(healthCheckUrl(row(project({ ssl: true }))), `https://app${counter}.example.com/health`);
  assert.equal(healthCheckUrl(row(project({ ssl: false }))), `http://app${counter}.example.com/health`);
});

test("no endpoint means no health check, and the deploy isn't gated", async () => {
  const id = project({ endpoint: null });
  assert.equal(healthCheckUrl(row(id)), null);
  assert.equal(await verifyDeployHealth(id, "deploy", fakeDeps(["down"])), null);
});

test("a passing check passes on the first probe", async () => {
  const deps = fakeDeps(["up"]);
  const result = await verifyDeployHealth(project(), "deploy", deps);
  assert.equal(result?.healthy, true);
  assert.equal(deps.probes, 1);
});

test("an app that comes up within the grace period passes", async () => {
  const deps = fakeDeps(["down", "down", "up"]);
  const result = await verifyDeployHealth(project({ graceS: 10 }), "deploy", deps);
  assert.equal(result?.healthy, true);
  assert.equal(deps.probes, 3);
});

test("an app that never comes up fails once the grace period runs out", async () => {
  const deps = fakeDeps(["down"]);
  const result = await verifyDeployHealth(project({ graceS: 10 }), "deploy", deps);
  assert.equal(result?.healthy, false);
  // Probes at 0, 3, 6 and 9 s; the next would be at 12 s, past the 10 s grace period.
  assert.equal(deps.probes, 4);
});

test("a failed check marks the running revision unhealthy without changing its status", () => {
  const id = project();
  recordSuccessfulDeployment(id, {
    commitSha: "aaaaaaa", branch: "main", composeFileName: "docker-compose.yml",
    sourceCompose: "x", effectiveCompose: "x", triggeredBy: "manual",
  });
  markActiveDeploymentUnhealthy(id);
  const [active] = listProjectDeployments(id);
  assert.equal(active.status, "active");
  assert.ok(active.healthFailedAt);
});

test("grace period and auto-rollback are validated and stored", () => {
  const id = project();
  assert.throws(() => updateProject(id, { deployHealthGraceS: 2 }), /between 5 and 600/);
  assert.throws(() => updateProject(id, { autoRollbackUnhealthy: "yes" }), /true or false/);
  const { project: updated } = updateProject(id, { deployHealthGraceS: 120, autoRollbackUnhealthy: true });
  assert.equal(updated.deployHealthGraceS, 120);
  assert.equal(updated.autoRollbackUnhealthy, true);
});
