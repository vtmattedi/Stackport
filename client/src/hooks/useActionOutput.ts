import { useEffect, useRef, useState } from "react";
import type { ActionOutputEvent } from "../api/types";
import { actionTracker } from "../context/ActionTracker";
import { useSocket } from "../context/SocketContext";

export interface ActionOutput {
  text: string;
  /** True once the server says the action has ended and nothing more will arrive. */
  done: boolean;
}

/**
 * An action's output, live: attaches over the socket (replaying from the start, or
 * from where this view left off after a reconnect) and appends chunks in sequence
 * order, dropping any it already has. Pass null to show nothing.
 */
export function useActionOutput(actionId: string | null): ActionOutput {
  const { emit, on, off, connected } = useSocket();
  const [output, setOutput] = useState<ActionOutput>({ text: "", done: false });
  const nextSeqRef = useRef(0);

  useEffect(() => {
    nextSeqRef.current = 0;
    setOutput({ text: "", done: false });
  }, [actionId]);

  // Output events only say "done" in a replay; the tracker knows when a live one ends.
  useEffect(() => {
    if (!actionId) return;
    return actionTracker.onFinished((record) => {
      if (record.id === actionId) setOutput((prev) => (prev.done ? prev : { ...prev, done: true }));
    });
  }, [actionId]);

  useEffect(() => {
    if (!actionId || !connected) return;
    // Sequence bookkeeping happens here, not inside a state updater: updaters must be
    // pure (StrictMode runs them twice, which would drop every chunk as a duplicate).
    const handler = (event: ActionOutputEvent) => {
      if (event.id !== actionId) return;
      let reset: string | undefined;
      if (event.reset !== undefined) {
        reset = event.reset;
        nextSeqRef.current = event.nextSeq;
      }
      let appended = "";
      for (const chunk of event.chunks) {
        if (chunk.seq < nextSeqRef.current) continue;
        appended += chunk.data;
        nextSeqRef.current = chunk.seq + 1;
      }
      setOutput((prev) => ({
        text: (reset ?? prev.text) + appended,
        done: prev.done || event.done,
      }));
    };
    on<ActionOutputEvent>("action:output", handler);
    emit("action:attach", { id: actionId, fromSeq: nextSeqRef.current });
    return () => {
      off<ActionOutputEvent>("action:output", handler);
      emit("action:detach", actionId);
    };
  }, [actionId, connected, emit, on, off]);

  return output;
}
