import type { SchedulingFacts } from "../shared/scheduling-facts";
import { normalizeWeeklyFlightNo } from "../flights/weekly-flight-plan";

export function normalizeRelaxedShiftFlights(
  values: readonly string[]
): string[] {
  return [
    ...new Set(
      values
        .filter((value) => typeof value === "string")
        .map(normalizeWeeklyFlightNo)
        .filter(Boolean)
    ),
  ];
}

export function relaxedShiftFlightScope(state: SchedulingFacts): {
  candidates: string[];
  selected: string[];
} {
  const candidates = normalizeRelaxedShiftFlights([
    ...state.templates.map((f) => f.flightNo),
    ...state.flights.map((f) => f.flightNo),
    ...state.positionRules.map((r) => r.flightNo),
    ...state.history
      .filter((r) => r.flightNo !== "轮值")
      .map((r) => r.flightNo),
    ...state.assignments
      .filter((a) => a.flightNo !== "轮值")
      .map((a) => a.flightNo),
    ...(state.settings.relaxedShiftFlightNumbers ?? []),
  ]);
  return {
    candidates,
    selected:
      state.settings.relaxedShiftFlightNumbers === null
        ? candidates.filter((no) => /^(MF|CX)\d/.test(no))
        : normalizeRelaxedShiftFlights(
            state.settings.relaxedShiftFlightNumbers
          ),
  };
}
