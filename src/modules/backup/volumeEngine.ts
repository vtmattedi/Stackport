/* eslint-disable security/detect-non-literal-fs-filename -- paths are Stackport's own staging files and directories it created. */
import crypto from "crypto";
import { spawn } from "child_process";
import fs from "fs";
import { currentImage } from "../maintenance/selfUpdate";

/**
 * Reads and writes a project's data as a privileged helper does.
 *
 * Stackport runs as an unprivileged user, but a database's data directory belongs to the database's own user with a restrictive mode. A short-lived container
 * running as root from Stackport's own image (so nothing is pulled and nothing else is trusted) tars the data with owners and modes intact, untars it on the
 * other side, and lists it for verification. The same engine reads a Docker named volume and a managed bind directory: both are just a path inside the helper.
 */

export type VolumeSource =
  /** A directory on the Docker host (what the daemon sees). */
  | { kind: "bind"; hostPath: string }
  | { kind: "named"; name: string };

export interface VolumeEngine {
  /** Running containers of a Compose project: a project in use must not be copied. */
  runningContainers(composeProject: string): Promise<string[]>;
  /** The named volumes Compose created for a project, with the volume key as the Compose file names it. */
  namedVolumes(composeProject: string): Promise<{ name: string; key: string }[]>;
  volumeExists(name: string): Promise<boolean>;
  /** Writes a tar of the volume's contents to `file`. */
  exportTar(source: VolumeSource, file: string): Promise<{ size: number; sha256: string }>;
  /** Creates the volume (or directory) if needed and unpacks `file` into it. */
  importTar(source: VolumeSource, file: string, labels?: Record<string, string>): Promise<void>;
  /** A digest of what is in the volume: every file's content hash, mode, owner and size, directories, links. Not times. */
  treeDigest(source: VolumeSource): Promise<string>;
  /** Removes what an import created. Idempotent. */
  remove(source: VolumeSource): Promise<void>;
}

/** Prints one NUL-separated record per entry, then each file's SHA-256, both sorted in the C locale: the same tree gives the same bytes on any host. */
const TREE_SCRIPT = [
  "cd /v",
  "export LC_ALL=C",
  // One group, sorted as a whole: a pipe binds to a single command, and the digest must not depend on directory read order. Sockets are not carried (tar skips them).
  "{ find . -mindepth 1 -type d -printf 'd %m %U:%G %p\\0'; find . -mindepth 1 -type f -printf 'f %m %U:%G %s %p\\0'; find . -mindepth 1 -type l -printf 'l %U:%G %p -> %l\\0'; find . -mindepth 1 ! -type d ! -type f ! -type l ! -type s -printf 'o %y %p\\0'; } | sort -z",
  "find . -type f -print0 | sort -z | xargs -0 -r sha256sum -z",
].join("; ");

function run(args: string[], options: { stdin?: string; stdoutFile?: string; collect?: boolean; timeoutMs?: number } = {}): Promise<{ stdout: Buffer; size: number; sha256: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"] });
    const hash = crypto.createHash("sha256");
    const out = options.stdoutFile ? fs.createWriteStream(options.stdoutFile, { mode: 0o600 }) : null;
    out?.on("error", (error) => { clearTimeout(timer); child.kill("SIGKILL"); reject(error); }); // a full disk
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 6 * 60 * 60 * 1000);
    if (options.stdin) {
      // The helper may exit before it has read everything (a bad mount, a missing image): its exit code and stderr say why, so a closed pipe is not a crash.
      child.stdin!.on("error", () => { /* reported through the exit code */ });
      fs.createReadStream(options.stdin).on("error", (error) => { child.kill("SIGKILL"); reject(error); }).pipe(child.stdin!);
    }
    child.stdout!.on("data", (part: Buffer) => {
      hash.update(part);
      size += part.length;
      if (out) out.write(part);
      else if (options.collect !== false) chunks.push(part);
    });
    child.stderr!.on("data", (part: Buffer) => { if (stderr.length < 4000) stderr += part.toString("utf8"); });
    child.on("error", (error) => { clearTimeout(timer); out?.destroy(); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const finish = (): void => {
        if (code === 0) resolve({ stdout: Buffer.concat(chunks), size, sha256: hash.digest("hex") });
        else reject(new Error(`docker ${args.slice(0, 2).join(" ")} failed (${String(code)}): ${stderr.trim().slice(0, 500)}`));
      };
      if (out) out.end(finish); else finish();
    });
  });
}

function mountArgs(source: VolumeSource, readOnly: boolean): string[] {
  const src = source.kind === "named" ? source.name : source.hostPath;
  // --mount is a comma-separated list: a comma or quote in a path would change what is mounted (and the helper runs as root).
  if (/[",\n\r]/.test(src)) throw new Error(`The path ${JSON.stringify(src)} cannot be given to the helper container (it contains a comma or a quote).`);
  return ["--mount", `type=${source.kind === "named" ? "volume" : "bind"},src=${src},dst=/v${readOnly ? ",readonly" : ""}`];
}

export class DockerVolumeEngine implements VolumeEngine {
  constructor(readonly image: string) {}

  /** The engine for this installation, or null when Docker cannot be reached (callers then fall back to what they can read themselves). */
  static async create(env: NodeJS.ProcessEnv = process.env): Promise<DockerVolumeEngine | null> {
    try {
      await run(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 15_000 });
      const image = env["STACKPORT_HELPER_IMAGE"] || (await currentImage());
      return new DockerVolumeEngine(image);
    } catch {
      return null;
    }
  }

  private helper(source: VolumeSource, readOnly: boolean, command: string[], extra: string[] = []): string[] {
    // --user 0: the point of the helper. No network, no capabilities beyond what tar needs to restore owners.
    return ["run", "--rm", "--user", "0", "--network", "none", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER", "--cap-add", "DAC_READ_SEARCH",
      ...extra, ...mountArgs(source, readOnly), "--entrypoint", "sh", this.image, "-c", command.join(" ")];
  }

  async runningContainers(composeProject: string): Promise<string[]> {
    const { stdout } = await run(["ps", "--filter", `label=com.docker.compose.project=${composeProject}`, "--format", "{{.Names}}"]);
    return stdout.toString("utf8").split("\n").map((line) => line.trim()).filter(Boolean);
  }

  async namedVolumes(composeProject: string): Promise<{ name: string; key: string }[]> {
    const { stdout } = await run(["volume", "ls", "--filter", `label=com.docker.compose.project=${composeProject}`, "--format", '{{.Name}}\t{{.Label "com.docker.compose.volume"}}']);
    return stdout.toString("utf8").split("\n").filter(Boolean).map((line) => { const [name, key] = line.split("\t"); return { name, key: key ?? "" }; });
  }

  async volumeExists(name: string): Promise<boolean> {
    try { await run(["volume", "inspect", name]); return true; } catch { return false; }
  }

  async exportTar(source: VolumeSource, file: string): Promise<{ size: number; sha256: string }> {
    const result = await run(this.helper(source, true, ["tar", "-C", "/v", "--numeric-owner", "-cf", "-", ".", ";", "rc=$?;", "[", "$rc", "-le", "1", "]"]), { stdoutFile: file });
    return { size: result.size, sha256: result.sha256 };
  }

  async importTar(source: VolumeSource, file: string, labels: Record<string, string> = {}): Promise<void> {
    if (source.kind === "named") {
      await run(["volume", "create", ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]), source.name]);
    }
    await run(this.helper(source, false, ["tar", "-C", "/v", "--numeric-owner", "--same-owner", "-p", "-xf", "-"], ["-i"]), { stdin: file, collect: false });
  }

  async treeDigest(source: VolumeSource): Promise<string> {
    const { stdout } = await run(this.helper(source, true, [TREE_SCRIPT]));
    return crypto.createHash("sha256").update(stdout).digest("hex");
  }

  async remove(source: VolumeSource): Promise<void> {
    if (source.kind === "named") {
      try { await run(["volume", "rm", "-f", source.name]); } catch { /* already gone */ }
      return;
    }
    // A managed directory is owned by whoever wrote into it: empty and remove it as root.
    try { await run(this.helper({ kind: "bind", hostPath: source.hostPath }, false, ["find", "/v", "-mindepth", "1", "-delete"])); } catch { /* best effort */ }
    try { await run(this.helper({ kind: "bind", hostPath: parentOf(source.hostPath) }, false, ["rmdir", `/v/${baseOf(source.hostPath)}`])); } catch { /* already gone */ }
  }
}

function parentOf(p: string): string { return p.replace(/[\\/][^\\/]+[\\/]?$/, "") || "/"; }
function baseOf(p: string): string { return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? ""; }
