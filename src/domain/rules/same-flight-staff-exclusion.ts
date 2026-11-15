import type { Assignment } from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import type { SameFlightStaffExclusion } from "./structured-policy-contract";

export const SAME_FLIGHT_STAFF_EXCLUSION_RULE_ID =
  "same-flight-staff-exclusion";

export interface SameFlightStaffExclusionViolation {
  exclusion: SameFlightStaffExclusion;
  firstStaffId: string;
  secondStaffId: string;
  flightId: string;
  flightNo: string;
  firstAssignmentIds: string[];
  secondAssignmentIds: string[];
}

/** Compile each group once into the distinct-person conflicts consumed by all paths. */
export function sameFlightStaffExclusionPairs(
  exclusion: SameFlightStaffExclusion
): readonly (readonly [string, string])[] {
  const members = [...new Set(exclusion.staffIds)];
  return members.flatMap((first, index) =>
    members.slice(index + 1).map((second) => [first, second] as const)
  );
}

export function sameFlightStaffExclusionApplies(
  exclusion: SameFlightStaffExclusion,
  flightNo: string
): boolean {
  return (
    exclusion.enabled !== false &&
    (!exclusion.flightNo ||
      exclusion.flightNo.trim().toUpperCase() === flightNo.trim().toUpperCase())
  );
}

export function matchingSameFlightStaffExclusion(
  state: Pick<ScheduleGenerationFacts, "settings">,
  firstStaffId: string,
  secondStaffId: string,
  flightNo: string
): SameFlightStaffExclusion | undefined {
  if (!firstStaffId || !secondStaffId || firstStaffId === secondStaffId)
    return undefined;
  return (state.settings.sameFlightStaffExclusions ?? []).find(
    (exclusion) =>
      sameFlightStaffExclusionApplies(exclusion, flightNo) &&
      exclusion.staffIds.includes(firstStaffId) &&
      exclusion.staffIds.includes(secondStaffId)
  );
}

export function sameFlightStaffExclusionViolations(
  state: Pick<ScheduleGenerationFacts, "settings">,
  assignments: readonly Assignment[]
): SameFlightStaffExclusionViolation[] {
  const assignedByFlight = new Map<string, Assignment[]>();
  for (const assignment of assignments) {
    if (assignment.status !== "assigned" || !assignment.staffId) continue;
    const own = assignedByFlight.get(assignment.flightId) ?? [];
    own.push(assignment);
    assignedByFlight.set(assignment.flightId, own);
  }
  const violations: SameFlightStaffExclusionViolation[] = [];
  for (const [flightId, flightAssignments] of assignedByFlight) {
    const flightNo = flightAssignments[0]?.flightNo ?? "";
    for (const exclusion of state.settings.sameFlightStaffExclusions ?? []) {
      if (!sameFlightStaffExclusionApplies(exclusion, flightNo)) continue;
      for (const [firstStaffId, secondStaffId] of sameFlightStaffExclusionPairs(
        exclusion
      )) {
        const firstAssignmentIds = flightAssignments
          .filter((item) => item.staffId === firstStaffId)
          .map((item) => item.id);
        const secondAssignmentIds = flightAssignments
          .filter((item) => item.staffId === secondStaffId)
          .map((item) => item.id);
        if (!firstAssignmentIds.length || !secondAssignmentIds.length) continue;
        violations.push({
          exclusion,
          firstStaffId,
          secondStaffId,
          flightId,
          flightNo,
          firstAssignmentIds,
          secondAssignmentIds,
        });
      }
    }
  }
  return violations;
}

export function sameFlightStaffExclusionMessage(
  state: Pick<ScheduleGenerationFacts, "staff">,
  violation: SameFlightStaffExclusionViolation
): string {
  return sameFlightStaffExclusionPairMessage(
    state,
    violation.exclusion,
    violation.flightNo,
    violation.firstStaffId,
    violation.secondStaffId
  );
}

export function sameFlightStaffExclusionPairMessage(
  state: Pick<ScheduleGenerationFacts, "staff">,
  exclusion: SameFlightStaffExclusion,
  flightNo: string,
  firstStaffId = exclusion.staffIds[0] ?? "",
  secondStaffId = exclusion.staffIds[1] ?? ""
): string {
  const [first, second] =
    exclusion.staffIds.indexOf(firstStaffId) <=
    exclusion.staffIds.indexOf(secondStaffId)
      ? [firstStaffId, secondStaffId]
      : [secondStaffId, firstStaffId];
  const name = (staffId: string): string =>
    state.staff.find((person) => person.id === staffId)?.name ?? staffId;
  return `${name(first)}与${name(second)}不能同时安排在${flightNo}`;
}
