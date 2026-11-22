import { expect, it, vi } from "vitest";
import {
  flightLeaderCoverage,
  flightLeaderWarnings,
} from "../../src/domain/rules/flight-leader-coverage";
import { improveFlightLeaderCoverage } from "../../src/domain/reviews/flight-leader-coverage";
import { createScheduleRunFacts } from "../../src/domain/shared/schedule-run-facts";
import { defaultHighsSolver } from "../../src/infrastructure/solver/highs-solver";
import { buildScheduleFeedback } from "../../src/domain/feedback/schedule-feedback";
import { BUILT_IN_RULE_REGISTRY } from "../../src/domain/rules/built-in-rule-registry";
import {
  flightLeaderScenario,
  LEADER_DATE,
} from "../helpers/flight-leader-scenario";
import { ScheduleGuardError } from "../../src/domain/kernel/schedule-guard";
import type { FinalScheduleReviewContext } from "../../src/domain/rules/rule-registry";

function context(state = flightLeaderScenario()): FinalScheduleReviewContext {
  return {
    state,
    date: LEADER_DATE,
    assignments: state.assignments,
    facts: createScheduleRunFacts(state, LEADER_DATE),
    solver: defaultHighsSolver,
    lockedAssignmentIds: new Set(),
    assertSafe: () => undefined,
  };
}

it("uses the real flight and unique assigned people, not role count or concurrent periods", () => {
  const state = flightLeaderScenario();
  state.assignments.push({ ...state.assignments[0]!, id: "reuse" });
  expect(flightLeaderCoverage(state).map((f) => f.actual)).toEqual([2, 0]);
  state.flights[1]!.startTime = "15:00";
  expect(flightLeaderWarnings(flightLeaderCoverage(state))).toEqual([
    expect.stringContaining("ZZ101无负责人"),
  ]);
  state.settings.minimumFlightLeaders = 2;
  state.staff[1]!.flightLeaderQualified = false;
  expect(
    flightLeaderWarnings(flightLeaderCoverage(state)).join("；")
  ).toContain("负责人不足");
});

it("does nothing when disabled, including no solver invocation", async () => {
  const state = flightLeaderScenario();
  state.settings.flightLeaderCoverageEnabled = false;
  const ctx = context(state),
    solve = vi.spyOn(ctx.solver, "solve");
  expect(flightLeaderCoverage(state)).toEqual([]);
  expect(await improveFlightLeaderCoverage(ctx)).toEqual(state.assignments);
  expect(solve).not.toHaveBeenCalled();
  solve.mockRestore();
});

it("uses the existing solver to spread qualified leaders with all original jobs intact", async () => {
  const state = flightLeaderScenario(),
    before = structuredClone(state.assignments);
  const result = await improveFlightLeaderCoverage(context(state));
  expect(flightLeaderCoverage(state, result).map((f) => f.actual)).toEqual([
    1, 1,
  ]);
  expect(state.assignments).toEqual(before);
  expect(
    result.map((a) => [a.id, a.positionRuleId, a.startTime, a.endTime])
  ).toEqual(
    before.map((a) => [a.id, a.positionRuleId, a.startTime, a.endTime])
  );
  for (const p of state.staff)
    expect(result.filter((a) => a.staffId === p.id)).toHaveLength(1);
});

it("respects a target of two and never transfers another flight's shortage", async () => {
  const state = flightLeaderScenario();
  state.settings.minimumFlightLeaders = 2;
  expect(await improveFlightLeaderCoverage(context(state))).toEqual(
    state.assignments
  );
  expect(flightLeaderWarnings(flightLeaderCoverage(state))).toHaveLength(1);
});

it.each(["qualification", "locked", "manual", "unavailable"])(
  "preserves %s and reports the remaining shortage",
  async (kind) => {
    const state = flightLeaderScenario(),
      ctx = context(state);
    if (kind === "qualification")
      state.positionRules
        .slice(2)
        .forEach((r) => (r.qualifiedStaffIds = ["worker-2", "worker-3"]));
    if (kind === "locked")
      ctx.lockedAssignmentIds = new Set(state.assignments.map((a) => a.id));
    if (kind === "manual")
      state.assignments.forEach((a) => (a.manualRemark = "人工保留"));
    if (kind === "unavailable")
      state.staff.slice(0, 2).forEach((p) => (p.status = "休假"));
    const result = await improveFlightLeaderCoverage(ctx);
    expect(result.map((a) => a.staffId)).toEqual(
      state.assignments.map((a) => a.staffId)
    );
    expect(
      flightLeaderWarnings(flightLeaderCoverage(state, result)).length
    ).toBeGreaterThan(0);
  }
);

it("keeps the original table when the final safety check rejects an otherwise improved plan", async () => {
  const ctx = context();
  ctx.assertSafe = () => {
    throw new ScheduleGuardError([
      { ruleId: "test-rejection", message: "测试拒绝换人" },
    ]);
  };
  const result = await improveFlightLeaderCoverage(ctx);
  expect(result.map((a) => a.staffId)).toEqual(
    ctx.assignments.map((a) => a.staffId)
  );
});

it("reports the final shortage again after later/manual rewriting and does not reject it", async () => {
  const state = flightLeaderScenario();
  state.assignments = await improveFlightLeaderCoverage(context(state));
  expect(
    buildScheduleFeedback(state, LEADER_DATE).find(
      (f) => f.key === "flight-leader-coverage"
    )?.level
  ).toBe("ok");
  state.assignments = flightLeaderScenario().assignments;
  const feedback = buildScheduleFeedback(state, LEADER_DATE).find(
    (f) => f.key === "flight-leader-coverage"
  )!;
  expect(feedback.level).toBe("attention");
  expect(feedback.evidence).toContain("ZZ101无负责人");
});

it("registers after all existing final reviews", () => {
  const ids = BUILT_IN_RULE_REGISTRY.executionPlan()
    .filter((h) => h.execute.some((e) => e.kind === "final-review"))
    .map((h) => h.id);
  expect(ids.slice(-4)).toEqual([
    "relaxed-shift-balance",
    "staff-work-continuity",
    "staff-airline-mix",
    "flight-leader-coverage",
  ]);
});

it("fills a target of two when safely possible without making new jobs", async () => {
  const state = flightLeaderScenario(2, 3, 4);
  state.settings.minimumFlightLeaders = 2;
  const result = await improveFlightLeaderCoverage(context(state));
  expect(flightLeaderCoverage(state, result).map((f) => f.actual)).toEqual([
    2, 2,
  ]);
  expect(result).toHaveLength(6);
});

it("handles six flights without moving the shortage between them", async () => {
  const state = flightLeaderScenario(6);
  const result = await improveFlightLeaderCoverage(context(state));
  expect(flightLeaderCoverage(state, result).map((f) => f.actual)).toEqual([
    1, 1, 1, 1, 1, 1,
  ]);
  expect(result).toHaveLength(12);
});

it("preserves each person's old workload even when workload balancing is disabled", async () => {
  const state = flightLeaderScenario();
  state.assignments.slice(0, 2).forEach((a) => (a.fatiguePoints = 3));
  state.positionRules.slice(0, 2).forEach((r) => (r.fatiguePoints = 3));
  expect(await improveFlightLeaderCoverage(context(state))).toEqual(
    state.assignments
  );
});

it("keeps the original complete table on a limited search timeout", async () => {
  const ctx = context();
  ctx.solver = {
    solve: async () => ({
      termination: "timed-out",
      selectedVariableIds: new Set<string>(),
      objectiveValues: new Map<string, number>(),
    }),
  };
  expect(await improveFlightLeaderCoverage(ctx)).toEqual(ctx.assignments);
});
