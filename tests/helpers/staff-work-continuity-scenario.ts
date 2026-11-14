import {
  dutyFlightCountScenario,
  DUTY_COUNT_DATE,
} from "./duty-flight-count-scenario";
import type { Assignment } from "../../src/model";

export const CONTINUITY_DATE = DUTY_COUNT_DATE;

export function continuityScenario() {
  const { state, rows } = dutyFlightCountScenario();
  state.staff = state.staff.filter((p) => ["peer-a", "peer-b"].includes(p.id));
  state.staff.forEach((p) => {
    p.dutyQualified = false;
  });
  state.dutyRosterOverrides = [];
  state.settings.dutyPositionPriorities = [];
  state.settings.earlyDepartureBalanceEnabled = false;
  state.settings.afternoonRestBalanceEnabled = false;
  const periods = [
    ["08:00", "10:00"],
    ["12:30", "14:30"],
    ["16:00", "18:00"],
    ["20:00", "23:00"],
  ];
  state.flights.forEach((f, i) => {
    f.startTime = periods[i]![0]!;
    f.endTime = periods[i]![1]!;
  });
  state.positionRules = state.flights.map((f, i) => ({
    ...state.positionRules[0]!,
    id: `rule-${i}`,
    flightNo: f.flightNo,
    name: `G${10 + i}`,
    qualifiedStaffIds: state.staff.map((p) => p.id),
  }));
  state.templates = structuredClone(state.flights);
  state.assignments = state.flights.map((f, i): Assignment => {
    const p = state.staff[i === 0 || i === 3 ? 0 : 1]!;
    return {
      ...rows[0]!,
      id: `row-${i}`,
      flightId: f.id,
      flightNo: f.flightNo,
      positionRuleId: `rule-${i}`,
      position: `G${10 + i}`,
      staffId: p.id,
      staffName: p.name,
      startTime: f.startTime,
      endTime: f.endTime,
      workHours: i === 3 ? 3 : 2,
    };
  });
  return state;
}
