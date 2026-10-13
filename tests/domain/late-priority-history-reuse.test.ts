import { describe, expect, it } from "vitest";
import { createLatePriorityPressureState } from "../performance/fixtures/late-priority";
import { createScheduleFrequencyFacts } from "../../src/domain/statistics/schedule-frequency";
import {
  latePriorityFrequencyProfileForAssignment,
  latePriorityFrequencyProfileWithSchedule,
} from "../../src/domain/statistics/late-priority-frequency";

describe("run scoped late priority history", () => {
  it("keeps live schedules out of the history cache", () => {
    const { state, assignments, date } = createLatePriorityPressureState();
    const facts = createScheduleFrequencyFacts(state, date);
    const target = assignments[0]!;
    const historical = latePriorityFrequencyProfileForAssignment(
      state,
      "P0",
      target,
      date,
      facts
    );
    expect(historical.counts.supervisor.currentMonthCount).toBe(14);
    const current = latePriorityFrequencyProfileWithSchedule(
      state,
      "P0",
      target,
      assignments,
      date,
      facts
    );
    expect(current.counts.supervisor.currentMonthCount).toBe(15);
    const removed = assignments.filter((row) => row.id !== target.id);
    expect(
      latePriorityFrequencyProfileWithSchedule(
        state,
        "P0",
        target,
        removed,
        date,
        facts
      )
    ).toEqual(historical);
    expect(
      latePriorityFrequencyProfileForAssignment(
        state,
        "P0",
        target,
        date,
        facts
      )
    ).toEqual(historical);
  });
  it("recomputes corrections, scope, qualification and status for changed configuration", () => {
    const { state, assignments, date } = createLatePriorityPressureState();
    const facts = createScheduleFrequencyFacts(state, date);
    const target = assignments[0]!;
    const baseline = latePriorityFrequencyProfileForAssignment(
      state,
      "P0",
      target,
      date,
      facts
    );
    state.latePriorityFrequencyAdjustments.push({
      month: "2026-10",
      flightNo: "TR121",
      staffId: "P0",
      kind: "supervisor",
      delta: 3,
    });
    expect(
      latePriorityFrequencyProfileForAssignment(
        state,
        "P0",
        target,
        date,
        facts
      ).counts.supervisor.currentMonthCount
    ).toBe(baseline.counts.supervisor.currentMonthCount + 3);
    state.settings.latePriorityFlightNumbers = ["TR121"];
    expect(
      latePriorityFrequencyProfileForAssignment(
        state,
        "P0",
        target,
        date,
        facts
      )
    ).toEqual(
      latePriorityFrequencyProfileForAssignment(state, "P0", target, date)
    );
    state.staff[1]!.status = "休假";
    state.positionRules[0]!.qualifiedStaffIds = ["P0"];
    expect(
      latePriorityFrequencyProfileForAssignment(
        state,
        "P0",
        target,
        date,
        facts
      )
    ).toEqual(
      latePriorityFrequencyProfileForAssignment(state, "P0", target, date)
    );
  });
  it("never reuses history from an earlier run or date", () => {
    const { state, assignments, date } = createLatePriorityPressureState();
    const target = assignments[0]!;
    const before = latePriorityFrequencyProfileForAssignment(
      state,
      "P0",
      target,
      date,
      createScheduleFrequencyFacts(state, date)
    );
    state.history = [];
    const after = latePriorityFrequencyProfileForAssignment(
      state,
      "P0",
      target,
      date,
      createScheduleFrequencyFacts(state, date)
    );
    expect(before.totalCurrentMonthCount).toBeGreaterThan(0);
    expect(after.totalCurrentMonthCount).toBe(0);
    expect(
      latePriorityFrequencyProfileForAssignment(
        state,
        "P0",
        target,
        "2026-11-01",
        createScheduleFrequencyFacts(state, date)
      ).totalCurrentMonthCount
    ).toBe(0);
  });
});
