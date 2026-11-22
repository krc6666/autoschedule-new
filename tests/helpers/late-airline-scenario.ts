import { airlineMixScenario, AIRLINE_MIX_DATE } from "./airline-mix-scenario";

export const LATE_AIRLINE_DATE = AIRLINE_MIX_DATE;
export function lateAirlineScenario(onlyFdMorning = false) {
  const state = airlineMixScenario();
  const names = ["FD101", onlyFdMorning ? "FD102" : "CX102", "AK103", "TR104"];
  const periods = [
    ["09:40", "11:40"],
    [onlyFdMorning ? "09:40" : "08:30", onlyFdMorning ? "11:40" : "10:30"],
    ["21:05", "23:05"],
    ["21:55", "23:55"],
  ];
  state.flights.forEach((f, i) => {
    Object.assign(f, {
      flightNo: names[i]!,
      startTime: periods[i]![0]!,
      endTime: periods[i]![1]!,
    });
    Object.assign(state.positionRules[i]!, {
      flightNo: f.flightNo,
      name: `G${10 + i}`,
      remark: "",
      fatiguePoints: 1,
    });
    const person = state.staff[i === 0 || i === 3 ? 0 : 1]!;
    Object.assign(state.assignments[i]!, {
      flightNo: f.flightNo,
      startTime: f.startTime,
      endTime: f.endTime,
      workHours: 2,
      fatiguePoints: 1,
      staffId: person.id,
      staffName: person.name,
    });
  });
  state.templates = structuredClone(state.flights);
  state.settings.lateShiftEndTime = "22:00";
  state.settings.latePriorityFlightNumbers = ["AK103", "TR104"];
  state.settings.ordinaryPriorityPositions = [];
  state.history = state.assignments.map((a) => ({
    id: `past-${a.id}`,
    date: "2026-11-12",
    flightNo: a.flightNo,
    position: a.position,
    staffId: a.staffId!,
    staffName: a.staffName,
    startTime: a.startTime,
    endTime: a.endTime,
    workHours: a.workHours,
    fatiguePoints: a.fatiguePoints,
    remark: a.remark,
  }));
  return state;
}
