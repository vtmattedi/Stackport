#!/usr/bin/env node

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const targetDir = path.resolve(process.argv[2] || process.cwd());
const packagePath = path.join(targetDir, "package.json");
const lockPath = path.join(targetDir, "package-lock.json");
const buildInfoPath = path.join(targetDir, "build-info.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function bumpPatch(version) {
  const parts = String(version || "0.0.0").split(".").map((part) => Number.parseInt(part, 10));
  const major = Number.isFinite(parts[0]) ? parts[0] : 0;
  const minor = Number.isFinite(parts[1]) ? parts[1] : 0;
  const patch = Number.isFinite(parts[2]) ? parts[2] : 0;
  return `${major}.${minor}.${patch + 1}`;
}

function gitValue(args) {
  try {
    return execSync(`git ${args}`, { cwd: targetDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

const pkg = readJson(packagePath);
const nextVersion = bumpPatch(pkg.version);
pkg.version = nextVersion;
writeJson(packagePath, pkg);

if (fs.existsSync(lockPath)) {
  const lock = readJson(lockPath);
  lock.version = nextVersion;
  if (lock.packages && lock.packages[""]) {
    lock.packages[""].version = nextVersion;
  }
  writeJson(lockPath, lock);
}

writeJson(buildInfoPath, {
  name: pkg.name,
  version: nextVersion,
  builtAt: new Date().toISOString(),
  gitCommit: gitValue("rev-parse --short HEAD"),
  gitBranch: gitValue("branch --show-current"),
  gitMessage: gitValue("log -1 --format=%s"),
});

// If this target ships a PWA (has a public/ dir Vite copies verbatim into
// dist/), also drop the version there so the running app can fetch it
// unauthenticated and detect when a newer build has been deployed.
const publicDir = path.join(targetDir, "public");
if (fs.existsSync(publicDir)) {
  writeJson(path.join(publicDir, "version.json"), { version: nextVersion });
}

console.log(`${pkg.name} ${nextVersion}`);
