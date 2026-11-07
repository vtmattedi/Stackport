import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDockerEnv } from "../src/modules/deployments/operations";

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

test("proxy, certificate and API-version settings reach docker, in either case, but unrelated variables do not", () => {
  const env = buildDockerEnv({
    HTTPS_PROXY: "http://proxy:3128", http_proxy: "http://proxy:3128", NO_PROXY: "localhost", no_proxy: "localhost",
    DOCKER_API_VERSION: "1.43", SSL_CERT_FILE: "/etc/ssl/corp.pem",
    DATABASE_URL: "postgres://secret", STACKPORT_REPO_TOKEN: "t",
  }, "/d");
  assert.equal(env["HTTPS_PROXY"], "http://proxy:3128");
  assert.equal(env["http_proxy"], "http://proxy:3128");
  assert.equal(env["no_proxy"], "localhost");
  assert.equal(env["DOCKER_API_VERSION"], "1.43");
  assert.equal(env["SSL_CERT_FILE"], "/etc/ssl/corp.pem");
  assert.equal(env["DATABASE_URL"], undefined);
  assert.equal(env["STACKPORT_REPO_TOKEN"], undefined);
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
