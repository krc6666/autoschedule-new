import { createOrdinarySchedulingState } from "./scheduling-scenario";

export function warningScenario() {
  const state = createOrdinarySchedulingState();
  const basePerson = state.staff[0]!;
  state.staff = [1, 2, 3, 4, 5].map((n) => ({
    ...basePerson,
    id: `p${n}`,
    name: `人员${n}`,
    staffType: "常规" as const,
    status: "正常" as const,
    teamLeader: false,
    dutyQualified: false,
    nightShift: true,
  }));
  state.flights = [
    {
      id: "cx",
      flightNo: "CX937（早）",
      startTime: "08:30",
      endTime: "10:30",
      bookedPassengers: 200,
      positions: ["G18"],
      remark: "",
    },
    {
      id: "ke",
      flightNo: "KE166",
      startTime: "09:15",
      endTime: "11:15",
      bookedPassengers: 200,
      positions: ["H03", "H04"],
      remark: "",
    },
  ];
  const baseRule = state.positionRules[0]!;
  state.positionRules = state.flights.flatMap((f) =>
    f.positions.map((position) => ({
      ...baseRule,
      id: `${f.id}-${position}-rule`,
      flightNo: f.flightNo,
      name: position,
      category: "常规" as const,
      remark: f.id === "cx" ? "控制" : "",
      qualifiedStaffIds:
        f.id === "cx" ? ["p1", "p2", "p3", "p4"] : ["p1", "p5"],
      manual: false,
      fatiguePoints: 1,
      minPassengers: 0,
      earlyReleaseMinutes: 0,
    }))
  );
  state.dutyRosterOverrides = [];
  Object.assign(state.settings, {
    positionRotationEnabled: false,
    highLoadProtectionEnabled: false,
    rollingLoadProtectionEnabled: false,
    workloadBalanceEnabled: false,
    lateShiftRecoveryEnabled: true,
    nextWorkdayRecoveryMode: "forbid",
    minimumRegularTransitionMinutes: 0,
    positionTransitionPolicies: [],
    crossFlightPriorityPolicies: [
      { id: "ke-priority", enabled: true, flightNo: "KE166", staffIds: ["p1"] },
    ],
    nextWorkdayRecoveryTargets: [
      {
        id: "cx-recovery",
        enabled: true,
        flightNo: "CX937（早）",
        positionKeyword: "控制",
      },
    ],
  });
  state.history = ["p2", "p3", "p4"].map((staffId, i) => ({
    id: `history-${i}`,
    date: "2026-10-15",
    flightNo: "TR121",
    position: "H02",
    staffId,
    staffName: `人员${i + 2}`,
    startTime: "21:55",
    endTime: "23:55",
    flightCutoffTime: "23:55",
    workHours: 2,
    fatiguePoints: 1,
    remark: "一号",
  }));
  return state;
}
