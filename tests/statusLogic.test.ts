import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateAlerts, type AlertInput } from "../src/modules/status/alerts";
import { nginxRunningFrom } from "../src/modules/status/collect";
import { deriveProjectState, healthOf, containerCounts } from "../src/modules/status/projectState";
import { normalizeHost, percentile, summarizeRequests, type LoggedRequest } from "../src/modules/status/requestStats";
import { scopeSnapshot } from "../src/modules/status/scope";
import { clean, finite, type ProjectStatus, type StatusSnapshot } from "../src/modules/status/types";
import { HEALTH_CHECK_USER_AGENT } from "../src/modules/deployments/health";
import { deriveProjectStatus } from "../client/src/lib/projectStatus";
import { StatusHub, type SectionUpdate } from "../src/modules/status/hub";
import type { CollectedState } from "../src/modules/status/collect";

// ---- project state: the same decision the web UI makes

const running = { state: "running", healthCheckIgnored: false };
const exited = { state: "exited", healthCheckIgnored: false };
const helperExited = { state: "exited", healthCheckIgnored: true };

const CASES: { name: string; project: { paused: boolean; lastStatus: "up" | "down" | "unknown"; healthCheckIntervalS: number }; containers: typeof running[] | null; docker: boolean; state: string }[] = [
  { name: "paused wins over everything", project: { paused: true, lastStatus: "down", healthCheckIntervalS: 60 }, containers: [exited], docker: true, state: "paused" },
  { name: "no stack at all", project: { paused: false, lastStatus: "up", healthCheckIntervalS: 60 }, containers: null, docker: true, state: "not-deployed" },
  { name: "only an ignored helper", project: { paused: false, lastStatus: "up", healthCheckIntervalS: 60 }, containers: [helperExited], docker: true, state: "not-deployed" },
  { name: "a counted container is stopped", project: { paused: false, lastStatus: "up", healthCheckIntervalS: 60 }, containers: [running, exited], docker: true, state: "down" },
  { name: "a stopped helper does not count", project: { paused: false, lastStatus: "up", healthCheckIntervalS: 60 }, containers: [running, helperExited], docker: true, state: "ready" },
  { name: "running, health check failing", project: { paused: false, lastStatus: "down", healthCheckIntervalS: 60 }, containers: [running], docker: true, state: "problem" },
  { name: "running, health check not yet run", project: { paused: false, lastStatus: "unknown", healthCheckIntervalS: 60 }, containers: [running], docker: true, state: "problem" },
  { name: "running, no health check", project: { paused: false, lastStatus: "unknown", healthCheckIntervalS: 0 }, containers: [running], docker: true, state: "ready" },
  { name: "docker unavailable, last check up", project: { paused: false, lastStatus: "up", healthCheckIntervalS: 60 }, containers: null, docker: false, state: "ready" },
  { name: "docker unavailable, last check down", project: { paused: false, lastStatus: "down", healthCheckIntervalS: 60 }, containers: null, docker: false, state: "down" },
  { name: "docker unavailable, never checked", project: { paused: false, lastStatus: "unknown", healthCheckIntervalS: 60 }, containers: null, docker: false, state: "not-deployed" },
];

for (const c of CASES) {
  test(`project state: ${c.name}`, () => {
    assert.equal(deriveProjectState(c.project, c.containers, c.docker), c.state);
    // The web UI's own function, on the same facts, gives the same answer: the stream and the Projects page cannot disagree.
    const stack = c.containers === null ? null : { name: "1-x", status: "", configFiles: [], containers: c.containers.map((container, i) => ({ id: String(i), name: `c${i}`, service: null, image: "", state: container.state, status: "", ports: "", healthCheckIgnored: container.healthCheckIgnored, stats: null })) };
    assert.equal(deriveProjectStatus(c.project as never, stack as never, c.docker), c.state);
  });
}

test("health and container counts", () => {
  assert.equal(healthOf({ paused: false, lastStatus: "up", healthCheckIntervalS: 60 }), "ok");
  assert.equal(healthOf({ paused: false, lastStatus: "down", healthCheckIntervalS: 60 }), "failing");
  assert.equal(healthOf({ paused: false, lastStatus: "unknown", healthCheckIntervalS: 60 }), "unknown");
  assert.equal(healthOf({ paused: false, lastStatus: "up", healthCheckIntervalS: 0 }), "none");
  assert.deepEqual(containerCounts([running, exited, helperExited]), { running: 1, total: 2 });
  assert.deepEqual(containerCounts(null), { running: 0, total: 0 });
});

// ---- request statistics

const NOW = Date.parse("2026-11-12T12:00:00Z");
const req = (over: Partial<LoggedRequest> = {}): LoggedRequest => ({ date: new Date(NOW - 30_000), status: 200, host: "shop.example.com", requestTimeMs: 100, ua: "curl/8", ...over });
const owners = new Map([["shop.example.com", 1], ["blog.example.com", 2]]);

test("percentile is nearest-rank and null for nothing", () => {
  assert.equal(percentile([], 95), null);
  assert.equal(percentile([5], 95), 5);
  assert.equal(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95), 95);
  assert.equal(percentile([300, 100, 200], 50), 200);
});

test("hosts are compared in lower case and without a port", () => {
  assert.equal(normalizeHost("Shop.Example.COM:443"), "shop.example.com");
});

test("requests are counted per project, 5xx and p95 from the window only", () => {
  const lines = [
    req(), req({ status: 502, requestTimeMs: 4000 }), req({ status: 404 }), req({ status: 200, requestTimeMs: 300 }),
    req({ host: "BLOG.example.com:443", status: 500, requestTimeMs: null }),
    req({ date: new Date(NOW - 6 * 60_000), status: 500 }), // older than the window
    req({ date: new Date(NOW + 10 * 60_000), status: 500 }), // from the future: a clock that is wrong is not evidence
  ];
  const stats = summarizeRequests(lines, owners, NOW);
  assert.deepEqual(stats.get(1), { windowS: 300, requests: 4, serverErrors: 1, errorRatePct: 25, p95Ms: 4000 });
  assert.deepEqual(stats.get(2), { windowS: 300, requests: 1, serverErrors: 1, errorRatePct: 100, p95Ms: null });
});

test("Stackport's own health checks, unowned hosts and lines without a host are left out", () => {
  const stats = summarizeRequests([
    req({ ua: HEALTH_CHECK_USER_AGENT, status: 500 }), req({ host: "scanner.invalid" }), req({ host: null }), req({ date: null }),
  ], owners, NOW);
  assert.equal(stats.size, 0);
});

// ---- alerts: something is wrong with X, now

const traffic = (over: Partial<NonNullable<ProjectStatus["traffic"]>> = {}): ProjectStatus["traffic"] => ({ windowS: 300, requests: 100, serverErrors: 0, errorRatePct: 0, p95Ms: 100, ...over });
const project = (over: Partial<ProjectStatus & { latestDeployFailedAt: string | null }> = {}): AlertInput["projects"][number] => ({
  id: 1, name: "shop", group: null, state: "ready", containers: { running: 2, total: 2 }, health: "ok", lastCheckedAt: null, traffic: traffic(), latestDeployFailedAt: null, ...over,
});
const healthyHost: AlertInput["host"] = { dockerAvailable: true, nginxRunning: true, disk: { state: "normal", freePct: 50 } };
const alertsFor = (projects: AlertInput["projects"], host = healthyHost) => evaluateAlerts({ now: NOW, projects, host });
const codes = (alerts: { code: string }[]): string[] => alerts.map((a) => a.code).sort();

test("a healthy system has no alerts", () => {
  assert.deepEqual(alertsFor([project()]), []);
});

test("a down project and a failing health check are critical, and carry a stable id", () => {
  const down = alertsFor([project({ state: "down", containers: { running: 1, total: 2 } })]);
  assert.deepEqual(down.map((a) => [a.code, a.severity, a.id]), [["project_down", "critical", "project_down:1"]]);
  assert.match(down[0]!.message, /1 of 2 containers/);
  const failing = alertsFor([project({ state: "problem", health: "failing" })]);
  assert.deepEqual(codes(failing), ["project_unhealthy"]);
  assert.deepEqual(alertsFor([project({ state: "problem", health: "unknown" })]), [], "a health check that has not run yet is not a failure");
});

test("paused and not-deployed projects raise nothing", () => {
  assert.deepEqual(alertsFor([project({ state: "paused", traffic: traffic({ errorRatePct: 90 }) }), project({ id: 2, state: "not-deployed" })]), []);
});

test("a deploy that failed in the last day is flagged, an older one is not", () => {
  const recent = new Date(NOW - 3_600_000).toISOString();
  const old = new Date(NOW - 3 * 86_400_000).toISOString();
  assert.deepEqual(codes(alertsFor([project({ latestDeployFailedAt: recent })])), ["project_deploy_failed"]);
  assert.deepEqual(alertsFor([project({ latestDeployFailedAt: old })]), []);
});

test("error rate and p95 have warning and critical levels, and need enough requests", () => {
  const warn = alertsFor([project({ traffic: traffic({ errorRatePct: 1.5, serverErrors: 2, p95Ms: 2500 }) })]);
  assert.deepEqual(warn.map((a) => [a.code, a.severity, a.value, a.unit]).sort(), [["project_error_rate", "warning", 1.5, "%"], ["project_latency", "warning", 2500, "ms"]]);
  const crit = alertsFor([project({ traffic: traffic({ errorRatePct: 7, p95Ms: 9000 }) })]);
  assert.deepEqual(crit.map((a) => a.severity), ["critical", "critical"]);
  assert.deepEqual(alertsFor([project({ traffic: traffic({ requests: 5, serverErrors: 5, errorRatePct: 100, p95Ms: 9000 }) })]), [], "five requests prove nothing");
  assert.deepEqual(alertsFor([project({ traffic: null })]), []);
});

test("host conditions: Docker down, Nginx down, disk", () => {
  assert.deepEqual(codes(alertsFor([], { ...healthyHost, dockerAvailable: false, nginxRunning: null })), ["host_docker_down"]);
  assert.deepEqual(codes(alertsFor([], { ...healthyHost, nginxRunning: false })), ["host_nginx_down"]);
  const disk = alertsFor([], { ...healthyHost, disk: { state: "critical", freePct: 3.456 } });
  assert.deepEqual(disk.map((a) => [a.code, a.severity, a.value]), [["host_disk_low", "critical", 3.5]]);
  assert.deepEqual(alertsFor([], { ...healthyHost, disk: { state: "unknown", freePct: null } }), []);
});

// ---- what a token may see

const snapshot: StatusSnapshot = {
  host: { cpuPercent: 1, memPercent: 1, memUsedMb: 1, memTotalMb: 2, load1: 0, diskUsedPct: 1, netRxBps: 0, netTxBps: 0, sampledAt: "x" },
  projects: [
    { id: 1, name: "shop", group: "production", state: "ready", containers: { running: 1, total: 1 }, health: "ok", lastCheckedAt: null, traffic: null },
    { id: 2, name: "shop-staging", group: "staging", state: "down", containers: { running: 0, total: 1 }, health: "failing", lastCheckedAt: null, traffic: null },
  ],
  actions: [
    { id: "a", kind: "deploy", projectId: 1, projectName: "shop", startedAt: "x", phase: null, percent: 10, etaSeconds: null, basis: "time" },
    { id: "b", kind: "deploy", projectId: 2, projectName: "shop-staging", startedAt: "x", phase: null, percent: null, etaSeconds: null, basis: null },
    { id: "c", kind: "nginx-apply", projectId: null, projectName: null, startedAt: "x", phase: null, percent: null, etaSeconds: null, basis: null },
  ],
  alerts: [
    { id: "project_down:2", severity: "critical", code: "project_down", scope: "project", projectId: 2, subject: "shop-staging", message: "m", since: "x", value: null, unit: null },
    { id: "host_nginx_down:host", severity: "critical", code: "host_nginx_down", scope: "host", projectId: null, subject: "Nginx", message: "m", since: "x", value: null, unit: null },
  ],
};

const groupsOf = (s: StatusSnapshot): Map<number, string | null> => new Map(s.projects.map((p) => [p.id, p.group]));

test("a token with no group sees everything", () => {
  assert.equal(scopeSnapshot(snapshot, { group: null }, groupsOf(snapshot)), snapshot);
});

test("a token limited to a group sees only that group, and no host data", () => {
  const scoped = scopeSnapshot(snapshot, { group: "staging" }, groupsOf(snapshot));
  assert.equal(scoped.host, null);
  assert.deepEqual(scoped.projects.map((p) => p.id), [2]);
  assert.deepEqual(scoped.actions.map((a) => a.id), ["b"], "not production's action, not the host's");
  assert.deepEqual(scoped.alerts.map((a) => a.id), ["project_down:2"], "not the host's alert");
  const none = scopeSnapshot(snapshot, { group: "nonexistent" }, groupsOf(snapshot));
  assert.deepEqual([none.host, none.projects, none.actions, none.alerts], [null, [], [], []]);
});

// ---- text from people

test("clean strips control characters and cuts long names", () => {
  assert.equal(clean("shop\u0000\u001b[31m\nred x"), "shop [31m red x");
  assert.equal(clean("a".repeat(200), 10), "aaaaaaaaa…");
  assert.equal(finite(Number.NaN), null);
  assert.equal(finite(1.2345, 2), 1.23);
});

// ---- the hub: what is sent, when

const emptySnapshot = (): StatusSnapshot => ({ host: null, projects: [], actions: [], alerts: [] });
const downCondition = { id: "project_down:1", severity: "critical" as const, code: "project_down" as const, scope: "project" as const, projectId: 1, subject: "shop", message: "m", value: null, unit: null };

test("the hub sends each section once, then only the sections that changed, and keeps an alert's since while it holds", async () => {
  let state: CollectedState = { snapshot: emptySnapshot(), conditions: [], groups: new Map() };
  const hub = new StatusHub(async () => state);
  const seen: SectionUpdate[] = [];
  const unsubscribe = hub.subscribe((update) => seen.push(update));

  await hub.refresh();
  assert.deepEqual(seen.map((u) => u.section).sort(), ["actions", "alerts", "host", "projects"], "the first look says everything");

  seen.length = 0;
  await hub.refresh();
  assert.deepEqual(seen, [], "nothing changed, nothing is said");

  state = { snapshot: emptySnapshot(), conditions: [downCondition], groups: new Map() };
  await hub.refresh();
  assert.deepEqual((seen as SectionUpdate[]).map((u) => u.section), ["alerts"]);
  const since = ((seen as SectionUpdate[])[0]!.data as { since: string }[])[0]!.since;

  seen.length = 0;
  await new Promise((resolve) => setTimeout(resolve, 5));
  await hub.refresh();
  assert.deepEqual(seen, [], "the same condition again, with the same since, is not news");
  assert.equal((hub.peek()!.alerts[0])!.since, since);

  state = { snapshot: emptySnapshot(), conditions: [], groups: new Map() };
  await hub.refresh();
  assert.deepEqual(((seen as SectionUpdate[])[0]!.data as unknown[]).length, 0, "cleared");
  state = { snapshot: emptySnapshot(), conditions: [downCondition], groups: new Map() };
  await new Promise((resolve) => setTimeout(resolve, 5));
  await hub.refresh();
  assert.notEqual(hub.peek()!.alerts[0]!.since, since, "a condition that came back is a new one");
  unsubscribe();
});

test("the hub watches only while somebody listens, and a failing collection keeps the last good state", async () => {
  let calls = 0;
  let fail = false;
  const hub = new StatusHub(async () => { calls += 1; if (fail) throw new Error("docker is down"); return { snapshot: emptySnapshot(), conditions: [], groups: new Map() }; });
  assert.equal(hub.peek(), null);
  const unsubscribe = hub.subscribe(() => undefined);
  await hub.current();
  assert.equal(calls, 1);
  fail = true;
  await hub.refresh();
  assert.ok(hub.peek(), "the last good state is kept");
  unsubscribe();
  assert.equal(hub.peek(), null, "the last listener leaving drops it");
});

// ---- found in review

test("a group is matched as stored, not as cut for the wire: a long name still works, and two names that clean to the same text stay apart", () => {
  const long = "g".repeat(90);
  const cut = clean(long);
  const snap: StatusSnapshot = {
    host: null,
    projects: [
      { id: 1, name: "long", group: cut, state: "ready", containers: { running: 1, total: 1 }, health: "ok", lastCheckedAt: null, traffic: null },
      { id: 2, name: "spaced", group: "Team A", state: "ready", containers: { running: 1, total: 1 }, health: "ok", lastCheckedAt: null, traffic: null },
    ],
    actions: [], alerts: [],
  };
  const stored = new Map<number, string | null>([[1, long], [2, "Team  A"]]);
  assert.deepEqual(scopeSnapshot(snap, { group: long }, stored).projects.map((p) => p.id), [1], "the stored 90-character name matches although the wire shows 80");
  assert.deepEqual(scopeSnapshot(snap, { group: cut }, stored).projects, [], "the cut name is a different group");
  assert.deepEqual(scopeSnapshot(snap, { group: "Team  A" }, stored).projects.map((p) => p.id), [2]);
  assert.deepEqual(scopeSnapshot(snap, { group: "Team A" }, stored).projects, [], "same text once cleaned, but not the same group");
});

test("with Docker out of reach a project is not said to have 0 of 0 containers running", () => {
  const alerts = evaluateAlerts({
    now: NOW,
    projects: [project({ state: "down", containers: { running: 0, total: 0 } })],
    host: { dockerAvailable: false, nginxRunning: null, disk: { state: "normal", freePct: 50 } },
  });
  const forProject = alerts.filter((a) => a.scope === "project");
  assert.deepEqual(forProject.map((a) => a.code), ["project_unhealthy"], "it is the health check that said so");
  assert.doesNotMatch(forProject[0]!.message, /0 of 0/);
  assert.match(forProject[0]!.message, /Docker is not reachable/);
  assert.ok(alerts.some((a) => a.code === "host_docker_down"));
});

test("Nginx is not running only when Docker says the container is missing or stopped; a failed check is unknown", () => {
  assert.equal(nginxRunningFrom({ ok: true, stdout: "true\n", stderr: "" }), true);
  assert.equal(nginxRunningFrom({ ok: true, stdout: "false\n", stderr: "" }), false);
  assert.equal(nginxRunningFrom({ ok: false, stdout: "", stderr: "Error: No such object: stackport-nginx" }), false);
  assert.equal(nginxRunningFrom({ ok: false, stdout: "", stderr: "Error response from daemon: No such container: stackport-nginx" }), false);
  assert.equal(nginxRunningFrom({ ok: false, stdout: "", stderr: "" }), null, "a timeout says nothing");
  assert.equal(nginxRunningFrom({ ok: false, stdout: "", stderr: "Cannot connect to the Docker daemon" }), null);
});

test("the hub does not report an empty system when it could not look: current() fails and there is no data age", async () => {
  const hub = new StatusHub(async () => { throw new Error("database is busy"); });
  const unsubscribe = hub.subscribe(() => undefined);
  await assert.rejects(hub.current(), /could not be collected/);
  assert.equal(hub.peek(), null);
  assert.equal(hub.ageSeconds(), null);
  unsubscribe();
});

test("the data age grows while the collector fails, and the last good state is kept", async () => {
  let fail = false;
  const hub = new StatusHub(async () => { if (fail) throw new Error("down"); return { snapshot: emptySnapshot(), conditions: [], groups: new Map() }; });
  const unsubscribe = hub.subscribe(() => undefined);
  await hub.current();
  assert.equal(hub.ageSeconds(), 0);
  fail = true;
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await hub.refresh();
  assert.ok((hub.ageSeconds() ?? 0) >= 1, "older, not refreshed");
  assert.ok(hub.peek(), "still the last good state");
  unsubscribe();
});

test("a listener that throws does not stop the other listeners or the sections after it", async () => {
  const hub = new StatusHub(async () => ({ snapshot: emptySnapshot(), conditions: [downCondition], groups: new Map() }));
  const heard: string[] = [];
  const unsubscribeBad = hub.subscribe(() => { throw new Error("a broken connection"); });
  const unsubscribeGood = hub.subscribe((update) => heard.push(update.section));
  await hub.refresh();
  assert.deepEqual(heard.sort(), ["actions", "alerts", "host", "projects"], "every section still reached the healthy listener, alerts last of all");
  unsubscribeBad();
  unsubscribeGood();
});

test("a collection that never finishes is given up on, and the next one is not blocked behind it", async () => {
  let calls = 0;
  const hub = new StatusHub(() => { calls += 1; return calls === 1 ? new Promise<CollectedState>(() => undefined) : Promise.resolve({ snapshot: emptySnapshot(), conditions: [], groups: new Map() }); }, 30);
  const unsubscribe = hub.subscribe(() => undefined);
  await hub.refresh();
  assert.equal(hub.peek(), null, "nothing was collected");
  await hub.refresh();
  assert.ok(hub.peek(), "the next collection ran");
  assert.equal(calls, 2);
  unsubscribe();
});
