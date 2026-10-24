import { execFile } from "child_process";
import { promisify } from "util";
import { config } from "../config/env";

const exec = promisify(execFile);
const NAME = "stackport-updater";
const LABEL = "io.stackport.self-update";

export interface SelfUpdateStatus {
  id: string;
  status: "running" | "success" | "failed" | "rolled-back";
  output: string;
}

export class SelfUpdateBusyError extends Error {}

async function docker(args: string[]) {
  return exec("docker", args, {timeout: 30_000, maxBuffer: 2 * 1024 * 1024});
}

interface UpdaterContainer {
  Id: string;
  Config: {Labels?: Record<string, string>};
  State: {Running: boolean; ExitCode: number; Status: string};
}

function active(info: UpdaterContainer): boolean {
  return info.State.Running || ["created", "restarting"].includes(info.State.Status);
}

async function inspectUpdater(): Promise<UpdaterContainer | null> {
  try {
    const {stdout} = await docker(["inspect", NAME]);
    const info = JSON.parse(stdout)[0] as UpdaterContainer;
    if (info.Config?.Labels?.[LABEL] !== "true") throw new Error("Updater container name is already in use.");
    return info;
  } catch (error) {
    if (/no such (object|container)/i.test(String((error as {stderr?: string}).stderr))) return null;
    throw error;
  }
}

export async function getSelfUpdateStatus(): Promise<SelfUpdateStatus | null> {
  const info = await inspectUpdater();
  if (!info) return null;
  const logs = await docker(["logs", "--tail", "1000", NAME]);
  const output = [logs.stdout, logs.stderr].filter(Boolean).join("\n").slice(-120_000);
  const status = active(info) ? "running" : info.State.ExitCode !== 0 ? "failed"
    : /^\[stackport\] rollback complete$/m.test(output) ? "rolled-back" : "success";
  return {id: info.Id, status, output};
}

/** The image the running Stackport container was started from; the updater runs from it. */
export async function currentImage(): Promise<string> {
  const {stdout} = await docker(["inspect", "--format", "{{.Image}}", config.appServiceName]);
  const image = stdout.trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Cannot identify the running Stackport image.");
  return image;
}

/** `docker run` arguments for an updater container. Docker owns that process, so
 *  swapping the app does not kill it. Chroot runs the host's own CLI with its actual
 *  paths, credentials and Docker socket; host networking lets its localhost health
 *  checks work. */
export function updaterRunArgs(image: string, name: string, command: string[], opts: {detach: boolean}): string[] {
  return ["run", opts.detach ? "--detach" : "--rm", "--name", name,
    "--label", `${LABEL}=true`, "--label", "com.docker.compose.project=stackport",
    "--network", "host", "--mount", "type=bind,src=/,dst=/host",
    "--entrypoint", "chroot", image, "/host", "/usr/bin/env", "-i",
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "HOME=/root", ...command];
}

let launching = false;

export async function startSelfUpdate(): Promise<SelfUpdateStatus> {
  if (launching) throw new SelfUpdateBusyError("A Stackport update is already starting.");
  launching = true;
  try {
    const previous = await inspectUpdater();
    if (previous && active(previous)) throw new SelfUpdateBusyError("A Stackport update is already running.");
    if (previous) await docker(["rm", NAME]);
    const started = await docker(updaterRunArgs(await currentImage(), NAME, ["/usr/local/bin/stackport", "update"], {detach: true}));
    return {id: started.stdout.trim(), status: "running", output: "Stackport update started."};
  } finally {
    launching = false;
  }
}

/** Launches an updater exactly as the Update button does, but has it only prove it
 *  can reach the host CLI and Docker. `stackport update` runs this from a freshly
 *  swapped image before accepting it, so a release can't break its own next update. */
export async function runUpdaterSelfTest(): Promise<string> {
  const probe = "test -x /usr/local/bin/stackport && docker version --format 'docker {{.Server.Version}}'";
  const name = `${NAME}-selftest`;
  // A run killed by its timeout leaves the container behind and would block the next one.
  await docker(["rm", "--force", name]).catch(() => undefined);
  const {stdout} = await exec("docker", updaterRunArgs(await currentImage(), name, ["/bin/sh", "-c", probe], {detach: false}),
    {timeout: 60_000, maxBuffer: 1024 * 1024});
  return stdout.trim();
}
