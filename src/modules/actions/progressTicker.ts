import { actionEstimator, type ProgressBasis } from "./estimate";
import type { BuildPhase } from "./progress";
import { actionRegistry } from "./registry";

/**
 * Looks at every running action every few seconds, asks the estimator how far along it is, and says so when that has changed. Time-based
 * estimates move while the action's output is silent (a long pull, an nginx reload), which is when nothing else would tell a client it is alive.
 */

export const TICK_MS = 3_000;
/** A new time-left figure is only worth sending when it moved by at least this much. */
const ETA_STEP_S = 5;

export interface ActionProgressEvent {
  id: string;
  key: string;
  projectId: number | null;
  /** The Docker build phase, for actions that run one. */
  phase: BuildPhase | null;
  /** The raw "step n of m" fraction the build reported (0 to 1), when there is one. */
  stepRatio: number | null;
  percent: number;
  etaSeconds: number | null;
  basis: ProgressBasis;
}

export function startProgressTicker(emit: (event: ActionProgressEvent) => void, intervalMs: number = TICK_MS): () => void {
  const lastSent = new Map<string, { percent: number; etaSeconds: number | null; basis: ProgressBasis }>();

  const tick = (): void => {
    const running = actionRegistry.running();
    const ids = new Set(running.map((record) => record.id));
    actionEstimator.prune(ids);
    for (const id of [...lastSent.keys()]) if (!ids.has(id)) lastSent.delete(id);

    for (const record of running) {
      const estimate = actionEstimator.estimate(record);
      if (estimate.percent === null || estimate.basis === null) continue;
      actionRegistry.updateEstimate(record.key, estimate);
      const before = lastSent.get(record.id);
      const moved = !before || before.percent !== estimate.percent || before.basis !== estimate.basis
        || (estimate.etaSeconds !== null && (before.etaSeconds === null || Math.abs(before.etaSeconds - estimate.etaSeconds) >= ETA_STEP_S));
      if (!moved) continue;
      lastSent.set(record.id, { percent: estimate.percent, etaSeconds: estimate.etaSeconds, basis: estimate.basis });
      emit({
        id: record.id, key: record.key, projectId: record.projectId ?? null, phase: record.phase, stepRatio: record.progress,
        percent: estimate.percent, etaSeconds: estimate.etaSeconds, basis: estimate.basis,
      });
    }
  };

  const timer = setInterval(() => { try { tick(); } catch { /* the next tick tries again */ } }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
