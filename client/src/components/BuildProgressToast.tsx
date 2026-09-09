import { useEffect, useRef, useState } from "react";
import { formatElapsed } from "../lib/format";
import { useSocket } from "../context/SocketContext";
import type { BuildPhase, ProjectActionsSnapshot, ProjectBuildProgressEvent } from "../api/types";

const PHASE_LABELS: Record<BuildPhase, string> = {
  preparing: "Preparing",
  pulling: "Pulling",
  building: "Building",
  deploying: "Deploying",
  starting: "Starting",
};

interface BuildProgressToastProps {
  projectId: number;
  title: string;
  initialPhase: BuildPhase | null;
  initialProgress: number | null;
  startedAt: string;
  /** Fires once, the moment we learn the action finished. `ok` is best-effort from
   *  whichever signal triggered it — callers still fetch the final ActionRecord
   *  separately (see trackBuildProgressToast) for the full success/fail detail. */
  onDone: (ok: boolean) => void;
}

/** Toast body for a running project build/deploy — progress bar + a locally-ticking
 *  elapsed timer. Created ONCE per action and never re-invoked with fresh props
 *  afterward — an earlier version of this component got recreated via a fresh
 *  `notify.loading(...)` call on every poll tick, which risked the toast library not
 *  preserving mounted state across those calls and freezing the elapsed timer. This
 *  version owns its own live `project:build-progress` subscription and its own 1s
 *  timer, both scoped to its own mount lifetime.
 *
 * Also listens for `project:deploy:sync` — the snapshot the server already sends
 * synchronously in direct response to our own `deploy:subscribe` call. That closes a
 * real race: `tryStart` kicks off the actual docker process fire-and-forget before
 * our REST call even returns, so a fast/fully-cached build can finish (and emit its
 * `done` progress event) before this component has mounted and joined the socket
 * room. Without the sync catch-up, that `done` event is simply missed and the toast
 * hangs forever waiting for a signal that already came and went. The sync snapshot
 * carries the CURRENT state regardless of timing, so it catches that case directly. */
export function BuildProgressToast({ projectId, title, initialPhase, initialProgress, startedAt, onDone }: BuildProgressToastProps) {
  const { emit, on, off } = useSocket();
  const [phase, setPhase] = useState(initialPhase);
  const [progress, setProgress] = useState(initialProgress);
  const [elapsedMs, setElapsedMs] = useState(() => Date.now() - new Date(startedAt).getTime());
  const doneFiredRef = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    const startedAtMs = new Date(startedAt).getTime();
    setElapsedMs(Date.now() - startedAtMs);
    const timer = window.setInterval(() => setElapsedMs(Date.now() - startedAtMs), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  useEffect(() => {
    const fireDone = (ok: boolean) => {
      if (doneFiredRef.current) return; // the live event and the sync catch-up can both fire — only act once
      doneFiredRef.current = true;
      onDoneRef.current(ok);
    };

    const progressHandler = (event: ProjectBuildProgressEvent) => {
      if (event.projectId !== projectId) return;
      setPhase(event.phase);
      setProgress(event.progress);
      if (event.done) fireDone(event.ok ?? false);
    };
    const syncHandler = (snap: ProjectActionsSnapshot) => {
      const record = snap.repo;
      if (!record || record.projectId !== projectId) return;
      setPhase(record.phase);
      setProgress(record.progress);
      if (record.status !== "running") fireDone(record.ok ?? false);
    };

    // Listeners must be registered before we ask the server to subscribe us, so
    // nothing sent in immediate response can arrive before we're ready for it.
    on<ProjectBuildProgressEvent>("project:build-progress", progressHandler);
    on<ProjectActionsSnapshot>("project:deploy:sync", syncHandler);
    emit("deploy:subscribe", projectId);

    return () => {
      off<ProjectBuildProgressEvent>("project:build-progress", progressHandler);
      off<ProjectActionsSnapshot>("project:deploy:sync", syncHandler);
      emit("deploy:unsubscribe", projectId);
    };
  }, [projectId, emit, on, off]);

  const pct = progress != null ? Math.round(progress * 100) : null;

  return (
    <div className="build-progress-toast">
      <div className="build-progress-toast-row">
        <span className="build-progress-toast-title">{title}</span>
        <span className="build-progress-toast-elapsed mono">{formatElapsed(elapsedMs)}</span>
      </div>
      <div className="build-progress-toast-row">
        <div className="build-progress-toast-bar" role="progressbar" aria-valuenow={pct ?? 0} aria-valuemin={0} aria-valuemax={100}>
          <div className="build-progress-toast-bar-fill" style={{ width: `${pct ?? 0}%` }} />
        </div>
        <span className="build-progress-toast-pct mono">
          {PHASE_LABELS[phase ?? "preparing"]}{pct != null ? ` ~${pct}%` : ""}
        </span>
      </div>
    </div>
  );
}
