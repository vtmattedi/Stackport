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
// Latency is re-measured every 5 s; it gets its own context so that tick only
// re-renders the status indicator, not every component that uses the socket.
const SocketLatencyContext = createContext<number | null>(null);

// ── Provider ──────────────────────────────────────────────────────────────────

export function SocketProvider({ children }: { children: React.ReactNode }) {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  const measureLatency = useCallback(() => {
    const socket = socketRef.current;
    if (!socket?.connected) {
      setLatencyMs(null);
      return;
    }

    const startedAt = performance.now();
    socket.timeout(3000).emit("latency:ping", (err: Error | null) => {
      setLatencyMs(err ? null : Math.round(performance.now() - startedAt));
    });
  }, []);

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
      setConnected(true);
      measureLatency();
    });
    socket.on("disconnect", () => {
      setConnected(false);
      setLatencyMs(null);
    });
    socket.io.on("reconnect_attempt", () => {
      socket.auth = { token: getToken() };
    });
    socket.on("connect_error", (err: Error) => {
      setConnected(false);
      setLatencyMs(null);
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
  }, [measureLatency]);

  // Cleanup on unmount (e.g. full page reload after logout)
  useEffect(() => {
    return () => {
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!connected) return;
    measureLatency();
    const timer = window.setInterval(measureLatency, 5000);
    return () => window.clearInterval(timer);
  }, [connected, measureLatency]);

  const subscribe = useCallback(<T,>(channel: string, handler: (data: T) => void) => {
    const s = getOrCreate();
    if (!s) return;
    s.emit("subscribe", channel);
    s.on(`data:${channel}`, handler as (d: unknown) => void);
  }, [getOrCreate]);

  const unsubscribe = useCallback(<T,>(channel: string, handler: (data: T) => void) => {
    const s = socketRef.current;
    if (!s) return;
    s.emit("unsubscribe", channel);
    s.off(`data:${channel}`, handler as (d: unknown) => void);
  }, []);





  const subscribeProject = useCallback(<T,>(projectId: number, handler: (data: T) => void) => {
    const s = getOrCreate();
    if (!s) return;
    s.emit("project:subscribe", projectId);
    s.on("project:update", handler as (d: unknown) => void);
  }, [getOrCreate]);

  const unsubscribeProject = useCallback(<T,>(projectId: number, handler: (data: T) => void) => {
    const s = socketRef.current;
    if (!s) return;
    s.emit("project:unsubscribe", projectId);
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
    setLatencyMs(null);
  }, []);

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
      <SocketLatencyContext.Provider value={latencyMs}>
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

/** Round-trip latency to the server in ms, or null when unknown/disconnected. */
export function useSocketLatency(): number | null {
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
  vps: queryKeys.vps,
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
