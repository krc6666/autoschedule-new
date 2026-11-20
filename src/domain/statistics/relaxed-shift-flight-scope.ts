import type { SchedulingFacts } from "../shared/scheduling-facts";
import { normalizeWeeklyFlightNo } from "../flights/weekly-flight-plan";
import { flightIdentityKey } from "../flights/flight-identities";

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
  const rawCandidates = normalizeRelaxedShiftFlights([
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
  const candidates = normalizeRelaxedShiftFlights(
    rawCandidates.map((no) => flightIdentityKey(state, no))
  );
  return {
    candidates,
    selected:
      state.settings.relaxedShiftFlightNumbers === null
        ? normalizeRelaxedShiftFlights(
            rawCandidates
              .filter((no) => /^(MF|CX)\d/.test(no))
              .map((no) => flightIdentityKey(state, no))
          )
        : normalizeRelaxedShiftFlights(
            state.settings.relaxedShiftFlightNumbers.map((no) =>
              flightIdentityKey(state, no)
            )
          ),
  };
}
