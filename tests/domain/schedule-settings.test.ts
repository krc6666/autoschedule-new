import { describe, expect, it } from "vitest";

import type { ScheduleSettings } from "../../src/model";
import {
  applyScheduleSettingsPatch,
  createDefaultScheduleSettings,
  normalizeScheduleSettings,
  SCHEDULE_SETTING_DEFINITIONS,
} from "../../src/domain/rules/schedule-settings";
import {
  STRUCTURED_POLICY_DEFINITIONS,
  STRUCTURED_POLICY_KEYS,
  normalizeStructuredPolicies,
} from "../../src/domain/rules/structured-policy-settings";

describe("schedule settings module", () => {
  it("registers every structured policy with defaults, normalization, and adapters", () => {
    const definitions = Object.values(STRUCTURED_POLICY_DEFINITIONS);
    const keys = definitions.map((definition) => definition.key).sort();

    expect(new Set(keys).size).toBe(keys.length);
    expect(STRUCTURED_POLICY_KEYS.slice().sort()).toEqual(keys);
    expect(
      Object.keys(createDefaultScheduleSettings())
        .filter((key) => keys.includes(key as (typeof keys)[number]))
        .sort()
    ).toEqual(keys);
    expect(Object.keys(normalizeStructuredPolicies({})).sort()).toEqual(keys);

    for (const definition of definitions) {
      const fallback = definition.createDefault();
      const normalize = definition.normalize as (
        value: unknown,
        fallback: unknown
      ) => unknown;
      expect(normalize(undefined, fallback)).toEqual(fallback);
      expect(definition.excelSheet).toBeTruthy();
      expect(definition.uiCollection).toBeTruthy();
      expect(definition.uiEntity).toBeTruthy();
    }
  });

  it("owns every scalar setting default and validation rule", () => {
    const complexKeys = new Set([
      "flightLeaderRequirements",
      "adminSupportEnabled",
      "positionTransitionPolicies",
      "dutyPositionPriorities",
      "nextWorkdayRecoveryTargets",
      "lateShiftRecoveryPositionRules",
      "mobileSupervisorCoverageRules",
      "mobileSupervisorFillRules",
      "crossWorkdayQualificationReservations",
      "crossFlightPriorityPolicies",
      "teamLeaderGapFillPositionPolicies",
      "sameFlightStaffExclusions",
      "airlineMixPolicies",
      "latePriorityFlightNumbers",
      "relaxedShiftFlightNumbers",
      "ordinaryPriorityPositions",
    ]);
    const scalarKeys = Object.keys(createDefaultScheduleSettings())
      .filter((key) => !complexKeys.has(key))
      .sort();
    expect(
      SCHEDULE_SETTING_DEFINITIONS.map((definition) => definition.key).sort()
    ).toEqual(scalarKeys);
    expect(
      SCHEDULE_SETTING_DEFINITIONS.find(
        (definition) => definition.key === "dutyFatiguePoints"
      )
    ).toMatchObject({ defaultValue: 12, min: 0, max: 50 });
    expect(
      SCHEDULE_SETTING_DEFINITIONS.find(
        (definition) => definition.key === "minimumRegularTransitionMinutes"
      )
    ).toMatchObject({ defaultValue: 90, min: 0, max: 1440 });
    expect(
      SCHEDULE_SETTING_DEFINITIONS.find(
        (definition) => definition.key === "tr121H02CooldownWorkdays"
      )
    ).toMatchObject({ defaultValue: 3, min: 0, max: 30, integer: true });
    expect(createDefaultScheduleSettings()).toMatchObject({
      minimumRegularTransitionMinutes: 90,
      sameDayCrossFlightPriorityEnabled: true,
      dailyFlightCountBalanceExemptHalfRest: true,
      dailyFlightCountBalanceExemptTeamLeaders: true,
      tr121H02CooldownWorkdays: 3,
      nextWorkdayRecoveryMode: "prefer",
      crossWorkdayQualificationReservations: [],
    });
  });

  it("keeps both flight-count exemption switches configurable with legacy defaults", () => {
    const normalized = normalizeScheduleSettings({
      dailyFlightCountBalanceExemptHalfRest: false,
      dailyFlightCountBalanceExemptTeamLeaders: false,
    });

    expect(normalized.dailyFlightCountBalanceExemptHalfRest).toBe(false);
    expect(normalized.dailyFlightCountBalanceExemptTeamLeaders).toBe(false);
    expect(
      normalizeScheduleSettings({}).dailyFlightCountBalanceExemptHalfRest
    ).toBe(true);
    expect(
      normalizeScheduleSettings({}).dailyFlightCountBalanceExemptTeamLeaders
    ).toBe(true);
  });

  it("normalizes the cross-workday recovery target strength", () => {
    expect(
      normalizeScheduleSettings({ nextWorkdayRecoveryMode: "forbid" })
        .nextWorkdayRecoveryMode
    ).toBe("forbid");
    expect(
      normalizeScheduleSettings({ nextWorkdayRecoveryMode: "invalid" as never })
        .nextWorkdayRecoveryMode
    ).toBe("prefer");
  });

  it("migrates legacy same-flight staff pairs into unordered unique groups", () => {
    const normalized = normalizeScheduleSettings(
      JSON.parse(
        JSON.stringify({
          sameFlightStaffExclusions: [
            {
              id: " first ",
              enabled: false,
              firstStaffId: "worker-b",
              secondStaffId: "worker-a",
              flightNo: " ke166 ",
            },
            {
              id: "duplicate",
              enabled: true,
              firstStaffId: "worker-a",
              secondStaffId: "worker-b",
              flightNo: "KE166",
            },
            {
              id: "invalid",
              enabled: true,
              firstStaffId: "worker-a",
              secondStaffId: "worker-a",
              flightNo: "",
            },
          ],
        })
      )
    );

    expect(normalized.sameFlightStaffExclusions).toEqual([
      {
        id: "first",
        enabled: false,
        staffIds: ["worker-a", "worker-b"],
        flightNo: "KE166",
      },
    ]);
  });

  it("normalizes cross-flight priority rows by staff id", () => {
    const normalized = normalizeScheduleSettings({
      crossFlightPriorityPolicies: [
        {
          id: " priority ",
          enabled: true,
          flightNo: " ke166 ",
          staffIds: [" 1 ", "2", "1"],
        },
      ],
    });

    expect(normalized.crossFlightPriorityPolicies).toEqual([
      {
        id: "priority",
        enabled: true,
        flightNo: "KE166",
        staffIds: ["1", "2"],
      },
    ]);
  });

  it("normalizes the same values for every settings adapter", () => {
    const defaults = createDefaultScheduleSettings();
    const input = {
      dutyFatiguePoints: 100,
      tr121H02CooldownWorkdays: 99.7,
      highLoadRecoveryMinutes: 1500.4,
      lateShiftEndTime: "25:00",
      minimumRegularTransitionMinutes: 2000,
      crossWorkdayQualificationReservations: [
        {
          id: " reserve ",
          enabled: true,
          flightNo: " cx931 ",
          matchField: "position",
          keyword: " 控制 ",
          minimumStaffCount: 100,
        },
      ],
      positionTransitionPolicies: [
        {
          id: " transition ",
          name: " ",
          enabled: true,
          sourceFlightNo: " cx931 ",
          sourcePositions: [" G20 ", ""],
          targetFlightNo: " tr121 ",
          targetPosition: " H02 ",
          minimumGapMinutes: 2000,
          mode: "forbid",
        },
      ],
    } satisfies Partial<ScheduleSettings>;

    expect(normalizeScheduleSettings({ ...defaults, ...input })).toMatchObject({
      dutyFatiguePoints: 50,
      tr121H02CooldownWorkdays: 30,
      highLoadRecoveryMinutes: 1440,
      lateShiftEndTime: "23:00",
      minimumRegularTransitionMinutes: 1440,
      crossWorkdayQualificationReservations: [
        {
          id: "reserve",
          enabled: true,
          flightNo: "CX931",
          matchField: "position",
          keyword: "控制",
          minimumStaffCount: 50,
        },
      ],
      positionTransitionPolicies: [
        {
          id: "transition",
          name: "未命名衔接规则",
          sourceFlightNo: "CX931",
          sourcePositions: ["G20"],
          targetFlightNo: "TR121",
          targetPosition: "H02",
          minimumGapMinutes: 1440,
          mode: "forbid",
        },
      ],
    });
  });

  it("applies partial imports without resetting settings omitted by the workbook", () => {
    const current = createDefaultScheduleSettings();
    current.positionRotationEnabled = false;
    const next = applyScheduleSettingsPatch(current, { dutyFatiguePoints: 6 });
    expect(next.dutyFatiguePoints).toBe(6);
    expect(next.positionRotationEnabled).toBe(false);
    expect(next.dutyPositionPriorities).toEqual(current.dutyPositionPriorities);
  });
});
