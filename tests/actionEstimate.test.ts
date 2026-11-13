import { before, test } from "node:test";
import assert from "node:assert/strict";
import { getDatabase, initializeDatabase } from "../src/config/database";
import { ActionEstimator, MIN_SAMPLES, PHASE_BANDS, estimateProgress, median, recentDurations, type EstimateInput } from "../src/modules/actions/estimate";
import { startProgressTicker, type ActionProgressEvent } from "../src/modules/actions/progressTicker";
import { actionRegistry } from "../src/modules/actions/registry";

before(() => { initializeDatabase(); });

const START = Date.parse("2026-11-12T10:00:00Z");
const input = (over: Partial<EstimateInput> = {}): EstimateInput => ({ phase: null, stepRatio: null, startedAtMs: START, now: START + 10_000, typicalMs: null, floor: 0, ...over });

// ---- the arithmetic

test("with no build phase and no history there is no number, not an invented one", () => {
  assert.deepEqual(estimateProgress(input()), { percent: null, etaSeconds: null, basis: null });
});

test("without a build phase it is elapsed over the typical duration, capped at 95 while running, with the time left", () => {
  assert.deepEqual(estimateProgress(input({ typicalMs: 20_000 })), { percent: 50, etaSeconds: 10, basis: "time" });
  assert.deepEqual(estimateProgress(input({ typicalMs: 10_000, now: START + 30_000 })), { percent: 95, etaSeconds: null, basis: "time" }, "slower than usual: capped, and no time left to promise");
});

test("a docker build follows its phases, and its steps inside the build phase", () => {
  const at = (phase: EstimateInput["phase"], stepRatio: number | null = null) => estimateProgress(input({ phase, stepRatio }));
  assert.deepEqual(at("preparing"), { percent: 0, etaSeconds: null, basis: "phase" });
  assert.equal(at("pulling").percent, PHASE_BANDS.pulling[0]);
  assert.deepEqual(at("building", 0.5), { percent: 45, etaSeconds: 10, basis: "steps" }, "halfway through the build band, and the pace so far says as long again to go");
  assert.equal(at("building", 1).percent, 75);
  assert.equal(at("deploying").percent, 75);
  assert.equal(at("starting").percent, 90);
});

test("with history, time moves a phase along but never past the top of it", () => {
  const e = estimateProgress(input({ phase: "pulling", typicalMs: 100_000, now: START + 10_000 }));
  assert.equal(e.basis, "time");
  assert.equal(e.percent, 10, "10% of the typical time, inside the pulling band (5 to 15)");
  const stuck = estimateProgress(input({ phase: "pulling", typicalMs: 1_000, now: START + 600_000 }));
  assert.ok(stuck.percent! <= PHASE_BANDS.pulling[1], "a long pull does not claim the build has started");
});

test("an estimate never goes down", () => {
  assert.equal(estimateProgress(input({ phase: "building", stepRatio: 0.1, floor: 60 })).percent, 60);
  assert.equal(estimateProgress(input({ typicalMs: 100_000, now: START + 1_000, floor: 33 })).percent, 33);
});

test("with no history the time left comes from the pace of the steps, once there are enough of them to say", () => {
  assert.equal(estimateProgress(input({ phase: "building", stepRatio: 0.25, now: START + 30_000 })).etaSeconds, 90);
  assert.equal(estimateProgress(input({ phase: "building", stepRatio: 0.05, now: START + 30_000 })).etaSeconds, null, "five percent in is too early to extrapolate");
});

test("the time left agrees with the percentage: a slow build is not \"almost done\" while it is a third of the way through", () => {
  // Typically 5 minutes; today it has taken 7 and is on step 3 of 9.
  const slow = estimateProgress(input({ phase: "building", stepRatio: 3 / 9, typicalMs: 300_000, now: START + 420_000 }));
  assert.equal(slow.basis, "steps");
  assert.equal(slow.percent, 35);
  assert.equal(slow.etaSeconds, 840, "today's pace, 7 minutes for a third, says 14 more");
  // Before the steps say anything, history is the best there is.
  assert.equal(estimateProgress(input({ phase: "pulling", typicalMs: 100_000, now: START + 10_000 })).etaSeconds, 90);
  // The countdown moves in steps of five seconds, so it is not a change to send every second.
  const ticks = [10_000, 10_400, 11_200, 12_000].map((ms) => estimateProgress(input({ typicalMs: 100_000, now: START + ms })).etaSeconds);
  assert.ok(ticks.every((eta) => eta !== null && eta % 5 === 0), JSON.stringify(ticks));
});

test("a start time that cannot be read gives no estimate, not NaN", () => {
  assert.deepEqual(estimateProgress(input({ startedAtMs: Number.NaN, typicalMs: 20_000 })), { percent: null, etaSeconds: null, basis: null });
  const estimator = new ActionEstimator(() => [10_000, 10_000, 10_000], () => START + 5_000);
  const broken = { id: "b", kind: "x", projectId: undefined, startedAt: "not a date", phase: null, progress: null };
  assert.equal(estimator.estimate(broken).percent, null);
  assert.equal(estimator.estimate(broken).percent, null, "and it did not poison its memory of the action");
});

test("typical durations that have gone stale are dropped, not kept for ever", () => {
  let at = START;
  let looks = 0;
  const estimator = new ActionEstimator(() => { looks += 1; return [10_000, 10_000, 10_000]; }, () => at);
  const record = { id: "t", kind: "x", projectId: undefined, startedAt: new Date(START).toISOString(), phase: null, progress: null };
  estimator.estimate(record);
  at = START + 120_000;
  estimator.prune(new Set(["t"]));
  estimator.estimate(record);
  assert.equal(looks, 2, "after the prune the entry was gone and had to be looked up again");
});

test("median", () => {
  assert.equal(median([]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([9, 1, 5]), 5);
  assert.equal(median([1, 2, 3, 10]), 2.5);
});

// ---- history, from the real actions table

function recordRun(kind: string, projectId: number | null, seconds: number, status = "success", minutesAgo = 10): void {
  const started = new Date(Date.now() - minutesAgo * 60_000);
  getDatabase().prepare("INSERT INTO actions (id, key, kind, project_id, status, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(`${kind}-${projectId}-${seconds}-${status}-${minutesAgo}-${Math.random()}`, `k:${kind}`, kind, projectId, status, started.toISOString(), new Date(started.getTime() + seconds * 1000).toISOString());
}

test("earlier durations come from successful runs of the same kind (and project), leaving out the ones that say nothing", () => {
  for (const s of [12, 14, 16]) recordRun("test-kind", null, s);
  recordRun("test-kind", null, 500, "failed");   // a failure says nothing about how long success takes
  recordRun("test-kind", null, 0);               // a no-op
  recordRun("other-kind", null, 99);
  assert.deepEqual(recentDurations("test-kind", null).sort((a, b) => a - b), [12_000, 14_000, 16_000]);
  assert.deepEqual(recentDurations("test-kind", 7), [], "another project's history is not this one's");
});

test("the estimator needs at least three earlier runs, takes their median, and holds what it found for a minute", () => {
  let calls = 0;
  let samples = [10_000, 20_000];
  let at = START + 5_000;
  const estimator = new ActionEstimator(() => { calls += 1; return samples; }, () => at);
  const record = { id: "a", kind: "x", projectId: undefined, startedAt: new Date(START).toISOString(), phase: null, progress: null };

  assert.equal(estimator.estimate(record).percent, null, `${samples.length} runs is fewer than ${MIN_SAMPLES}`);
  samples = [10_000, 20_000, 30_000];
  assert.equal(estimator.estimate(record).percent, null, "what it found is held for a minute: the new run is not looked for yet");
  assert.equal(calls, 1);

  at = START + 66_000; // more than a minute after the first look
  const later = estimator.estimate(record);
  assert.equal(calls, 2, "a minute on, it looks again");
  assert.equal(later.percent, 95, "66 s elapsed against a typical 20 s (the median of 10, 20 and 30): capped");
  assert.equal(later.etaSeconds, null, "it has outlasted a typical run: no countdown");
});

test("the estimator forgets finished actions", () => {
  const estimator = new ActionEstimator(() => [10_000, 10_000, 10_000], () => START + 5_000);
  const record = { id: "gone", kind: "x", projectId: undefined, startedAt: new Date(START).toISOString(), phase: null, progress: null };
  assert.equal(estimator.estimate(record).percent, 50);
  estimator.prune(new Set());
  const earlier = { ...record };
  assert.equal(new ActionEstimator(() => [10_000, 10_000, 10_000], () => START + 1_000).estimate(earlier).percent, 10, "a new estimator has no floor");
});

// ---- the ticker

test("the ticker says so when a running action's estimate changes, and only then", async () => {
  const events: ActionProgressEvent[] = [];
  const seen = (): ActionProgressEvent[] => events;
  const key = "system:estimate-test";
  let release: () => void = () => undefined;
  const started = actionRegistry.tryStart(key, "estimate-test", {}, () => new Promise((resolve) => { release = () => resolve({ ok: true, output: "done" }); }));
  assert.ok(started);
  const stop = startProgressTicker((event) => events.push(event), 10);
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60));
  try {
    await settle();
    assert.equal(seen().length, 0, "no phase and no history: nothing to say");

    actionRegistry.updateProgress(key, "building", 0.5);
    await settle();
    assert.equal(seen().length, 1);
    const first = seen()[0]!;
    assert.deepEqual([first.percent, first.basis, first.phase, first.stepRatio, first.key, first.projectId], [45, "steps", "building", 0.5, key, null]);
    assert.equal(actionRegistry.getById(started.id)?.estimate?.percent, 45, "and it is kept on the action");

    await settle();
    assert.equal(seen().length, 1, "nothing changed, nothing sent");

    actionRegistry.updateProgress(key, "deploying", 0.9);
    await settle();
    assert.equal(seen().at(-1)!.percent, 75);
  } finally {
    stop();
    release();
    await settle();
  }
});
