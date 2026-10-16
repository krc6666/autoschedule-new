import { describe, expect, it } from "vitest";
import { createDefaultState } from "../../src/defaults";
import type { AppState } from "../../src/model";
import { diagnoseSupervisorFillRuleConfiguration } from "../../src/domain/coverage/supervisor-fill-facts";
import {
  diagnosePolicyConfiguration,
  diagnoseGapFillReferences,
  diagnoseOrdinaryPriorityPosition,
  diagnoseScalarPolicySetting,
} from "../../src/domain/rules/policy-configuration-diagnostics";
import type { StructuredPolicyKey } from "../../src/domain/rules/structured-policy-contract";
import { buildCurrentScheduleFlightCandidates } from "../../src/domain/flights/next-workday-flight-plan";
import { updateConfigurationField } from "../../src/app/configuration-actions";

function fillState() {
  const state = createDefaultState();
  state.templates = [{ ...state.templates[0]!, id: "tw", flightNo: "tw616" }];
  state.flights = [];
  const base = state.positionRules[0]!;
  state.positionRules = [
    {
      ...base,
      id: "source",
      flightNo: "TW616",
      name: "督导",
      category: "机动督导",
      coverageRole: "none",
    },
    {
      ...base,
      id: "target",
      flightNo: "TW616",
      name: "G16",
      remark: "一号",
      category: "常规",
      coverageRole: "supervisor-fill",
    },
  ];
  state.settings.mobileSupervisorFillRules = [
    {
      id: "fill",
      enabled: true,
      sourceFlightNo: "TW616",
      sourcePositionKeyword: "督导",
      targetFlightNo: "TW616",
      targetPositionKeyword: "G16",
      allowAutomatic: true,
      allowManual: true,
    },
  ];
  return state;
}

describe("configuration diagnostics", () => {
  it("distinguishes a missing plan from missing configuration without changing data", () => {
    const state = fillState();
    const before = JSON.stringify(state);
    expect(
      diagnoseSupervisorFillRuleConfiguration(
        state,
        state.settings.mobileSupervisorFillRules[0]!
      )
    ).toMatchObject({ code: "current-plan-not-applicable", severity: "info" });
    expect(JSON.stringify(state)).toBe(before);
    state.flights = [{ ...state.templates[0]!, bookedPassengers: 0 }];
    expect(
      diagnoseSupervisorFillRuleConfiguration(
        state,
        state.settings.mobileSupervisorFillRules[0]!
      )
    ).toBeNull();
    state.flights = [];
    state.templates = [];
    expect(
      diagnoseSupervisorFillRuleConfiguration(
        state,
        state.settings.mobileSupervisorFillRules[0]!
      )
    ).toMatchObject({ code: "source-flight-missing", severity: "warning" });
  });

  it("does not turn TWB616 or TW626 into TW616", () => {
    const state = fillState();
    state.templates[0]!.flightNo = "TWB616";
    state.flights = [
      { ...state.templates[0]!, flightNo: "TW626", bookedPassengers: 0 },
    ];
    expect(
      diagnoseSupervisorFillRuleConfiguration(
        state,
        state.settings.mobileSupervisorFillRules[0]!
      )?.code
    ).toBe("source-flight-missing");
  });

  it("reports the target role before the plan absence and accepts any matching eligible position", () => {
    const state = fillState();
    state.positionRules[1]!.coverageRole = "none";
    expect(
      diagnoseSupervisorFillRuleConfiguration(
        state,
        state.settings.mobileSupervisorFillRules[0]!
      )?.code
    ).toBe("target-position-not-fill");
    state.positionRules.push({
      ...state.positionRules[1]!,
      id: "target-valid",
      name: "G16备用",
      coverageRole: "supervisor-fill",
    });
    state.positionRules.unshift({
      ...state.positionRules[0]!,
      id: "source-not-supervisor",
      category: "常规",
    });
    expect(
      diagnoseSupervisorFillRuleConfiguration(
        state,
        state.settings.mobileSupervisorFillRules[0]!
      )?.code
    ).toBe("current-plan-not-applicable");
  });

  it("treats intentionally disabled fill modes as information", () => {
    const state = fillState();
    const rule = state.settings.mobileSupervisorFillRules[0]!;
    rule.allowAutomatic = false;
    expect(diagnoseSupervisorFillRuleConfiguration(state, rule)).toMatchObject({
      code: "automatic-disabled",
      severity: "info",
    });
    rule.allowManual = false;
    expect(diagnoseSupervisorFillRuleConfiguration(state, rule)).toMatchObject({
      code: "no-operation-enabled",
      severity: "info",
    });
    rule.enabled = false;
    rule.sourceFlightNo = "MISSING";
    expect(diagnoseSupervisorFillRuleConfiguration(state, rule)).toMatchObject({
      code: "disabled",
      severity: "info",
    });
  });

  const invalidCases: [
    Exclude<StructuredPolicyKey, "teamLeaderGapFillPositionPolicies">,
    (state: AppState) => void,
    string,
  ][] = [
    [
      "sameFlightStaffExclusions",
      (s) => {
        s.settings.sameFlightStaffExclusions = [
          {
            id: "bad",
            enabled: true,
            flightNo: "",
            firstStaffId: s.staff[0]!.id,
            secondStaffId: s.staff[0]!.id,
          },
        ];
      },
      "staff-reference-invalid",
    ],
    [
      "crossFlightPriorityPolicies",
      (s) => {
        s.settings.crossFlightPriorityPolicies = [
          {
            id: "bad",
            enabled: true,
            flightNo: "TW616",
            staffIds: ["deleted"],
          },
        ];
      },
      "staff-reference-invalid",
    ],
    [
      "dutyPositionPriorities",
      (s) => {
        s.settings.dutyPositionPriorities = [
          {
            id: "bad",
            enabled: true,
            flightNo: "TW616",
            positionKeyword: "不存在",
          },
        ];
      },
      "position-missing",
    ],
    [
      "crossWorkdayQualificationReservations",
      (s) => {
        s.settings.crossWorkdayQualificationReservations = [
          {
            id: "bad",
            enabled: true,
            flightNo: "TW616",
            matchField: "remark",
            keyword: "不存在",
            minimumStaffCount: 1,
          },
        ];
      },
      "position-missing",
    ],
    [
      "lateShiftRecoveryPositionRules",
      (s) => {
        s.settings.lateShiftRecoveryPositionRules = [
          {
            id: "bad",
            enabled: true,
            flightNo: "TW616",
            matchField: "remark",
            keyword: "不存在",
            nextWorkdayCutoffTime: "",
          },
        ];
      },
      "late-position-missing",
    ],
    [
      "nextWorkdayRecoveryTargets",
      (s) => {
        s.settings.nextWorkdayRecoveryTargets = [
          {
            id: "bad",
            enabled: true,
            flightNo: "TW616",
            positionKeyword: "不存在",
          },
        ];
      },
      "position-missing",
    ],
    [
      "mobileSupervisorCoverageRules",
      (s) => {
        s.settings.mobileSupervisorCoverageRules = [
          {
            id: "bad",
            enabled: true,
            flightNo: "TW616",
            matchField: "position",
            keyword: "不存在",
            mode: "allow",
          },
        ];
      },
      "position-missing",
    ],
    [
      "positionTransitionPolicies",
      (s) => {
        s.settings.positionTransitionPolicies = [
          {
            id: "bad",
            name: "衔接",
            enabled: true,
            sourceFlightNo: "TW616",
            sourcePositions: ["G1"],
            targetFlightNo: "TW616",
            targetPosition: "G16",
            minimumGapMinutes: 90,
            mode: "forbid",
          },
        ];
      },
      "position-missing",
    ],
  ];
  it.each(invalidCases)(
    "explains unmatched %s and treats disabled entries neutrally",
    (key, configure, code) => {
      const state = fillState();
      configure(state);
      const diagnostics = diagnosePolicyConfiguration(state, key, "bad");
      expect(diagnostics.some((issue) => issue.code === code)).toBe(true);
      expect(
        diagnostics.every((issue) => issue.explanation && issue.steps.length)
      ).toBe(true);
      state.settings[key][0]!.enabled = false;
      expect(diagnosePolicyConfiguration(state, key, "bad")).toEqual([
        expect.objectContaining({ code: "disabled", severity: "info" }),
      ]);
    }
  );

  it("uses the existing duty matcher including whitespace normalization and an empty keyword", () => {
    const state = fillState();
    state.settings.dutyPositionPriorities = [
      { id: "duty", enabled: true, flightNo: "TW 616", positionKeyword: "" },
    ];
    expect(
      diagnosePolicyConfiguration(state, "dutyPositionPriorities", "duty")
    ).toEqual([
      expect.objectContaining({
        code: "current-plan-not-applicable",
        severity: "info",
      }),
    ]);
  });

  it("does not call retained other-group personnel deleted", () => {
    const state = fillState();
    state.groups.B.staff = [
      { ...state.staff[0]!, id: "other-one" },
      { ...state.staff[1]!, id: "other-two" },
    ];
    state.settings.crossFlightPriorityPolicies = [
      {
        id: "other",
        enabled: true,
        flightNo: "TW616",
        staffIds: ["other-one"],
      },
    ];
    state.settings.sameFlightStaffExclusions = [
      {
        id: "pair",
        enabled: true,
        flightNo: "",
        firstStaffId: "other-one",
        secondStaffId: "other-two",
      },
    ];
    expect(
      diagnosePolicyConfiguration(state, "crossFlightPriorityPolicies", "other")
    ).toEqual([
      expect.objectContaining({ code: "other-group", severity: "info" }),
    ]);
    expect(
      diagnosePolicyConfiguration(state, "sameFlightStaffExclusions", "pair")
    ).toEqual([
      expect.objectContaining({ code: "other-group", severity: "info" }),
    ]);
  });

  it("does not require next-workday targets to be in today's plan", () => {
    const state = fillState();
    state.settings.crossWorkdayQualificationReservations = [
      {
        id: "reserve",
        enabled: true,
        flightNo: "TW616",
        matchField: "remark",
        keyword: "一号",
        minimumStaffCount: 1,
      },
    ];
    state.settings.nextWorkdayRecoveryTargets = [
      {
        id: "recovery",
        enabled: true,
        flightNo: "TW616",
        positionKeyword: "一号",
      },
    ];
    state.settings.lateShiftRecoveryEnabled = true;
    expect(
      diagnosePolicyConfiguration(
        state,
        "crossWorkdayQualificationReservations",
        "reserve"
      )
    ).toEqual([]);
    expect(
      diagnosePolicyConfiguration(
        state,
        "nextWorkdayRecoveryTargets",
        "recovery"
      )
    ).toEqual([]);
    state.settings.lateShiftRecoveryEnabled = false;
    expect(
      diagnosePolicyConfiguration(
        state,
        "nextWorkdayRecoveryTargets",
        "recovery"
      )
    ).toEqual([
      expect.objectContaining({ code: "parent-disabled", severity: "info" }),
    ]);
  });

  it("keeps an archived late-shift source valid after its flight template is removed", () => {
    const state = fillState();
    state.settings.lateShiftRecoveryPositionRules = [
      {
        id: "old-late",
        enabled: true,
        flightNo: "OLD616",
        matchField: "position",
        keyword: "督导",
        nextWorkdayCutoffTime: "",
      },
    ];
    state.settings.lateShiftRecoveryEnabled = true;
    state.history = [
      {
        id: "archived",
        date: "2026-10-10",
        flightNo: "OLD616",
        position: "督导",
        staffId: "test",
        staffName: "测试",
        startTime: "22:00",
        endTime: "23:30",
        workHours: 1.5,
        fatiguePoints: 2,
        remark: "",
      },
    ];
    const issues = diagnosePolicyConfiguration(
      state,
      "lateShiftRecoveryPositionRules",
      "old-late"
    );
    expect(issues.every((issue) => issue.severity === "info")).toBe(true);
    expect(issues.some((issue) => issue.code === "historical-source")).toBe(
      true
    );
  });

  it("explains an allow rule blocked by an existing forbid rule", () => {
    const state = fillState();
    state.settings.mobileSupervisorCoverageRules = [
      {
        id: "allow",
        enabled: true,
        flightNo: "TW616",
        matchField: "position",
        keyword: "G16",
        mode: "allow",
      },
      {
        id: "forbid",
        enabled: true,
        flightNo: "TW616",
        matchField: "remark",
        keyword: "一号",
        mode: "forbid",
      },
    ];
    expect(
      diagnosePolicyConfiguration(
        state,
        "mobileSupervisorCoverageRules",
        "allow"
      )
    ).toEqual([
      expect.objectContaining({
        code: "forbid-precedes-allow",
        severity: "warning",
      }),
    ]);
  });

  it("reports orphan ordinary and gap-fill references using actual field and worksheet names", () => {
    const state = fillState();
    state.settings.ordinaryPriorityPositions = [
      { airlineCode: "TW", position: "G16" },
      { airlineCode: "TW", position: "G1" },
    ];
    expect(diagnoseOrdinaryPriorityPosition(state, 0)).toEqual([]);
    expect(diagnoseOrdinaryPriorityPosition(state, 1)[0]?.code).toBe(
      "ordinary-position-missing"
    );
    state.settings.teamLeaderGapFillPositionPolicies = [
      { flightNo: "TW616", position: "G1", movable: true },
    ];
    expect(diagnoseGapFillReferences(state)[0]?.steps.join(" ")).toContain(
      "分队长补差保护范围"
    );
  });

  it.each(["常规", "机动督导", "分流", "引导", "行政支援"] as const)(
    "accepts a configured ordinary position in category %s",
    (category) => {
      const state = createDefaultState();
      const rule = state.positionRules.find(
        (item) => item.flightNo === "TR121" && item.name === "督导"
      )!;
      rule.category = category;
      state.settings.ordinaryPriorityPositions = [
        { airlineCode: "TR", position: "督导" },
      ];

      expect(diagnoseOrdinaryPriorityPosition(state, 0)).toEqual([]);
    }
  );

  it("uses the central scalar contract for invalid numbers, times and intentional zeros", () => {
    expect(
      diagnoseScalarPolicySetting("maxDailyHours", 25, "每日工时上限")[0]?.code
    ).toBe("invalid-number");
    expect(
      diagnoseScalarPolicySetting("maxDailyHours", 12, "每日工时上限")
    ).toEqual([]);
    expect(
      diagnoseScalarPolicySetting("lateShiftEndTime", "", "末班结束界线")[0]
        ?.code
    ).toBe("invalid-time");
    expect(
      diagnoseScalarPolicySetting(
        "minimumRegularTransitionMinutes",
        0,
        "普通岗位最小衔接间隔"
      )[0]
    ).toMatchObject({ code: "zero-disabled", severity: "info" });
    expect(
      diagnoseScalarPolicySetting(
        "dailyFlightCountBalanceExemptHalfRest",
        false,
        "半休豁免"
      )
    ).toEqual([]);
  });

  it("keeps a renamed template, current prepare selection and fill relation consistent", () => {
    const state = fillState();
    state.templates[0]!.flightNo = "TWB616";
    state.positionRules.forEach((rule) => {
      rule.flightNo = "TWB616";
    });
    const relation = state.settings.mobileSupervisorFillRules[0]!;
    relation.sourceFlightNo = relation.targetFlightNo = "TWB616";
    state.flights = [{ ...state.templates[0]!, bookedPassengers: 100 }];
    expect(
      updateConfigurationField(state, "template", "tw", "flightNo", "TW616")
    ).toBe("updated");
    expect(state.settings.mobileSupervisorFillRules[0]?.sourceFlightNo).toBe(
      "TW616"
    );
    const choices = buildCurrentScheduleFlightCandidates(
      state.templates,
      state.flights
    );
    expect(
      choices.map((choice) => [choice.flightNo, choice.selectedByDefault])
    ).toEqual([["TW616", true]]);
    expect(
      diagnoseSupervisorFillRuleConfiguration(
        state,
        state.settings.mobileSupervisorFillRules[0]!
      )?.code
    ).toBeUndefined();
  });
});
