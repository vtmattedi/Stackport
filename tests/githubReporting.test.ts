import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { getDatabase, initializeDatabase } from "../src/config/database";
import { createProject } from "../src/modules/projects/operations";
import { addProjectDomain } from "../src/modules/ingress/domains";
import { GithubClient } from "../src/modules/github/client";
import { completeLink, completeManifest, forgetInstallationTokens, refreshRepositories, startLink, startManifest, type PreflightDeps } from "../src/modules/github/app";
import { beginDeployReport, finishDeployReport, reportingAvailable, type ReportableProject } from "../src/modules/github/reporting";
import { startFakeGithub, type FakeGithubWithCodes } from "./helpers/fakeGithub";

let fake: FakeGithubWithCodes;
let client: GithubClient;
const domain: PreflightDeps = { appConfig: () => ({ enabled: true, domain: "sp.example.com", useSsl: true }), hasCertificate: async () => true };
const SHA = "a".repeat(40);

before(async () => {
  initializeDatabase();
  fake = (await startFakeGithub()) as FakeGithubWithCodes;
  client = new GithubClient({ apiUrl: fake.apiUrl, webUrl: fake.webUrl, sleep: async () => undefined });
});
after(async () => { await fake.close(); });

/** An App registered, installation 11 linked with the given permissions, repository 101 `acme/shop`. */
async function world(permissions: Record<string, string>): Promise<ReportableProject> {
  const db = getDatabase();
  for (const table of ["github_app", "github_app_installations", "github_app_repositories", "github_app_states"]) db.prepare(`DELETE FROM ${table}`).run();
  forgetInstallationTokens();
  fake.deployments.length = 0;
  fake.deploymentStatuses.length = 0;
  fake.deploymentFailure = null;
  const start = await startManifest("admin", { modules: ["deployments"], owner: "", isPublic: false }, domain, client);
  await completeManifest(fake.issueCode("manifest"), start.state, domain, client);
  fake.installations = [{ id: 11, account: { id: 1, login: "acme", type: "Organization" }, permissions, repositories: [{ id: 101, full_name: "acme/shop", default_branch: "main" }] }];
  await completeLink(fake.issueCode("oauth"), new URL(startLink("admin", client).authorizeUrl).searchParams.get("state")!, client);
  await refreshRepositories(11, client);
  const { id } = createProject({ name: "reporting", sourceType: "github", githubRepo: "acme/shop" });
  db.prepare("UPDATE projects SET github_auth_mode = 'app', github_installation_id = 11, github_repository_id = 101 WHERE id = ?").run(id);
  return { id, name: "reporting", githubRepo: "acme/shop", githubAuthMode: "app", githubInstallationId: 11 };
}

test("reporting is available only for an App project whose installation has approved deployments: write", async () => {
  const project = await world({ contents: "read", deployments: "write" });
  assert.equal(reportingAvailable(project), true);
  assert.equal(reportingAvailable({ ...project, githubAuthMode: null }), false, "a token project is never reported");
  assert.equal(reportingAvailable({ ...project, githubRepo: null }), false);
  assert.equal(reportingAvailable({ ...project, githubInstallationId: 999 }), false);
  const without = await world({ contents: "read" });
  assert.equal(reportingAvailable(without), false, "the permission was not approved");
  const readOnly = await world({ contents: "read", deployments: "read" });
  assert.equal(reportingAvailable(readOnly), false);
});

test("a deploy is reported: a deployment for the commit, in progress, then success with where it runs", async () => {
  const project = await world({ contents: "read", deployments: "write" });
  addProjectDomain(project.id, "shop.example.com", true, "web", 80);
  const report = await beginDeployReport(project, SHA, client);
  assert.ok(report);
  assert.equal(fake.deployments.length, 1);
  assert.deepEqual([fake.deployments[0].repo, fake.deployments[0].body["ref"], fake.deployments[0].body["environment"], fake.deployments[0].body["auto_merge"]], ["acme/shop", SHA, "production", false]);
  assert.deepEqual(fake.deployments[0].body["required_contexts"], [], "GitHub must not refuse the record because a check is pending");
  assert.deepEqual(fake.deploymentStatuses.map((s) => s.body["state"]), ["in_progress"]);
  assert.equal(fake.deploymentStatuses[0].body["log_url"], `https://sp.example.com/projects/${project.id}`);

  await finishDeployReport(report, { ok: true, healthy: true }, client);
  const last = fake.deploymentStatuses.at(-1)!;
  assert.deepEqual([last.body["state"], last.body["environment_url"], last.id], ["success", "https://shop.example.com", fake.deployments[0].id]);
});

test("a failed deploy and a deploy that fails its health check are reported as failures, with the reason in the description", async () => {
  const project = await world({ contents: "read", deployments: "write" });
  const failed = await beginDeployReport(project, SHA, client);
  await finishDeployReport(failed, { ok: false, healthy: true }, client);
  assert.deepEqual([fake.deploymentStatuses.at(-1)?.body["state"], fake.deploymentStatuses.at(-1)?.body["description"]], ["failure", "The deploy failed"]);
  assert.equal(fake.deploymentStatuses.at(-1)?.body["environment_url"], undefined, "no address for a deploy that did not work");
  const unhealthy = await beginDeployReport(project, SHA, client);
  await finishDeployReport(unhealthy, { ok: false, healthy: false }, client);
  assert.equal(fake.deploymentStatuses.at(-1)?.body["description"], "Deployed, but it failed its health check");
});

test("GitHub refusing, or a token project, or an odd commit never breaks a deploy: nothing is thrown and nothing is reported", async () => {
  const project = await world({ contents: "read", deployments: "write" });
  fake.deploymentFailure = 403;
  assert.equal(await beginDeployReport(project, SHA, client), null, "GitHub said no");
  await finishDeployReport(null, { ok: true, healthy: true }, client);
  fake.deploymentFailure = null;
  const before = fake.requests.length;
  assert.equal(await beginDeployReport({ ...project, githubAuthMode: null }, SHA, client), null);
  assert.equal(await beginDeployReport(project, null, client), null, "no commit known");
  assert.equal(await beginDeployReport(project, "not-a-sha; rm -rf", client), null);
  assert.equal(fake.requests.length, before, "no request was made for any of them");
  const down = new GithubClient({ apiUrl: "http://127.0.0.1:1", webUrl: "http://127.0.0.1:1", timeoutMs: 300, sleep: async () => undefined });
  assert.equal(await beginDeployReport(project, SHA, down), null, "GitHub unreachable");
});

test("what is sent holds no secret", async () => {
  const project = await world({ contents: "read", deployments: "write" });
  const report = await beginDeployReport(project, SHA, client);
  await finishDeployReport(report, { ok: true, healthy: true }, client);
  const sent = JSON.stringify([fake.deployments, fake.deploymentStatuses]);
  assert.ok(!/ghs_|BEGIN|secret/i.test(sent));
});
