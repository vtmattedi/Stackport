import * as fs from "fs";
import * as path from "path";

const MAX_RELATIVE_PATH_LENGTH = 240;

/**
 * Syntactic validation only: rejects absolute paths, empty/`.`/`..` segments, and
 * overlong paths. Does not check containment against a real directory on disk —
 * pair with `resolveContainedPath` for that.
 */
export function normalizeRelativePath(input: string): string | null {
  const trimmed = input.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!trimmed || trimmed.length > MAX_RELATIVE_PATH_LENGTH) return null;
  if (path.posix.isAbsolute(trimmed)) return null;
  const parts = trimmed.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  return trimmed;
}

function isWithin(target: string, root: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/**
 * The real path of `target`, following symlinks, even when `target` does not exist yet:
 * the deepest part that does exist is resolved and the rest is appended. Returns null
 * for a dangling symlink, because writing through one creates the file wherever it points.
 */
function realPathAllowingMissing(target: string): string | null {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- this module is the containment check: it inspects the path it is asked about.
      return path.join(fs.realpathSync(current), ...missing.reverse());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
      // realpath fails with ENOENT for a link whose target is missing as well as for a missing name.
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- this module is the containment check: it inspects the path it is asked about.
      if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) return null;
      const parent = path.dirname(current);
      if (parent === current) return null;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Resolves `relative` under `root` and rejects it if the result would escape
 * `root`: by `..` segments, or through a symlink inside `root` that points outside it
 * (S12). Returns the resolved absolute path, or null if it escapes. The path is not
 * created, so a name that does not exist yet is checked through its existing parents.
 */
export function resolveContainedPath(root: string, relative: string): string | null {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relative);
  if (!isWithin(target, resolvedRoot)) return null;
  const realRoot = realPathAllowingMissing(resolvedRoot);
  const realTarget = realPathAllowingMissing(target);
  if (realRoot === null || realTarget === null || !isWithin(realTarget, realRoot)) return null;
  return target;
}
