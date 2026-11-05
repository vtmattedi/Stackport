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

/**
 * Resolves `relative` under `root` and rejects it if the result would escape
 * `root` (zip-slip-style traversal via symlinks, encoded separators, etc. that
 * `normalizeRelativePath` alone wouldn't catch). Returns the resolved absolute
 * path, or null if it escapes.
 */
export function resolveContainedPath(root: string, relative: string): string | null {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relative);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) return null;
  return target;
}
