import type { Flight, PositionRule } from "../../model";
import {
  activeFlightRules,
  isSupervisorPosition,
} from "../flights/schedule-position-rules";
import type { FlightRuleFacts } from "../shared/scheduling-facts";

/** The first displayed position after all supervisor positions. */
export function isDailyPrimaryPosition(
  state: Pick<FlightRuleFacts, "positionRules" | "settings">,
  flight: Flight,
  rule: PositionRule
): boolean {
  const primary = activeFlightRules(state, flight).find(
    (candidate) => !isSupervisorPosition(candidate.name)
  );
  return primary?.id === rule.id;
}
