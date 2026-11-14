/* eslint-disable no-console -- this file's entire purpose is printing to the operator's terminal */
/* eslint-disable security/detect-non-literal-fs-filename -- every path here is the operator's own CLI argument or Stackport's configured data directory. */
/* eslint-disable security/detect-object-injection -- indexes are positions in argv. */
// Invoked by `stackport backup|restore|backup-verify` through docker (see stackport.sh), never over HTTP:
// whoever can run a container on the host is already the local-root authorization boundary.
//
//   backup.js create  --level 1|2 --out FILE
//   backup.js verify  FILE
//   backup.js restore FILE --mode recover|clone [--yes]      (offline: nothing else may hold the database)
//
// The passphrase comes from --passphrase-file, STACKPORT_BACKUP_PASSPHRASE, or a prompt on a terminal.
import fs from "fs";
import path from "path";
import readline from "readline";
import { config } from "../config/env";
import { initializeDatabase, closeDatabase } from "../config/database";
import { ArchiveError } from "../modules/backup/archive";
import { createBackup } from "../modules/backup/export";
import { describeInstallation, restoreBackup, RestoreRefused, stageArchive, verifyStaged, type Finding, type RestoreMode } from "../modules/backup/restore";
import type { BackupManifest } from "../modules/backup/manifest";

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): { positional: string[]; flags: Map<string, string | true> } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (["yes"].includes(key)) flags.set(key, true);
    else if (next === undefined || next.startsWith("--")) fail(`--${key} needs a value`);
    else { flags.set(key, next); i += 1; }
  }
  return { positional, flags };
}

function ask(question: string, muted: boolean): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    if (muted) {
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => { if (s.includes(question)) process.stdout.write(s); };
    }
    rl.question(question, (answer) => { rl.close(); if (muted) process.stdout.write("\n"); resolve(answer); });
  });
}

async function readPassphrase(flags: Map<string, string | true>, confirm: boolean): Promise<string> {
  const file = flags.get("passphrase-file");
  if (typeof file === "string") {
    const value = fs.readFileSync(file, "utf8").replace(/\r?\n$/, "");
    if (!value) fail("the passphrase file is empty");
    return value;
  }
  const fromEnv = process.env["STACKPORT_BACKUP_PASSPHRASE"];
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY) fail("no passphrase: use --passphrase-file or STACKPORT_BACKUP_PASSPHRASE, or run on a terminal");
  const first = await ask("Backup passphrase: ", true);
  if (confirm) {
    // Only when creating: an existing archive must stay openable whatever passphrase it was made with.
    if (first.length < 12) fail("use a passphrase of at least 12 characters");
    if ((await ask("Repeat the passphrase: ", true)) !== first) fail("the passphrases differ");
  }
  return first;
}

function printFindings(findings: Finding[]): void {
  for (const finding of findings) console.log(`  ${finding.level === "error" ? "ERROR" : "warn "}  ${finding.message}`);
}

function printManifest(manifest: BackupManifest): void {
  console.log(`Archive made ${manifest.createdAt} by Stackport ${manifest.stackportVersion} (schema ${manifest.schemaVersion})`);
  console.log(`Level ${manifest.level} — from instance "${manifest.instance.name}" (${manifest.instance.id})`);
  console.log("Included:");
  for (const c of manifest.components.filter((x) => x.included)) console.log(`  + ${c.description}`);
  console.log("NOT included:");
  for (const c of manifest.components.filter((x) => !x.included)) console.log(`  - ${c.description}${c.reason ? ` — ${c.reason}` : ""}`);
  const rows = Object.entries(manifest.tables).filter(([, n]) => n > 0).map(([t, n]) => `${t}: ${n}`);
  if (rows.length) console.log(`Rows: ${rows.join(", ")}`);
  const host = Object.entries(manifest.host);
  if (host.length) console.log(`Source host values (shown, never applied): ${host.map(([k, v]) => `${k}=${v}`).join(", ")}`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);

  if (command === "create") {
    const level = Number(flags.get("level") ?? "2");
    if (level === 3) fail("level 3 (full data) is not available yet; use level 1 or 2");
    if (level !== 1 && level !== 2) fail("--level must be 1 or 2");
    const out = flags.get("out");
    if (typeof out !== "string") fail("--out FILE is required");
    if (fs.existsSync(out)) fail(`${out} already exists; choose another name`);
    const passphrase = await readPassphrase(flags, true);
    initializeDatabase();
    try {
      const manifest = createBackup({ level, outPath: out, passphrase });
      printManifest(manifest);
      console.log(`\nBackup written to ${path.resolve(out)}`);
      console.log("Keep the passphrase safe: without it the archive cannot be opened, and Stackport cannot recover it.");
    } finally {
      closeDatabase();
    }
    return;
  }

  if (command === "verify" || command === "restore") {
    const archive = positional[0];
    if (!archive) fail(`usage: ${command} FILE`);
    if (!fs.existsSync(archive)) fail(`${archive} does not exist`);
    const passphrase = await readPassphrase(flags, false);

    if (command === "verify") {
      const scratch = path.resolve(path.dirname(config.sqlitePath));
      fs.mkdirSync(scratch, { recursive: true });
      const dir = fs.mkdtempSync(path.join(scratch, ".verify-"));
      try {
        const staged = stageArchive(archive, passphrase, path.join(dir, "x"));
        const findings = verifyStaged(staged);
        printManifest(staged.manifest);
        console.log(findings.length ? "\nFindings:" : "\nNo problems found.");
        printFindings(findings);
        // Not process.exit here: it would skip the finally and leave the decrypted archive on disk.
        process.exitCode = findings.some((f) => f.level === "error") ? 1 : 0;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      return;
    }

    const mode = flags.get("mode");
    if (mode !== "recover" && mode !== "clone") fail("--mode recover|clone is required (recover keeps the instance identity; clone creates a new one)");
    const current = describeInstallation(path.resolve(config.sqlitePath));
    console.log("This will REPLACE the installation's configuration with the archive's.");
    if (current.exists) {
      console.log(`Current: "${current.instanceName ?? "?"}" (${current.instanceId ?? "no id"}), ${current.projects} projects. Its database is kept under data/backups/pre-restore-*.`);
      if (current.projects > 0) console.log("Containers of existing projects keep running but are no longer tracked unless the archive describes them.");
    }
    console.log(mode === "clone" ? "Mode: clone — new instance id, sessions/tokens/GitHub App removed, projects paused, automation off.\n" : "Mode: recover — keeps the instance id; sessions are ended.\n");
    if (flags.get("yes") !== true) {
      if (!process.stdin.isTTY) fail("not a terminal: pass --yes to confirm the restore");
      if ((await ask("Type RESTORE to continue: ", false)).trim() !== "RESTORE") fail("cancelled");
    }
    const result = restoreBackup({ archivePath: archive, passphrase, mode: mode as RestoreMode });
    printManifest(result.manifest);
    console.log("\nDone:");
    for (const action of result.actions) console.log(`  * ${action}`);
    if (result.warnings.length) { console.log("Warnings:"); for (const w of result.warnings) console.log(`  ! ${w}`); }
    console.log(`\nInstance id: ${result.instanceId}`);
    if (result.secretsToAdopt.length) console.log(`The host must adopt these keys before starting: ${result.secretsToAdopt.join(", ")} (written to ${result.envOutPath}; \`stackport restore\` does this for you).`);
    return;
  }

  fail("usage: backup.js create --level 1|2 --out FILE | verify FILE | restore FILE --mode recover|clone [--yes]");
}

main().catch((error: unknown) => {
  if (error instanceof RestoreRefused) {
    console.error("The archive is not acceptable:");
    printFindings(error.findings);
    process.exit(1);
  }
  if (error instanceof ArchiveError) fail(error.message);
  console.error(error);
  process.exit(1);
});
