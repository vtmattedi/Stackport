import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { before, test } from "node:test";
import { getDatabase, initializeDatabase } from "../src/config/database";
import { collectSecrets } from "../src/modules/actions/log";
import { evaluateResolvedPolicy } from "../src/modules/deployments/compose/policy";
import { addManagedDomain } from "../src/modules/ingress/managedDomains";
import { setProjectDomainRoute } from "../src/modules/ingress/domains";
import { announceBranchPreview } from "../src/modules/github/branchPreview";
import { GithubClient } from "../src/modules/github/client";
import { bindProjectToApp, getProjectBinding, unbindProjectFromApp } from "../src/modules/github/binding";
import { writeDeploymentEnv } from "../src/modules/deployments/env";
import { branchCheckoutConflict, createBranchDeployment, listBranchDeployments } from "../src/modules/projects/branchDeployments";
import { createProjectEnvFile, deleteProjectEnvFile, listProjectEnvFiles, updateProjectEnvFile } from "../src/modules/projects/envFiles";
import { createProject, updateProject } from "../src/modules/projects/operations";
import { expectedComposeProjectName, projectRepoDir } from "../src/modules/projects/workspace";

before(() => { initializeDatabase(); addManagedDomain("example.com"); });

test("a project has multiple independent deployments and generated HTTPS URLs", () => {
  const main = createProject({ name: "App", githubRepo: "owner/app", autoDeployBranch: "main" });
  const one = createBranchDeployment(main.id, { branch: "feature/example", env: "separate" });
  const two = createBranchDeployment(main.id, { branch: "feature-example", env: "shared" });
  assert.equal(one.branchParentId, main.id);
  assert.deepEqual(listBranchDeployments(main.id).map((item) => item.id), [two.id, one.id]);
  assert.equal(one.domains[0].domain, "app-feature-example.example.com");
  assert.equal(two.domains[0].domain, "app-feature-example-2.example.com");
  assert.equal(one.domains[0].useSsl, true);
  assert.notEqual(projectRepoDir(one), projectRepoDir(two));
  assert.notEqual(expectedComposeProjectName(one), expectedComposeProjectName(main));
  assert.throws(() => createBranchDeployment(main.id, { branch: "feature-example", env: "shared" }), /already has/);
  assert.throws(() => createBranchDeployment(main.id, { branch: "main", env: "shared" }), /primary deployment/);
  assert.throws(() => createBranchDeployment(one.id, { branch: "nested", env: "shared" }), /belong to a GitHub project/);
  assert.match(branchCheckoutConflict(main, one.autoDeployBranch) ?? "", /own deployment/);
  assert.match(branchCheckoutConflict(one, "main") ?? "", /pinned/);
  assert.throws(() => updateProject(one.id, { autoDeployBranch: "main" }), /keeps its repository and branch/);
  assert.throws(() => updateProject(main.id, { githubRepo: "owner/different" }), /Remove the branch deployments/);
  updateProject(main.id, { groupName: "New group" });
  assert.ok(listBranchDeployments(main.id).every((item) => item.groupName === "New group"));
  assert.throws(() => updateProject(one.id, { groupName: "Different group" }), /primary project/);
  assert.throws(() => getDatabase().prepare("DELETE FROM projects WHERE id = ?").run(main.id), /FOREIGN KEY/);
});

test("shared env reads live values and masks them, while separate env starts empty", () => {
  const parent = createProject({ name: "Env app", githubRepo: "owner/env", autoDeployBranch: "main" });
  const shared = createBranchDeployment(parent.id, { branch: "feature/shared", env: "shared" });
  const separate = createBranchDeployment(parent.id, { branch: "feature/separate", env: "separate" });
  const env = createProjectEnvFile(parent.id, ".env", [{ key: "API_KEY", value: "first-fixture-value" }]);
  assert.deepEqual(listProjectEnvFiles(separate.id), []);
  assert.equal(listProjectEnvFiles(shared.id)[0].variables[0].value, "first-fixture-value");
  assert.throws(() => createProjectEnvFile(shared.id, ".env", []), /Edit them on the primary project/);
  updateProjectEnvFile(env.id, parent.id, ".env", [{ key: "API_KEY", value: "updated-fixture-value" }]);
  assert.deepEqual(collectSecrets(shared.id), ["updated-fixture-value"]);
  createProjectEnvFile(separate.id, ".env", [{ key: "API_KEY", value: "different-fixture-value" }]);
  assert.deepEqual(collectSecrets(separate.id), ["different-fixture-value"]);
});

test("branch Compose checks reject names and build tags that could collide", () => {
  const options = { enforced: true, projectDir: process.cwd(), branchNamespace: "99-branch" };
  const doc = { name: "99-branch", services: { web: { build: { context: process.cwd(), tags: ["shared:latest"] }, image: "shared:latest", container_name: "web" } } };
  const rejected = evaluateResolvedPolicy({ ok: true, doc }, options);
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /container_name/);
  assert.match(rejected.message, /fixed image tag/);
  assert.match(rejected.message, /additional image tags/);
  assert.equal(evaluateResolvedPolicy({ ok: true, doc: { name: "99-branch", services: { web: { image: "nginx:alpine" } } } }, options).ok, true);
});

test("redeploying a shared branch clears old secrets and restores the source's tracked env file", async () => {
  const primary = createProject({ name: "Env cleanup app", githubRepo: "owner/env-cleanup", autoDeployBranch: "main" });
  const branch = createBranchDeployment(primary.id, { branch: "feature/cleanup", env: "shared" });
  const dir = projectRepoDir(branch);
  fs.mkdirSync(dir, { recursive: true });
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git(["init", "-q"]);
  const tracked = path.join(dir, ".env");
  const untracked = path.join(dir, "extra.env");
  fs.writeFileSync(tracked, "VALUE=repo-default\n");
  git(["add", "--", ".env"]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Track default env"]);
  const first = createProjectEnvFile(primary.id, ".env", [{ key: "VALUE", value: "fixture-secret" }]);
  const second = createProjectEnvFile(primary.id, "extra.env", [{ key: "EXTRA", value: "fixture-secret" }]);
  await writeDeploymentEnv(branch, dir);
  assert.match(fs.readFileSync(tracked, "utf8"), /fixture-secret/);
  assert.ok(fs.existsSync(untracked));
  deleteProjectEnvFile(first.id, primary.id);
  deleteProjectEnvFile(second.id, primary.id);
  await writeDeploymentEnv(branch, dir);
  assert.match(fs.readFileSync(tracked, "utf8"), /^VALUE=repo-default\r?\n$/);
  assert.equal(fs.existsSync(untracked), false);
});

test("changing the primary GitHub App binding also changes its branch deployments", () => {
  const primary = createProject({ name: "App binding", githubRepo: "owner/binding", autoDeployBranch: "main" });
  const branch = createBranchDeployment(primary.id, { branch: "preview", env: "separate" });
  bindProjectToApp(primary.id, { installationId: 4, repositoryId: 27, fullName: "owner/binding", defaultBranch: "main" });
  assert.deepEqual(getProjectBinding(branch.id), getProjectBinding(primary.id));
  unbindProjectFromApp(primary.id);
  assert.deepEqual(getProjectBinding(branch.id), { mode: null, installationId: null, repositoryId: null, repo: "owner/binding" });
});

test("an opted-in GitHub App posts only the ready HTTPS URL to the matching pull request", async () => {
  const db = getDatabase();
  const parent = createProject({ name: "PR app", githubRepo: "owner/pr-app", autoDeployBranch: "main" });
  db.prepare("UPDATE projects SET github_auth_mode = 'app' WHERE id = ?").run(parent.id);
  const branch = createBranchDeployment(parent.id, { branch: "feature/pr", env: "separate", commentOnPullRequest: true });
  const requests: { path: string; method: string; body: unknown }[] = [];
  const client = new GithubClient({ apiUrl: "https://api.github.test", webUrl: "https://github.test", timeoutMs: 1000, retries: 0,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      requests.push({ path: url.pathname + url.search, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
      return Response.json(url.pathname.endsWith("/pulls") ? [
        { number: 1, head: { ref: "feature/pr", repo: { full_name: "fork/pr-app" } } },
        { number: 7, head: { ref: "feature/pr", repo: { full_name: "owner/pr-app" } } },
      ] : {});
    },
  });
  let reachable = false;
  const deps = { certificate: async () => true, token: async () => "fixture-token", client: () => client, reachable: async () => reachable };
  assert.equal(await announceBranchPreview(branch.id, deps), "");
  assert.equal(requests.length, 0);
  setProjectDomainRoute(branch.id, branch.domains[0].id, "web", 80);
  db.prepare("INSERT INTO project_deployments (project_id, branch, status) VALUES (?, ?, 'active')").run(branch.id, branch.autoDeployBranch);
  assert.equal(await announceBranchPreview(branch.id, deps), "");
  assert.equal(requests.length, 0);
  reachable = true;
  assert.match(await announceBranchPreview(branch.id, deps), /pull request #7/);
  assert.equal(await announceBranchPreview(branch.id, deps), "");
  assert.deepEqual(requests.filter((r) => r.method === "POST"), [{
    path: "/repos/owner/pr-app/issues/7/comments", method: "POST", body: { body: `Stackport preview is ready: https://${branch.domains[0].domain}` },
  }]);
});
