import { describe, expect, it } from "vitest";

import { createDefaultState } from "../../src/defaults";
import { updateConfigurationField } from "../../src/app/configuration-actions";
import {
  addCrossWorkdayQualificationReservation,
  addCrossFlightPriorityPolicy,
  addDutyPriority,
  addLateShiftRecoveryPositionRule,
  addMobileSupervisorCoverageRule,
  addMobileSupervisorFillRule,
  addSameFlightStaffExclusion,
  addNextWorkdayRecoveryTarget,
  addTransitionPolicy,
  applySchedulePolicy,
  deleteDutyPriority,
  deleteCrossWorkdayQualificationReservation,
  deleteMobileSupervisorCoverageRule,
  deleteMobileSupervisorFillRule,
  deleteSameFlightStaffExclusion,
  deleteNextWorkdayRecoveryTarget,
  deleteLateShiftRecoveryPositionRule,
  deleteTransitionPolicy,
  moveDutyPriority,
  moveCrossWorkdayQualificationReservation,
  updateDutyPriority,
  updateNextWorkdayRecoveryTarget,
  updateLateShiftRecoveryPositionRule,
  updatePolicyEntityField,
  setTeamLeaderGapFillPositionsMovable,
  type PolicyFieldUpdateResult,
  type SchedulePolicyInput,
} from "../../src/app/policy-actions";

const input: SchedulePolicyInput = {
  maxDailyHours: 10.5,
  minimumRegularTransitionMinutes: 90,
  highLoadProtectionEnabled: true,
  highLoadFatigueThreshold: Number.NaN,
  highLoadRecoveryMinutes: 2000,
  remarkedPositionHighLoad: true,
  rollingLoadProtectionEnabled: true,
  rollingLoadWindowMinutes: 360,
  rollingLoadMaxFatigue: 8,
  positionRotationEnabled: true,
  sameDayCrossFlightPriorityEnabled: true,
  tr121H02CooldownWorkdays: 3,
  latePriorityFlightNumbers: [" tr121 ", "TW 616", "TR121"],
  lateShiftRecoveryEnabled: true,
  nextWorkdayRecoveryMode: "forbid",
  lateShiftEndTime: "",
  teamLeaderConcurrentSupervisionMaxOverlapMinutes: 1000,
  workloadBalanceEnabled: true,
  maxWorkHoursDifference: 2,
  maxTodayFatigueDifference: 4,
  dutyFatiguePoints: 60,
  earlyDepartureCutoffTime: "",
  afternoonRestStartTime: "",
  afternoonRestEndTime: "",
};

function addActiveSchedule(state: ReturnType<typeof createDefaultState>): void {
  state.assignments = [
    {
      id: "assignment",
      flightId: "flight",
      flightNo: "TR121",
      positionRuleId: null,
      position: "临时岗位",
      staffId: null,
      staffName: "",
      startTime: "20:00",
      endTime: "21:00",
      workHours: 0,
      fatiguePoints: 0,
      remark: "",
      manualRemark: "",
      status: "manual",
    },
  ];
}

describe("policy actions", () => {
  it("keeps supervisor-fill references aligned when an active flight is renamed", () => {
    const state = createDefaultState();
    const flight = state.flights[0]!;
    const base = state.positionRules[0]!;
    state.positionRules.push(
      {
        ...base,
        id: "source-supervisor",
        flightNo: flight.flightNo,
        name: "机动督导",
        category: "机动督导",
      },
      {
        ...base,
        id: "target-h05",
        flightNo: flight.flightNo,
        name: "H05",
        category: "常规",
        coverageRole: "supervisor-fill",
      }
    );
    state.settings.mobileSupervisorFillRules = [
      {
        id: "fill-rule",
        enabled: true,
        sourceFlightNo: flight.flightNo,
        sourcePositionKeyword: "机动督导",
        targetFlightNo: flight.flightNo,
        targetPositionKeyword: "H05",
        allowAutomatic: true,
        allowManual: true,
      },
    ];

    expect(
      updateConfigurationField(state, "flight", flight.id, "flightNo", "NEW931")
    ).toBe("updated");

    expect(state.positionRules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "source-supervisor",
          flightNo: "NEW931",
        }),
        expect.objectContaining({ id: "target-h05", flightNo: "NEW931" }),
      ])
    );
    expect(state.settings.mobileSupervisorFillRules[0]).toMatchObject({
      sourceFlightNo: "NEW931",
      targetFlightNo: "NEW931",
    });
  });

  it("adds, edits, and deletes a structured supervisor-fill relationship", () => {
    const state = createDefaultState();
    state.settings.mobileSupervisorFillRules = [];
    addActiveSchedule(state);

    const rule = addMobileSupervisorFillRule(state);
    expect(rule).toMatchObject({
      enabled: true,
      allowAutomatic: true,
      allowManual: true,
    });
    expect(
      updatePolicyEntityField(
        state,
        "supervisor-fill",
        rule.id,
        "targetFlightNo",
        " ke166 "
      )
    ).toBe("saved");
    expect(
      updatePolicyEntityField(
        state,
        "supervisor-fill",
        rule.id,
        "targetPositionKeyword",
        "H05"
      )
    ).toBe("saved");
    expect(rule).toMatchObject({
      targetFlightNo: "KE166",
      targetPositionKeyword: "H05",
    });
    expect(state.schedulePolicyStale).toBe(true);
    expect(deleteMobileSupervisorFillRule(state, rule.id)).toBe(true);
    expect(state.settings.mobileSupervisorFillRules).toEqual([]);
  });

  it("updates the team-leader gap-fill scope in bulk while preserving fixed positions", () => {
    const state = createDefaultState();
    const movable = state.positionRules.find(
      (rule) => rule.category === "常规" && rule.flightNo !== "KE166"
    )!;
    const fixed = state.positionRules.find((rule) => rule.id !== movable.id)!;
    fixed.manual = true;
    addActiveSchedule(state);

    expect(
      setTeamLeaderGapFillPositionsMovable(state, [movable.id, fixed.id], true)
    ).toBe(true);
    expect(state.settings.teamLeaderGapFillPositionPolicies).toEqual([
      {
        flightNo: movable.flightNo,
        position: movable.name,
        movable: true,
      },
    ]);
    expect(state.schedulePolicyStale).toBe(true);

    expect(
      setTeamLeaderGapFillPositionsMovable(state, [movable.id], false)
    ).toBe(true);
    expect(state.settings.teamLeaderGapFillPositionPolicies[0]).toEqual({
      flightNo: movable.flightNo,
      position: movable.name,
      movable: false,
    });
  });

  it("edits only the active group's people in a shared cross-flight priority row", () => {
    const state = createDefaultState();
    const otherGroupStaffId = "B-1";
    state.groups.B.staff = [
      { ...state.staff[0]!, id: otherGroupStaffId, name: "B组人员" },
    ];
    const policy = addCrossFlightPriorityPolicy(state);
    policy.staffIds = [state.staff[0]!.id, otherGroupStaffId];

    expect(
      updatePolicyEntityField(
        state,
        "cross-flight-priority",
        policy.id,
        "staffIds",
        state.staff[1]!.id
      )
    ).toBe("saved");
    expect(policy.staffIds).toEqual([otherGroupStaffId, state.staff[1]!.id]);
  });

  it("adds, edits, and deletes configurable same-flight staff exclusions", () => {
    const state = createDefaultState();
    addActiveSchedule(state);
    const exclusion = addSameFlightStaffExclusion(state);

    expect(exclusion).toMatchObject({
      enabled: true,
      firstStaffId: state.staff[0]!.id,
      secondStaffId: state.staff[1]!.id,
      flightNo: "",
    });
    expect(
      updatePolicyEntityField(
        state,
        "same-flight-staff-exclusion",
        exclusion.id,
        "firstStaffId",
        state.staff[2]!.id
      )
    ).toBe("saved");
    expect(
      updatePolicyEntityField(
        state,
        "same-flight-staff-exclusion",
        exclusion.id,
        "flightNo",
        " ke166 "
      )
    ).toBe("saved");
    expect(exclusion).toMatchObject({
      enabled: true,
      firstStaffId: state.staff[2]!.id,
      secondStaffId: state.staff[1]!.id,
      flightNo: "KE166",
    });
    state.schedulePolicyStale = false;
    const assignments = structuredClone(state.assignments);
    expect(
      updatePolicyEntityField(
        state,
        "same-flight-staff-exclusion",
        exclusion.id,
        "enabled",
        false
      )
    ).toBe("saved");
    expect(exclusion.enabled).toBe(false);
    expect(state.schedulePolicyStale).toBe(true);
    expect(state.assignments).toEqual(assignments);
    expect(deleteSameFlightStaffExclusion(state, exclusion.id)).toBe(true);
    expect(state.settings.sameFlightStaffExclusions).toEqual([]);
  });
  it("normalizes settings explicitly and marks an existing schedule stale without regenerating it", () => {
    const state = createDefaultState();
    state.settings.dutyPositionPriorities[0]!.flightNo = " tr121 ";
    state.assignments = [
      {
        id: "assignment",
        flightId: "flight",
        flightNo: "TR121",
        positionRuleId: null,
        position: "临时岗位",
        staffId: null,
        staffName: "",
        startTime: "20:00",
        endTime: "21:00",
        workHours: 0,
        fatiguePoints: 0,
        remark: "",
        manualRemark: "",
        status: "manual",
      },
    ];

    expect(applySchedulePolicy(state, input)).toBe(true);
    expect(state.schedulePolicyStale).toBe(true);
    expect(state.assignments).toHaveLength(1);
    expect(state.settings).toMatchObject({
      maxDailyHours: 10.5,
      highLoadFatigueThreshold: 4,
      highLoadRecoveryMinutes: 1440,
      lateShiftEndTime: "23:00",
      nextWorkdayRecoveryMode: "forbid",
      teamLeaderConcurrentSupervisionMaxOverlapMinutes: 720,
      dutyFatiguePoints: 50,
      earlyDepartureCutoffTime: "12:00",
      afternoonRestStartTime: "12:00",
      afternoonRestEndTime: "18:00",
    });
    expect(state.settings.dutyPositionPriorities[0]?.flightNo).toBe("TR121");
    expect(state.settings).not.toHaveProperty("highLoadTransitionMode");
    expect(state.settings).not.toHaveProperty("rollingLoadMode");
    expect(state.settings).not.toHaveProperty("lateShiftRecoveryMode");
  });

  it("maintains duty priorities through explicit actions", () => {
    const state = createDefaultState();
    const added = addDutyPriority(state);
    expect(updateDutyPriority(state, added.id, "flightNo", " cx937 ")).toBe(
      true
    );
    expect(added.flightNo).toBe("CX937");
    expect(moveDutyPriority(state, added.id, -1)).toBe(true);
    expect(state.settings.dutyPositionPriorities.at(-2)?.id).toBe(added.id);
  });

  it("maintains editable next-workday recovery targets through explicit actions", () => {
    const state = createDefaultState();
    const added = addNextWorkdayRecoveryTarget(state);
    expect(
      updateNextWorkdayRecoveryTarget(state, added.id, "flightNo", " ke166 ")
    ).toBe(true);
    expect(
      updateNextWorkdayRecoveryTarget(
        state,
        added.id,
        "positionKeyword",
        " 控制 "
      )
    ).toBe(true);
    expect(
      updateNextWorkdayRecoveryTarget(state, added.id, "enabled", false)
    ).toBe(true);
    expect(added).toMatchObject({
      flightNo: "KE166",
      positionKeyword: "控制",
      enabled: false,
    });
    expect(deleteNextWorkdayRecoveryTarget(state, added.id)).toBe(true);
    expect(
      state.settings.nextWorkdayRecoveryTargets.some(
        (item) => item.id === added.id
      )
    ).toBe(false);
  });

  it("maintains ordered cross-workday qualification reservations", () => {
    const state = createDefaultState();
    const first = addCrossWorkdayQualificationReservation(state);
    const second = addCrossWorkdayQualificationReservation(state);
    expect(
      updatePolicyEntityField(
        state,
        "cross-workday-reservation",
        second.id,
        "flightNo",
        " cx931 "
      )
    ).toBe("saved");
    expect(
      updatePolicyEntityField(
        state,
        "cross-workday-reservation",
        second.id,
        "matchField",
        "remark"
      )
    ).toBe("saved");
    expect(
      updatePolicyEntityField(
        state,
        "cross-workday-reservation",
        second.id,
        "minimumStaffCount",
        2
      )
    ).toBe("saved");
    expect(moveCrossWorkdayQualificationReservation(state, second.id, -1)).toBe(
      true
    );
    expect(
      state.settings.crossWorkdayQualificationReservations[0]
    ).toMatchObject({
      id: second.id,
      flightNo: "CX931",
      matchField: "remark",
      minimumStaffCount: 2,
    });
    expect(deleteCrossWorkdayQualificationReservation(state, first.id)).toBe(
      true
    );
  });

  it("maintains editable final-late priority position rules through explicit actions", () => {
    const state = createDefaultState();
    const added = addLateShiftRecoveryPositionRule(state);
    expect(
      updateLateShiftRecoveryPositionRule(
        state,
        added.id,
        "flightNo",
        " tr121 "
      )
    ).toBe(true);
    expect(
      updateLateShiftRecoveryPositionRule(
        state,
        added.id,
        "matchField",
        "remark"
      )
    ).toBe(true);
    expect(
      updateLateShiftRecoveryPositionRule(state, added.id, "keyword", " 控制 ")
    ).toBe(true);
    expect(
      updateLateShiftRecoveryPositionRule(
        state,
        added.id,
        "nextWorkdayCutoffTime",
        "12:30"
      )
    ).toBe(true);
    expect(
      updateLateShiftRecoveryPositionRule(state, added.id, "enabled", false)
    ).toBe(true);
    expect(added).toMatchObject({
      flightNo: "TR121",
      matchField: "remark",
      keyword: "控制",
      nextWorkdayCutoffTime: "12:30",
      enabled: false,
    });
    expect(deleteLateShiftRecoveryPositionRule(state, added.id)).toBe(true);
    expect(
      state.settings.lateShiftRecoveryPositionRules.some(
        (item) => item.id === added.id
      )
    ).toBe(false);
  });

  it("routes every structured policy entity through one field update entry", () => {
    const state = createDefaultState();
    addTransitionPolicy(state);
    addMobileSupervisorCoverageRule(state);
    const transition = state.settings.positionTransitionPolicies.at(-1)!;
    const coverage = state.settings.mobileSupervisorCoverageRules.at(-1)!;

    expect(
      updatePolicyEntityField(
        state,
        "transition-policy",
        transition.id,
        "sourceFlightNo",
        " tr121 "
      )
    ).toBe("saved");
    expect(
      updatePolicyEntityField(
        state,
        "supervisor-coverage",
        coverage.id,
        "mode",
        "allow"
      )
    ).toBe("saved");
    expect(
      updatePolicyEntityField(state, "staff", "missing", "name", "测试")
    ).toBe("not-policy");
    expect(transition.sourceFlightNo).toBe("TR121");
    expect(coverage.mode).toBe("allow");
  });

  it("does not mark the schedule stale for unchanged, invalid, or missing updates", () => {
    const state = createDefaultState();
    addActiveSchedule(state);
    const priority = state.settings.dutyPositionPriorities[0]!;

    expect(
      updateDutyPriority(state, priority.id, "flightNo", priority.flightNo)
    ).toBe(true);
    expect(state.schedulePolicyStale).toBe(false);
    expect(updateDutyPriority(state, priority.id, "unknown", "value")).toBe(
      false
    );
    expect(updateDutyPriority(state, "missing", "enabled", false)).toBe(false);
    expect(moveDutyPriority(state, priority.id, -1)).toBe(false);
    expect(deleteDutyPriority(state, "missing")).toBe(false);
    expect(state.schedulePolicyStale).toBe(false);
    expect(state.assignments).toHaveLength(1);
  });

  it.each<
    [
      string,
      (
        state: ReturnType<typeof createDefaultState>
      ) => boolean | PolicyFieldUpdateResult,
    ]
  >([
    [
      "duty priority",
      (state) => {
        const item = state.settings.dutyPositionPriorities[0]!;
        return updateDutyPriority(state, item.id, "enabled", item.enabled);
      },
    ],
    [
      "recovery target",
      (state) => {
        const item = state.settings.nextWorkdayRecoveryTargets[0]!;
        return updateNextWorkdayRecoveryTarget(
          state,
          item.id,
          "enabled",
          item.enabled
        );
      },
    ],
    [
      "late-shift recovery rule",
      (state) => {
        const item = state.settings.lateShiftRecoveryPositionRules[0]!;
        return updateLateShiftRecoveryPositionRule(
          state,
          item.id,
          "keyword",
          item.keyword
        );
      },
    ],
    [
      "cross-workday reservation",
      (state) => {
        const item = addCrossWorkdayQualificationReservation(state);
        state.schedulePolicyStale = false;
        return updatePolicyEntityField(
          state,
          "cross-workday-reservation",
          item.id,
          "minimumStaffCount",
          item.minimumStaffCount
        );
      },
    ],
    [
      "transition policy",
      (state) => {
        const item = state.settings.positionTransitionPolicies[0]!;
        return updatePolicyEntityField(
          state,
          "transition-policy",
          item.id,
          "mode",
          item.mode
        );
      },
    ],
    [
      "supervisor coverage rule",
      (state) => {
        const item = state.settings.mobileSupervisorCoverageRules[0]!;
        return updatePolicyEntityField(
          state,
          "supervisor-coverage",
          item.id,
          "mode",
          item.mode
        );
      },
    ],
  ])(
    "keeps the active schedule current after unchanged %s",
    (_name, update) => {
      const state = createDefaultState();
      addActiveSchedule(state);

      expect(update(state)).toBeTruthy();
      expect(state.schedulePolicyStale).toBe(false);
      expect(state.assignments).toHaveLength(1);
    }
  );

  it.each<[string, (state: ReturnType<typeof createDefaultState>) => unknown]>([
    ["add duty priority", (state) => addDutyPriority(state)],
    [
      "move duty priority",
      (state) =>
        moveDutyPriority(
          state,
          state.settings.dutyPositionPriorities[1]!.id,
          -1
        ),
    ],
    [
      "delete duty priority",
      (state) =>
        deleteDutyPriority(state, state.settings.dutyPositionPriorities[0]!.id),
    ],
    [
      "update duty priority",
      (state) =>
        updateDutyPriority(
          state,
          state.settings.dutyPositionPriorities[0]!.id,
          "flightNo",
          "CX937"
        ),
    ],
    ["add recovery target", (state) => addNextWorkdayRecoveryTarget(state)],
    [
      "add cross-workday reservation",
      (state) => addCrossWorkdayQualificationReservation(state),
    ],
    [
      "delete recovery target",
      (state) =>
        deleteNextWorkdayRecoveryTarget(
          state,
          state.settings.nextWorkdayRecoveryTargets[0]!.id
        ),
    ],
    [
      "update recovery target",
      (state) =>
        updateNextWorkdayRecoveryTarget(
          state,
          state.settings.nextWorkdayRecoveryTargets[0]!.id,
          "enabled",
          false
        ),
    ],
    ["add final-late rule", (state) => addLateShiftRecoveryPositionRule(state)],
    [
      "delete final-late rule",
      (state) =>
        deleteLateShiftRecoveryPositionRule(
          state,
          state.settings.lateShiftRecoveryPositionRules[0]!.id
        ),
    ],
    [
      "update final-late rule",
      (state) =>
        updateLateShiftRecoveryPositionRule(
          state,
          state.settings.lateShiftRecoveryPositionRules[0]!.id,
          "enabled",
          false
        ),
    ],
    ["add transition policy", (state) => addTransitionPolicy(state)],
    [
      "delete transition policy",
      (state) =>
        deleteTransitionPolicy(
          state,
          state.settings.positionTransitionPolicies[0]!.id
        ),
    ],
    [
      "update transition policy",
      (state) =>
        updatePolicyEntityField(
          state,
          "transition-policy",
          state.settings.positionTransitionPolicies[0]!.id,
          "enabled",
          false
        ),
    ],
    [
      "add supervisor coverage rule",
      (state) => addMobileSupervisorCoverageRule(state),
    ],
    [
      "delete supervisor coverage rule",
      (state) =>
        deleteMobileSupervisorCoverageRule(
          state,
          state.settings.mobileSupervisorCoverageRules[0]!.id
        ),
    ],
    [
      "update supervisor coverage rule",
      (state) =>
        updatePolicyEntityField(
          state,
          "supervisor-coverage",
          state.settings.mobileSupervisorCoverageRules[0]!.id,
          "enabled",
          false
        ),
    ],
  ])("marks an active schedule stale after %s", (_name, mutate) => {
    const state = createDefaultState();
    addActiveSchedule(state);

    mutate(state);

    expect(state.schedulePolicyStale).toBe(true);
    expect(state.assignments).toHaveLength(1);
  });
});
