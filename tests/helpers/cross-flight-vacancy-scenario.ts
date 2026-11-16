import type { Assignment, PositionRule, Staff } from "../../src/model";
import { createOrdinarySchedulingState } from "./scheduling-scenario";

const DATE = "2026-11-18";

export function vacancyScenario(supervisorFill = false) {
  const state = createOrdinarySchedulingState();
  const base = state.staff[0]!;
  const person = (id: string): Staff => ({
    ...base,
    id,
    name: id,
    status: "正常",
    staffType: "常规",
    teamLeader: false,
    dutyQualified: false,
    nightShift: true,
  });
  state.staff = [
    person("anchor"),
    person("bridge"),
    person("replacement"),
    ...(supervisorFill ? [person("supervisor")] : []),
  ];
  state.history = [];
  state.assignments = [];
  state.dutyRosterOverrides = [
    {
      date: DATE,
      cxPreflightStaffId: null,
      dutyStaffId: null,
      standbyStaffIds: [null, null],
    },
  ];
  Object.assign(state.settings, {
    minimumRegularTransitionMinutes: 0,
    workloadBalanceEnabled: false,
    lateShiftRecoveryEnabled: false,
    highLoadProtectionEnabled: false,
    rollingLoadProtectionEnabled: false,
    positionRotationEnabled: false,
    sameDayCrossFlightPriorityEnabled: false,
    earlyDepartureBalanceEnabled: false,
    afternoonRestBalanceEnabled: false,
    ordinaryPriorityPositions: [],
    positionTransitionPolicies: [],
    crossWorkdayQualificationReservations: [],
  });
  state.settings.crossFlightPriorityPolicies = [
    {
      id: "prefer-source",
      enabled: true,
      flightNo: "AB100",
      staffIds: [
        "bridge",
        ...(supervisorFill ? ["replacement", "supervisor"] : []),
      ],
    },
  ];
  state.settings.sameFlightStaffExclusions = [
    {
      id: "exclusive",
      enabled: true,
      flightNo: "CD200",
      staffIds: ["anchor", "replacement"],
    },
  ];
  state.flights = [
    {
      id: "source-flight",
      flightNo: "AB100",
      startTime: "08:00",
      endTime: "10:00",
      bookedPassengers: 100,
      positions: [],
      remark: "",
    },
    {
      id: "vacancy-flight",
      flightNo: "CD200",
      startTime: "08:15",
      endTime: "10:15",
      bookedPassengers: 100,
      positions: [],
      remark: "",
    },
  ];
  const baseRule = state.positionRules[0]!;
  const rule = (
    id: string,
    flightNo: string,
    name: string,
    qualifiedStaffIds: string[]
  ): PositionRule => ({
    ...baseRule,
    id,
    flightNo,
    name,
    qualifiedStaffIds,
    category: "常规",
    manual: false,
    minPassengers: 0,
    earlyReleaseMinutes: 0,
    fatiguePoints: 2,
    remark: "",
  });
  state.positionRules = [
    ...(supervisorFill
      ? [
          {
            ...rule("supervisor-rule", "AB100", "督导", ["supervisor"]),
            category: "机动督导" as const,
          },
          rule("fill-rule", "AB100", "H05", ["replacement"]),
        ]
      : []),
    rule("source-rule", "AB100", "H07", ["bridge", "replacement"]),
    rule("anchor-rule", "CD200", "G19", ["anchor"]),
    rule("vacancy-rule", "CD200", "G12", ["bridge", "replacement"]),
  ];
  state.settings.mobileSupervisorFillRules = supervisorFill
    ? [
        {
          id: "configured-fill",
          enabled: true,
          sourceFlightNo: "AB100",
          sourcePositionKeyword: "督导",
          targetFlightNo: "AB100",
          targetPositionKeyword: "H05",
          allowAutomatic: true,
          allowManual: true,
        },
      ]
    : [];
  return state;
}

export function occupiedSnapshot(
  state: ReturnType<typeof vacancyScenario>
): Assignment[] {
  const staffByRule: Record<string, string> = {
    "supervisor-rule": "supervisor",
    "fill-rule": "replacement",
    "source-rule": "bridge",
    "anchor-rule": "anchor",
  };
  return state.positionRules.map((rule) => {
    const flight = state.flights.find((f) => f.flightNo === rule.flightNo)!;
    const staffId = staffByRule[rule.id] ?? null;
    return {
      id: rule.id,
      flightId: flight.id,
      flightNo: flight.flightNo,
      positionRuleId: rule.id,
      position: rule.name,
      staffId,
      staffName: staffId ?? "",
      startTime: flight.startTime,
      endTime: flight.endTime,
      status: staffId ? "assigned" : "unfilled",
      workHours: 2,
      fatiguePoints: 2,
      remark: "",
      manualRemark: "",
    };
  });
}
