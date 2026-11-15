import { describe, expect, it } from "vitest";

import type { CandidatePriority } from "../../src/domain/candidates/candidate-priority";
import {
  compareCandidateRulePlan,
  createCandidateRulePlan,
  firstDifferentCandidateRulePlan,
} from "../../src/domain/rules/candidate-rule-plan";
import { createDefaultScheduleSettings } from "../../src/domain/rules/schedule-settings";
import type { AssignmentTask } from "../../src/domain/flights/schedule-tasks";
import type { Staff } from "../../src/model";
import {
  SCHEDULING_RULES,
  SCHEDULING_STAGE_ORDER,
} from "../../src/domain/rules/schedule-rule-contract";
import { compileSchedulingPlan } from "../../src/domain/rules/scheduling-execution-plan";
import {
  isHighFatigueOrdinaryRotationPosition,
  isPriorityRotationPosition,
} from "../../src/domain/reviews/position-rotation-policy";
import { ROTATION_REVIEW_POLICIES } from "../../src/domain/reviews/reassignment-safety-policy";

const comparisonPlan = createCandidateRulePlan(createDefaultScheduleSettings());
const candidatePriorityOrder = comparisonPlan.map((rule) => rule.id);
const ruleFeedbackOrder = compileSchedulingPlan(
  createDefaultScheduleSettings()
).feedbackKeys;
const comparisonTask = {} as AssignmentTask;
const leftStaff = { id: "left" } as Staff;
const rightStaff = { id: "right" } as Staff;

function compareCandidatePriority(
  left: CandidatePriority,
  right: CandidatePriority
): number {
  return compareCandidateRulePlan(
    comparisonPlan,
    comparisonTask,
    leftStaff,
    left,
    rightStaff,
    right
  );
}

function firstDifferentCandidateRule(
  left: CandidatePriority,
  right: CandidatePriority
): string | null {
  return (
    firstDifferentCandidateRulePlan(
      comparisonPlan,
      comparisonTask,
      leftStaff,
      left,
      rightStaff,
      right
    )?.id ?? null
  );
}

function priority(
  overrides: Partial<CandidatePriority> = {}
): CandidatePriority {
  return {
    ke166ReservationConflict: false,
    dutyPosition: "unrelated",
    strictTransitionViolations: 0,
    preferredTransitionViolations: 0,
    scarceQualification: { futureTaskCount: 0, minimumEligibleStaff: null },
    alreadyAssignedToday: false,
    lateShiftRecovery: {
      protectedMorningTarget: false,
      protectedLatePriorityTarget: false,
    },
    lateShiftCutoff: {
      disposition: "unprotected",
      cutoffMinutes: null,
      previousEndMinutes: null,
    },
    repeatedPriorityPosition: false,
    repeatedHighFatiguePosition: false,
    rollingLoadExcess: 0,
    highLoadRecoveryConflict: false,
    tr121H02Cooldown: {
      applies: false,
      inCooldown: false,
      remainingWorkdays: 0,
      lastAssignedDate: null,
    },
    latePriorityFrequency: {
      applies: false,
      targetKinds: [],
      previousWorkdayAssigned: false,
      supervisorQualified: false,
      supervisorRotationDeficit: 0,
      categoryBoundaryExcess: {
        supervisor: 0,
        "number-one": 0,
        declaration: 0,
        delivery: 0,
      },
      counts: {
        supervisor: { currentMonthCount: 0, recentWorkdayCount: 0 },
        "number-one": { currentMonthCount: 0, recentWorkdayCount: 0 },
        declaration: { currentMonthCount: 0, recentWorkdayCount: 0 },
        delivery: { currentMonthCount: 0, recentWorkdayCount: 0 },
      },
      totalCurrentMonthCount: 0,
      totalRecentWorkdayCount: 0,
    },
    previousWorkdayLoad: {
      fatiguePoints: 0,
      latestEndMinutes: 0,
      workHours: 0,
      priorityPositionCount: 0,
    },
    positionFrequency: { currentMonthCount: 0, recentWorkdayCount: 0 },
    workloadBalance: {
      violatesConfiguredTarget: false,
      todayHoursExcess: 0,
      rollingHoursExcess: 0,
      todayFatigueExcess: 0,
      todayHoursSpread: 0,
      rollingHoursSpread: 0,
      recentFatigueSpread: 0,
      todayFatigueSpread: 0,
    },
    historicalFatigue: 0,
    ...overrides,
  };
}

describe("scheduling policy contract", () => {
  it("classifies only configured regular priority positions for frequency balancing", () => {
    for (const keyword of ["一号", "申报", "督导", "控制", "送资料"]) {
      expect(
        isPriorityRotationPosition({
          category: "常规",
          name: "G20",
          remark: keyword,
        })
      ).toBe(true);
    }
    expect(
      isPriorityRotationPosition({ category: "常规", name: "G15", remark: "" })
    ).toBe(false);
    expect(
      isPriorityRotationPosition({
        category: "机动督导",
        name: "督导",
        remark: "",
      })
    ).toBe(false);
    expect(
      isPriorityRotationPosition({
        category: "行政支援",
        name: "督导",
        remark: "",
      })
    ).toBe(false);
  });

  it("classifies high-fatigue ordinary positions from the configured threshold", () => {
    expect(
      isHighFatigueOrdinaryRotationPosition(
        { category: "常规", name: "H03", remark: "", fatiguePoints: 6 },
        4
      )
    ).toBe(true);
    expect(
      isHighFatigueOrdinaryRotationPosition(
        { category: "常规", name: "H07", remark: "", fatiguePoints: 2 },
        4
      )
    ).toBe(false);
    expect(
      isHighFatigueOrdinaryRotationPosition(
        {
          category: "常规",
          flightNo: "TR121",
          name: "H02",
          remark: "一号",
          fatiguePoints: 10,
        },
        4,
        [{ airlineCode: "TR", position: "H02" }]
      )
    ).toBe(false);
    expect(
      isHighFatigueOrdinaryRotationPosition(
        { category: "引导", name: "柜台引导", remark: "", fatiguePoints: 6 },
        4
      )
    ).toBe(false);
  });

  it("keeps reserved assignments ahead of protection and fairness rules", () => {
    expect(
      SCHEDULING_RULES.find((rule) => rule.id === "mobile-supervisor")
    ).toMatchObject({
      stage: "reserved-assignment",
      label: "机动督导独立优先、缺员兼任与配置补位",
    });
    expect(candidatePriorityOrder.indexOf("ke166-supervisor")).toBeLessThan(
      candidatePriorityOrder.indexOf("duty-position")
    );
    expect(
      SCHEDULING_RULES.find((rule) => rule.id === "ke166-supervisor")
    ).toMatchObject({
      stage: "reserved-assignment",
      label: "KE166第二真人容量与专项保护",
    });
    expect(candidatePriorityOrder.slice(3, 9)).toEqual([
      "position-transition",
      "tr121-h02-cooldown",
      "late-priority-aggregate-rotation",
      "late-priority-frequency",
      "position-frequency",
      "priority-position-consecutive",
    ]);
    for (const softRule of [
      "late-shift-recovery",
      "late-shift-cutoff",
      "preferred-position-transition",
      "staff-coverage",
      "rolling-load",
      "high-load-recovery",
      "cross-workday-load",
      "workload-balance",
    ] as const) {
      expect(candidatePriorityOrder.indexOf("position-frequency")).toBeLessThan(
        candidatePriorityOrder.indexOf(softRule)
      );
    }
  });

  it("leaves before-cutoff access to the whole-day model and prefers an unprotected worker after the cutoff", () => {
    const beforeCutoff = priority({
      lateShiftCutoff: {
        disposition: "before-cutoff",
        cutoffMinutes: 900,
        previousEndMinutes: 1435,
      },
    });
    const afterCutoff = priority({
      lateShiftCutoff: {
        disposition: "after-cutoff",
        cutoffMinutes: 900,
        previousEndMinutes: 1435,
      },
    });
    const unprotected = priority();

    expect(compareCandidatePriority(beforeCutoff, unprotected)).toBe(0);
    expect(compareCandidatePriority(afterCutoff, unprotected)).toBeGreaterThan(
      0
    );
    expect(firstDifferentCandidateRule(beforeCutoff, unprotected)).toBeNull();
    expect(firstDifferentCandidateRule(afterCutoff, unprotected)).toBe(
      "late-shift-cutoff"
    );
  });

  it("finishes the lower-frequency round before considering consecutive repetition", () => {
    const repeated = priority({
      repeatedPriorityPosition: true,
      alreadyAssignedToday: false,
      positionFrequency: { currentMonthCount: 0, recentWorkdayCount: 0 },
    });
    const alternate = priority({
      repeatedPriorityPosition: false,
      alreadyAssignedToday: true,
      positionFrequency: { currentMonthCount: 5, recentWorkdayCount: 5 },
    });

    expect(compareCandidatePriority(repeated, alternate)).toBeLessThan(0);
    expect(firstDifferentCandidateRule(repeated, alternate)).toBe(
      "position-frequency"
    );
  });

  it("prevents a repeated high-fatigue ordinary position before workload balancing", () => {
    const repeated = priority({
      repeatedHighFatiguePosition: true,
      workloadBalance: {
        violatesConfiguredTarget: false,
        todayHoursExcess: 0,
        rollingHoursExcess: 0,
        todayFatigueExcess: 0,
        todayHoursSpread: 0,
        rollingHoursSpread: 0,
        recentFatigueSpread: 0,
        todayFatigueSpread: 0,
      },
    });
    const alternate = priority({
      repeatedHighFatiguePosition: false,
      workloadBalance: {
        violatesConfiguredTarget: true,
        todayHoursExcess: 10,
        rollingHoursExcess: 10,
        todayFatigueExcess: 10,
        todayHoursSpread: 10,
        rollingHoursSpread: 10,
        recentFatigueSpread: 10,
        todayFatigueSpread: 10,
      },
    });

    expect(compareCandidatePriority(repeated, alternate)).toBeGreaterThan(0);
    expect(firstDifferentCandidateRule(repeated, alternate)).toBe(
      "high-fatigue-position-consecutive"
    );
  });

  it("defers before-cutoff ordering between protected workers to the whole-day model", () => {
    const earlierCutoff = priority({
      lateShiftCutoff: {
        disposition: "before-cutoff",
        cutoffMinutes: 840,
        previousEndMinutes: 1410,
      },
    });
    const laterCutoff = priority({
      lateShiftCutoff: {
        disposition: "before-cutoff",
        cutoffMinutes: 960,
        previousEndMinutes: 1440,
      },
    });
    const laterPreviousFinish = priority({
      lateShiftCutoff: {
        disposition: "before-cutoff",
        cutoffMinutes: 840,
        previousEndMinutes: 1450,
      },
    });

    expect(compareCandidatePriority(earlierCutoff, laterCutoff)).toBe(0);
    expect(compareCandidatePriority(laterPreviousFinish, earlierCutoff)).toBe(
      0
    );
  });

  it("registers every candidate priority exactly once", () => {
    const registered = SCHEDULING_RULES.map((rule) => rule.id);
    expect(new Set(registered).size).toBe(registered.length);
    expect(
      candidatePriorityOrder.every((ruleId) => registered.includes(ruleId))
    ).toBe(true);
  });

  it("declares how every rule participates in feedback", () => {
    expect(
      SCHEDULING_RULES.every((rule) =>
        ["dedicated", "aggregated", "decision-only"].includes(rule.feedbackMode)
      )
    ).toBe(true);
    const dedicatedKeys = SCHEDULING_RULES.flatMap((rule) =>
      rule.feedbackMode === "dedicated" ? [rule.feedbackKey] : []
    );
    expect(new Set(ruleFeedbackOrder)).toEqual(new Set(dedicatedKeys));
  });

  it("keeps every candidate rule inside the declared stage sequence", () => {
    const stageByRule = new Map(
      SCHEDULING_RULES.map((rule) => [rule.id, rule.stage])
    );
    const stageIndexes = candidatePriorityOrder.map((ruleId) =>
      SCHEDULING_STAGE_ORDER.indexOf(stageByRule.get(ruleId)!)
    );
    expect(stageIndexes).toEqual(
      [...stageIndexes].sort((left, right) => left - right)
    );
  });

  it("compares strict and preferred transition violations in explicit sequence", () => {
    const strictViolation = priority({ strictTransitionViolations: 1 });
    const preferredViolations = priority({ preferredTransitionViolations: 20 });

    expect(
      compareCandidatePriority(strictViolation, preferredViolations)
    ).toBeGreaterThan(0);
    expect(
      firstDifferentCandidateRule(strictViolation, preferredViolations)
    ).toBe("position-transition");
    expect(firstDifferentCandidateRule(priority(), preferredViolations)).toBe(
      "preferred-position-transition"
    );
  });

  it("prefers a lower same-position frequency before workload balancing", () => {
    const frequent = priority({
      positionFrequency: { currentMonthCount: 4, recentWorkdayCount: 1 },
      workloadBalance: { ...priority().workloadBalance, todayHoursExcess: 0 },
    });
    const lessFrequent = priority({
      positionFrequency: { currentMonthCount: 1, recentWorkdayCount: 4 },
      workloadBalance: { ...priority().workloadBalance, todayHoursExcess: 20 },
    });

    expect(compareCandidatePriority(frequent, lessFrequent)).toBeGreaterThan(0);
    expect(firstDifferentCandidateRule(frequent, lessFrequent)).toBe(
      "position-frequency"
    );
  });

  it("keeps position-frequency selection independent from staff coverage", () => {
    const frequent = priority({
      positionFrequency: { currentMonthCount: 4, recentWorkdayCount: 2 },
    });
    const underused = priority({
      positionFrequency: { currentMonthCount: 0, recentWorkdayCount: 0 },
    });

    expect(compareCandidatePriority(frequent, underused)).toBeGreaterThan(0);
    expect(firstDifferentCandidateRule(frequent, underused)).toBe(
      "position-frequency"
    );
  });

  it("uses monthly position frequency before previous-workday load", () => {
    const heavierPrevious = priority({
      previousWorkdayLoad: {
        fatiguePoints: 10,
        latestEndMinutes: 1200,
        workHours: 8,
        priorityPositionCount: 2,
      },
      positionFrequency: { currentMonthCount: 0, recentWorkdayCount: 0 },
    });
    const lighterPrevious = priority({
      previousWorkdayLoad: {
        fatiguePoints: 1,
        latestEndMinutes: 600,
        workHours: 2,
        priorityPositionCount: 0,
      },
      positionFrequency: { currentMonthCount: 5, recentWorkdayCount: 5 },
    });

    expect(
      compareCandidatePriority(heavierPrevious, lighterPrevious)
    ).toBeLessThan(0);
    expect(firstDifferentCandidateRule(heavierPrevious, lighterPrevious)).toBe(
      "position-frequency"
    );
  });

  it("uses late priority totals before previous-workday load for late positions", () => {
    const frequent = priority({
      latePriorityFrequency: {
        applies: true,
        targetKinds: ["number-one"],
        previousWorkdayAssigned: false,
        supervisorQualified: false,
        supervisorRotationDeficit: 0,
        categoryBoundaryExcess: {
          supervisor: 0,
          "number-one": 1,
          declaration: 0,
          delivery: 0,
        },
        counts: {
          supervisor: { currentMonthCount: 0, recentWorkdayCount: 0 },
          "number-one": { currentMonthCount: 4, recentWorkdayCount: 4 },
          declaration: { currentMonthCount: 3, recentWorkdayCount: 3 },
          delivery: { currentMonthCount: 0, recentWorkdayCount: 0 },
        },
        totalCurrentMonthCount: 4,
        totalRecentWorkdayCount: 4,
      },
      previousWorkdayLoad: {
        fatiguePoints: 0,
        latestEndMinutes: 0,
        workHours: 0,
        priorityPositionCount: 0,
      },
    });
    const underused = priority({
      latePriorityFrequency: {
        applies: true,
        targetKinds: ["number-one"],
        previousWorkdayAssigned: false,
        supervisorQualified: false,
        supervisorRotationDeficit: 0,
        categoryBoundaryExcess: {
          supervisor: 0,
          "number-one": 0,
          declaration: 0,
          delivery: 0,
        },
        counts: {
          supervisor: { currentMonthCount: 0, recentWorkdayCount: 0 },
          "number-one": { currentMonthCount: 0, recentWorkdayCount: 0 },
          declaration: { currentMonthCount: 0, recentWorkdayCount: 0 },
          delivery: { currentMonthCount: 0, recentWorkdayCount: 0 },
        },
        totalCurrentMonthCount: 0,
        totalRecentWorkdayCount: 0,
      },
      previousWorkdayLoad: {
        fatiguePoints: 20,
        latestEndMinutes: 1435,
        workHours: 10,
        priorityPositionCount: 3,
      },
    });

    expect(compareCandidatePriority(frequent, underused)).toBeGreaterThan(0);
    expect(firstDifferentCandidateRule(frequent, underused)).toBe(
      "late-priority-aggregate-rotation"
    );
  });

  it("uses the recent-six-workday count only after the current-month count is tied", () => {
    const recentFrequent = priority({
      positionFrequency: { currentMonthCount: 2, recentWorkdayCount: 4 },
    });
    const recentLessFrequent = priority({
      positionFrequency: { currentMonthCount: 2, recentWorkdayCount: 1 },
    });

    expect(
      compareCandidatePriority(recentFrequent, recentLessFrequent)
    ).toBeGreaterThan(0);
    expect(
      firstDifferentCandidateRule(recentFrequent, recentLessFrequent)
    ).toBe("position-frequency");
  });

  it("registers frequency rebalancing in generation and continuous rotation after scheduling", () => {
    const frequencyReview = SCHEDULING_RULES.find(
      (rule) => rule.id === "position-frequency-review"
    );
    const rotation = SCHEDULING_RULES.find(
      (rule) => rule.id === "position-rotation"
    );
    expect(frequencyReview?.stage).toBe("protection");
    expect(rotation?.stage).toBe("post-schedule-review");
    expect(candidatePriorityOrder).not.toContain("position-frequency-review");
    expect(candidatePriorityOrder).not.toContain("position-rotation");
    expect(
      ROTATION_REVIEW_POLICIES.frequency.protectLatePriorityFrequency
    ).toBe(true);
    expect(
      ROTATION_REVIEW_POLICIES.consecutive.protectLatePriorityFrequency
    ).toBe(true);
  });
});
