import { test } from "node:test";
import assert from "node:assert/strict";
import { loadYamlDoc } from "../src/services/composeYaml";
import { extractComposeEnvFileRefs, extractRawComposeIngressTargets } from "../src/services/composeIngress";

const COMPOSE = `
services:
  web:
    env_file: ./front/.env
    ports:
      - "8080:3000"
      - "127.0.0.1:9229:9229/tcp"
      - "\${HOST_PORT:-5000}:\${APP_PORT}"
  api:
    env_file:
      - .env
      - path: api/.env.local
        required: false
    expose: ["4000"]
  worker:
    env_file: [.env]
    environment:
      - PORT=7000
`;

test("raw compose ports become ingress targets without resolving env", () => {
  assert.deepEqual(extractRawComposeIngressTargets(loadYamlDoc(COMPOSE)), [
    { service: "api", containerPort: 4000 },
    { service: "web", containerPort: 3000 },
    { service: "web", containerPort: 9229 },
    { service: "worker", containerPort: 7000 },
  ]);
});

test("env_file references are collected per path with their services", () => {
  assert.deepEqual(extractComposeEnvFileRefs(loadYamlDoc(COMPOSE)), [
    { path: ".env", required: true, services: ["api", "worker"] },
    { path: "api/.env.local", required: false, services: ["api"] },
    { path: "front/.env", required: true, services: ["web"] },
  ]);
});

test("a compose file without services yields nothing", () => {
  assert.deepEqual(extractComposeEnvFileRefs(loadYamlDoc("version: '3'")), []);
  assert.deepEqual(extractRawComposeIngressTargets(null), []);
});
