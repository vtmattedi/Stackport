import { Server as SocketIOServer, Socket } from "socket.io";
import { getDatabase } from "../config/database";
import { rowToProject, type ProjectRow } from "../entities/Project";
import { getSystemSnapshot } from "../routes/system";
import { getHardwareSnapshot } from "../routes/hardware";
import { setRealtimeServer } from "./realtime";
import { verifyStoredAuthToken } from "./authTokens";
import { actionRegistry, dockerPruneKey, nginxKey, projectRepoKey, projectSslKeyPrefix } from "./actionRegistry";
import { attachDomains } from "./projectDomains";
import { bindDockerShellEvents } from "./dockerShellSocket";
import { bindDockerLogsEvents } from "./dockerLogsSocket";

type Channel = "system" | "projects" | "hardware";

/** Action ids are UUIDs, or "legacy-<n>" for deploys copied from project_deploys. */
const ACTION_ID_RE = /^(?:[0-9a-f-]{36}|legacy-[0-9]+)$/;

const INTERVALS_MS: Record<Channel, number> = {
  system:   5_000,
  projects: 10_000,
  hardware: 15_000,
};

async function fetchChannel(channel: Channel): Promise<unknown> {
  switch (channel) {
    case "system":
      return getSystemSnapshot();
    case "projects": {
      const rows = getDatabase()
        .prepare("SELECT * FROM projects ORDER BY favorite DESC, name ASC")
        .all() as ProjectRow[];
      return attachDomains(rows.map(rowToProject));
    }
    case "hardware":
      return getHardwareSnapshot();
  }
}

function isChannel(s: string): s is Channel {
  return s in INTERVALS_MS;
}

export class SocketManager {
  private io: SocketIOServer;
  private timers = new Map<Channel, NodeJS.Timeout>();

  constructor(io: SocketIOServer) {
    this.io = io;
    setRealtimeServer(io);
    this.applyAuth();
    this.bindEvents();
  }

  // ── Auth middleware ────────────────────────────────────────────────────────

  private applyAuth(): void {
    this.io.use((socket: Socket, next) => {
      try {
        const token = (socket.handshake.auth as { token?: string }).token;
        if (!token) throw new Error("No token");
        const verified = verifyStoredAuthToken(token);
        if (!verified) throw new Error("Invalid token");
        socket.data["user"] = verified.username;
        socket.data["authTokenId"] = verified.tokenId;
        next();
      } catch {
        next(new Error("Unauthorized"));
      }
    });
  }

  // ── Connection events ──────────────────────────────────────────────────────

  private bindEvents(): void {
    this.io.on("connection", (socket: Socket) => {
      void socket.join("global");
      bindDockerShellEvents(socket);
      bindDockerLogsEvents(socket);
      socket.emit("system:actions:sync", {
        nginx: actionRegistry.get(nginxKey()) ?? null,
        certbot: actionRegistry.list("system:certbot:"),
        docker: actionRegistry.get(dockerPruneKey()) ?? null,
      });

      socket.on("subscribe", (ch: unknown) => {
        if (typeof ch !== "string" || !isChannel(ch)) return;
        void socket.join(ch);
        this.ensurePolling(ch);
      });

      socket.on("unsubscribe", (ch: unknown) => {
        if (typeof ch !== "string" || !isChannel(ch)) return;
        void socket.leave(ch);
        this.stopIfEmpty(ch);
      });

      // Generic action output: replay from `fromSeq` (or the whole log), then live
      // chunks in the action's room. Clients drop chunks with a seq they already have,
      // so the overlap between replay and live output is harmless.
      socket.on("action:attach", (payload: unknown) => {
        const { id, fromSeq } = (payload ?? {}) as { id?: unknown; fromSeq?: unknown };
        if (typeof id !== "string" || !ACTION_ID_RE.test(id)) return;
        const from = typeof fromSeq === "number" && Number.isInteger(fromSeq) && fromSeq >= 0 ? fromSeq : 0;
        void socket.join(`action:${id}`);
        const replay = actionRegistry.replay(id, from);
        socket.emit("action:output", replay ?? { id, chunks: [], reset: "", nextSeq: 0, done: true });
      });

      socket.on("action:detach", (id: unknown) => {
        if (typeof id !== "string" || !ACTION_ID_RE.test(id)) return;
        void socket.leave(`action:${id}`);
      });

      socket.on("deploy:subscribe", (projectId: unknown) => {
        if (typeof projectId !== "number" || !Number.isInteger(projectId) || projectId <= 0) return;
        void socket.join(`deploy:${projectId}`);
        socket.emit("project:deploy:sync", {
          repo: actionRegistry.get(projectRepoKey(projectId)) ?? null,
          ssl: actionRegistry.list(projectSslKeyPrefix(projectId)),
        });
      });

      socket.on("deploy:unsubscribe", (projectId: unknown) => {
        if (typeof projectId !== "number" || !Number.isInteger(projectId) || projectId <= 0) return;
        void socket.leave(`deploy:${projectId}`);
      });

      socket.on("project:subscribe", (projectId: unknown) => {
        if (typeof projectId !== "number" || !Number.isInteger(projectId) || projectId <= 0) return;
        void socket.join(`project:${projectId}`);
        void this.pushProject(socket, projectId);
      });

      socket.on("project:unsubscribe", (projectId: unknown) => {
        if (typeof projectId !== "number" || !Number.isInteger(projectId) || projectId <= 0) return;
        void socket.leave(`project:${projectId}`);
      });

      // Immediate push for a single socket (manual refresh)
      socket.on("refresh", (ch: unknown) => {
        if (typeof ch !== "string" || !isChannel(ch)) return;
        fetchChannel(ch)
          .then((data) => socket.emit(`data:${ch}`, data))
          .catch(() => { /* ignore */ });
      });

      socket.on("latency:ping", (ack: unknown) => {
        if (typeof ack === "function") ack();
      });

      socket.on("disconnect", () => {
        for (const ch of Object.keys(INTERVALS_MS) as Channel[]) {
          this.stopIfEmpty(ch);
        }
      });
    });
  }

  // ── Polling lifecycle ─────────────────────────────────────────────────────

  private ensurePolling(channel: Channel): void {
    if (this.timers.has(channel)) {
      // Already polling — do an immediate push just for the new subscriber via the room
      // (the next tick will also deliver it)
      void this.pushToRoom(channel);
      return;
    }
    void this.pushToRoom(channel);
    const timer = setInterval(() => void this.pushToRoom(channel), INTERVALS_MS[channel]);
    this.timers.set(channel, timer);
  }

  private async pushToRoom(channel: Channel): Promise<void> {
    const size = this.io.sockets.adapter.rooms.get(channel)?.size ?? 0;
    if (size === 0) { this.stopPolling(channel); return; }
    try {
      const data = await fetchChannel(channel);
      this.io.to(channel).emit(`data:${channel}`, data);
    } catch { /* silent — client keeps last data */ }
  }

  private pushProject(socket: Socket, projectId: number): void {
    const row = getDatabase().prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRow | undefined;
    if (!row) return;
    socket.emit("project:update", {
      projectId,
      project: rowToProject(row),
      ports: [],
      ok: true,
      output: "",
    });
  }

  private stopIfEmpty(channel: Channel): void {
    const size = this.io.sockets.adapter.rooms.get(channel)?.size ?? 0;
    if (size === 0) this.stopPolling(channel);
  }

  private stopPolling(channel: Channel): void {
    const t = this.timers.get(channel);
    if (t) { clearInterval(t); this.timers.delete(channel); }
  }

  // ── Shutdown ──────────────────────────────────────────────────────────────

  stop(): void {
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
  }
}
