import {
  vacancyScenario,
  occupiedSnapshot,
} from "./cross-flight-vacancy-scenario";

export function supervisorIndependenceScenario() {
  const state = vacancyScenario(true);
  state.flights = state.flights.slice(0, 1);
  state.positionRules = state.positionRules.filter(
    (r) => r.flightNo === "AB100"
  );
  state.staff = state.staff.filter((p) => p.id !== "anchor");
  state.settings.crossFlightPriorityPolicies = [];
  state.settings.sameFlightStaffExclusions = [];
  state.positionRules.find((r) => r.id === "source-rule")!.qualifiedStaffIds = [
    "supervisor",
    "bridge",
  ];
  return state;
}

export function beforeSupervisorSnapshot(
  state: ReturnType<typeof supervisorIndependenceScenario>
) {
  const rows = occupiedSnapshot(state).filter(
    (a) => a.positionRuleId !== "supervisor-rule"
  );
  Object.assign(
    rows.find((a) => a.positionRuleId === "source-rule")!,
    {
      staffId: "supervisor",
      staffName: "supervisor",
    }
  );
  return rows;
}
