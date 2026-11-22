import { describe, expect, it } from "vitest";

import { createDefaultScheduleSettings } from "../../src/domain/rules/schedule-settings";
import { ACTIVE_SCHEDULING_RULES } from "../../src/domain/rules/schedule-rule-contract";
import {
  compileSchedulingPlan,
  dailyObjectiveIsBestEffort,
  dailyObjectiveRuleId,
  orderDailyObjectiveBuckets,
} from "../../src/domain/rules/scheduling-execution-plan";

describe("compiled scheduling execution plan", () => {
  it("uses the central contract order for every registered hook", () => {
    const plan = compileSchedulingPlan(createDefaultScheduleSettings());

    expect(plan.hooks.map((hook) => hook.id)).toEqual(
      ACTIVE_SCHEDULING_RULES.map((rule) => rule.id)
    );
  });

  it("projects candidates and post reviews without a second order list", () => {
    const plan = compileSchedulingPlan(createDefaultScheduleSettings());

    expect(plan.candidateRules.map((rule) => rule.id)).toEqual([
      "ke166-supervisor",
      "duty-position",
      "scarce-qualification",
      "position-transition",
      "tr121-h02-cooldown",
      "late-priority-aggregate-rotation",
      "late-priority-frequency",
      "position-frequency",
      "priority-position-consecutive",
      "late-shift-recovery",
      "late-shift-cutoff",
      "high-fatigue-position-consecutive",
      "preferred-position-transition",
      "staff-coverage",
      "daily-flight-count-balance",
      "rolling-load",
      "high-load-recovery",
      "cross-workday-load",
      "workload-balance",
      "historical-fatigue",
    ]);
    expect(plan.postScheduleMutations.map((item) => item.stage)).toEqual([
      "late-priority-frequency",
      "position-frequency",
      "late-shift-recovery",
      "late-shift-cutoff",
      "position-rotation",
      "mobile-supervisor-finalize",
      "post-mobile-supervisor-late-priority-frequency-validation",
      "post-mobile-supervisor-frequency-validation",
      "post-mobile-supervisor-rotation-validation",
    ]);
  });

  it("derives objective policy and feedback order from rule definitions", () => {
    const plan = compileSchedulingPlan(createDefaultScheduleSettings());

    expect(
      plan.candidateRules.find((rule) => rule.id === "scarce-qualification")
    ).toMatchObject({ deferAfterCoverage: true, optimization: "required" });
    expect(
      dailyObjectiveRuleId("candidate:workload-balance:today-fatigue-excess")
    ).toBe("workload-balance");
    expect(
      dailyObjectiveIsBestEffort(
        "candidate:workload-balance:today-fatigue-excess"
      )
    ).toBe(true);
    expect(dailyObjectiveIsBestEffort("candidate:position-frequency")).toBe(
      false
    );
    expect(plan.feedbackKeys).toEqual([
      "morning-priority",
      "cross-workday-qualification-reservation",
      "high-load",
      "cross-workday-load",
      "position-frequency-review",
      "position-rotation",
      "previous-late",
      "current-late",
      "duty-roster",
      "daily-flight-count-balance",
      "staff-work-continuity",
      "staff-airline-mix",
      "flight-leader-coverage",
    ]);
  });

  it("orders duty relief as rest, priority-position avoidance, then fatigue", () => {
    const plan = orderDailyObjectiveBuckets({
      ke166Capacity: [
        { id: "ke166-capacity", direction: "maximize", terms: [] },
      ],
      ke166Reservation: [{ id: "ke166", direction: "minimize", terms: [] }],
      duty: [{ id: "duty", direction: "maximize", terms: [] }],
      coverage: [{ id: "coverage", direction: "minimize", terms: [] }],
      crossWorkdayReservation: [],
      strictTransition: [{ id: "strict", direction: "minimize", terms: [] }],
      crossFlightPriority: [],
      protectedFairness: [
        {
          id: "candidate:late-priority-frequency",
          direction: "minimize",
          terms: [],
        },
      ],
      dutyRelief: [
        { id: "duty:between-target-rest", direction: "minimize", terms: [] },
        {
          id: "duty:avoid-additional-priority",
          direction: "minimize",
          terms: [],
        },
        {
          id: "duty:between-target-fatigue",
          direction: "minimize",
          terms: [],
        },
      ],
      recovery: [
        {
          id: "candidate:late-shift-cutoff",
          direction: "minimize",
          terms: [],
        },
      ],
      halfRest: [
        {
          id: "half-rest-morning:participation",
          direction: "maximize",
          terms: [],
        },
      ],
      remainingCandidate: [
        { id: "candidate:workload", direction: "minimize", terms: [] },
      ],
    });

    expect(plan.map((objective) => objective.id)).toEqual([
      "ke166-capacity",
      "ke166",
      "duty",
      "coverage",
      "strict",
      "candidate:late-priority-frequency",
      "duty:between-target-rest",
      "duty:avoid-additional-priority",
      "duty:between-target-fatigue",
      "candidate:late-shift-cutoff",
      "half-rest-morning:participation",
      "candidate:workload",
    ]);
  });
});
