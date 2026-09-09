export type BuildPhase = "preparing" | "pulling" | "building" | "deploying" | "starting";

export interface BuildProgressUpdate {
  phase: BuildPhase;
  progress: number;
}

// Reserves the jump to 1.0 for actual successful completion (see finish() below) —
// an estimate based on partial/streaming output should never claim "done" on its own.
const PROGRESS_CAP_WHILE_RUNNING = 0.95;

// Matches both `#N [1/5] ...` (unnamed/default stage) and `#N [stage-name 3/7] ...`
// (named stage) BuildKit step-start lines.
const STEP_LINE_RE = /^#\d+\s+\[[^\]]*?(\d+)\/(\d+)\]/;
const GIT_COMMAND_RE = /^\$\s+git\b/;
const DOCKER_BUILD_COMMAND_RE = /^\$\s+docker\b.*\b(?:build|up)\b/;
// docker compose v2's human-readable container lifecycle lines, e.g.
// "Container myproj-web-1  Creating" / "...  Started".
const COMPOSE_DEPLOYING_RE = /\bContainer\s+\S+\s+(?:Recreate|Recreating|Recreated|Creating|Created|Removing)\b/i;
const COMPOSE_STARTING_RE = /\bContainer\s+\S+\s+(?:Starting|Started)\b/i;

interface TrackerEntry {
  buffer: string; // partial trailing line carried across chunks
  phase: BuildPhase;
  progress: number;
}

/**
 * Best-effort progress estimator that runs alongside the existing human-readable
 * docker/git output stream (never replaces it, never switches the docker command to
 * `--progress rawjson`). Consumes raw output chunks — which may contain a partial
 * line, several lines, or a mid-line fragment — and derives a rough {phase, progress}
 * from recognizable markers: which command just started (git vs. docker build/up),
 * BuildKit's `#N [stage current/total]` step lines, and docker compose's container
 * lifecycle lines. Keyed by the same actionRegistry key as the action itself, so
 * concurrent builds for different projects never share state.
 */
class BuildProgressTracker {
  private entries = new Map<string, TrackerEntry>();

  private entry(key: string): TrackerEntry {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { buffer: "", phase: "preparing", progress: 0 };
      this.entries.set(key, entry);
    }
    return entry;
  }

  /** Feeds one raw output chunk for the given action. Returns the updated
   *  {phase, progress} if this chunk moved the needle, or null if it didn't
   *  (the vast majority of lines don't match anything) — callers can skip a
   *  registry write in that case. */
  consume(key: string, chunk: string): BuildProgressUpdate | null {
    const entry = this.entry(key);
    const combined = entry.buffer + chunk;
    const lines = combined.split(/\r?\n/);
    entry.buffer = lines.pop() ?? ""; // trailing partial line (or "") carries to next chunk

    let changed = false;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line && this.applyLine(entry, line)) changed = true;
    }
    return changed ? { phase: entry.phase, progress: entry.progress } : null;
  }

  private applyLine(entry: TrackerEntry, line: string): boolean {
    let changed = false;

    if (entry.phase === "preparing" && GIT_COMMAND_RE.test(line)) {
      entry.phase = "pulling";
      changed = true;
    } else if ((entry.phase === "preparing" || entry.phase === "pulling") && DOCKER_BUILD_COMMAND_RE.test(line)) {
      entry.phase = "building";
      changed = true;
    }

    const stepMatch = STEP_LINE_RE.exec(line);
    if (stepMatch) {
      const current = Number(stepMatch[1]);
      const total = Number(stepMatch[2]);
      if (Number.isFinite(current) && Number.isFinite(total) && total > 0) {
        if (entry.phase === "preparing" || entry.phase === "pulling") {
          entry.phase = "building";
          changed = true;
        }
        const ratio = Math.min(current / total, PROGRESS_CAP_WHILE_RUNNING);
        if (ratio > entry.progress) {
          entry.progress = ratio;
          changed = true;
        }
      }
    }

    if (entry.phase !== "starting" && COMPOSE_DEPLOYING_RE.test(line)) {
      if (entry.phase !== "deploying") changed = true;
      entry.phase = "deploying";
    }
    if (COMPOSE_STARTING_RE.test(line) && entry.phase !== "starting") {
      entry.phase = "starting";
      changed = true;
    }

    return changed;
  }

  /** Call once the action's final outcome is known. Success snaps progress to 1.0;
   *  failure leaves the last estimate untouched — both leave phase as-is. */
  finish(key: string, ok: boolean): BuildProgressUpdate {
    const entry = this.entry(key);
    if (ok) entry.progress = 1;
    return { phase: entry.phase, progress: entry.progress };
  }

  /** Drops all state for a key once its final snapshot has been persisted, so the
   *  next action reusing the same key starts clean instead of inheriting stale
   *  step counts or phase from the previous run. */
  reset(key: string): void {
    this.entries.delete(key);
  }
}

export const buildProgressTracker = new BuildProgressTracker();
