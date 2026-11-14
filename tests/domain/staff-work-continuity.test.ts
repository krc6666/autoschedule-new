import { describe, expect, it, vi } from "vitest";
import {
  BUILT_IN_RULE_REGISTRY,
  builtInRulePreferences,
} from "../../src/domain/rules/built-in-rule-registry";
import { createScheduleRunFacts } from "../../src/domain/shared/schedule-run-facts";
import { defaultHighsSolver } from "../../src/infrastructure/solver/highs-solver";
import {
  continuityScenario,
  CONTINUITY_DATE,
} from "../helpers/staff-work-continuity-scenario";
import type { Assignment } from "../../src/model";
import {
  staffWorkContinuity,
  improvesStaffWorkContinuity,
  improveStaffWorkContinuity,
} from "../../src/domain/reviews/staff-work-continuity";
import { buildScheduleFeedback } from "../../src/domain/feedback/schedule-feedback";
import { ScheduleGuardError } from "../../src/domain/kernel/schedule-guard";
import { generateSchedule } from "../helpers/generate-schedule";
import { preservesRelaxedShiftBalance } from "../../src/domain/reviews/relaxed-shift-balance";
import { reassignmentSafetyReasons } from "../../src/domain/reviews/rotation-review-safety";
import { optimizeReassignment } from "../../src/domain/solver/reassignment-optimizer";

async function finalContinuity(
  state = continuityScenario(),
  lockedAssignmentIds = new Set<string>()
) {
  const executor = BUILT_IN_RULE_REGISTRY.definition(
    "staff-work-continuity"
  )?.execute.find((e) => e.kind === "final-review");
  return executor?.kind === "final-review"
    ? await executor.execute({
        state,
        date: CONTINUITY_DATE,
        assignments: state.assignments,
        lockedAssignmentIds,
        solver: defaultHighsSolver,
        facts: createScheduleRunFacts(state, CONTINUITY_DATE),
        assertSafe: () => undefined,
      })
    : state.assignments;
}

function span(rows: readonly Assignment[], id: string) {
  const own = rows.filter((a) => a.staffId === id);
  const minutes = (s: string) =>
    Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  return (
    Math.max(...own.map((a) => minutes(a.endTime))) -
    Math.min(...own.map((a) => minutes(a.startTime)))
  );
}

describe("ordinary staff work continuity", () => {
  it("does not mistake touching morning and last-flight tasks for an idle gap", () => {
    const state = continuityScenario();
    state.flights[3]!.startTime = "12:00";
    state.flights[3]!.endTime = "13:00";
    state.assignments[0]!.endTime = "12:00";
    state.assignments[3]!.startTime = "12:00";
    state.assignments[3]!.endTime = "13:00";
    // The late task is the last *scheduled* flight for this scenario.
    state.flights = state.flights.filter((f) =>
      ["flight-0", "flight-3"].includes(f.id)
    );
    state.assignments = state.assignments.filter((a) => a.staffId === "peer-a");
    expect(
      staffWorkContinuity(state, state.assignments, null)[0]
    ).toMatchObject({ split: false, maximumGapMinutes: 0 });
  });
  it("does not trade better attendance for another worker's consecutive heavy position", () => {
    const state = continuityScenario();
    state.positionRules[3]!.fatiguePoints = 5;
    state.assignments[3]!.fatiguePoints = 5;
    state.history = ["2026-11-10", "2026-11-12"].map((date, i) => ({
      ...state.assignments[3]!,
      id: `history-${i}`,
      date,
      staffId: "peer-b",
      staffName: "peer-b",
    }));
    const reasons = reassignmentSafetyReasons({
      kind: "plan",
      state,
      assignments: state.assignments,
      date: CONTINUITY_DATE,
      primaryAssignmentId: "row-3",
      changes: [
        { assignmentId: "row-3", staffId: "peer-b" },
        { assignmentId: "row-2", staffId: "peer-a" },
      ],
      facts: createScheduleRunFacts(state, CONTINUITY_DATE),
      intent: { kind: "staff-work-continuity-review" },
    });
    expect(reasons).toContain("交换会把连续轮岗问题转移给其他人员");
  });
  it("shortens an isolated morning/last shift without adding flights or transferring the split", async () => {
    const state = continuityScenario();
    const result = await finalContinuity(state);
    expect(span(result, "peer-a")).toBeLessThan(15 * 60);
    expect(
      Math.max(...state.staff.map((p) => span(result, p.id)))
    ).toBeLessThan(15 * 60);
    for (const p of state.staff)
      expect(
        new Set(result.filter((a) => a.staffId === p.id).map((a) => a.flightNo))
          .size
      ).toBe(2);
    expect(state.assignments[3]!.staffId).toBe("peer-a");
    expect(result.every((a) => a.status === "assigned")).toBe(true);
  });
  it("runs after monthly rest balancing, so later finalization cannot undo it", () => {
    const ids = BUILT_IN_RULE_REGISTRY.executionPlan(
      builtInRulePreferences(continuityScenario().settings)
    )
      .filter((h) => h.execute.some((e) => e.kind === "final-review"))
      .map((h) => h.id);
    expect(ids.slice(-2)).toEqual([
      "staff-work-continuity",
      "staff-airline-mix",
    ]);
  });
  it("retains locked assignments when no safe improvement exists", async () => {
    const state = continuityScenario();
    expect(
      await finalContinuity(state, new Set(state.assignments.map((a) => a.id)))
    ).toEqual(state.assignments);
  });
  it("still concentrates work with both monthly rest switches enabled", async () => {
    const state = continuityScenario();
    state.settings.earlyDepartureBalanceEnabled = true;
    state.settings.afternoonRestBalanceEnabled = true;
    expect(span(await finalContinuity(state), "peer-a")).toBeLessThan(900);
  });
  it("only yields the improved target's idle-afternoon opportunity, retaining other rest budgets", async () => {
    const state = continuityScenario();
    const compact = await finalContinuity(state);
    state.settings.earlyDepartureBalanceEnabled = true;
    state.settings.afternoonRestBalanceEnabled = true;
    expect(
      preservesRelaxedShiftBalance(
        state,
        CONTINUITY_DATE,
        state.assignments,
        compact
      )
    ).toBe(false);
    expect(
      preservesRelaxedShiftBalance(
        state,
        CONTINUITY_DATE,
        state.assignments,
        compact,
        new Set(["peer-a"])
      )
    ).toBe(true);
    expect(
      preservesRelaxedShiftBalance(
        state,
        CONTINUITY_DATE,
        state.assignments,
        compact,
        new Set(["peer-b"])
      )
    ).toBe(false);
  });
  it("works on six flights and a larger staff list without skipping final review", async () => {
    const state = continuityScenario();
    const base = structuredClone(state);
    for (let group = 1; group < 6; group++) {
      const suffix = `-${group}`;
      state.staff.push(
        ...base.staff.map((p) => ({
          ...p,
          id: p.id + suffix,
          name: p.name + suffix,
        }))
      );
      state.positionRules.push(
        ...base.positionRules.map((r) => ({
          ...r,
          id: r.id + suffix,
          qualifiedStaffIds: r.qualifiedStaffIds.map((id) => id + suffix),
        }))
      );
      state.assignments.push(
        ...base.assignments.map((a) => ({
          ...a,
          id: a.id + suffix,
          positionRuleId: a.positionRuleId + suffix,
          staffId: a.staffId + suffix,
          staffName: a.staffName + suffix,
        }))
      );
    }
    state.flights.push(
      { ...state.flights[1]!, id: "extra1", flightNo: "EXTRA1" },
      { ...state.flights[2]!, id: "extra2", flightNo: "EXTRA2" }
    );
    const result = await finalContinuity(state);
    expect(
      staffWorkContinuity(state, result, null).filter((p) => p.split)
    ).toHaveLength(0);
    expect(result).toHaveLength(24);
    expect(result.every((a) => a.status === "assigned")).toBe(true);
  });
  it("exempts the selected duty worker while still inspecting ordinary staff", async () => {
    const state = continuityScenario();
    state.staff[0]!.dutyQualified = true;
    state.dutyRosterOverrides = [
      {
        date: CONTINUITY_DATE,
        dutyStaffId: "peer-a",
        cxPreflightStaffId: null,
        standbyStaffIds: [null, null],
      },
    ];
    expect(
      staffWorkContinuity(state, state.assignments, "peer-a").some(
        (p) => p.split
      )
    ).toBe(false);
    expect(await finalContinuity(state)).toEqual(state.assignments);
  });
  it("merges overlapping and zero-hour reused attendance without counting another flight", () => {
    const state = continuityScenario();
    state.assignments.push({
      ...state.assignments[0]!,
      id: "reuse",
      startTime: "09:00",
      endTime: "10:30",
      workHours: 0,
    });
    const person = staffWorkContinuity(state, state.assignments, null).find(
      (p) => p.staffId === "peer-a"
    )!;
    expect(person).toMatchObject({
      split: true,
      flightCount: 2,
      spanMinutes: 900,
      maximumGapMinutes: 570,
    });
  });
  it("uses actual attendance, not the flight template, for a late-ending morning assignment", () => {
    const state = continuityScenario();
    state.assignments[0]!.endTime = "13:00";
    expect(staffWorkContinuity(state, state.assignments, null)[0]!.split).toBe(
      false
    );
  });
  it("links the existing morning window rather than a fixed noon constant", () => {
    const state = continuityScenario();
    state.settings.morningStatsEndTime = "09:30";
    expect(staffWorkContinuity(state, state.assignments, null)[0]!.split).toBe(
      false
    );
    state.settings.morningStatsEndTime = "11:00";
    expect(staffWorkContinuity(state, state.assignments, null)[0]!.split).toBe(
      true
    );
  });
  it.each([
    ["20:00", "01:00", 1020, 600],
    ["00:10", "02:00", 1080, 850],
  ])(
    "normalizes last-flight attendance %s—%s across midnight",
    (start, end, daySpan, gap) => {
      const state = continuityScenario();
      state.flights[3]!.startTime = start;
      state.flights[3]!.endTime = end;
      state.assignments[3]!.startTime = start;
      state.assignments[3]!.endTime = end;
      expect(
        staffWorkContinuity(state, state.assignments, null)[0]
      ).toMatchObject({
        split: true,
        spanMinutes: daySpan,
        maximumGapMinutes: gap,
      });
    }
  );
  it("does not treat adding a middle flight as a comfort improvement", () => {
    const state = continuityScenario();
    const after = structuredClone(state.assignments);
    after[1]!.staffId = "peer-a";
    expect(
      improvesStaffWorkContinuity(
        staffWorkContinuity(state, state.assignments, null),
        staffWorkContinuity(state, after, null),
        "peer-a"
      )
    ).toBe(false);
  });
  it("rejects transferring the same early/last split to another worker", () => {
    const state = continuityScenario();
    const after = state.assignments.map((a) => ({
      ...a,
      staffId: a.staffId === "peer-a" ? "peer-b" : "peer-a",
    }));
    expect(
      improvesStaffWorkContinuity(
        staffWorkContinuity(state, state.assignments, null),
        staffWorkContinuity(state, after, null),
        "peer-a"
      )
    ).toBe(false);
  });
  it("keeps the legal original when qualification leaves no complete safe exchange", async () => {
    const state = continuityScenario();
    for (const r of state.positionRules)
      r.qualifiedStaffIds = [
        state.assignments.find((a) => a.positionRuleId === r.id)!.staffId!,
      ];
    expect(await finalContinuity(state)).toEqual(state.assignments);
    const feedback = buildScheduleFeedback(state, CONTINUITY_DATE).find(
      (f) => f.key === "staff-work-continuity"
    )!;
    expect(feedback.level).toBe("attention");
    expect(feedback.evidence).toContain("600分钟");
    expect(feedback.evidence).toContain("不代表已证明无解");
  });
  it("returns the original on solver timeout without submitting partial work", async () => {
    const state = continuityScenario();
    const solve = vi.fn(async () => ({
      termination: "timed-out" as const,
      selectedVariableIds: new Set<string>(),
      objectiveValues: new Map<string, number>(),
    }));
    const result = await improveStaffWorkContinuity({
      state,
      date: CONTINUITY_DATE,
      assignments: state.assignments,
      lockedAssignmentIds: new Set(),
      solver: { solve },
      facts: createScheduleRunFacts(state, CONTINUITY_DATE),
      assertSafe: () => undefined,
    });
    expect(result).toEqual(state.assignments);
    expect(solve.mock.calls.length).toBeLessThanOrEqual(2);
  });
  it("never installs a proposal rejected by the final safety guard", async () => {
    const state = continuityScenario();
    const assertSafe = vi.fn(() => {
      throw new ScheduleGuardError([]);
    });
    const result = await improveStaffWorkContinuity({
      state,
      date: CONTINUITY_DATE,
      assignments: state.assignments,
      lockedAssignmentIds: new Set(),
      solver: defaultHighsSolver,
      facts: createScheduleRunFacts(state, CONTINUITY_DATE),
      assertSafe,
    });
    expect(result).toEqual(state.assignments);
    expect(assertSafe).toHaveBeenCalled();
  });
  it("rechecks a previously concentrated result after a later flow recreates the split", async () => {
    const state = continuityScenario();
    const concentrated = await finalContinuity(state);
    expect(span(concentrated, "peer-a")).toBeLessThan(900);
    const primary = concentrated.find((a) => a.id === "row-3")!;
    const exchange = concentrated.find(
      (a) => a.staffId === "peer-a" && a.id !== "row-0"
    )!;
    const later = await optimizeReassignment({
      solver: defaultHighsSolver,
      state,
      assignments: concentrated,
      primary,
      movableAssignments: [exchange],
      date: CONTINUITY_DATE,
      facts: createScheduleRunFacts(state, CONTINUITY_DATE),
      intent: { kind: "late-shift-recovery-review" },
      primaryCandidateAllowed: (p) => p.id === "peer-a",
      preserveStaffAssignmentCounts: true,
    });
    expect(later.changes).not.toBeNull();
    const laterRewritten = concentrated.map((a) => ({
      ...a,
      staffId:
        later.changes!.find((c) => c.assignmentId === a.id)?.staffId ??
        a.staffId,
    }));
    expect(span(laterRewritten, "peer-a")).toBe(900);
    const result = await finalContinuity({
      ...state,
      assignments: laterRewritten,
    });
    expect(span(result, "peer-a")).toBeLessThan(900);
    expect(result).toEqual(concentrated);
  });
  it("applies to complete generated schedules and keeps their final safety credential", async () => {
    const state = continuityScenario();
    const result = await generateSchedule(
      { ...state, assignments: [] },
      CONTINUITY_DATE
    );
    expect(result.unfilledCount).toBe(0);
    expect(result.safetyCredential).toBeDefined();
    expect(
      staffWorkContinuity(state, result.assignments, null).some((p) => p.split)
    ).toBe(false);
    expect(
      Math.max(...state.staff.map((p) => span(result.assignments, p.id)))
    ).toBeLessThan(900);
    console.info(
      "CONTINUITY_FINAL",
      JSON.stringify(
        result.assignments.map((a) => ({
          flight: a.flightNo,
          staff: a.staffId,
          start: a.startTime,
          end: a.endTime,
        }))
      )
    );
  });
});
