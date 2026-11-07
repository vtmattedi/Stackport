import * as fs from "fs/promises";
import * as path from "path";

/** A new project's writable bind mounts live in directories Stackport creates (S2), so they start empty.
 *  When the repository ships files in that folder (seed data, default config, an initial database), the
 *  container would no longer see them. The first time a managed directory is created it is filled from the
 *  repository's folder instead, and never again: after that the data belongs to the application. */

export type SeedOutcome = "seeded" | "exists" | "empty-source" | "no-source";

type Entry = string;

/** One line per file, directory and link under `root`: kind, path, size, link target. Two trees with the same
 *  manifest hold the same names and sizes; links are compared by target. */
async function manifest(root: string, dir = ""): Promise<Entry[]> {
  const out: Entry[] = [];
  for (const name of (await fs.readdir(path.join(root, dir))).sort()) {
    const rel = path.posix.join(dir, name);
    const stat = await fs.lstat(path.join(root, rel));
    if (stat.isSymbolicLink()) out.push(`l|${rel}|${await fs.readlink(path.join(root, rel))}`);
    else if (stat.isDirectory()) { out.push(`d|${rel}`); out.push(...await manifest(root, rel)); }
    else out.push(`f|${rel}|${stat.size}`);
  }
  return out;
}

/** Creates `target` and, if it is new, fills it from `source`. The copy is made beside it and renamed into place
 *  once it matches the source, so an interrupted or failed copy never leaves a half-filled directory behind
 *  that the next deploy would take for the real one. Links are copied as links, not followed. */
export async function seedManagedDirectory(source: string, target: string): Promise<SeedOutcome> {
  if (await fs.lstat(target).then(() => true, () => false)) return "exists";
  await fs.mkdir(path.dirname(target), { recursive: true });

  const sourceStat = await fs.lstat(source).catch(() => null);
  if (!sourceStat?.isDirectory()) { await fs.mkdir(target); return "no-source"; }
  if ((await fs.readdir(source)).length === 0) { await fs.mkdir(target); return "empty-source"; }

  const staging = `${target}.seeding`;
  await fs.rm(staging, { recursive: true, force: true });
  try {
    await fs.cp(source, staging, { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true });
    const [wanted, copied] = await Promise.all([manifest(source), manifest(staging)]);
    if (wanted.length !== copied.length || wanted.some((line, i) => line !== copied[i])) {
      throw new Error(`the copy of ${source} does not match the original`);
    }
    await fs.rename(staging, target);
  } catch (err) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(`Could not fill the new mount directory from the repository's files: ${err instanceof Error ? err.message : String(err)}`);
  }
  return "seeded";
}
