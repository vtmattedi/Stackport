import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findFileReferences, formatPolicyViolation } from "../src/modules/deployments/compose/policy";
import { checkComposeFileReferences } from "../src/modules/deployments/compose/references";

/** Compose reads env_file, include, extends and the Dockerfile from the Stackport container's own
 *  filesystem, where /app/.env holds the app's secrets. Each must stay inside the project. */

let base: string;
let project: string;
let outside: string;

before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "sp-refs-"));
  project = path.join(base, "project");
  outside = path.join(base, "outside");
  fs.mkdirSync(path.join(project, "env"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "stackport.env"), "JWT_SECRET=x\n");
  fs.writeFileSync(path.join(project, "env", "app.env"), "A=1\n");
  fs.symlinkSync(outside, path.join(project, "linked"), "junction");
});
after(() => { fs.rmSync(base, { recursive: true, force: true }); });

const write = (name: string, content: string) => { fs.mkdirSync(path.dirname(path.join(project, name)), { recursive: true }); fs.writeFileSync(path.join(project, name), content); };
const yamlPath = (p: string) => JSON.stringify(p);
const lines = async (file = "compose.yml") => (await checkComposeFileReferences(project, file)).map(formatPolicyViolation);

test("findFileReferences reads every spelling of env_file, extends, build and include", () => {
  const refs = findFileReferences({
    include: ["a.yml", { path: ["b.yml", "c.yml"], env_file: "inc.env" }],
    services: {
      web: {
        env_file: ["one.env", { path: "two.env", required: false }],
        extends: { file: "base.yml", service: "web" },
        build: { context: "./api", dockerfile: "Dockerfile.prod" },
      },
      db: { env_file: "db.env", extends: "web" },
    },
  });
  const summary = refs.map((ref) => `${ref.kind}:${ref.service ?? "-"}:${ref.path}`).sort();
  assert.deepEqual(summary, [
    "dockerfile:web:Dockerfile.prod",
    "env_file:db:db.env",
    "env_file:web:one.env",
    "env_file:web:two.env",
    "extends:web:base.yml",
    "include-env_file:-:inc.env",
    "include:-:a.yml",
    "include:-:b.yml",
    "include:-:c.yml",
  ]);
  assert.equal(refs.find((ref) => ref.kind === "dockerfile")?.context, "./api");
});

test("an env_file inside the project passes, in every form", async () => {
  write("compose.yml", "services:\n  web:\n    image: x\n    env_file:\n      - env/app.env\n      - path: ./env/app.env\n        required: false\n");
  assert.deepEqual(await lines(), []);
});

test("an absolute env_file that points at Stackport's own secrets is refused", async () => {
  write("compose.yml", `services:\n  web:\n    image: x\n    env_file: ${yamlPath(path.join(outside, "stackport.env"))}\n`);
  const found = await lines();
  assert.equal(found.length, 1);
  assert.match(found[0], /services\.web\.env_file: .*outside the project folder/);
});

test("the mapping form and a parent-directory path are refused too", async () => {
  write("compose.yml", `services:\n  web:\n    image: x\n    env_file:\n      - path: ${yamlPath(path.join(outside, "stackport.env"))}\n        required: false\n      - ../outside/stackport.env\n`);
  assert.equal((await lines()).length, 2);
});

test("an env_file reached through a symlink out of the project is refused", async () => {
  write("compose.yml", "services:\n  web:\n    image: x\n    env_file: linked/stackport.env\n");
  assert.equal((await lines()).length, 1);
});

test("a path built from a variable cannot be checked, so it is refused", async () => {
  write("compose.yml", "services:\n  web:\n    image: x\n    env_file: ${ENV_FILE:-.env}\n");
  const found = await lines();
  assert.equal(found.length, 1);
  assert.match(found[0], /variable/);
});

test("an included file is followed: its own env_file is checked", async () => {
  write("compose.yml", "include:\n  - extra/part.yml\nservices:\n  web:\n    image: x\n");
  write("extra/part.yml", `services:\n  api:\n    image: x\n    env_file: ${yamlPath(path.join(outside, "stackport.env"))}\n`);
  const found = await lines();
  assert.equal(found.length, 1);
  assert.match(found[0], /services\.api\.env_file/);
});

test("a relative path in an included file is relative to that file", async () => {
  write("compose.yml", "include:\n  - extra/part.yml\nservices:\n  web:\n    image: x\n");
  write("extra/part.yml", "services:\n  api:\n    image: x\n    env_file: ../env/app.env\n");
  assert.deepEqual(await lines(), []);
});

test("an include or extends that points outside the project is refused and not followed", async () => {
  write("compose.yml", `include:\n  - ${yamlPath(path.join(outside, "other.yml"))}\nservices:\n  web:\n    image: x\n    extends:\n      file: ../outside/other.yml\n      service: web\n`);
  const found = await lines();
  assert.equal(found.length, 2);
  assert.ok(found.some((line) => /^include\./.test(line)));
  assert.ok(found.some((line) => /services\.web\.extends/.test(line)));
});

test("a Dockerfile outside the project is refused; one inside, or a remote context, is fine", async () => {
  write("compose.yml", "services:\n  a:\n    build:\n      context: .\n      dockerfile: /app/.env\n  b:\n    build:\n      context: ./api\n      dockerfile: ../Dockerfile.shared\n  c:\n    build:\n      context: https://github.com/acme/app.git\n      dockerfile: Dockerfile\n");
  write("Dockerfile.shared", "FROM alpine\n");
  const found = await lines();
  assert.equal(found.length, 1);
  assert.match(found[0], /services\.a\.dockerfile/);
});

test("include cycles end, and a file that cannot be read is left for Compose to report", async () => {
  write("compose.yml", "include:\n  - a.yml\n  - missing.yml\nservices:\n  web:\n    image: x\n");
  write("a.yml", "include:\n  - compose.yml\nservices:\n  x:\n    image: y\n");
  assert.deepEqual(await lines(), []);
  write("compose.yml", "include:\n  - broken.yml\nservices:\n  web:\n    image: x\n");
  write("broken.yml", "services: [unclosed\n");
  assert.deepEqual(await lines(), []);
});
