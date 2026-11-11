import { addMissingRuleFlightTemplates } from "../domain/flights/template-position-rules";
import type { AppState, Flight, FlightTemplate, PositionRule } from "../model";
import { normalizeWeeklyFlightNo } from "../domain/flights/weekly-flight-plan";

/** Add imported group flights to the shared template, keeping group rule values independent. */
export function synchronizeImportedRuleFlightsToTemplates(
  state: AppState,
  importedRules: readonly PositionRule[],
  importedFlights: readonly Flight[] = [],
  importedTemplates: readonly FlightTemplate[] = []
): FlightTemplate[] {
  if (!importedRules.length) return [];
  const importedFlightNos = new Set(
    importedRules
      .map((rule) => normalizeWeeklyFlightNo(rule.flightNo))
      .filter(Boolean)
  );
  const allGroupRules = (["A", "B"] as const).flatMap((groupId) =>
    groupId === state.activeGroupId
      ? state.positionRules
      : state.groups[groupId].positionRules
  );
  const positionRules = allGroupRules.filter((rule) =>
    importedFlightNos.has(normalizeWeeklyFlightNo(rule.flightNo))
  );
  const result = addMissingRuleFlightTemplates(
    state.templates,
    importedRules,
    positionRules,
    [
      ...importedFlights,
      ...importedTemplates,
      ...state.flights,
      ...state.groups.A.flights,
      ...state.groups.B.flights,
    ]
  );
  if (!result.added.length) return [];
  state.templates = result.templates;
  state.shared.templates = result.templates;
  return result.added;
}
