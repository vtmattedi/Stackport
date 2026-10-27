import { before, test } from "node:test";
import assert from "node:assert/strict";
import { initializeDatabase } from "../src/config/database";
import { createProject } from "../src/services/projectAdmin";
import { getProjectById } from "../src/services/projectDeploy";
import { recordSuccessfulDeployment } from "../src/services/projectDeployments";
import { previewDeploy, previewRollback, type PreviewDeps } from "../src/services/deployPreview";
import { diffLines } from "../src/services/textDiff";

before(() => { initializeDatabase(); });

test("diffLines: identical text", () => {
  assert.deepEqual(diffLines("a\nb\n", "a\nb"), { identical: true, tooLarge: false, hunks: [] });
});

test("diffLines: one change in the middle keeps three lines of context", () => {
  const old = ["1", "2", "3", "4", "5", "6", "7", "8", "9"].join("\n");
  const next = ["1", "2", "3", "4", "five", "6", "7", "8", "9"].join("\n");
  const diff = diffLines(old, next);
  assert.equal(diff.identical, false);
  assert.equal(diff.hunks.length, 1);
  const [hunk] = diff.hunks;
  assert.equal(hunk.oldStart, 2);
  assert.equal(hunk.newStart, 2);
  assert.deepEqual(hunk.lines.map((l) => `${l.type[0]}${l.text}`), ["c2", "c3", "c4", "r5", "afive", "c6", "c7", "c8"]);
});

test("diffLines: distant changes become separate hunks, near ones merge", () => {
  const old = Array.from({ length: 30 }, (_, i) => `l${i + 1}`);
  const far = [...old]; far[1] = "x"; far[25] = "y";
  assert.equal(diffLines(old.join("\n"), far.join("\n")).hunks.length, 2);
  const near = [...old]; near[1] = "x"; near[6] = "y";
  assert.equal(diffLines(old.join("\n"), near.join("\n")).hunks.length, 1);
});

test("diffLines: added and removed lines at the ends", () => {
  const diff = diffLines("a\nb", "z\na\nb\nc");
  const lines = diff.hunks.flatMap((h) => h.lines.map((l) => `${l.type[0]}${l.text}`));
  assert.deepEqual(lines, ["az", "ca", "cb", "ac"]);
});

let counter = 0;
function setup(): number {
  const id = createProject({ name: `preview-${++counter}`, sourceType: "github", githubRepo: "o/r" }).id;
  return id;
}

function deploy(projectId: number, sha: string, compose: string): void {
  recordSuccessfulDeployment(projectId, {
    commitSha: sha, branch: "main", composeFileName: "docker-compose.yml",
    sourceCompose: compose, effectiveCompose: `${compose}\n# stackport`, triggeredBy: "manual",
  });
}

function commit(sha: string, message: string) {
  return { sha, commit: { message: `${message}\n\nbody`, author: { name: "dev", date: "2026-01-01T00:00:00Z" } } };
}

function fakeGitHub(routes: Record<string, unknown>): PreviewDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    get: async (path) => {
      calls.push(path);
      if (!(path in routes)) throw new Error(`GitHub API 404: ${path}`);
      return routes[path];
    },
  };
}

test("deploy preview lists the new commits and diffs the Compose source", async () => {
  const id = setup();
  deploy(id, "aaaaaaa", "services:\n  web:\n    image: a");
  const project = { ...getProjectById(id)!, autoDeployBranch: "main", composeFile: "docker-compose.yml" };
  const gh = fakeGitHub({
    "/repos/o/r/compare/aaaaaaa...main": {
      status: "ahead", ahead_by: 2, behind_by: 0,
      commits: [commit("bbbbbbb", "first"), commit("ccccccc", "second")],
    },
    "/repos/o/r/contents/docker-compose.yml?ref=ccccccc": {
      type: "file", encoding: "base64", content: Buffer.from("services:\n  web:\n    image: b").toString("base64"),
    },
  });
  const preview = await previewDeploy(project, null, gh);
  assert.equal(preview.from?.sha, "aaaaaaa");
  assert.equal(preview.to.sha, "ccccccc");
  assert.equal(preview.commits?.status, "ahead");
  assert.deepEqual(preview.commits?.added.map((c) => c.message), ["first", "second"]);
  assert.equal(preview.commits?.removedTotal, 0);
  assert.equal(preview.compose?.basis, "source");
  const changed = preview.compose?.diff.hunks.flatMap((h) => h.lines).filter((l) => l.type !== "context");
  assert.deepEqual(changed, [{ type: "remove", text: "    image: a" }, { type: "add", text: "    image: b" }]);
});

test("deploy preview reports a GitHub failure as a note instead of throwing", async () => {
  const id = setup();
  deploy(id, "aaaaaaa", "x");
  const project = { ...getProjectById(id)!, autoDeployBranch: "main", composeFile: "docker-compose.yml" };
  const preview = await previewDeploy(project, "feature/x", fakeGitHub({}));
  assert.equal(preview.commits, null);
  assert.match(preview.commitsNote ?? "", /Couldn't compare commits/);
  assert.match(preview.composeNote ?? "", /GitHub couldn't be reached/);
});

test("deploy preview with nothing deployed yet", async () => {
  const id = setup();
  const project = { ...getProjectById(id)!, autoDeployBranch: "main", composeFile: "docker-compose.yml" };
  const gh = fakeGitHub({});
  const preview = await previewDeploy(project, null, gh);
  assert.equal(preview.from, null);
  assert.match(preview.commitsNote ?? "", /Nothing has been deployed/);
  assert.equal(gh.calls.length, 0);
});

test("rollback preview lists the commits being undone and diffs the effective Compose", async () => {
  const id = setup();
  deploy(id, "aaaaaaa", "v: 1");
  deploy(id, "ccccccc", "v: 2");
  const project = getProjectById(id)!;
  const gh = fakeGitHub({
    "/repos/o/r/compare/aaaaaaa...ccccccc": {
      status: "ahead", ahead_by: 2, behind_by: 0,
      commits: [commit("bbbbbbb", "first"), commit("ccccccc", "second")],
    },
  });
  const result = await previewRollback(project, undefined, gh);
  assert.ok(result.ok);
  if (!result.ok) return;
  const { preview } = result;
  assert.equal(preview.to.sha, "aaaaaaa");
  assert.equal(preview.commits?.status, "behind");
  assert.deepEqual(preview.commits?.removed.map((c) => c.sha), ["bbbbbbb", "ccccccc"]);
  assert.equal(preview.commits?.addedTotal, 0);
  assert.equal(preview.compose?.basis, "effective");
  const changed = preview.compose?.diff.hunks.flatMap((h) => h.lines).filter((l) => l.type !== "context");
  assert.deepEqual(changed, [{ type: "remove", text: "v: 2" }, { type: "add", text: "v: 1" }]);
});

test("rollback preview without a target is an error", async () => {
  const id = setup();
  deploy(id, "aaaaaaa", "v: 1");
  const result = await previewRollback(getProjectById(id)!, undefined, fakeGitHub({}));
  assert.equal(result.ok, false);
});
