import { execFile } from "child_process";

/** TEMPORARY (see types.ts): runs the docker CLI for the migrations; injectable for tests. */
export interface DockerResult { code: number; stdout: string; stderr: string }
export type DockerRunner = (args: string[]) => Promise<DockerResult>;

/** What looking at a host directory through a helper container found. Only "missing" means the
 *  directory is not there; "error" means we could not tell (daemon trouble, no image), and
 *  must never be read as "nothing to do". */
export type DirectoryProbe =
  | { state: "present"; kb: number; entries: number }
  | { state: "missing" }
  | { state: "error"; detail: string };

const MISSING_RE = /bind source path does not exist|no such file or directory/i;
const PROBE_SCRIPT = "du -sk /from | cut -f1; ls -A /from | wc -l";

export async function probeDirectory(docker: DockerRunner, image: string, hostPath: string): Promise<DirectoryProbe> {
  const result = await docker([
    "run", "--rm", "--mount", `type=bind,src=${hostPath},dst=/from,readonly`, "--entrypoint", "sh", image, "-c", PROBE_SCRIPT,
  ]);
  if (result.code === 0) {
    const [kb, entries] = result.stdout.trim().split(/\s+/).map(Number);
    return { state: "present", kb: kb || 0, entries: entries || 0 };
  }
  if (MISSING_RE.test(result.stderr)) return { state: "missing" };
  return { state: "error", detail: result.stderr.trim().split("\n")[0]?.slice(0, 300) || `docker exited with code ${result.code}` };
}

export function dockerRunner(): DockerRunner {
  return (args) => new Promise((resolve) => {
    execFile("docker", args, { timeout: 3_600_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr });
    });
  });
}
