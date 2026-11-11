import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const script = path.resolve(__dirname, "../scripts/ci/version-gate.sh");
const gate = (branch: string, head: string, base: string): { status: number | null; out: string } => {
  const run = spawnSync("bash", [script, branch, head, base], { encoding: "utf8" });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
};

test("the version has to be raised, and has to match a branch that is named like a version", () => {
  assert.equal(gate("1.3.9", "1.3.9", "1.3.8").status, 0);
  assert.equal(gate("some-feature", "1.4.0", "1.3.8").status, 0, "a branch with another name only has to raise the version");
  assert.equal(gate("1.3.10", "1.3.10", "1.3.9").status, 0, "compared as numbers, not text");
  const same = gate("1.3.9", "1.3.8", "1.3.8");
  assert.equal(same.status, 1);
  assert.match(same.out, /not higher than main's 1\.3\.8/);
  assert.equal(gate("1.3.9", "1.3.7", "1.3.8").status, 1, "lower than main");
  assert.equal(gate("1.3.9", "1.3.9", "1.3.10").status, 1, "1.3.9 is below 1.3.10");
  const mismatch = gate("1.3.9", "1.3.8", "1.3.7");
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.out, /branch is named 1\.3\.9 but package\.json says 1\.3\.8/);
  assert.equal(gate("1.3.9", "v1.3.9", "1.3.8").status, 1, "not a plain version");
});
