import { describe, expect, it } from "vitest";

import type { Assignment, Flight, PositionRule } from "../../src/model";
import { SAME_DAY_PRIORITY_CONFLICT_REASON } from "../../src/domain/rules/airline-rotation";
import { ROTATION_REVIEW_POLICIES } from "../../src/domain/reviews/reassignment-safety-policy";
import { reassignmentSafetyReasons } from "../../src/domain/reviews/rotation-review-safety";
import { halfRestRegressionReasons } from "../../src/domain/rules/half-rest";
import {
  reassignmentChoiceRequirements,
  type ReassignmentChoiceFacts,
} from "../../src/domain/solver/reassignment-choice-graph";
import type { ReassignmentOptimizationOptions } from "../../src/domain/solver/reassignment-contract";
import {
  createRotationReviewHalfRestScenario,
  createRotationReviewFrequencyScenario,
  createRotationReviewMinimumWorkScenario,
  createRotationReviewRetainWorkScenario,
} from "../helpers/scheduling-scenario";

describe("rotation review safety", () => {
  it("rejects an automatic post-review change that newly joins same-day CX priority work", () => {
    const { state, target, originalWorker, replacementWorker } =
      createRotationReviewFrequencyScenario();
    const earlyFlight: Flight = {
      ...state.flights[0]!,
      flightNo: "CX937（晚）",
      startTime: "09:25",
      endTime: "11:25",
    };
    const lateFlight: Flight = {
      ...earlyFlight,
      id: "late-flight",
      flightNo: "CX931",
      startTime: "17:50",
      endTime: "19:50",
    };
    const earlyRule: PositionRule = {
      ...state.positionRules[0]!,
      flightNo: earlyFlight.flightNo,
      remark: "一号",
    };
    const lateRule: PositionRule = {
      ...earlyRule,
      id: "late-rule",
      flightNo: lateFlight.flightNo,
    };
    const lateAssignment: Assignment = {
      ...target,
      id: "late-assignment",
      flightId: lateFlight.id,
      flightNo: lateFlight.flightNo,
      positionRuleId: lateRule.id,
      staffId: replacementWorker.id,
      staffName: replacementWorker.name,
      startTime: lateFlight.startTime,
      endTime: lateFlight.endTime,
      remark: "一号",
    };
    target.flightId = earlyFlight.id;
    target.flightNo = earlyFlight.flightNo;
    target.positionRuleId = earlyRule.id;
    target.staffId = originalWorker.id;
    target.staffName = originalWorker.name;
    target.startTime = earlyFlight.startTime;
    target.endTime = earlyFlight.endTime;
    target.remark = "一号";
    state.flights = [earlyFlight, lateFlight];
    state.positionRules = [earlyRule, lateRule];
    state.assignments = [target, lateAssignment];
    state.settings.sameDayCrossFlightPriorityEnabled = true;

    const reasons = reassignmentSafetyReasons({
      kind: "plan",
      state,
      assignments: state.assignments,
      changes: [{ assignmentId: target.id, staffId: replacementWorker.id }],
      primaryAssignmentId: target.id,
      date: "2026-07-30",
      intent: { kind: "position-frequency-review" },
    });

    expect(reasons).toContain(SAME_DAY_PRIORITY_CONFLICT_REASON);
  });

  it("does not impose a global retain-work requirement on a local frequency review", () => {
    const { state, worker, assignment } =
      createRotationReviewRetainWorkScenario();
    const choices: ReassignmentChoiceFacts[] = [
      {
        assignment,
        person: worker,
        choice: {
          id: "choice:worker",
          assignmentId: assignment.id,
          staffId: worker.id,
          keepsCurrentStaff: true,
          preferenceRank: 0,
          workHours: 2,
        },
      },
    ];
    const requirements = reassignmentChoiceRequirements(
      {
        state,
        intent: { kind: "position-frequency-review" },
      } as unknown as ReassignmentOptimizationOptions,
      choices,
      [assignment],
      []
    );
    expect(requirements).not.toContainEqual(
      expect.objectContaining({ id: `retain-work:${worker.id}` })
    );
  });

  it("rejects post-review plans that leave a non-team-leader half-rest worker empty", () => {
    const { assignment, person } = createRotationReviewMinimumWorkScenario();
    const reasons = halfRestRegressionReasons(
      [assignment],
      [{ ...assignment, staffId: null, staffName: "", status: "unfilled" }],
      {
        requestedStaffIds: [person.id],
        activeStaffIds: new Set([person.id]),
        minimumWorkStaffIds: new Set([person.id]),
        ignoredWarnings: [],
        modesByStaffId: new Map([[person.id, "early-finish"]]),
        earlyFinishStaffIds: new Set([person.id]),
        lateStartStaffIds: new Set(),
      }
    );
    expect(reasons).toContain("调整会使半休人员失去12点前岗位");
  });
  it("requires an explicit safety policy for every review purpose", () => {
    expect(Object.keys(ROTATION_REVIEW_POLICIES).sort()).toEqual([
      "consecutive",
      "coverage",
      "frequency",
      "late-frequency",
      "mobile-supervisor",
      "recovery",
    ]);
    expect(ROTATION_REVIEW_POLICIES.coverage).toMatchObject({
      assignedCount: "may-increase",
      protectDutyMorning: false,
      transitionMode: "forbid",
    });
    expect(ROTATION_REVIEW_POLICIES.frequency).toMatchObject({
      frequency: "improve-primary",
      protectPreviousWorkdayLoad: false,
      preventStaffWithoutWork: false,
      transitionMode: "forbid",
    });
    expect(ROTATION_REVIEW_POLICIES.consecutive).toMatchObject({
      frequency: "preserve-priority",
      preventStaffWithoutWork: false,
      transitionMode: "forbid",
    });
  });

  it("allows priority-position fairness even when the original worker has no other work", () => {
    const { state, originalWorker, replacementWorker, target } =
      createRotationReviewFrequencyScenario();
    state.history = [
      {
        id: "history",
        date: "2026-07-28",
        flightNo: "F100",
        position: "G20",
        staffId: originalWorker.id,
        staffName: originalWorker.name,
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 2,
        remark: "一号",
      },
    ];

    const reasons = reassignmentSafetyReasons({
      kind: "plan",
      state,
      assignments: [target],
      changes: [{ assignmentId: target.id, staffId: replacementWorker!.id }],
      primaryAssignmentId: target.id,
      date: "2026-07-30",
      intent: { kind: "position-frequency-review" },
    });

    expect(reasons).toEqual([]);
  });

  it("accepts a lower-frequency replacement when the original worker keeps another assignment", () => {
    const { state, originalWorker, replacementWorker, target } =
      createRotationReviewFrequencyScenario();
    state.history = [
      {
        id: "history",
        date: "2026-07-28",
        flightNo: "F100",
        position: "G20",
        staffId: originalWorker.id,
        staffName: originalWorker.name,
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 2,
        remark: "一号",
      },
    ];
    const otherWork: Assignment = {
      ...target,
      id: "other",
      flightId: "other-flight",
      flightNo: "F200",
      positionRuleId: null,
      position: "G18",
      remark: "",
      staffId: originalWorker.id,
      staffName: originalWorker.name,
      startTime: "12:00",
      endTime: "14:00",
    };

    const reasons = reassignmentSafetyReasons({
      kind: "plan",
      state,
      assignments: [target, otherWork],
      changes: [{ assignmentId: target.id, staffId: replacementWorker.id }],
      primaryAssignmentId: target.id,
      date: "2026-07-30",
      intent: { kind: "position-frequency-review" },
    });

    expect(reasons).toEqual([]);
  });

  it("keeps strict position transitions above priority-position fairness", () => {
    const { state, originalWorker, replacementWorker, target } =
      createRotationReviewFrequencyScenario();
    state.history = [
      {
        id: "history",
        date: "2026-07-28",
        flightNo: "F100",
        position: "G20",
        staffId: originalWorker.id,
        staffName: originalWorker.name,
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 2,
        remark: "一号",
      },
    ];
    state.settings.positionTransitionPolicies = [
      {
        id: "strict-transition",
        name: "严格衔接",
        enabled: true,
        sourceFlightNo: "F000",
        sourcePositions: ["G10"],
        targetFlightNo: "F100",
        targetPosition: "G20",
        minimumGapMinutes: 90,
        mode: "forbid",
      },
    ];
    const previous: Assignment = {
      ...target,
      id: "previous",
      flightId: "previous-flight",
      flightNo: "F000",
      positionRuleId: null,
      position: "G10",
      staffId: replacementWorker.id,
      staffName: replacementWorker.name,
      startTime: "06:00",
      endTime: "07:30",
      workHours: 1.5,
      remark: "",
    };

    const reasons = reassignmentSafetyReasons({
      kind: "plan",
      state,
      assignments: [target, previous],
      changes: [{ assignmentId: target.id, staffId: replacementWorker.id }],
      primaryAssignmentId: target.id,
      date: "2026-07-30",
      intent: { kind: "position-frequency-review" },
    });

    expect(reasons.some((reason) => reason.includes("衔接"))).toBe(true);
  });

  it("does not let a post-schedule reassignment bypass the global transition gap", () => {
    const { state, replacementWorker, target } =
      createRotationReviewFrequencyScenario();
    state.settings.positionTransitionPolicies = [];
    state.settings.minimumRegularTransitionMinutes = 90;
    const previous: Assignment = {
      ...target,
      id: "previous",
      flightId: "previous-flight",
      flightNo: "F000",
      positionRuleId: null,
      position: "G10",
      staffId: replacementWorker.id,
      staffName: replacementWorker.name,
      startTime: "06:00",
      endTime: "07:00",
      workHours: 1,
      remark: "",
    };

    const reasons = reassignmentSafetyReasons({
      kind: "plan",
      state,
      assignments: [target, previous],
      changes: [{ assignmentId: target.id, staffId: replacementWorker.id }],
      primaryAssignmentId: target.id,
      date: "2026-07-30",
      intent: { kind: "position-frequency-review" },
    });

    expect(reasons.some((reason) => reason.includes("最小航班衔接间隔"))).toBe(
      true
    );
  });

  it("does not let a lower-priority review consume an established reservation", () => {
    const { state, originalWorker, replacementWorker, target } =
      createRotationReviewFrequencyScenario();
    state.flights[0]!.startTime = "21:00";
    state.flights[0]!.endTime = "23:30";
    target.startTime = "21:00";
    target.endTime = "23:30";
    state.positionRules.push({
      ...state.positionRules[0]!,
      id: "next-control",
      flightNo: "NEXT200",
      name: "控制",
      remark: "",
      qualifiedStaffIds: [replacementWorker.id],
    });
    state.templates = [
      {
        id: "next-template",
        flightNo: "NEXT200",
        startTime: "08:00",
        endTime: "10:00",
        positions: ["控制"],
        remark: "",
      },
    ];
    state.settings.crossWorkdayQualificationReservations = [
      {
        id: "reserve-control",
        enabled: true,
        flightNo: "NEXT200",
        matchField: "position",
        keyword: "控制",
        minimumStaffCount: 1,
      },
    ];
    target.staffId = originalWorker.id;
    target.staffName = originalWorker.name;

    const reasons = reassignmentSafetyReasons({
      kind: "plan",
      state,
      assignments: [target],
      changes: [{ assignmentId: target.id, staffId: replacementWorker.id }],
      primaryAssignmentId: target.id,
      date: "2026-07-30",
      intent: { kind: "position-frequency-review" },
    });

    expect(reasons).toContain("调整会减少跨工作日资质预留人数");

    const strictGapFillReasons = reassignmentSafetyReasons({
      kind: "plan",
      state,
      assignments: [target],
      changes: [{ assignmentId: target.id, staffId: replacementWorker.id }],
      primaryAssignmentId: target.id,
      date: "2026-07-30",
      intent: {
        kind: "team-leader-gap-fill",
        crossWorkdayReservation: "preserve",
      },
    });
    expect(strictGapFillReasons).toContain("调整会减少跨工作日资质预留人数");

    const gapFillReasons = reassignmentSafetyReasons({
      kind: "plan",
      state,
      assignments: [target],
      changes: [{ assignmentId: target.id, staffId: replacementWorker.id }],
      primaryAssignmentId: target.id,
      date: "2026-07-30",
      intent: {
        kind: "team-leader-gap-fill",
        crossWorkdayReservation: "yield-to-selected-vacancy",
      },
    });
    expect(gapFillReasons).not.toContain("调整会减少跨工作日资质预留人数");
  });

  function createStrictHalfRestFixture() {
    return createRotationReviewHalfRestScenario();
  }

  it("does not add a strict recovery exception for an ordinary half-rest reassignment", () => {
    const { state, target, facts, recoveringWorker } =
      createStrictHalfRestFixture();

    const reasons = reassignmentSafetyReasons({
      kind: "plan",
      state,
      assignments: [target],
      changes: [{ assignmentId: target.id, staffId: recoveringWorker.id }],
      primaryAssignmentId: target.id,
      date: "2026-07-30",
      intent: { kind: "position-frequency-review" },
      facts,
    });

    expect(reasons).toContain("调整会在未补齐半休空缺时新增严格恢复突破");
  });

  it("allows strict recovery to yield when a post-review plan fills a half-rest vacancy", () => {
    const { state, target, facts, recoveringWorker } =
      createStrictHalfRestFixture();
    const vacancy: Assignment = {
      ...target,
      staffId: null,
      staffName: "",
      workHours: 0,
      status: "unfilled",
    };

    const reasons = reassignmentSafetyReasons({
      kind: "plan",
      state,
      assignments: [vacancy],
      changes: [
        {
          assignmentId: vacancy.id,
          staffId: recoveringWorker.id,
          workHours: 2,
          status: "assigned",
        },
      ],
      primaryAssignmentId: vacancy.id,
      date: "2026-07-30",
      intent: { kind: "team-leader-concurrent-gap-fill" },
      facts,
    });

    expect(reasons).not.toContain(
      "严格跨工作日恢复限制不允许该人员承担次班目标岗位"
    );
    expect(reasons).not.toContain("调整会在未补齐半休空缺时新增严格恢复突破");
  });

  it("rejects assigning a morning flight to a late-start half-rest worker", () => {
    const { state, target, facts, recoveringWorker } =
      createStrictHalfRestFixture();
    const morningFlight = {
      ...state.flights[0]!,
      id: "morning-flight",
      flightNo: "AM100",
      startTime: "08:00",
      endTime: "10:00",
    };
    const morningRule = {
      ...state.positionRules[0]!,
      id: "morning-control",
      flightNo: "AM100",
    };
    state.flights = [morningFlight];
    state.positionRules = [morningRule];
    const morningTarget = {
      ...target,
      id: "morning-target",
      flightId: morningFlight.id,
      flightNo: morningFlight.flightNo,
      positionRuleId: morningRule.id,
      startTime: morningFlight.startTime,
      endTime: morningFlight.endTime,
    };
    const reasons = reassignmentSafetyReasons({
      kind: "plan",
      state,
      assignments: [morningTarget],
      changes: [
        { assignmentId: morningTarget.id, staffId: recoveringWorker.id },
      ],
      primaryAssignmentId: morningTarget.id,
      date: "2026-07-30",
      intent: { kind: "position-frequency-review" },
      facts: {
        ...facts,
        halfRest: {
          ...facts.halfRest,
          activeStaffIds: new Set([recoveringWorker.id]),
          lateStartStaffIds: new Set([recoveringWorker.id]),
          earlyFinishStaffIds: new Set(),
          modesByStaffId: new Map([[recoveringWorker.id, "late-start"]]),
        },
      },
    });
    expect(reasons.some((reason) => /半休/.test(reason))).toBe(true);
  });
});
