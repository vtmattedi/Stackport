import { test } from "node:test";
import assert from "node:assert/strict";
import { loadYamlDoc } from "../src/services/composeYaml";
import { dotenvKeys, extractComposeVariables } from "../src/services/composeVariables";

const COMPOSE = `
# \${IN_A_COMMENT} is ignored
services:
  web:
    image: "app:\${TAG:-latest}"
    environment:
      DATABASE_URL: postgres://\${DB_USER}:\${DB_PASS:?set DB_PASS}@db/app
      PRICE: "$$5"
      HOME_DIR: $HOME
      MIXED: \${MIXED}
      MIXED_AGAIN: \${MIXED:-x}
    env_file: ./web.env
`;

test("interpolated variables are found with their default and required forms", () => {
  const refs = extractComposeVariables(loadYamlDoc(COMPOSE));
  assert.deepEqual(refs, [
    { name: "DB_PASS", hasDefault: false, required: true },
    { name: "DB_USER", hasDefault: false, required: false },
    { name: "HOME", hasDefault: false, required: false },
    { name: "MIXED", hasDefault: false, required: false },
    { name: "TAG", hasDefault: true, required: false },
  ]);
});

test("escaped dollars and comments are not references", () => {
  const names = extractComposeVariables(loadYamlDoc(COMPOSE)).map((r) => r.name);
  assert.equal(names.includes("IN_A_COMMENT"), false);
  assert.equal(names.includes("5"), false);
});

test("dotenv keys are read, including export lines, ignoring comments", () => {
  assert.deepEqual([...dotenvKeys("# c\nA=1\nexport B=2\n  C = 3\nnot a line\n")].sort(), ["A", "B", "C"]);
});
