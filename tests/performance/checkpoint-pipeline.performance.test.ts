import { describe, expect, it } from "vitest";
import { generateSchedule } from "../../src/domain/kernel/scheduling-kernel";
import { defaultHighsSolver } from "../../src/infrastructure/solver/highs-solver";
import type { SolverPort } from "../../src/domain/solver/solver-port";
import { createLatePriorityPressureState } from "./fixtures/late-priority";

describe("complete scheduling with production safe checkpoints", () => {
  it("does not calculate intermediate plans when nobody consumes them", async () => {
    const { state, date } = createLatePriorityPressureState();
    state.history = [];
    const callbackFlags: boolean[] = [];
    const result = await generateSchedule(state, date, {
      solver: {
        solve: (problem, options) => {
          callbackFlags.push(
            Boolean(
              options?.onRequiredSolution || options?.onBestEffortSolution
            )
          );
          return defaultHighsSolver.solve(problem, options);
        },
      },
    });
    expect(callbackFlags.length).toBeGreaterThan(0);
    expect(callbackFlags).not.toContain(true);
    expect(result.assignments).toHaveLength(8);
    expect(result.safetyCredential?.phase).toBe("final");
  }, 30_000);
  it("measures all stages, solver calls and safe checkpoint finalization", async () => {
    const { state, date } = createLatePriorityPressureState();
    // This benchmark exercises history/review cost, not the TR121 monthly cap.
    state.history = state.history.map((row) =>
      row.flightNo === "TR121" && row.remark === "一号"
        ? { ...row, position: "H02", remark: "申报" }
        : row
    );
    state.settings.minimumRegularTransitionMinutes = 0;
    state.settings.crossFlightPriorityPolicies = [];
    state.settings.positionTransitionPolicies = [];
    state.settings.crossWorkdayQualificationReservations = [];
    state.settings.lateShiftRecoveryEnabled = false;
    state.settings.highLoadProtectionEnabled = false;
    state.settings.rollingLoadProtectionEnabled = false;
    state.positionRules
      .filter((rule) => rule.name === "督导")
      .forEach((rule) => (rule.category = "机动督导"));
    const measurements = {
      mainCalls: 0,
      checkpointCalls: 0,
      mainSolverMs: 0,
      checkpointSolverMs: 0,
      safeResults: 0,
      phases: {} as Record<string, number>,
    };
    const wrapped = (kind: "main" | "checkpoint"): SolverPort => ({
      solve: async (problem, options) => {
        measurements[kind === "main" ? "mainCalls" : "checkpointCalls"]++;
        const start = performance.now();
        try {
          return await defaultHighsSolver.solve(problem, options);
        } finally {
          measurements[
            kind === "main" ? "mainSolverMs" : "checkpointSolverMs"
          ] += performance.now() - start;
        }
      },
    });
    let phase = "prepare",
      last = performance.now();
    const started = last;
    const result = await generateSchedule(state, date, {
      solver: wrapped("main"),
      checkpointSolver: wrapped("checkpoint"),
      onProgress: (next) => {
        const now = performance.now();
        measurements.phases[phase] =
          (measurements.phases[phase] ?? 0) + now - last;
        phase = next;
        last = now;
      },
      onSafeResult: (safe) => {
        expect(safe.safetyCredential?.phase).toBe("final");
        measurements.safeResults++;
      },
    });
    const elapsed = performance.now() - started;
    console.info(
      "[performance] full checkpoint pipeline",
      JSON.stringify({ elapsedMs: Math.round(elapsed), ...measurements })
    );
    expect(result.assignments).toHaveLength(8);
    expect(result.unfilledCount).toBe(0);
    expect(result.safetyCredential?.phase).toBe("final");
    expect(measurements.safeResults).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(15_000);
  }, 90_000);
});
