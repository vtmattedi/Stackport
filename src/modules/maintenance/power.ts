/* eslint-disable security/detect-non-literal-fs-filename -- every path is the power directory beside Stackport's database plus a fixed file name (reboot-request, cancel-request, ready, status). */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { config } from "../../config/env";
import { actionRegistry } from "../actions/registry";
import { dockerRun, type DockerRun } from "../ingress/networks";

/**
 * Rebooting the host from Host > Power.
 *
 * Stackport runs in a container with no way to reboot the machine, and is not given one. It writes a signed request file into its
 * data directory (`power/reboot-request`); a systemd path unit that `stackport install` or `repair` sets up on the host notices it
 * and runs `stackport power-run`, which checks the signature, the age and the shape of the file and then schedules `shutdown -r`.
 * The host writes `power/status` back. The signing key is STACKPORT_POWER_KEY (root-only `secrets.env` on the host, and in this
 * process's environment), so a file written by anything else is refused. The shell side is `power_verify` in stackport.sh: the two
 * must sign the same string.
 */

export const MAX_DELAY_MINUTES = 60;

export type PowerAction = "reboot" | "cancel";

export class PowerError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export function powerDir(): string {
  return path.join(path.dirname(path.resolve(config.sqlitePath)), "power");
}

/** HMAC-SHA256 (hex) over "action|requested_at|by|delay_min", the same string `power_mac` signs in stackport.sh. */
export function signPowerRequest(key: string, action: PowerAction, requestedAt: number, by: string, delayMinutes: number): string {
  return crypto.createHmac("sha256", key).update(`${action}|${requestedAt}|${by}|${delayMinutes}`).digest("hex");
}

/** A name the host will accept in `by`: letters, digits, dot, underscore, hyphen, at most 40. */
export function powerRequester(user: string | undefined): string {
  const cleaned = (user ?? "").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40);
  return cleaned || "admin";
}

export function powerRequestBody(key: string, action: PowerAction, requestedAt: number, by: string, delayMinutes: number): string {
  return [
    `action=${action}`,
    `requested_at=${requestedAt}`,
    `by=${by}`,
    `delay_min=${delayMinutes}`,
    `mac=${signPowerRequest(key, action, requestedAt, by, delayMinutes)}`,
    "",
  ].join("\n");
}

export interface HostPowerStatus {
  state: "scheduled" | "cancelled" | "rejected" | "failed" | "unknown";
  /** Unix seconds when the host recorded it. */
  at: number | null;
  /** Unix seconds when the machine will reboot, for a scheduled reboot. */
  rebootAt: number | null;
  by: string | null;
  detail: string | null;
}

export function parseHostStatus(text: string): HostPowerStatus {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at > 0) values[line.slice(0, at)] = line.slice(at + 1);
  }
  const state = (["scheduled", "cancelled", "rejected", "failed"] as const).find((s) => s === values["state"]) ?? "unknown";
  const number = (value: string | undefined): number | null => (value && /^\d{1,12}$/.test(value) ? Number(value) : null);
  return { state, at: number(values["at"]), rebootAt: number(values["reboot_at"]), by: values["by"] ?? null, detail: values["detail"] ?? null };
}

export interface PowerState {
  /** The host side is installed and this process can sign requests. */
  available: boolean;
  /** Why not, with what to do about it. */
  unavailableReason: string | null;
  /** A request has been written and the host has not picked it up yet. */
  requestPending: boolean;
  /** What the host did with the last request. */
  status: HostPowerStatus | null;
  /** True while a reboot is scheduled and still ahead. */
  rebootScheduled: boolean;
}

export function readPowerState(now: number = Date.now(), dir: string = powerDir(), key: string = config.powerKey): PowerState {
  const exists = (name: string): boolean => fs.existsSync(path.join(dir, name));
  let unavailableReason: string | null = null;
  if (!key) unavailableReason = "This instance has no power key yet. Run `sudo stackport repair` on the server (it adds the key and restarts Stackport).";
  else if (!exists("ready")) unavailableReason = "The host side is not set up. Run `sudo stackport repair` on the server, or use `sudo stackport reboot` over SSH.";
  let status: HostPowerStatus | null = null;
  try { status = parseHostStatus(fs.readFileSync(path.join(dir, "status"), "utf8")); } catch { /* no request has been handled yet */ }
  const rebootScheduled = status?.state === "scheduled" && status.rebootAt !== null && status.rebootAt * 1000 > now;
  return { available: unavailableReason === null, unavailableReason, requestPending: exists("reboot-request") || exists("cancel-request"), status, rebootScheduled };
}

function writeRequest(action: PowerAction, by: string, delayMinutes: number, now: number, dir: string, key: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const body = powerRequestBody(key, action, Math.floor(now / 1000), by, delayMinutes);
  // Written aside and renamed, so the host never reads half a file.
  const tmp = path.join(dir, `.${action}-${crypto.randomBytes(4).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, body, { mode: 0o644 });
  fs.renameSync(tmp, path.join(dir, `${action}-request`));
}

export function requestReboot(user: string | undefined, delayMinutes: unknown, now: number = Date.now(), dir: string = powerDir(), key: string = config.powerKey): PowerState {
  if (typeof delayMinutes !== "number" || !Number.isInteger(delayMinutes) || delayMinutes < 0 || delayMinutes > MAX_DELAY_MINUTES) {
    throw new PowerError(400, `delayMinutes must be a whole number from 0 to ${MAX_DELAY_MINUTES}`);
  }
  const state = readPowerState(now, dir, key);
  if (!state.available) throw new PowerError(409, state.unavailableReason ?? "Host > Power is not available.");
  if (state.requestPending) throw new PowerError(409, "A request is already waiting for the host.");
  if (state.rebootScheduled) throw new PowerError(409, "A reboot is already scheduled. Cancel it first.");
  writeRequest("reboot", powerRequester(user), delayMinutes, now, dir, key);
  return readPowerState(now, dir, key);
}

export function requestCancel(user: string | undefined, now: number = Date.now(), dir: string = powerDir(), key: string = config.powerKey): PowerState {
  const state = readPowerState(now, dir, key);
  if (!state.available) throw new PowerError(409, state.unavailableReason ?? "Host > Power is not available.");
  if (!state.rebootScheduled && !(state.requestPending)) throw new PowerError(409, "No reboot is scheduled.");
  writeRequest("cancel", powerRequester(user), 0, now, dir, key);
  return readPowerState(now, dir, key);
}

export interface PowerPreflight {
  /** Deploys, builds and the like that a reboot would cut off. */
  runningActions: { id: string; kind: string; key: string; startedAt: string }[];
  runningContainers: number;
  /** Running containers with no restart policy: they stay stopped after the reboot. */
  containersWithoutRestart: string[];
  /** False when Docker could not be asked; the lists above are then incomplete. */
  dockerRead: boolean;
}

export async function readPowerPreflight(run: DockerRun = dockerRun): Promise<PowerPreflight> {
  const runningActions = actionRegistry.running().map(({ id, kind, key, startedAt }) => ({ id, kind, key, startedAt }));
  try {
    const ids = (await run(["ps", "--quiet"])).split(/\s+/).filter(Boolean);
    const without: string[] = [];
    if (ids.length) {
      const out = await run(["inspect", ...ids, "--format", "{{.Name}} {{.HostConfig.RestartPolicy.Name}}"]);
      for (const line of out.split(/\r?\n/)) {
        const [name, policy] = line.trim().split(/\s+/);
        if (name && (!policy || policy === "no")) without.push(name.replace(/^\//, ""));
      }
    }
    return { runningActions, runningContainers: ids.length, containersWithoutRestart: without.sort(), dockerRead: true };
  } catch {
    return { runningActions, runningContainers: 0, containersWithoutRestart: [], dockerRead: false };
  }
}
