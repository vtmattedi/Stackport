// Run by `stackport update` inside a freshly swapped container:
//   docker exec -u node stackport node dist/scripts/updaterSelfTest.js
// Exits non-zero, and the update rolls back, unless the new version is ready and can
// launch the self-updater the same way the UI's Update button does.
import { initializeDatabase } from "../config/database";
import { getReadiness } from "../services/readiness";
import { runUpdaterSelfTest } from "../services/selfUpdate";

async function main(): Promise<void> {
  initializeDatabase();
  const readiness = await getReadiness({ requireBundle: true, requireDocker: true });
  for (const [name, result] of Object.entries(readiness.checks)) {
    process.stdout.write(`[selftest] ${name}: ${result.ok ? "ok" : "FAILED"}${result.detail ? ` (${result.detail})` : ""}\n`);
  }
  if (!readiness.ok) process.exit(1);
  process.stdout.write(`[selftest] updater launch: ok (${await runUpdaterSelfTest()})\n`);
}

main().catch((err: unknown) => {
  process.stdout.write(`[selftest] updater launch: FAILED (${err instanceof Error ? err.message : String(err)})\n`);
  process.exit(1);
});
