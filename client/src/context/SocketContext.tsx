import {
  createContext, useContext, useEffect, useMemo, useRef, useState, useCallback,
} from "react";
import { io, Socket } from "socket.io-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getToken, clearToken } from "../api/client";
import { queryKeys } from "../lib/queryKeys";

// ── Types ─────────────────────────────────────────────────────────────────────

interface SocketContextValue {
  connected: boolean;
  subscribe: <T>(channel: string, handler: (data: T) => void) => void;
  unsubscribe: <T>(channel: string, handler: (data: T) => void) => void;
  subscribeProject: <T>(projectId: number, handler: (data: T) => void) => void;
  unsubscribeProject: <T>(projectId: number, handler: (data: T) => void) => void;
  subscribeGlobal: <T>(handler: (data: T) => void) => void;
  unsubscribeGlobal: <T>(handler: (data: T) => void) => void;
  subscribeSystemActionsSync: <T>(handler: (data: T) => void) => void;
  unsubscribeSystemActionsSync: <T>(handler: (data: T) => void) => void;
  /** Ask the server for an immediate push (delivered only to this socket). */
  refresh: (channel: string) => void;
  /** Explicitly disconnect — call on logout so the next login gets a fresh token. */
  disconnect: () => void;
  /** Generic fire-and-forget emit, for features without a purpose-built subscribe pair. */
  emit: (event: string, payload?: unknown) => void;
  /** Generic emit with an acknowledgement response (via socket.io's ack callback). */
  emitWithAck: <TResponse>(event: string, payload?: unknown, timeoutMs?: number) => Promise<TResponse>;
  /** Generic event listener registration. */
  on: <T>(event: string, handler: (data: T) => void) => void;
  /** Generic event listener removal. */
  off: <T>(event: string, handler: (data: T) => void) => void;
}

const SocketContext = createContext<SocketContextValue | null>(null);

/** Round-trip time to the server. `ms` is the median of the last few samples, so one
 *  sample held up by a busy main thread (the ack callback can only run once the page
 *  is free) doesn't show as a spike; null until measured. `unresponsive` is set when
 *  pings stop coming back while the socket still looks connected. */
export interface SocketLatency {
  ms: number | null;
  unresponsive: boolean;
}

const LATENCY_UNKNOWN: SocketLatency = { ms: null, unresponsive: false };
const LATENCY_INTERVAL_MS = 5000;
const LATENCY_TIMEOUT_MS = 3000;
const LATENCY_SAMPLES = 5;
/** Missed pings before the indicator says so, and before the connection is replaced:
 *  the engine's own heartbeat takes up to 45 s to notice a dead connection. */
const MISSES_UNRESPONSIVE = 2;
const MISSES_RECONNECT = 3;

// Latency is re-measured every 5 s; it gets its own context so that tick only
// re-renders the status indicator, not every component that uses the socket.
const SocketLatencyContext = createContext<SocketLatency>(LATENCY_UNKNOWN);

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Counts per key, so a room is left only when its last subscriber goes. */
function addRef<K>(map: Map<K, number>, key: K): boolean {
  const count = map.get(key) ?? 0;
  map.set(key, count + 1);
  return count === 0;
}

function dropRef<K>(map: Map<K, number>, key: K): boolean {
  const count = map.get(key) ?? 0;
  if (count <= 1) { map.delete(key); return count === 1; }
  map.set(key, count - 1);
  return false;
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function SocketProvider({ children }: { children: React.ReactNode }) {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [latency, setLatency] = useState<SocketLatency>(LATENCY_UNKNOWN);
  const samplesRef = useRef<number[]>([]);
  const missesRef = useRef(0);
  // What this page is subscribed to. Rooms live in the server's socket, so a new
  // connection starts in none of them: every (re)connect joins these again.
  const channelRefs = useRef(new Map<string, number>());
  const projectRefs = useRef(new Map<number, number>());

  const resetLatency = useCallback(() => {
    samplesRef.current = [];
    missesRef.current = 0;
    setLatency(LATENCY_UNKNOWN);
  }, []);

  const measureLatency = useCallback(() => {
    const socket = socketRef.current;
    if (!socket?.connected) {
      resetLatency();
      return;
    }
    // Hidden tabs have their timers throttled and may be frozen outright; samples
    // taken there measure the browser, not the connection.
    if (document.hidden) return;

    const startedAt = performance.now();
    socket.timeout(LATENCY_TIMEOUT_MS).emit("latency:ping", (err: Error | null) => {
      if (socket !== socketRef.current) return;
      if (err) {
        missesRef.current += 1;
        if (missesRef.current >= MISSES_RECONNECT) {
          // Half-open connection: replace it now instead of waiting for the heartbeat.
          resetLatency();
          socket.disconnect().connect();
          return;
        }
        if (missesRef.current >= MISSES_UNRESPONSIVE) setLatency((current) => ({ ...current, unresponsive: true }));
        return;
      }
      missesRef.current = 0;
      samplesRef.current = [...samplesRef.current, Math.round(performance.now() - startedAt)].slice(-LATENCY_SAMPLES);
      setLatency({ ms: median(samplesRef.current), unresponsive: false });
    });
  }, [resetLatency]);

  // Lazily create the socket on first subscribe (handles the case where the
  // provider mounts before the user has logged in and set a token).
  const getOrCreate = useCallback((): Socket | null => {
    if (socketRef.current) return socketRef.current;
    const token = getToken();
    if (!token) return null;

    const socket = io(window.location.origin, {
      auth: { token },
      transports: ["websocket", "polling"],
    });
    socket.on("connect", () => {
      // Also fires on every reconnect, on a server socket that is in no rooms yet.
      for (const channel of channelRefs.current.keys()) socket.emit("subscribe", channel);
      for (const projectId of projectRefs.current.keys()) socket.emit("project:subscribe", projectId);
      setConnected(true);
    });
    socket.on("disconnect", () => {
      setConnected(false);
      resetLatency();
    });
    socket.io.on("reconnect_attempt", () => {
      socket.auth = { token: getToken() };
    });
    socket.on("connect_error", (err: Error) => {
      setConnected(false);
      resetLatency();
      const currentToken = getToken();
      const attemptedToken = (socket.auth as { token?: string }).token;
      // Auth rejection → clear stale token and redirect to login
      if ((err.message === "Unauthorized" || err.message === "No token") && (!currentToken || currentToken === attemptedToken)) {
        clearToken();
        window.location.href = "/";
      }
    });
    socket.on("auth:revoked", () => {
      clearToken();
      socket.disconnect();
      window.location.href = "/";
    });
    socketRef.current = socket;
    return socket;
  }, [resetLatency]);

  // Cleanup on unmount (e.g. full page reload after logout)
  useEffect(() => {
    return () => {
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!connected) return;
    // The first sample waits a moment: right after (re)connecting the page is busy
    // rendering the data that just arrived, which would show as latency.
    const first = window.setTimeout(measureLatency, 1000);
    const timer = window.setInterval(measureLatency, LATENCY_INTERVAL_MS);
    const onVisible = () => {
      if (document.hidden) return;
      samplesRef.current = [];
      missesRef.current = 0;
      measureLatency();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [connected, measureLatency]);

  const subscribe = useCallback(<T,>(channel: string, handler: (data: T) => void) => {
    const s = getOrCreate();
    if (!s) return;
    // While disconnected, the connect handler joins it.
    if (addRef(channelRefs.current, channel) && s.connected) s.emit("subscribe", channel);
    s.on(`data:${channel}`, handler as (d: unknown) => void);
  }, [getOrCreate]);

  const unsubscribe = useCallback(<T,>(channel: string, handler: (data: T) => void) => {
    const s = socketRef.current;
    if (!s) return;
    if (dropRef(channelRefs.current, channel) && s.connected) s.emit("unsubscribe", channel);
    s.off(`data:${channel}`, handler as (d: unknown) => void);
  }, []);





  const subscribeProject = useCallback(<T,>(projectId: number, handler: (data: T) => void) => {
    const s = getOrCreate();
    if (!s) return;
    if (addRef(projectRefs.current, projectId) && s.connected) s.emit("project:subscribe", projectId);
    s.on("project:update", handler as (d: unknown) => void);
  }, [getOrCreate]);

  const unsubscribeProject = useCallback(<T,>(projectId: number, handler: (data: T) => void) => {
    const s = socketRef.current;
    if (!s) return;
    if (dropRef(projectRefs.current, projectId) && s.connected) s.emit("project:unsubscribe", projectId);
    s.off("project:update", handler as (d: unknown) => void);
  }, []);

  const subscribeGlobal = useCallback(<T,>(handler: (data: T) => void) => {
    const s = getOrCreate();
    if (!s) return;
    s.on("global:event", handler as (d: unknown) => void);
  }, [getOrCreate]);

  const unsubscribeGlobal = useCallback(<T,>(handler: (data: T) => void) => {
    const s = socketRef.current;
    if (!s) return;
    s.off("global:event", handler as (d: unknown) => void);
  }, []);

  const subscribeSystemActionsSync = useCallback(<T,>(handler: (data: T) => void) => {
    const s = getOrCreate();
    if (!s) return;
    s.on("system:actions:sync", handler as (d: unknown) => void);
  }, [getOrCreate]);

  const unsubscribeSystemActionsSync = useCallback(<T,>(handler: (data: T) => void) => {
    const s = socketRef.current;
    if (!s) return;
    s.off("system:actions:sync", handler as (d: unknown) => void);
  }, []);

  const refresh = useCallback((channel: string) => {
    socketRef.current?.emit("refresh", channel);
  }, []);

  const disconnect = useCallback(() => {
    socketRef.current?.disconnect();
    socketRef.current = null;
    setConnected(false);
    resetLatency();
  }, [resetLatency]);

  const emit = useCallback((event: string, payload?: unknown) => {
    socketRef.current?.emit(event, payload);
  }, []);

  const emitWithAck = useCallback(<TResponse,>(event: string, payload?: unknown, timeoutMs = 8000): Promise<TResponse> => {
    const s = getOrCreate();
    if (!s) return Promise.reject(new Error("Not connected"));
    return s.timeout(timeoutMs).emitWithAck(event, payload) as Promise<TResponse>;
  }, [getOrCreate]);

  const on = useCallback(<T,>(event: string, handler: (data: T) => void) => {
    const s = getOrCreate();
    s?.on(event, handler as (d: unknown) => void);
  }, [getOrCreate]);

  const off = useCallback(<T,>(event: string, handler: (data: T) => void) => {
    socketRef.current?.off(event, handler as (d: unknown) => void);
  }, []);

  const value = useMemo<SocketContextValue>(() => ({
    connected, subscribe, unsubscribe, subscribeProject, unsubscribeProject, subscribeGlobal, unsubscribeGlobal, subscribeSystemActionsSync, unsubscribeSystemActionsSync, refresh, disconnect, emit, emitWithAck, on, off,
  }), [connected, subscribe, unsubscribe, subscribeProject, unsubscribeProject, subscribeGlobal, unsubscribeGlobal, subscribeSystemActionsSync, unsubscribeSystemActionsSync, refresh, disconnect, emit, emitWithAck, on, off]);

  return (
    <SocketContext.Provider value={value}>
      <SocketLatencyContext.Provider value={latency}>
        {children}
      </SocketLatencyContext.Provider>
    </SocketContext.Provider>
  );
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

export function useSocket(): SocketContextValue {
  const ctx = useContext(SocketContext);
  if (!ctx) throw new Error("useSocket must be used inside <SocketProvider>");
  return ctx;
}

/** Round-trip latency to the server; see SocketLatency. */
export function useSocketLatency(): SocketLatency {
  return useContext(SocketLatencyContext);
}

/**
 * Subscribe to a named channel on mount, unsubscribe on unmount.
 * An optional `fallback` REST fetcher runs immediately so the page
 * renders right away; socket pushes override it with live data.
 */
/** The query key each pushed channel lives under, shared with code that invalidates it
 *  (the action tracker refetches projects and system when an action ends). */
const CHANNEL_KEYS: Record<string, readonly unknown[]> = {
  system: queryKeys.system,
  projects: queryKeys.projects,
};

/**
 * Data the server pushes on a channel, held in the query cache so every component
 * reading the channel shares one copy: seeded over REST (`fallback`), then replaced by
 * each push, and refetched over REST when something invalidates it.
 */
export function useChannelData<T>(
  channel: string,
  options?: { fallback?: () => Promise<T> },
): {
  data: T | null;
  connected: boolean;
  refresh: () => void;
} {
  const { subscribe, unsubscribe, connected, refresh: socketRefresh } = useSocket();
  const queryClient = useQueryClient();
  const key = CHANNEL_KEYS[channel] ?? ["channel", channel];
  // Callers pass an inline arrow; a ref keeps the query function stable across renders.
  const fallbackRef = useRef(options?.fallback);
  fallbackRef.current = options?.fallback;

  const { data } = useQuery({
    queryKey: key,
    queryFn: () => (fallbackRef.current ? fallbackRef.current() : Promise.resolve(null as T)),
    // Pushes keep it current while subscribed; invalidation still refetches.
    staleTime: Infinity,
  });

  // Channels re-push on a timer whether or not anything changed; skipping identical
  // payloads keeps every consumer from re-rendering on a no-op push.
  const accept = useCallback((next: T) => {
    const current = queryClient.getQueryData<T>(key);
    try {
      if (current !== undefined && JSON.stringify(current) === JSON.stringify(next)) return;
    } catch { /* unserializable: always accept */ }
    queryClient.setQueryData(key, next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, channel]);

  // Live socket subscription
  useEffect(() => {
    subscribe<T>(channel, accept);
    return () => unsubscribe<T>(channel, accept);
  }, [channel, subscribe, unsubscribe, accept]);

  const refresh = useCallback(() => {
    socketRefresh(channel);
    // When socket is offline, fall back to REST for the manual refresh too
    if (!connected) void queryClient.invalidateQueries({ queryKey: key });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, socketRefresh, connected, queryClient]);

  return { data: (data ?? null) as T | null, connected, refresh };
}
