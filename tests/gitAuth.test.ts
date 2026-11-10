import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import {
  basicAuthHeader, buildGitEnv, gitCredentialProblem, gitUrlScope, gitVersionSupportsEnvConfig, parseGitVersion, resetGitCredentialCheck,
} from "../src/shared/gitAuth";

const exec = promisify(execFile);
const HEADER = basicAuthHeader("octocat", "ghp_SECRET_TOKEN_VALUE");

test("the header is scoped to the repository's own origin", () => {
  assert.equal(gitUrlScope("https://github.com/owner/repo.git"), "https://github.com/");
  assert.equal(gitUrlScope("http://127.0.0.1:8080/x.git"), "http://127.0.0.1:8080/");
  assert.equal(gitUrlScope("ssh://git@github.com/owner/repo.git"), null);
  assert.equal(gitUrlScope("not a url"), null);
  const env = buildGitEnv({}, HEADER, "https://github.com/");
  assert.equal(env["GIT_CONFIG_COUNT"], "1");
  assert.equal(env["GIT_CONFIG_KEY_0"], "http.https://github.com/.extraHeader");
  assert.equal(env["GIT_CONFIG_VALUE_0"], HEADER);
});

test("Git gets only what it needs: Stackport's own secrets are not passed on, and it cannot prompt", () => {
  const env = buildGitEnv({ PATH: "/usr/bin", HOME: "/root", JWT_SECRET: "s", ENCRYPTION_KEY: "k", WEBHOOK_SECRET: "w", STACKPORT_REPO_TOKEN: "t", HTTPS_PROXY: "http://proxy:3128" }, HEADER, "https://github.com/");
  assert.equal(env["PATH"], "/usr/bin");
  assert.equal(env["HTTPS_PROXY"], "http://proxy:3128");
  for (const name of ["JWT_SECRET", "ENCRYPTION_KEY", "WEBHOOK_SECRET", "STACKPORT_REPO_TOKEN"]) assert.equal(env[name], undefined, name);
  assert.equal(env["GIT_TERMINAL_PROMPT"], "0");
});

test("without a credential no configuration is added", () => {
  const env = buildGitEnv({ PATH: "/bin" }, null, "https://github.com/");
  assert.equal(Object.keys(env).some((key) => key.startsWith("GIT_CONFIG")), false);
  assert.equal(Object.keys(buildGitEnv({}, HEADER, null)).some((key) => key.startsWith("GIT_CONFIG")), false, "and none without a scope to attach it to");
});

test("Git versions: 2.31 is the first that reads configuration from the environment", () => {
  assert.deepEqual(parseGitVersion("git version 2.39.5\n"), [2, 39]);
  assert.deepEqual(parseGitVersion("git version 2.53.0.windows.1"), [2, 53]);
  assert.equal(parseGitVersion("something else"), null);
  assert.equal(gitVersionSupportsEnvConfig([2, 31]), true);
  assert.equal(gitVersionSupportsEnvConfig([2, 30]), false);
  assert.equal(gitVersionSupportsEnvConfig([3, 0]), true);
  assert.equal(gitVersionSupportsEnvConfig([1, 9]), false);
});

test("an old Git is refused with a reason; there is no fall back to the command line", async () => {
  resetGitCredentialCheck();
  assert.match(String(await gitCredentialProblem(async () => "git version 2.25.1")), /too old.*does not put credentials on the command line/);
  resetGitCredentialCheck();
  assert.equal(await gitCredentialProblem(async () => "git version 2.39.5"), null);
  resetGitCredentialCheck();
  assert.match(String(await gitCredentialProblem(async () => { throw new Error("ENOENT"); })), /not available/);
  resetGitCredentialCheck();
  assert.match(String(await gitCredentialProblem(async () => "garbage")), /Could not tell which version/);
  resetGitCredentialCheck();
});

/** Records the headers of every request it gets. */
async function listen(): Promise<{ origin: string; seen: Record<string, string | string[] | undefined>[]; close(): void }> {
  const seen: Record<string, string | string[] | undefined>[] = [];
  const server = http.createServer((req, res) => { seen.push(req.headers); res.statusCode = 404; res.end("no"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => { server.close(); server.closeAllConnections(); } };
}

test("real Git sends the header to its own origin and to no other", async () => {
  const own = await listen();
  const other = await listen();
  try {
    const env = buildGitEnv({ ...process.env, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" }, HEADER, gitUrlScope(`${own.origin}/x.git`));
    for (const origin of [own.origin, other.origin]) {
      await exec("git", ["ls-remote", `${origin}/x.git`], { env, timeout: 20_000 }).catch(() => undefined); // both answer 404
    }
    assert.ok(own.seen.length > 0, "git reached its own origin");
    assert.ok(own.seen.every((h) => h["authorization"] === HEADER.replace("Authorization: ", "")), "and sent the credential there");
    assert.ok(other.seen.length > 0, "git reached the other server");
    assert.ok(other.seen.every((h) => h["authorization"] === undefined), "which never saw it");
  } finally { own.close(); other.close(); }
});

test("no command line in the source carries a credential any more", () => {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && /extraHeader=/.test(fs.readFileSync(full, "utf8"))) offenders.push(path.relative(path.join(__dirname, ".."), full));
    }
  };
  walk(path.join(__dirname, "../src"));
  assert.deepEqual(offenders, []);
});
