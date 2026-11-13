import { getDatabase } from "../../config/database";
import type { ActionRecord } from "./registry";
import type { BuildPhase } from "./progress";

/**
 * How far along a running action is, as a percentage with an estimated time left. One estimator feeds both the live status stream and the web UI,
 * so the two never disagree.
 *
 * It is an estimate and says what it is based on (`basis`):
 *  - `steps`   a Docker build is in its build phase and reporting "step 3 of 9": the percentage follows the steps;
 *  - `phase`   a Docker build is somewhere in its life (preparing, pulling, building, deploying, starting) and the percentage is where that phase begins;
 *  - `time`    how long the last few successful runs of this kind of action (for this project) took: elapsed over typical.
 * With neither a phase nor enough history (3 earlier successful runs), the percentage is `null`: no number is better than an invented one.
 *
 * It never goes backwards for an action, and never claims more than 95% while the action is still running: 100 belongs to the moment it has
 * finished, which the stream and the UI already say another way.
 */

export type ProgressBasis = "steps" | "phase" | "time";

export interface ProgressEstimate {
  /** 0 to 95 while running; null when there is nothing to base one on. */
  percent: number | null;
  etaSeconds: number | null;
  basis: ProgressBasis | null;
}

export const NO_ESTIMATE: ProgressEstimate = { percent: null, etaSeconds: null, basis: null };

/** Where each phase of a Docker build sits on the 0 to 95 scale. Builds dominate, so building gets the widest band. */
export const PHASE_BANDS: Record<BuildPhase, readonly [number, number]> = {
  preparing: [0, 5],
  pulling: [5, 15],
  building: [15, 75],
  deploying: [75, 90],
  starting: [90, 95],
};

const CAP_WHILE_RUNNING = 95;
export const MIN_SAMPLES = 3;
const SAMPLE_COUNT = 10;
/** Runs shorter or longer than this say nothing about a typical one (a no-op, or one that sat waiting). */
const MIN_SAMPLE_MS = 1_000;
const MAX_SAMPLE_MS = 2 * 60 * 60 * 1000;

export interface EstimateInput {
  /** The Docker build phase, for actions that run one; null for the rest. */
  phase: BuildPhase | null;
  /** "Step n of m" as a fraction (0 to 1), from the build output; null or 0 when none has been seen. */
  stepRatio: number | null;
  startedAtMs: number;
  now: number;
  /** The median duration of earlier successful runs, or null when there are fewer than MIN_SAMPLES. */
  typicalMs: number | null;
  /** The highest percentage already reported for this action. */
  floor: number;
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

export function estimateProgress(input: EstimateInput): ProgressEstimate {
  // A start time that cannot be read would turn every number below into NaN.
  if (!Number.isFinite(input.startedAtMs) || !Number.isFinite(input.now)) return NO_ESTIMATE;
  const elapsed = Math.max(0, input.now - input.startedAtMs);
  const timeShare = input.typicalMs && input.typicalMs > 0 ? (elapsed / input.typicalMs) * 100 : null;

  let percent: number | null;
  let basis: ProgressBasis | null;
  if (input.phase !== null) {
    const [low, high] = PHASE_BANDS[input.phase];
    const steps = input.phase === "building" && input.stepRatio !== null && input.stepRatio > 0;
    const within = steps ? clamp(input.stepRatio ?? 0, 0, 1) : 0;
    const byPhase = low + (high - low) * within;
    // Time moves the number along inside the current phase when it has nothing better, but can never carry it past the top of the phase.
    percent = !steps && timeShare !== null ? Math.max(byPhase, Math.min(timeShare, high - 0.5)) : byPhase;
    basis = steps ? "steps" : timeShare !== null ? "time" : "phase";
  } else if (timeShare !== null) {
    percent = timeShare;
    basis = "time";
  } else {
    return NO_ESTIMATE;
  }

  percent = Math.round(clamp(Math.max(percent, input.floor), 0, CAP_WHILE_RUNNING));

  // The time left must agree with the percentage beside it. Once the build reports its steps, today's pace says more than history does. Otherwise it is the
  // typical duration less what has passed; an action that has already outlasted a typical run has no estimate ("taking longer than usual"), not "0 seconds".
  let remainingMs: number | null = null;
  if (basis === "steps" && input.stepRatio !== null && input.stepRatio >= 0.1) {
    remainingMs = (elapsed * (1 - input.stepRatio)) / input.stepRatio;
  } else if (input.typicalMs && input.typicalMs > 0 && elapsed < input.typicalMs) {
    remainingMs = input.typicalMs - elapsed;
  }
  // In steps of 5 seconds: a countdown that changes every second would be a change to send every second.
  const etaSeconds = remainingMs === null ? null : Math.round(remainingMs / 5_000) * 5;
  return { percent, etaSeconds, basis };
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted.at(middle)! : (sorted.at(middle - 1)! + sorted.at(middle)!) / 2;
}

/** How long earlier successful runs of this kind took (milliseconds), most recent first. Runs that say nothing are left out. */
export function recentDurations(kind: string, projectId: number | null, limit = SAMPLE_COUNT): number[] {
  const rows = getDatabase().prepare(
    "SELECT started_at, finished_at FROM actions WHERE kind = ? AND project_id IS ? AND status = 'success' AND finished_at IS NOT NULL ORDER BY started_at DESC LIMIT ?",
  ).all(kind, projectId, limit) as { started_at: string; finished_at: string }[];
  return rows
    .map((row) => Date.parse(row.finished_at) - Date.parse(row.started_at))
    .filter((ms) => Number.isFinite(ms) && ms >= MIN_SAMPLE_MS && ms <= MAX_SAMPLE_MS);
}

const TYPICAL_TTL_MS = 60_000;

export class ActionEstimator {
  private floors = new Map<string, number>();
  private typicals = new Map<string, { at: number; ms: number | null }>();

  constructor(
    private readonly durations: (kind: string, projectId: number | null) => number[] = recentDurations,
    private readonly clock: () => number = Date.now,
  ) {}

  private typical(kind: string, projectId: number | null): number | null {
    const key = `${kind}:${projectId ?? "-"}`;
    const cached = this.typicals.get(key);
    const now = this.clock();
    if (cached && now - cached.at < TYPICAL_TTL_MS) return cached.ms;
    const samples = this.durations(kind, projectId);
    const ms = samples.length >= MIN_SAMPLES ? median(samples) : null;
    this.typicals.set(key, { at: now, ms });
    return ms;
  }

  /** The estimate for a running action, never lower than one already given for it. */
  estimate(record: Pick<ActionRecord, "id" | "kind" | "projectId" | "startedAt" | "phase" | "progress">): ProgressEstimate {
    const now = this.clock();
    const result = estimateProgress({
      phase: record.phase,
      stepRatio: record.progress,
      startedAtMs: Date.parse(record.startedAt),
      now,
      typicalMs: this.typical(record.kind, record.projectId ?? null),
      floor: this.floors.get(record.id) ?? 0,
    });
    if (result.percent !== null) this.floors.set(record.id, result.percent);
    return result;
  }

  /** Forgets what it holds for actions that are no longer running, and typical durations that have gone stale. */
  prune(runningIds: Set<string>): void {
    for (const id of [...this.floors.keys()]) if (!runningIds.has(id)) this.floors.delete(id);
    const now = this.clock();
    for (const [key, entry] of [...this.typicals]) if (now - entry.at >= TYPICAL_TTL_MS) this.typicals.delete(key);
  }
}

export const actionEstimator = new ActionEstimator();
