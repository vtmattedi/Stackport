import { Server as SocketIOServer, Socket } from "socket.io";
import { getDatabase } from "../config/database";
import { rowToProject, type ProjectRow } from "../entities/Project";
import { getSystemSnapshot } from "../routes/system";
import { fetchVpsSnapshot, refreshVpsSnapshot } from "../routes/vps";
import { getHardwareSnapshot } from "../routes/hardware";
import { setRealtimeServer } from "./realtime";
import { verifyStoredAuthToken } from "./authTokens";
import { actionRegistry, dockerPruneKey, nginxKey, projectRepoKey, projectSslKeyPrefix } from "./actionRegistry";
import { attachDomains } from "./projectDomains";
import { bindDockerShellEvents } from "./dockerShellSocket";
import { bindDockerLogsEvents } from "./dockerLogsSocket";

type Channel = "system" | "projects" | "vps" | "hardware";

const INTERVALS_MS: Record<Channel, number> = {
  system:   5_000,
  projects: 10_000,
  vps:      15 * 60_000,
  hardware: 15_000,
};

async function fetchChannel(channel: Channel, refreshUpstream = false): Promise<unknown> {
  switch (channel) {
    case "system":
      return getSystemSnapshot();
    case "projects": {
      const rows = getDatabase()
        .prepare("SELECT * FROM projects ORDER BY favorite DESC, name ASC")
        .all() as ProjectRow[];
      return attachDomains(rows.map(rowToProject));
    }
    case "vps":
      return refreshUpstream ? refreshVpsSnapshot() : fetchVpsSnapshot();
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
    const timer = setInterval(() => void this.pushToRoom(channel, channel === "vps"), INTERVALS_MS[channel]);
    this.timers.set(channel, timer);
  }

  private async pushToRoom(channel: Channel, refreshUpstream = false): Promise<void> {
    const size = this.io.sockets.adapter.rooms.get(channel)?.size ?? 0;
    if (size === 0) { this.stopPolling(channel); return; }
    try {
      const data = await fetchChannel(channel, refreshUpstream);
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
