import * as fs from "fs/promises";
import * as path from "path";
import { loadYamlDoc } from "./yaml";
import { checkFileReference, findFileReferences, formatPolicyViolation, resolveReferencedPath, type PolicyViolation } from "./policy";

const MAX_DEPTH = 10;

/** Checks every file reference (env_file, include, extends, Dockerfile) in the Compose file
 *  and in the files it includes or extends, which are followed only while they stay inside
 *  the project folder. A file that cannot be read or parsed is left for Compose to report. */
export async function checkComposeFileReferences(projectDir: string, composeFile: string): Promise<PolicyViolation[]> {
  const violations = new Map<string, PolicyViolation>();
  const seen = new Set<string>();
  const queue = [{ file: path.resolve(projectDir, composeFile), depth: 0 }];

  for (let next = queue.shift(); next; next = queue.shift()) {
    const key = path.normalize(next.file);
    if (seen.has(key) || next.depth > MAX_DEPTH) continue;
    seen.add(key);

    let doc: unknown;
    try { doc = loadYamlDoc(await fs.readFile(next.file, "utf8")); } catch { continue; }

    const baseDir = path.dirname(next.file);
    for (const ref of findFileReferences(doc)) {
      const violation = checkFileReference(ref, baseDir, projectDir);
      if (violation) { violations.set(formatPolicyViolation(violation), violation); continue; }
      if (ref.kind === "include" || ref.kind === "extends") {
        const target = resolveReferencedPath(ref, baseDir);
        if (target) queue.push({ file: target, depth: next.depth + 1 });
      }
    }
  }
  return [...violations.values()];
}
