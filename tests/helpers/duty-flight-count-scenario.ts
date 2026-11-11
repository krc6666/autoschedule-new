import { createSchedulingScenario } from "./scheduling-scenario";
import type { Assignment, Flight, PositionRule } from "../../src/model";

export const DUTY_COUNT_DATE = "2026-11-14";

export function dutyFlightCountScenario(extraFlights = 0) {
  const state = createSchedulingScenario();
  const baseStaff = state.staff[0]!;
  state.staff = ["duty", "peer-a", "peer-b", "peer-c"].map((id) => ({
    ...baseStaff,
    id,
    name: id,
    status: "正常",
    staffType: "常规",
    teamLeader: false,
    nightShift: true,
    dutyQualified: true,
  }));
  const periods = [
    ["08:00", "09:00"],
    ["12:30", "13:30"],
    ["16:00", "17:00"],
    ["21:00", "22:00"],
  ];
  state.flights = periods.map(([startTime, endTime], i): Flight => ({
    id: `flight-${i}`,
    flightNo: `TEST${i}`,
    startTime: startTime!,
    endTime: endTime!,
    bookedPassengers: 100,
    positions: [],
    remark: "",
  }));
  const baseRule = state.positionRules[0]!;
  state.positionRules = state.flights.flatMap((f, i) =>
    Array.from(
      { length: i === 0 || i === 3 ? 4 : 3 },
      (_, j): PositionRule => ({
        ...baseRule,
        id: `${f.id}-rule-${j}`,
        flightNo: f.flightNo,
        name: `G${10 + j}`,
        category: "常规",
        manual: false,
        remark: "",
        minPassengers: 0,
        fatiguePoints: 1,
        earlyReleaseMinutes: 0,
        qualifiedStaffIds: state.staff.map((p) => p.id),
      })
    )
  );
  for (let i = 0; i < extraFlights; i++) {
    state.flights.push({
      ...state.flights[0]!,
      id: `unused-${i}`,
      flightNo: `UNUSED${i}`,
      positions: [],
    });
  }
  state.templates = state.flights.map((f) => ({ ...f }));
  state.history = [];
  state.assignments = [];
  state.settings.positionTransitionPolicies = [];
  state.settings.crossWorkdayQualificationReservations = [];
  state.settings.latePriorityFlightNumbers = [];
  state.settings.ordinaryPriorityPositions = [];
  state.settings.mobileSupervisorFillRules = [];
  state.settings.minimumRegularTransitionMinutes = 0;
  state.settings.highLoadProtectionEnabled = false;
  state.settings.rollingLoadProtectionEnabled = false;
  state.settings.workloadBalanceEnabled = false;
  state.settings.dutyPositionPriorities = [
    {
      id: "duty-late",
      enabled: true,
      flightNo: "TEST3",
      positionKeyword: "G10",
    },
  ];
  state.dutyRosterOverrides = [
    {
      date: DUTY_COUNT_DATE,
      dutyStaffId: "duty",
      cxPreflightStaffId: "peer-a",
      standbyStaffIds: ["peer-b", "peer-c"],
    },
  ];
  const rows: Assignment[] = state.positionRules.map((r) => {
    const f = state.flights.find((f) => f.flightNo === r.flightNo)!;
    const j = Number(r.id.split("-").at(-1));
    const hasDuty = f.id === "flight-0" || f.id === "flight-3";
    const p = state.staff[j + (hasDuty ? 0 : 1)]!;
    return {
      id: `assignment-${r.id}`,
      flightId: f.id,
      flightNo: f.flightNo,
      positionRuleId: r.id,
      position: r.name,
      staffId: p.id,
      staffName: p.name,
      startTime: f.startTime,
      endTime: f.endTime,
      workHours: 1,
      fatiguePoints: 1,
      status: "assigned",
      remark: "",
      manualRemark: "",
    };
  });
  return { state, rows };
}
