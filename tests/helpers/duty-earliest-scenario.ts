import { createOrdinarySchedulingState } from "./scheduling-scenario";
import { createAssignedPosition } from "../../src/domain/assignments/assignment-factory";

export const DUTY_EARLIEST_DATE = "2026-11-17";

export function dutyEarliestScenario() {
  const state = createOrdinarySchedulingState();
  state.staff = state.staff.slice(0, 3).map((person, index) => ({
    ...person,
    id: `p${index}`,
    name: `员工${index}`,
    status: "正常" as const,
    staffType: "常规" as const,
    teamLeader: false,
    dutyQualified: true,
    cxPreflightQualified: true,
    standbyQualified: true,
    nightShift: true,
  }));
  state.history = [];
  state.assignments = [];
  state.settings.minimumRegularTransitionMinutes = 0;
  state.settings.lateShiftRecoveryEnabled = false;
  state.settings.highLoadProtectionEnabled = false;
  state.settings.rollingLoadProtectionEnabled = false;
  state.settings.workloadBalanceEnabled = false;
  state.settings.positionTransitionPolicies = [];
  state.settings.crossWorkdayQualificationReservations = [];
  state.settings.ordinaryPriorityPositions = [];
  state.settings.dutyPositionPriorities = [
    { id: "late", flightNo: "ZZ900", positionKeyword: "G01", enabled: true },
  ];
  state.dutyRosterOverrides = [
    {
      date: DUTY_EARLIEST_DATE,
      dutyStaffId: "p0",
      cxPreflightStaffId: "p1",
      standbyStaffIds: ["p1", "p2"],
    },
  ];
  const baseFlight = state.flights[0]!;
  state.flights = [
    { id: "early", flightNo: "AA101", startTime: "07:00", endTime: "10:00" },
    { id: "later", flightNo: "BB102", startTime: "08:00", endTime: "11:00" },
    { id: "late", flightNo: "ZZ900", startTime: "21:00", endTime: "22:00" },
  ].map((flight) => ({
    ...baseFlight,
    ...flight,
    bookedPassengers: 100,
    positions: [],
  }));
  const baseRule = state.positionRules[0]!;
  state.positionRules = state.flights.map((flight) => ({
    ...baseRule,
    id: `r-${flight.id}`,
    flightNo: flight.flightNo,
    name: "G01",
    remark: "",
    category: "常规" as const,
    manual: false,
    minPassengers: 0,
    fatiguePoints: 1,
    qualifiedStaffIds: state.staff.map((person) => person.id),
  }));
  state.activeScheduleDate = DUTY_EARLIEST_DATE;
  return state;
}

export function dutyEarliestAssignments(state = dutyEarliestScenario()) {
  return state.flights.map((flight, index) =>
    createAssignedPosition(
      {
        key: `${flight.id}:r-${flight.id}`,
        flight,
        rule: state.positionRules[index]!,
      },
      state.staff[index === 1 ? 1 : 0]!,
      index === 2 ? 1 : 3,
      [],
      []
    )
  );
}
