import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ActionRecord, ActionSummary } from "../api/types";
import { queryClient } from "../lib/queryClient";
import { queryKeys } from "../lib/queryKeys";
import { useSocket } from "./SocketContext";

type Listener = (record: ActionSummary) => void;

/** Finished records kept so a waiter that starts late still gets its answer. */
const MAX_FINISHED = 200;

/**
 * The client's single view of server actions, fed by the socket's action:started and
 * action:finished events and resynced from GET /actions/running on every (re)connect.
 * It replaces the per-action-type waiters and polling loops: anything that needs to
 * know when an action ends calls waitFor(id).
 */
class ActionTracker {
  private running = new Map<string, ActionSummary>();
  private finished = new Map<string, ActionSummary>();
  private waiters = new Map<string, ((record: ActionSummary) => void)[]>();
  private startListeners = new Set<Listener>();
  private finishListeners = new Set<Listener>();

  onStarted(listener: Listener): () => void {
    this.startListeners.add(listener);
    return () => { this.startListeners.delete(listener); };
  }

  onFinished(listener: Listener): () => void {
    this.finishListeners.add(listener);
    return () => { this.finishListeners.delete(listener); };
  }

  runningActions(): ActionSummary[] {
    return [...this.running.values()];
  }

  started(record: ActionSummary): void {
    if (this.running.has(record.id) || this.finished.has(record.id)) return;
    this.running.set(record.id, record);
    this.publishRunning();
    if (record.key.startsWith("system:")) void queryClient.invalidateQueries({ queryKey: queryKeys.systemActions });
    for (const listener of this.startListeners) listener(record);
  }

  ended(record: ActionSummary): void {
    if (this.finished.has(record.id)) return;
    if (!this.running.has(record.id)) {
      // Finished before we saw it start (or before this tab loaded): still announce
      // the start first, so listeners see a consistent start/finish pair.
      this.running.set(record.id, record);
      for (const listener of this.startListeners) listener(record);
    }
    this.running.delete(record.id);
    this.finished.set(record.id, record);
    if (this.finished.size > MAX_FINISHED) this.finished.delete(this.finished.keys().next().value!);
    this.publishRunning();
    for (const resolve of this.waiters.get(record.id) ?? []) resolve(record);
    this.waiters.delete(record.id);
    for (const listener of this.finishListeners) listener(record);
    invalidateFor(record);
  }

  /** Resolves with the action's final record once it has finished. */
  waitFor(id: string): Promise<ActionSummary> {
    const done = this.finished.get(id);
    if (done) return Promise.resolve(done);
    return new Promise((resolve) => {
      this.waiters.set(id, [...(this.waiters.get(id) ?? []), resolve]);
    });
  }

  /** After (re)connecting: picks up actions started while we weren't listening, and
   *  settles any we were waiting on that ended meanwhile. */
  async resync(): Promise<void> {
    const list = await api.listRunningActions().catch(() => null);
    if (!list) return;
    const ids = new Set(list.map((r) => r.id));
    for (const record of list) this.started(record);
    const vanished = [...new Set([...this.running.keys(), ...this.waiters.keys()])].filter((id) => !ids.has(id));
    await Promise.all(vanished.map(async (id) => {
      const record = await api.getAction(id).catch(() => null);
      if (record && record.status !== "running") this.ended(record);
    }));
  }

  private publishRunning(): void {
    queryClient.setQueryData(queryKeys.runningActions, this.runningActions());
  }
}

/** When an action ends, the data it may have changed is refetched. */
function invalidateFor(record: ActionSummary): void {
  if (record.projectId !== undefined) {
    void queryClient.invalidateQueries({ queryKey: queryKeys.project(record.projectId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
  }
  if (record.key.startsWith("system:")) {
    void queryClient.invalidateQueries({ queryKey: queryKeys.systemActions });
    void queryClient.invalidateQueries({ queryKey: queryKeys.system });
  }
}

export const actionTracker = new ActionTracker();

/** Waits for an action to end and returns its final record with its stored log. */
export async function waitForActionResult(id: string): Promise<ActionRecord> {
  const final = await actionTracker.waitFor(id);
  const log = await api.getActionLog(id).catch(() => "");
  return { ...final, log };
}

/** Connects the tracker to the socket. Mount once, inside SocketProvider. */
export function ActionTrackerBridge() {
  const { on, off, connected } = useSocket();

  useEffect(() => {
    const started = (record: ActionSummary) => actionTracker.started(record);
    const finished = (record: ActionSummary) => actionTracker.ended(record);
    on<ActionSummary>("action:started", started);
    on<ActionSummary>("action:finished", finished);
    return () => {
      off<ActionSummary>("action:started", started);
      off<ActionSummary>("action:finished", finished);
    };
  }, [on, off]);

  useEffect(() => {
    if (connected) void actionTracker.resync();
  }, [connected]);

  return null;
}

/** Every action running on the server right now, kept current by socket events. */
export function useRunningActionRecords(): ActionSummary[] {
  const { data } = useQuery({
    queryKey: queryKeys.runningActions,
    queryFn: () => actionTracker.runningActions(),
    staleTime: Infinity,
    initialData: () => actionTracker.runningActions(),
  });
  return data;
}
