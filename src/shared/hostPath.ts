import * as path from "path";

/** Compose resolves relative paths to absolute ones in the host's own style, so a path
 *  can be POSIX or Windows (`C:\...`) whatever OS this code is running on. */
function libFor(reference: string): { lib: typeof path.posix; win: boolean } {
  const win = /^[A-Za-z]:[\\/]/.test(reference);
  return { lib: win ? path.win32 : path.posix, win };
}

/** `target` relative to `dir` (case-insensitive for Windows paths), or null when
 *  `target` is not `dir` or inside it. An empty string means they are the same. */
export function relativeInside(target: string, dir: string): string | null {
  const { lib } = libFor(dir);
  if (!lib.isAbsolute(target)) return null;
  // win32.relative compares case-insensitively but keeps the case of `target`, so the result can be re-rooted as it is.
  const relative = lib.relative(lib.normalize(dir), lib.normalize(target));
  if (relative === "") return "";
  // Only ".." as a whole segment leaves the directory; a child called "..data" is inside it.
  const leaves = relative === ".." || relative.startsWith(`..${lib.sep}`);
  return leaves || lib.isAbsolute(relative) ? null : relative;
}

/** True when `target` is `dir` or inside it. */
export function isInsideDir(target: string, dir: string): boolean {
  return relativeInside(target, dir) !== null;
}

/** Re-roots `target` from `fromRoot` to `toRoot`; paths outside `fromRoot` come back unchanged. */
export function rebasePath(target: string, fromRoot: string, toRoot: string): string {
  const relative = relativeInside(target, fromRoot);
  if (relative === null) return target;
  const { lib } = libFor(toRoot);
  return relative === "" ? toRoot : lib.join(toRoot, ...relative.split(/[\\/]/));
}
