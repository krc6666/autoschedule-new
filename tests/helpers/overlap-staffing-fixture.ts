import { createDefaultState } from "../../src/defaults";
import type { Assignment } from "../../src/model";

export function overlapStaffingFixture() {
  const state = createDefaultState();
  const baseStaff = state.staff.find((person) => person.staffType === "常规")!;
  state.staff = ["员工甲", "员工乙", "员工丙", "员工丁"].map((name, index) => ({
    ...baseStaff,
    id: `p${index}`,
    name,
    status: "正常" as const,
    teamLeader: false,
    nightShift: true,
  }));
  state.activeScheduleDate = "2026-11-18";
  state.history = [];
  state.halfRestSelections = [];
  state.settings.minimumRegularTransitionMinutes = 0;
  state.settings.positionTransitionPolicies = [];
  state.settings.lateShiftRecoveryEnabled = false;
  state.settings.maxDailyHours = 24;
  state.flights = [
    {
      id: "a",
      flightNo: "AA101",
      startTime: "08:00",
      endTime: "10:00",
      bookedPassengers: 100,
      positions: ["G01"],
      remark: "",
    },
    {
      id: "b",
      flightNo: "BB102",
      startTime: "09:00",
      endTime: "11:00",
      bookedPassengers: 100,
      positions: ["H01"],
      remark: "",
    },
  ];
  const baseRule = state.positionRules[0]!;
  state.positionRules = state.flights.map((flight, index) => ({
    ...baseRule,
    id: `r${index}`,
    flightNo: flight.flightNo,
    name: index ? "H01" : "G01",
    category: "常规" as const,
    manual: false,
    minPassengers: 0,
    qualifiedStaffIds: state.staff.map((person) => person.id),
  }));
  state.assignments = state.flights.map((flight, index): Assignment => ({
    id: `t${index}`,
    flightId: flight.id,
    flightNo: flight.flightNo,
    positionRuleId: `r${index}`,
    position: index ? "H01" : "G01",
    staffId: index ? "p0" : null,
    staffName: index ? "员工甲" : "",
    startTime: flight.startTime,
    endTime: flight.endTime,
    workHours: 2,
    fatiguePoints: 1,
    remark: "",
    manualRemark: "",
    status: index ? "assigned" : "unfilled",
  }));
  return state;
}
