import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDockerEnv } from "../src/services/projectDeploy";

test("docker compose never receives Stackport's secrets", () => {
  const env = buildDockerEnv({
    PATH: "/usr/bin",
    HOME: "/root",
    DOCKER_HOST: "unix:///var/run/docker.sock",
    JWT_SECRET: "s3cret",
    WEBHOOK_SECRET: "w",
    STACKPORT_REPO_TOKEN: "t",
  }, "/data/.docker");
  assert.deepEqual(env, {
    PATH: "/usr/bin",
    HOME: "/root",
    DOCKER_HOST: "unix:///var/run/docker.sock",
    DOCKER_CONFIG: "/data/.docker",
  });
});

test("an explicit DOCKER_CONFIG wins over the default", () => {
  assert.equal(buildDockerEnv({ DOCKER_CONFIG: "/custom" }, "/data/.docker")["DOCKER_CONFIG"], "/custom");
});

test("Windows-style env names are matched case-insensitively and keep their spelling", () => {
  const env = buildDockerEnv({ Path: "C:\\bin", SystemRoot: "C:\\Windows", JWT_SECRET: "x" }, "d");
  assert.equal(env["Path"], "C:\\bin");
  assert.equal(env["SystemRoot"], "C:\\Windows");
  assert.equal(env["JWT_SECRET"], undefined);
});
