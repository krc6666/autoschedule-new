import type { Assignment } from "../../model";
import type {
  HistoryRuleFacts,
  AssignmentEligibilityFacts,
} from "../shared/scheduling-facts";
import { improvesAutomaticRegularCoverage } from "../coverage/automatic-regular-coverage";
import type { CrossFlightPriorityPolicy } from "./structured-policy-contract";
import { intervalsOverlap } from "../shared/time";
import type { ScheduleFrequencyFacts } from "../statistics/schedule-frequency";

export function enabledCrossFlightPriorityPolicies(state: HistoryRuleFacts) {
  return state.settings.crossFlightPriorityPolicies.filter(
    (policy) =>
      policy.enabled && policy.flightNo.trim() && policy.staffIds.length
  );
}

export function isCrossFlightPriorityAssignment(
  state: HistoryRuleFacts,
  assignment: Pick<Assignment, "flightNo" | "staffId">
): boolean {
  const flightNo = assignment.flightNo.trim().toUpperCase();
  return enabledCrossFlightPriorityPolicies(state).some((policy) =>
    crossFlightPriorityPolicyMatches(policy, {
      flightNo,
      staffId: assignment.staffId,
    })
  );
}

export function crossFlightPriorityPolicyRank(
  state: HistoryRuleFacts,
  assignment: Pick<Assignment, "flightNo" | "staffId">
): number | null {
  const rank = enabledCrossFlightPriorityPolicies(state).findIndex((policy) =>
    crossFlightPriorityPolicyMatches(policy, assignment)
  );
  return rank < 0 ? null : rank;
}

export function crossFlightPriorityPolicyMatches(
  policy: CrossFlightPriorityPolicy,
  assignment: Pick<Assignment, "flightNo" | "staffId">
): boolean {
  const flightNo = assignment.flightNo.trim().toUpperCase();
  return (
    policy.flightNo === flightNo &&
    Boolean(assignment.staffId) &&
    policy.staffIds.includes(assignment.staffId!)
  );
}

export function crossFlightPriorityReassignmentReasons(
  state: HistoryRuleFacts & AssignmentEligibilityFacts,
  original: readonly Assignment[],
  planned: readonly Assignment[],
  _date: string,
  _frequencyFacts?: ScheduleFrequencyFacts
): string[] {
  if (improvesAutomaticRegularCoverage(state, original, planned)) return [];
  return crossFlightPriorityDisplacedFlights(state, original, planned).map(
    (flightNo) => `调整会把重点人员调离${flightNo}，优先保留原航班安排`
  );
}

export function crossFlightPriorityDisplacedFlights(
  state: HistoryRuleFacts,
  original: readonly Assignment[],
  planned: readonly Assignment[]
): string[] {
  const flights: string[] = [];
  for (const policy of enabledCrossFlightPriorityPolicies(state)) {
    const protectedOriginal = original.filter((assignment) =>
      crossFlightPriorityPolicyMatches(policy, assignment)
    );
    for (const before of protectedOriginal) {
      if (!before.staffId) continue;
      const retainedInPriorityFlight = planned.some(
        (assignment) =>
          assignment.status === "assigned" &&
          assignment.staffId === before.staffId &&
          assignment.flightNo.trim().toUpperCase() === policy.flightNo
      );
      if (retainedInPriorityFlight) continue;
      const replacements = planned.filter(
        (assignment) =>
          assignment.status === "assigned" &&
          assignment.staffId === before.staffId &&
          assignment.flightNo.trim().toUpperCase() !== policy.flightNo &&
          intervalsOverlap(
            assignment.startTime,
            assignment.endTime,
            before.startTime,
            before.endTime
          )
      );
      if (!replacements.length) continue;
      const protectedRank =
        enabledCrossFlightPriorityPolicies(state).indexOf(policy);
      if (
        replacements.some((replacement) => {
          const replacementRank = crossFlightPriorityPolicyRank(
            state,
            replacement
          );
          return replacementRank !== null && replacementRank < protectedRank;
        })
      )
        continue;
      flights.push(policy.flightNo);
    }
  }
  return [...new Set(flights)];
}

export function crossFlightPriorityCandidateScore(
  state: HistoryRuleFacts,
  assignment: Pick<Assignment, "flightNo" | "staffId">
): number {
  return isCrossFlightPriorityAssignment(state, assignment) ? 1 : 0;
}
