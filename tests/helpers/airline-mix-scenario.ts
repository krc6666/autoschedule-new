import {
  continuityScenario,
  CONTINUITY_DATE,
} from "./staff-work-continuity-scenario";

export const AIRLINE_MIX_DATE = CONTINUITY_DATE;

export function airlineMixScenario() {
  const state = continuityScenario();
  const names = ["FD101", "AK102", "CX103", "TR104"];
  const periods = [
    ["08:00", "10:00"],
    ["12:30", "14:30"],
    ["12:30", "14:30"],
    ["16:00", "18:00"],
  ];
  state.flights.forEach((f, i) => {
    f.flightNo = names[i]!;
    f.startTime = periods[i]![0]!;
    f.endTime = periods[i]![1]!;
    state.positionRules[i]!.flightNo = f.flightNo;
    const row = state.assignments[i]!;
    const person = state.staff[i < 2 ? 0 : 1]!;
    Object.assign(row, {
      flightNo: f.flightNo,
      startTime: f.startTime,
      endTime: f.endTime,
      workHours: 2,
      staffId: person.id,
      staffName: person.name,
    });
  });
  state.templates = structuredClone(state.flights);
  return state;
}
