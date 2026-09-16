import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { CONTAINER_REF_RE } from "../routes/system";
import { auditLog } from "../utils/logger";
import { isSystemContainer } from "./systemResources";

const MAX_TOTAL_SESSIONS = 20;
const MAX_SESSIONS_PER_USER = 4;
const MAX_SESSION_DURATION_MS = 4 * 60 * 60_000; // 4h hard cap, defense-in-depth
const KILL_GRACE_MS = 5_000;

interface ShellSession {
  containerId: string;
  username: string;
  socketId: string;
  child: ChildProcessWithoutNullStreams;
  createdAt: number;
  hardTimer: NodeJS.Timeout;
}

export interface ShellStartArgs {
  sessionId: string;
  containerId: string;
  cols: number;
  rows: number;
  username: string;
  socketId: string;
  onData: (chunk: string) => void;
  onExit: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
}

export type ShellStartResult = { ok: true; sessionId: string } | { ok: false; error: string };

const sessions = new Map<string, ShellSession>();

function sanitizeDims(cols: unknown, rows: unknown): { cols: number; rows: number } {
  const c = typeof cols === "number" && Number.isFinite(cols) ? Math.round(cols) : NaN;
  const r = typeof rows === "number" && Number.isFinite(rows) ? Math.round(rows) : NaN;
  return {
    cols: Number.isFinite(c) ? Math.min(Math.max(c, 20), 500) : 80,
    rows: Number.isFinite(r) ? Math.min(Math.max(r, 5), 200) : 24,
  };
}

function buildInitScript(cols: number, rows: number): string {
  return `stty rows ${rows} cols ${cols} 2>/dev/null; command -v bash >/dev/null 2>&1 && exec bash -i || exec sh -i`;
}

// docker's CLI refuses `-t` unless its own stdin is a real terminal, which it
// never is when spawned directly via child_process (plain pipes). `script`
// (util-linux, present on essentially every Linux box) allocates a real pty
// for the command it wraps regardless of its own stdio — so wrapping the
// docker invocation in `script -qc "..." /dev/null` satisfies docker's TTY
// check and gives us real terminal semantics (echo, line editing, Ctrl-C)
// without a native pty dependency. `containerId` is pre-validated against
// CONTAINER_REF_RE (alnum/_/./- only, no shell metacharacters) and
// buildInitScript()'s own output contains no single quotes, so both are
// safe to interpolate into this shell string.
function buildScriptCommand(containerId: string, cols: number, rows: number): string {
  return `docker exec -i -t ${containerId} sh -c '${buildInitScript(cols, rows)}'`;
}

export async function startSession(args: ShellStartArgs): Promise<ShellStartResult> {
  if (!CONTAINER_REF_RE.test(args.containerId)) {
    return { ok: false, error: "Invalid container id" };
  }
  // System containers do not receive generic workload shell access.
  if (await isSystemContainer(args.containerId)) {
    return { ok: false, error: "Interactive shell access isn't available for StackPort's own infrastructure" };
  }
  if (sessions.size >= MAX_TOTAL_SESSIONS) {
    return { ok: false, error: "Too many active shell sessions on the server, try again later" };
  }
  const userSessionCount = Array.from(sessions.values()).filter((s) => s.username === args.username).length;
  if (userSessionCount >= MAX_SESSIONS_PER_USER) {
    return { ok: false, error: "Too many active shell sessions for your user" };
  }

  const { cols, rows } = sanitizeDims(args.cols, args.rows);

  // Unprivileged, like every other docker call in system.ts: the app's
  // system user is a member of the `docker` group (see init.sh), which
  // grants direct socket access — no sudo involved.
  // -e/--return propagates the wrapped command's exit code as script's own
  // (without it, script always exits 0 regardless of the child's status).
  const child = spawn("script", ["-qec", buildScriptCommand(args.containerId, cols, rows), "/dev/null"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const sessionId = args.sessionId;

  const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
    const session = sessions.get(sessionId);
    if (!session) return;
    clearTimeout(session.hardTimer);
    sessions.delete(sessionId);
    auditLog(args.username, "system.shell-close", args.containerId, "ok", { sessionId, code, signal });
    args.onExit({ code, signal });
  };

  child.stdout.on("data", (chunk: Buffer) => args.onData(chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => args.onData(chunk.toString("utf8")));
  child.on("error", () => finish(null, null));
  child.on("close", (code, signal) => finish(code, signal));

  const hardTimer = setTimeout(() => stopSession(sessionId), MAX_SESSION_DURATION_MS).unref();

  sessions.set(sessionId, {
    containerId: args.containerId,
    username: args.username,
    socketId: args.socketId,
    child,
    createdAt: Date.now(),
    hardTimer,
  });

  auditLog(args.username, "system.shell-open", args.containerId, "ok", { sessionId, cols, rows });
  return { ok: true, sessionId };
}

export function writeToSession(sessionId: string, socketId: string, data: string): boolean {
  const session = sessions.get(sessionId);
  if (!session || session.socketId !== socketId) return false;
  session.child.stdin.write(data, "utf8");
  return true;
}

export function stopSession(sessionId: string, socketId?: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  if (socketId !== undefined && session.socketId !== socketId) return false;
  session.child.kill("SIGTERM");
  setTimeout(() => {
    if (sessions.has(sessionId)) session.child.kill("SIGKILL");
  }, KILL_GRACE_MS).unref();
  return true;
}

export function stopSessionsForSocket(socketId: string): void {
  for (const [sessionId, session] of sessions) {
    if (session.socketId === socketId) stopSession(sessionId);
  }
}
