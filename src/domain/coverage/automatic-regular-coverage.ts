import type { Assignment } from "../../model";
import type { AssignmentEligibilityFacts } from "../shared/scheduling-facts";
import { assignmentRule } from "../flights/schedule-position-rules";
import { shouldAutoAssign } from "../flights/schedule-tasks";

export function isAutomaticRegularAssignment(
  state: AssignmentEligibilityFacts,
  assignment: Assignment
): boolean {
  const rule = assignmentRule(state, assignment);
  const flight = state.flights.find((f) => f.id === assignment.flightId);
  return Boolean(
    rule &&
    flight &&
    rule.category === "常规" &&
    !rule.manual &&
    shouldAutoAssign(flight, rule, state.settings.adminSupportEnabled, state)
  );
}

/** A repair must fill an existing vacancy without moving any covered hole. */
export function improvesAutomaticRegularCoverage(
  state: AssignmentEligibilityFacts,
  original: readonly Assignment[],
  planned: readonly Assignment[]
): boolean {
  const plannedById = new Map(planned.map((row) => [row.id, row]));
  const covered = (row: Assignment | undefined) =>
    Boolean(row?.status === "assigned" && row.staffId);
  let filled = false;
  for (const before of original) {
    const after = plannedById.get(before.id);
    if (covered(before) && !covered(after)) return false;
    if (!isAutomaticRegularAssignment(state, before)) continue;
    if (before.status === "unfilled" && covered(after)) filled = true;
  }
  return filled;
}
