import { describe, expect, it } from "vitest";

import { createDefaultState } from "../../src/defaults";
import type { AppState, Assignment } from "../../src/model";
import { reviewLateShiftCutoff } from "../../src/domain/reviews/late-shift-cutoff-review";
import { defaultHighsSolver } from "../../src/infrastructure/solver/highs-solver";

function cutoffState(): AppState {
  const state = createDefaultState();
  // Isolate cutoff protection from this one-job-per-flight fixture's repeated first jobs.
  state.settings.dailyPrimaryPositionUniqueEnabled = false;
  const [protectedWorker, alternate] = state.staff
    .filter((person) => person.status === "正常")
    .slice(0, 2);
  state.staff = [protectedWorker!, alternate!];
  state.staff.forEach((person) => {
    person.dutyQualified = false;
  });
  state.flights = [
    {
      id: "early",
      flightNo: "EARLY100",
      startTime: "08:00",
      endTime: "10:00",
      bookedPassengers: 100,
      positions: [],
      remark: "",
    },
    {
      id: "afternoon",
      flightNo: "DAY200",
      startTime: "13:00",
      endTime: "15:00",
      bookedPassengers: 100,
      positions: [],
      remark: "",
    },
    {
      id: "evening",
      flightNo: "NIGHT300",
      startTime: "20:00",
      endTime: "22:00",
      bookedPassengers: 100,
      positions: [],
      remark: "",
    },
  ];
  const base = state.positionRules[0]!;
  const qualifiedStaffIds = state.staff.map((person) => person.id);
  state.positionRules = state.flights.map((flight, index) => ({
    ...base,
    id: `rule-${index}`,
    flightNo: flight.flightNo,
    name: `P${index}`,
    category: "常规" as const,
    remark: "",
    fatiguePoints: 1,
    qualifiedStaffIds,
  }));
  state.settings.lateShiftRecoveryPositionRules.find(
    (rule) => rule.keyword === "一号"
  )!.nextWorkdayCutoffTime = "12:00";
  state.settings.highLoadProtectionEnabled = false;
  state.settings.rollingLoadProtectionEnabled = false;
  state.settings.positionRotationEnabled = false;
  state.history = [
    {
      id: "protected-late",
      date: "2026-08-21",
      flightNo: "TR121",
      position: "H02",
      staffId: protectedWorker!.id,
      staffName: protectedWorker!.name,
      startTime: "21:55",
      endTime: "23:55",
      workHours: 2,
      fatiguePoints: 1,
      remark: "一号",
    },
  ];
  return state;
}

function assignment(
  state: AppState,
  id: string,
  flightIndex: number,
  staffIndex: number,
  fatiguePoints = 1
): Assignment {
  const flight = state.flights[flightIndex]!;
  const rule = state.positionRules[flightIndex]!;
  const staff = state.staff[staffIndex]!;
  return {
    id,
    flightId: flight.id,
    flightNo: flight.flightNo,
    positionRuleId: rule.id,
    position: rule.name,
    staffId: staff.id,
    staffName: staff.name,
    startTime: flight.startTime,
    endTime: flight.endTime,
    workHours: 2,
    fatiguePoints,
    remark: rule.remark,
    manualRemark: "",
    status: "assigned",
  };
}

describe("late-shift next-workday cutoff review", () => {
  it("directly reassigns a late flight when that makes the protected worker leave earlier without worsening load spread", async () => {
    const state = cutoffState();
    const assignments = [
      assignment(state, "early", 0, 0),
      assignment(state, "afternoon", 1, 1),
      assignment(state, "evening", 2, 0),
    ];

    await expect(
      reviewLateShiftCutoff(
        defaultHighsSolver,
        state,
        assignments,
        "2026-08-23",
        new Set()
      )
    ).resolves.toEqual([]);
    expect(assignments.find((item) => item.id === "evening")?.staffId).toBe(
      state.staff[1]!.id
    );
    expect(
      assignments.find((item) => item.id === "evening")?.decisionTrace
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "late-shift-cutoff",
          outcome: "selected",
        }),
      ])
    );
  });

  it("gives the earlier safe departure to the protected worker even when ordinary fatigue favors the alternate", async () => {
    const state = cutoffState();
    const assignments = [
      assignment(state, "early", 0, 0, 0),
      assignment(state, "afternoon", 1, 1, 10),
      assignment(state, "evening", 2, 0, 10),
    ];

    const warnings = await reviewLateShiftCutoff(
      defaultHighsSolver,
      state,
      assignments,
      "2026-08-23",
      new Set()
    );

    expect(warnings).toEqual([]);
    expect(assignments.find((item) => item.id === "evening")?.staffId).toBe(
      state.staff[1]!.id
    );
  });

  it("keeps the original complete schedule when the only alternate is locked", async () => {
    const state = cutoffState();
    const assignments = [
      assignment(state, "early", 0, 0),
      assignment(state, "afternoon", 1, 1),
      assignment(state, "evening", 2, 0),
    ];
    const warnings = await reviewLateShiftCutoff(
      defaultHighsSolver,
      state,
      assignments,
      "2026-08-23",
      new Set(["afternoon", "early"])
    );
    expect(assignments.every((item) => item.staffId)).toBe(true);
    expect(assignments.find((item) => item.id === "evening")?.staffId).not.toBe(
      undefined
    );
    expect(warnings).toEqual([]);
  });

  it("keeps strict next-workday targets ahead of cutoff preference", async () => {
    const state = cutoffState();
    state.settings.nextWorkdayRecoveryMode = "forbid";
    state.settings.nextWorkdayRecoveryTargets = [
      {
        id: "strict-target",
        enabled: true,
        flightNo: "NIGHT300",
        positionKeyword: "P2",
      },
    ];
    const assignments = [
      assignment(state, "early", 0, 0),
      assignment(state, "afternoon", 1, 1),
      assignment(state, "evening", 2, 0),
    ];
    await reviewLateShiftCutoff(
      defaultHighsSolver,
      state,
      assignments,
      "2026-08-23",
      new Set()
    );
    expect(assignments.find((item) => item.id === "evening")?.staffId).toBe(
      state.staff[1]!.id
    );
    expect(assignments.find((item) => item.id === "evening")?.staffId).not.toBe(
      state.staff[0]!.id
    );
  });
});
