import fs from "fs";
import path from "path";
import { getDatabase } from "../config/database";
import { config } from "../config/env";
import { currentImage } from "./selfUpdate";

export interface ReadinessCheck {
  ok: boolean;
  detail?: string;
}

export interface Readiness {
  ok: boolean;
  checks: Record<string, ReadinessCheck>;
}

export interface ReadinessOptions {
  /** The built UI must be on disk (production serves it from client/dist). */
  requireBundle: boolean;
  /** The Docker socket must answer and the app must be able to find its own image,
   *  which is what launching the self-updater needs. */
  requireDocker: boolean;
  /** Where the built UI's index.html lives; overridable for tests. */
  bundleIndex?: string;
}

const defaultOptions = (): ReadinessOptions => ({
  requireBundle: config.nodeEnv === "production",
  requireDocker: config.nodeEnv === "production",
});

async function check(fn: () => Promise<string | void> | string | void): Promise<ReadinessCheck> {
  try {
    const detail = await fn();
    return detail ? { ok: true, detail } : { ok: true };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Everything a freshly updated Stackport must have before the update is accepted:
 *  more than "the process listens", which is all /health proves. */
export async function getReadiness(options: ReadinessOptions = defaultOptions()): Promise<Readiness> {
  const checks: Record<string, ReadinessCheck> = {
    database: await check(() => {
      getDatabase().prepare("SELECT 1").get();
    }),
  };
  if (options.requireBundle) {
    checks["bundle"] = await check(() => {
      const index = options.bundleIndex ?? path.join(__dirname, "../../client/dist/index.html");
      if (!fs.existsSync(index)) throw new Error(`missing ${index}`);
    });
  }
  if (options.requireDocker) {
    checks["updater"] = await check(async () => `running ${(await currentImage()).slice(7, 19)}`);
  }
  return { ok: Object.values(checks).every((c) => c.ok), checks };
}
