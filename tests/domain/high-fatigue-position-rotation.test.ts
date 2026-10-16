import { describe, expect, it } from "vitest";

import { createOrdinarySchedulingState } from "../helpers/scheduling-scenario";
import type {
  AppState,
  Assignment,
  Flight,
  HistoryRecord,
  PositionRule,
  Staff,
} from "../../src/model";
import { reviewConsecutivePositionRotation } from "../../src/domain/reviews/position-rotation-review";
import { buildScheduleFeedback } from "../../src/domain/feedback/schedule-feedback";
import { generateSchedule } from "../helpers/generate-schedule";
import { defaultHighsSolver } from "../../src/infrastructure/solver/highs-solver";

function prepareState(staffCount: number): {
  state: AppState;
  staff: Staff[];
  baseRule: PositionRule;
} {
  const state = createOrdinarySchedulingState();
  const staff = state.staff
    .filter((person) => person.status === "正常")
    .slice(0, staffCount);
  state.staff = staff;
  state.staff.forEach((person) => {
    person.dutyQualified = false;
  });
  state.settings.lateShiftRecoveryEnabled = false;
  state.settings.highLoadProtectionEnabled = false;
  state.settings.rollingLoadProtectionEnabled = false;
  state.settings.workloadBalanceEnabled = false;
  state.settings.positionTransitionPolicies = [];
  state.settings.highLoadFatigueThreshold = 4;
  return { state, staff, baseRule: state.positionRules[0]! };
}

function flight(
  id: string,
  flightNo: string,
  startTime = "21:30",
  endTime = "23:30"
): Flight {
  return {
    id,
    flightNo,
    startTime,
    endTime,
    bookedPassengers: 100,
    positions: [],
    remark: "",
  };
}

function rule(
  baseRule: PositionRule,
  id: string,
  flightNo: string,
  name: string,
  fatiguePoints: number,
  qualifiedStaffIds: string[],
  remark = ""
): PositionRule {
  return {
    ...baseRule,
    id,
    flightNo,
    name,
    fatiguePoints,
    qualifiedStaffIds,
    remark,
    category: "常规",
  };
}

function assignment(
  id: string,
  targetFlight: Flight,
  targetRule: PositionRule,
  person: Staff
): Assignment {
  return {
    id,
    flightId: targetFlight.id,
    flightNo: targetFlight.flightNo,
    positionRuleId: targetRule.id,
    position: targetRule.name,
    staffId: person.id,
    staffName: person.name,
    startTime: targetFlight.startTime,
    endTime: targetFlight.endTime,
    workHours: 2,
    fatiguePoints: targetRule.fatiguePoints,
    remark: targetRule.remark,
    manualRemark: "",
    status: "assigned",
  };
}

function previousAssignment(
  person: Staff,
  targetFlight: Flight,
  targetRule: PositionRule,
  date = "2026-09-09"
): HistoryRecord {
  return {
    id: `history-${person.id}-${targetRule.id}`,
    date,
    flightNo: targetFlight.flightNo,
    position: targetRule.name,
    staffId: person.id,
    staffName: person.name,
    startTime: targetFlight.startTime,
    endTime: targetFlight.endTime,
    workHours: 2,
    fatiguePoints: targetRule.fatiguePoints,
    remark: targetRule.remark,
  };
}

describe("high-fatigue ordinary-position rotation", () => {
  it("avoids the repeated high-fatigue worker during initial schedule generation", async () => {
    const {
      state,
      staff: [repeatedWorker, alternate],
      baseRule,
    } = prepareState(2);
    const targetFlight = flight("target", "TEST100");
    const qualified = [repeatedWorker!.id, alternate!.id];
    const frontCounter = rule(
      baseRule,
      "front",
      targetFlight.flightNo,
      "H03",
      6,
      qualified
    );
    const rearCounter = rule(
      baseRule,
      "rear",
      targetFlight.flightNo,
      "H07",
      2,
      qualified
    );
    state.flights = [targetFlight];
    state.positionRules = [frontCounter, rearCounter];
    state.history = [
      previousAssignment(repeatedWorker!, targetFlight, frontCounter),
    ];

    const result = await generateSchedule(state, "2026-09-11");
    const frontAssignment = result.assignments.find(
      (item) => item.positionRuleId === frontCounter.id
    );

    expect(frontAssignment?.staffId).toBe(alternate!.id);
    expect(frontAssignment?.decisionTrace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "high-fatigue-position-consecutive",
          outcome: "selected",
        }),
      ])
    );
  });

  it("rotates a second consecutive high-fatigue ordinary position within the same flight", async () => {
    const {
      state,
      staff: [repeatedWorker, alternate],
      baseRule,
    } = prepareState(2);
    const targetFlight = flight("target", "TEST100");
    const qualified = [repeatedWorker!.id, alternate!.id];
    const frontCounter = rule(
      baseRule,
      "front",
      targetFlight.flightNo,
      "H03",
      6,
      qualified
    );
    const rearCounter = rule(
      baseRule,
      "rear",
      targetFlight.flightNo,
      "H07",
      2,
      qualified
    );
    state.flights = [targetFlight];
    state.positionRules = [frontCounter, rearCounter];
    state.history = [
      previousAssignment(repeatedWorker!, targetFlight, frontCounter),
    ];
    const assignments = [
      assignment(
        "front-assignment",
        targetFlight,
        frontCounter,
        repeatedWorker!
      ),
      assignment("rear-assignment", targetFlight, rearCounter, alternate!),
    ];

    const warnings = await reviewConsecutivePositionRotation(
      defaultHighsSolver,
      state,
      assignments,
      "2026-09-11",
      new Set()
    );

    expect(warnings).toEqual([]);
    expect(
      assignments.find((item) => item.positionRuleId === frontCounter.id)
        ?.staffId
    ).toBe(alternate!.id);
    expect(
      assignments.find((item) => item.positionRuleId === rearCounter.id)
        ?.staffId
    ).toBe(repeatedWorker!.id);
  });

  it("allows a low-fatigue ordinary position on the second consecutive workday", async () => {
    const {
      state,
      staff: [worker, alternate],
      baseRule,
    } = prepareState(2);
    const targetFlight = flight("target", "TEST100");
    const qualified = [worker!.id, alternate!.id];
    const rearCounter = rule(
      baseRule,
      "rear",
      targetFlight.flightNo,
      "H07",
      2,
      qualified
    );
    const otherCounter = rule(
      baseRule,
      "other",
      targetFlight.flightNo,
      "H08",
      2,
      qualified
    );
    state.flights = [targetFlight];
    state.positionRules = [rearCounter, otherCounter];
    state.history = [previousAssignment(worker!, targetFlight, rearCounter)];
    const assignments = [
      assignment("rear-assignment", targetFlight, rearCounter, worker!),
      assignment("other-assignment", targetFlight, otherCounter, alternate!),
    ];

    const warnings = await reviewConsecutivePositionRotation(
      defaultHighsSolver,
      state,
      assignments,
      "2026-09-11",
      new Set()
    );

    expect(warnings).toEqual([]);
    expect(
      assignments.find((item) => item.positionRuleId === rearCounter.id)
        ?.staffId
    ).toBe(worker!.id);
  });

  it("rotates a second consecutive high-fatigue ordinary position through an overlapping flight", async () => {
    const {
      state,
      staff: [repeatedWorker, alternate],
      baseRule,
    } = prepareState(2);
    const targetFlight = flight("target", "TEST100", "21:30", "23:30");
    const overlappingFlight = flight("overlap", "TEST200", "22:00", "00:00");
    const qualified = [repeatedWorker!.id, alternate!.id];
    const frontCounter = rule(
      baseRule,
      "front",
      targetFlight.flightNo,
      "H03",
      6,
      qualified
    );
    const overlapCounter = rule(
      baseRule,
      "overlap-counter",
      overlappingFlight.flightNo,
      "G08",
      2,
      qualified
    );
    state.flights = [targetFlight, overlappingFlight];
    state.positionRules = [frontCounter, overlapCounter];
    state.history = [
      previousAssignment(repeatedWorker!, targetFlight, frontCounter),
    ];
    const assignments = [
      assignment(
        "front-assignment",
        targetFlight,
        frontCounter,
        repeatedWorker!
      ),
      assignment(
        "overlap-assignment",
        overlappingFlight,
        overlapCounter,
        alternate!
      ),
    ];

    const warnings = await reviewConsecutivePositionRotation(
      defaultHighsSolver,
      state,
      assignments,
      "2026-09-11",
      new Set()
    );

    expect(warnings).toEqual([]);
    expect(
      assignments.find((item) => item.positionRuleId === frontCounter.id)
        ?.staffId
    ).toBe(alternate!.id);
    expect(
      assignments.find((item) => item.positionRuleId === overlapCounter.id)
        ?.staffId
    ).toBe(repeatedWorker!.id);
  });

  it.each([
    { label: "priority", remark: "控制", fatiguePoints: 6 },
    { label: "high-fatigue ordinary", remark: "", fatiguePoints: 6 },
  ])(
    "uses a free third worker to release a same-time replacement for a repeated $label position",
    async ({ remark, fatiguePoints }) => {
      const {
        state,
        staff: [repeatedWorker, replacement, releaseWorker],
        baseRule,
      } = prepareState(3);
      const earlyFlight = flight("early", "EARLY1", "06:00", "08:00");
      const targetFlight = flight("target", "TEST100");
      const primary = rule(
        baseRule,
        "primary",
        targetFlight.flightNo,
        "H03",
        fatiguePoints,
        [repeatedWorker!.id, replacement!.id],
        remark
      );
      const source = rule(baseRule, "source", targetFlight.flightNo, "H07", 2, [
        replacement!.id,
        releaseWorker!.id,
      ]);
      const early = rule(baseRule, "early", earlyFlight.flightNo, "E01", 1, [
        repeatedWorker!.id,
      ]);
      state.flights = [earlyFlight, targetFlight];
      state.positionRules = [early, primary, source];
      state.history = [
        previousAssignment(repeatedWorker!, targetFlight, primary),
      ];
      const assignments = [
        assignment("early-assignment", earlyFlight, early, repeatedWorker!),
        assignment(
          "primary-assignment",
          targetFlight,
          primary,
          repeatedWorker!
        ),
        assignment("source-assignment", targetFlight, source, replacement!),
      ];

      const warnings = await reviewConsecutivePositionRotation(
        defaultHighsSolver,
        state,
        assignments,
        "2026-09-11",
        new Set()
      );

      expect(warnings).toEqual([]);
      expect(
        assignments.find((item) => item.positionRuleId === primary.id)?.staffId
      ).toBe(replacement!.id);
      expect(
        assignments.find((item) => item.positionRuleId === source.id)?.staffId
      ).toBe(releaseWorker!.id);
      expect(
        assignments.find((item) => item.positionRuleId === early.id)?.staffId
      ).toBe(repeatedWorker!.id);
    }
  );

  it("uses a four-person open chain to rotate a repeated high-fatigue ordinary position", async () => {
    const {
      state,
      staff: [repeatedWorker, firstMover, secondMover, endpointWorker],
      baseRule,
    } = prepareState(4);
    const earlyFlight = flight("early", "EARLY1", "06:00", "08:00");
    const targetFlight = flight("target", "TEST100");
    const target = rule(
      baseRule,
      "target-position",
      targetFlight.flightNo,
      "H03",
      6,
      [repeatedWorker!.id, firstMover!.id]
    );
    const sourceOne = rule(
      baseRule,
      "source-one",
      targetFlight.flightNo,
      "H07",
      2,
      [firstMover!.id, secondMover!.id]
    );
    const sourceTwo = rule(
      baseRule,
      "source-two",
      targetFlight.flightNo,
      "H08",
      2,
      [secondMover!.id, endpointWorker!.id]
    );
    const early = rule(
      baseRule,
      "early-position",
      earlyFlight.flightNo,
      "E01",
      1,
      [repeatedWorker!.id]
    );
    state.flights = [earlyFlight, targetFlight];
    state.positionRules = [early, target, sourceOne, sourceTwo];
    state.history = [previousAssignment(repeatedWorker!, targetFlight, target)];
    const assignments = [
      assignment("early-assignment", earlyFlight, early, repeatedWorker!),
      assignment("target-assignment", targetFlight, target, repeatedWorker!),
      assignment("source-one-assignment", targetFlight, sourceOne, firstMover!),
      assignment(
        "source-two-assignment",
        targetFlight,
        sourceTwo,
        secondMover!
      ),
    ];

    const warnings = await reviewConsecutivePositionRotation(
      defaultHighsSolver,
      state,
      assignments,
      "2026-09-11",
      new Set()
    );

    expect(warnings).toEqual([]);
    expect(
      assignments.find((item) => item.positionRuleId === target.id)?.staffId
    ).toBe(firstMover!.id);
    expect(
      assignments.find((item) => item.positionRuleId === sourceOne.id)?.staffId
    ).toBe(secondMover!.id);
    expect(
      assignments.find((item) => item.positionRuleId === sourceTwo.id)?.staffId
    ).toBe(endpointWorker!.id);
    expect(
      assignments.find((item) => item.positionRuleId === early.id)?.staffId
    ).toBe(repeatedWorker!.id);
  });

  it("keeps the original schedule when an open chain requires more than five participants", async () => {
    const {
      state,
      staff: [
        repeatedWorker,
        firstMover,
        secondMover,
        thirdMover,
        fourthMover,
        endpointWorker,
      ],
      baseRule,
    } = prepareState(6);
    const earlyFlight = flight("early", "EARLY1", "06:00", "08:00");
    const targetFlight = flight("target", "TEST100");
    const target = rule(
      baseRule,
      "target-position",
      targetFlight.flightNo,
      "H03",
      6,
      [repeatedWorker!.id, firstMover!.id]
    );
    const sourceOne = rule(
      baseRule,
      "source-one",
      targetFlight.flightNo,
      "H07",
      2,
      [firstMover!.id, secondMover!.id]
    );
    const sourceTwo = rule(
      baseRule,
      "source-two",
      targetFlight.flightNo,
      "H08",
      2,
      [secondMover!.id, thirdMover!.id]
    );
    const sourceThree = rule(
      baseRule,
      "source-three",
      targetFlight.flightNo,
      "H09",
      2,
      [thirdMover!.id, fourthMover!.id]
    );
    const sourceFour = rule(
      baseRule,
      "source-four",
      targetFlight.flightNo,
      "H10",
      2,
      [fourthMover!.id, endpointWorker!.id]
    );
    const early = rule(
      baseRule,
      "early-position",
      earlyFlight.flightNo,
      "E01",
      1,
      [repeatedWorker!.id]
    );
    state.flights = [earlyFlight, targetFlight];
    state.positionRules = [
      early,
      target,
      sourceOne,
      sourceTwo,
      sourceThree,
      sourceFour,
    ];
    state.history = [previousAssignment(repeatedWorker!, targetFlight, target)];
    const assignments = [
      assignment("early-assignment", earlyFlight, early, repeatedWorker!),
      assignment("target-assignment", targetFlight, target, repeatedWorker!),
      assignment("source-one-assignment", targetFlight, sourceOne, firstMover!),
      assignment(
        "source-two-assignment",
        targetFlight,
        sourceTwo,
        secondMover!
      ),
      assignment(
        "source-three-assignment",
        targetFlight,
        sourceThree,
        thirdMover!
      ),
      assignment(
        "source-four-assignment",
        targetFlight,
        sourceFour,
        fourthMover!
      ),
    ];

    const warnings = await reviewConsecutivePositionRotation(
      defaultHighsSolver,
      state,
      assignments,
      "2026-09-11",
      new Set()
    );

    expect(warnings.join("\n")).toContain("已连续1次承担TEST100/H03");
    expect(warnings.join("\n")).toContain("整体重排最多允许五人参与");
    expect(
      assignments.find((item) => item.positionRuleId === target.id)?.staffId
    ).toBe(repeatedWorker!.id);
    expect(
      assignments.find((item) => item.positionRuleId === sourceOne.id)?.staffId
    ).toBe(firstMover!.id);
    expect(
      assignments.find((item) => item.positionRuleId === sourceTwo.id)?.staffId
    ).toBe(secondMover!.id);
    expect(
      assignments.find((item) => item.positionRuleId === sourceThree.id)
        ?.staffId
    ).toBe(thirdMover!.id);
    expect(
      assignments.find((item) => item.positionRuleId === sourceFour.id)?.staffId
    ).toBe(fourthMover!.id);
    expect(
      assignments.find((item) => item.positionRuleId === early.id)?.staffId
    ).toBe(repeatedWorker!.id);
  });

  it("reports a concrete exception when a repeated high-fatigue ordinary position has no safe replacement", async () => {
    const {
      state,
      staff: [repeatedWorker, otherWorker],
      baseRule,
    } = prepareState(2);
    const targetFlight = flight("target", "TEST100");
    const frontCounter = rule(
      baseRule,
      "front",
      targetFlight.flightNo,
      "H03",
      6,
      [repeatedWorker!.id]
    );
    const rearCounter = rule(
      baseRule,
      "rear",
      targetFlight.flightNo,
      "H07",
      2,
      [otherWorker!.id]
    );
    state.flights = [targetFlight];
    state.positionRules = [frontCounter, rearCounter];
    state.history = [
      previousAssignment(repeatedWorker!, targetFlight, frontCounter),
    ];
    const assignments = [
      assignment(
        "front-assignment",
        targetFlight,
        frontCounter,
        repeatedWorker!
      ),
      assignment("rear-assignment", targetFlight, rearCounter, otherWorker!),
    ];

    const warnings = await reviewConsecutivePositionRotation(
      defaultHighsSolver,
      state,
      assignments,
      "2026-09-11",
      new Set()
    );
    state.assignments = assignments;
    const feedback = buildScheduleFeedback(state, "2026-09-11").find(
      (item) => item.key === "position-rotation"
    );

    expect(warnings.join("\n")).toContain("已连续1次承担TEST100/H03");
    expect(warnings.join("\n")).toContain("唯一合格人员");
    expect(feedback).toMatchObject({ level: "attention" });
    expect(feedback?.text).toContain("当前连续第2次");
    expect(
      assignments.find((item) => item.positionRuleId === frontCounter.id)
        ?.staffId
    ).toBe(repeatedWorker!.id);
  });
});
