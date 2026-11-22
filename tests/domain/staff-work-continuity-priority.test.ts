import { describe, expect, it } from "vitest";
import { priorityContinuityScenario } from "../helpers/priority-continuity-scenario";
import { CONTINUITY_DATE } from "../helpers/staff-work-continuity-scenario";
import { createScheduleRunFacts } from "../../src/domain/shared/schedule-run-facts";
import { createScheduleSafetySession } from "../../src/domain/kernel/schedule-safety-session";
import { reassignmentSafetyReasons } from "../../src/domain/reviews/rotation-review-safety";
import {
  improveStaffWorkContinuity,
  staffWorkContinuity,
} from "../../src/domain/reviews/staff-work-continuity";
import { positionFrequencyProfileForAssignment } from "../../src/domain/statistics/schedule-frequency";
import { defaultHighsSolver } from "../../src/infrastructure/solver/highs-solver";
import { generateSchedule } from "../helpers/generate-schedule";

async function concentrate(
  state = priorityContinuityScenario(),
  lockedAssignmentIds = new Set<string>()
) {
  const facts = createScheduleRunFacts(state, CONTINUITY_DATE);
  const session = createScheduleSafetySession({
    state,
    date: CONTINUITY_DATE,
    phase: "final",
    runFacts: facts,
    warningSink: [],
  });
  session.assertAssignmentsSafe(state.assignments);
  return improveStaffWorkContinuity({
    state,
    date: CONTINUITY_DATE,
    assignments: state.assignments,
    lockedAssignmentIds,
    solver: defaultHighsSolver,
    facts,
    assertSafe: (rows) => session.assertAssignmentsSafe(rows),
  });
}

describe("priority rotation before work continuity", () => {
  it.each([
    "staff-work-continuity-review",
    "staff-airline-mix-review",
    "flight-leader-coverage-review",
  ] as const)(
    "%s cannot move a priority slot to a higher-frequency worker",
    (kind) => {
      const state = priorityContinuityScenario();
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
        intent: { kind },
      });
      expect(reasons).toContain("调整会破坏重点岗位频率均衡");
    }
  );

  it("keeps an already rotated slot even when a worse-frequency exchange shortens attendance", async () => {
    const state = priorityContinuityScenario();
    const priority = state.assignments[3]!;
    expect(
      positionFrequencyProfileForAssignment(
        state,
        priority,
        "peer-a",
        CONTINUITY_DATE
      )
    ).toMatchObject({ currentMonthCount: 0 });
    expect(
      positionFrequencyProfileForAssignment(
        state,
        priority,
        "peer-b",
        CONTINUITY_DATE
      )
    ).toMatchObject({ currentMonthCount: 3 });
    const result = await concentrate(state);
    expect(result.find((a) => a.id === priority.id)!.staffId).toBe("peer-a");
    expect(result.every((a) => a.status === "assigned")).toBe(true);
    expect(result).toHaveLength(state.assignments.length);
    expect(state.assignments[3]!.staffId).toBe("peer-a");
  });

  it("also protects recent frequency when month totals are equal", async () => {
    const state = priorityContinuityScenario();
    const history = state.history[0]!;
    state.history.push(
      ...["2026-11-01", "2026-11-02", "2026-11-03"].map((date) => ({
        ...history,
        id: `${date}-peer-a`,
        date,
        staffId: "peer-a",
        staffName: "peer-a",
      })),
      ...["2026-11-04", "2026-11-05", "2026-11-07"].map((date) => ({
        ...history,
        id: `${date}-ordinary`,
        date,
        position: "G10",
        flightNo: "CX999",
      }))
    );
    const priority = state.assignments[3]!;
    const before = positionFrequencyProfileForAssignment(
      state,
      priority,
      "peer-a",
      CONTINUITY_DATE
    );
    const incoming = positionFrequencyProfileForAssignment(
      state,
      priority,
      "peer-b",
      CONTINUITY_DATE
    );
    expect(before.currentMonthCount).toBe(incoming.currentMonthCount);
    expect(before.recentWorkdayCount).toBeLessThan(incoming.recentWorkdayCount);
    expect(
      (await concentrate(state)).find((a) => a.id === priority.id)!.staffId
    ).toBe("peer-a");
  });

  it("keeps the split original when the remaining concentration option would undo rotation", async () => {
    const state = priorityContinuityScenario();
    const result = await concentrate(state, new Set(["row-0"]));
    expect(result).toEqual(state.assignments);
    expect(
      staffWorkContinuity(state, result, null).find(
        (p) => p.staffId === "peer-a"
      )!.split
    ).toBe(true);
  });

  it.each(["unlisted-position", "other-airline", "equal-frequency"] as const)(
    "still concentrates work for %s without expanding priority membership",
    async (variant) => {
      const state = priorityContinuityScenario();
      if (variant === "unlisted-position")
        state.settings.ordinaryPriorityPositions[0]!.position = "H02";
      if (variant === "other-airline")
        state.settings.ordinaryPriorityPositions[0]!.airlineCode = "CX";
      if (variant === "equal-frequency") state.history = [];
      const result = await concentrate(state);
      expect(
        staffWorkContinuity(state, result, null).some((p) => p.split)
      ).toBe(false);
      for (const person of state.staff) {
        expect(
          new Set(
            result.filter((a) => a.staffId === person.id).map((a) => a.flightNo)
          ).size
        ).toBe(2);
      }
    }
  );

  it("retains the priority result through complete schedule finalization", async () => {
    const state = priorityContinuityScenario();
    const result = await generateSchedule(
      { ...state, assignments: [] },
      CONTINUITY_DATE
    );
    expect(result.unfilledCount).toBe(0);
    expect(result.safetyCredential?.phase).toBe("final");
    expect(
      result.assignments.find((a) => a.positionRuleId === "rule-3")!.staffId
    ).toBe("peer-a");
  });
});
