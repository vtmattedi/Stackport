import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Pin all Stackport-owned nginx usages to the same upstream security release.
// In November 2026, 1.30.7 stable / 1.31.9 mainline fixed the HTTP/2
// memory-corruption vulnerabilities, including CVE-2026-123007.
const INGRESS_IMAGE = "nginx:1.30.7-alpine";
const root = path.resolve(__dirname, "..");
const read = (file: string): string => fs.readFileSync(path.join(root, file), "utf8");

const pinnedImageFiles = [
  "docker-compose.system.yml",
  "stackport.sh",
  "scripts/e2e/app-ingress.cjs",
  "scripts/e2e/backup-upload.cjs",
  "scripts/tests/clean-install.sh",
  "scripts/ui/fakeDocker.ts",
  "docs/operations/runbook.md",
  "docs/engineering/full-backup.md",
] as const;

test("Stackport nginx images use the patched stable version across deployment, tests and docs", () => {
  for (const file of pinnedImageFiles) {
    const versions = [...read(file).matchAll(/\bnginx:\d+\.\d+\.\d+-alpine\b/g)].map((match) => match[0]);
    assert.ok(versions.length > 0, `${file} must pin an nginx version`);
    assert.ok(versions.every((image) => image === INGRESS_IMAGE),
      `${file} must use ${INGRESS_IMAGE}; found ${versions.join(", ")}`);
  }

  assert.match(read("docker-compose.system.yml"),
    /^  nginx:\r?\n    image: nginx:1\.30\.7-alpine\s*$/m,
    "production ingress must use the fixed NGINX release");
});

test("the updater pre-pulls nginx before swapping the live application image", () => {
  const script = read("stackport.sh");
  const pull = script.indexOf('pull --policy missing nginx');
  const swap = script.indexOf('swap_to_image "$STAGED_IMAGE"');
  assert.ok(pull !== -1 && swap !== -1 && pull < swap,
    "stage_update must acquire the target proxy image before swapping the running stack");
});

test("rolling back Stackport cannot recreate nginx from the old vulnerable Compose image", () => {
  const script = read("stackport.sh");
  assert.match(script, /swap_to_image "\$PREVIOUS_IMAGE" app-only/);
  assert.match(script, /compose up -d --no-deps --build stackport/);
  assert.match(script, /if \[\[ "\$scope" == "all" \]\]; then compose up -d --no-build/);
});

test("generated HTTPS server blocks still support HTTP/2 after the image fix", () => {
  const config = read("src/modules/ingress/nginx/configWriter.ts");
  assert.match(config, /http2 on;/);
});
