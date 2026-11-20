import type { Assignment, Flight, PositionRule, Staff } from "../../model";
import {
  flightIdentities,
  flightPositionSource,
  type FlightIdentityFacts,
} from "./flight-identities";
import { normalizeWeeklyFlightNo } from "./weekly-flight-plan";
import { createId } from "../../utils";
import { durationHours } from "../shared/time";
import type {
  FlightRuleFacts,
  ScheduleGenerationFacts,
} from "../shared/scheduling-facts";

export function isAuxiliaryCategory(
  category: PositionRule["category"] | undefined
): boolean {
  return category === "行政支援";
}

export function isFixedBottomPosition(position: string): boolean {
  return position.includes("引导") && !position.includes("督导");
}

/** A guide-shaped diversion position is movable only in the team-leader gap-fill path. */
export function isGapFillGuidePosition(
  rule: Pick<PositionRule, "category" | "name">
): boolean {
  return (
    rule.category === "引导" ||
    (rule.category === "分流" && isFixedBottomPosition(rule.name))
  );
}

export function isSupervisorPosition(position: string): boolean {
  return position.includes("督导");
}

export function assignmentRule(
  state: Pick<FlightRuleFacts, "positionRules">,
  assignment: Assignment
): PositionRule | undefined {
  return assignment.positionRuleId
    ? state.positionRules.find((rule) => rule.id === assignment.positionRuleId)
    : undefined;
}

export function isGuideAssignment(
  state: Pick<FlightRuleFacts, "positionRules">,
  assignment: Assignment
): boolean {
  return assignmentRule(state, assignment)?.category === "引导";
}

export function guideSourceStaff(
  state: Pick<ScheduleGenerationFacts, "positionRules" | "staff">,
  assignment: Assignment
): Staff | undefined {
  if (assignment.status !== "assigned" || !assignment.staffId) return undefined;
  const category = assignmentRule(state, assignment)?.category;
  if (category === "引导") return undefined;
  const person = state.staff.find((item) => item.id === assignment.staffId);
  return person?.status === "正常" && person.staffType === "常规"
    ? person
    : undefined;
}

export function isIndependentGuideAssignment(
  state: Pick<FlightRuleFacts, "positionRules">,
  assignment: Assignment
): boolean {
  return (
    isGuideAssignment(state, assignment) &&
    assignment.guideMode === "independent"
  );
}

/** Project the manual choice before checking conflicts/hours or committing it. */
export function manualGuideAssignment(
  state: Pick<
    ScheduleGenerationFacts,
    "positionRules" | "staff" | "assignments"
  >,
  assignment: Assignment,
  staffId: string
): Assignment {
  if (!isGuideAssignment(state, assignment)) return assignment;
  // Other counter edits must not silently change an explicit independent duty.
  const independent =
    (isIndependentGuideAssignment(state, assignment) &&
      assignment.staffId === staffId) ||
    !state.assignments.some(
      (source) =>
        source.id !== assignment.id &&
        source.flightId === assignment.flightId &&
        guideSourceStaff(state, source)?.id === staffId
    );
  const result = { ...assignment, staffId };
  if (independent) result.guideMode = "independent";
  else delete result.guideMode;
  result.status = independent ? "assigned" : "manual";
  Object.assign(result, guideAssignmentWorkload(state, result));
  return result;
}

export function guideAssignmentWorkload(
  state: Pick<FlightRuleFacts, "positionRules">,
  assignment: Assignment
): Pick<Assignment, "workHours" | "fatiguePoints"> {
  return isIndependentGuideAssignment(state, assignment)
    ? {
        workHours: durationHours(assignment.startTime, assignment.endTime),
        fatiguePoints: assignmentRule(state, assignment)!.fatiguePoints,
      }
    : { workHours: 0, fatiguePoints: 0 };
}

/** A guide can legally reuse its regular-counter source on the same flight. */
export function isLegalGuideReuse(
  state: Pick<ScheduleGenerationFacts, "positionRules" | "staff">,
  left: Assignment,
  right: Assignment
): boolean {
  if (
    !left.staffId ||
    left.staffId !== right.staffId ||
    left.flightId !== right.flightId
  )
    return false;
  return (
    (isReusableAssignment(state, left) &&
      guideSourceStaff(state, right)?.id === left.staffId) ||
    (isReusableAssignment(state, right) &&
      guideSourceStaff(state, left)?.id === right.staffId)
  );
}

export function compareGuideSourceAssignments(
  state: Pick<FlightRuleFacts, "positionRules">,
  displayIndex: ReadonlyMap<string, number>,
  left: Assignment,
  right: Assignment
): number {
  const leftAdministrative =
    assignmentRule(state, left)?.category === "行政支援";
  const rightAdministrative =
    assignmentRule(state, right)?.category === "行政支援";
  return (
    Number(rightAdministrative) - Number(leftAdministrative) ||
    (displayIndex.get(right.positionRuleId ?? "") ?? -1) -
      (displayIndex.get(left.positionRuleId ?? "") ?? -1)
  );
}

export function isReusableAssignment(
  state: Pick<FlightRuleFacts, "positionRules">,
  assignment: Assignment
): boolean {
  return (
    isGuideAssignment(state, assignment) &&
    !isIndependentGuideAssignment(state, assignment)
  );
}

export function makeUnfilled(
  flight: Flight,
  position: string,
  rule: PositionRule | undefined
): Assignment {
  return {
    id: createId("assignment"),
    flightId: flight.id,
    flightNo: flight.flightNo,
    positionRuleId: rule?.id ?? null,
    position,
    staffId: null,
    staffName: "",
    startTime: flight.startTime,
    endTime: flight.endTime,
    workHours: durationHours(flight.startTime, flight.endTime),
    fatiguePoints:
      rule?.fatiguePoints ?? durationHours(flight.startTime, flight.endTime),
    remark: rule?.remark ?? "未找到岗位规则",
    manualRemark: "",
    status:
      rule?.manual || isAuxiliaryCategory(rule?.category)
        ? "manual"
        : "unfilled",
  };
}

export function activeFlightRules(
  state: Pick<FlightRuleFacts, "positionRules" | "settings"> &
    FlightIdentityFacts,
  flight: Flight
): PositionRule[] {
  // Exact jobs are the common path and keep their independent qualifications.
  // Resolve/normalize directory sources only when this actual number has no jobs.
  let flightRules = state.positionRules.filter(
    (rule) => rule.flightNo === flight.flightNo
  );
  if (!flightRules.length && flightIdentities(state).length) {
    const requested = normalizeWeeklyFlightNo(flight.flightNo);
    flightRules = state.positionRules.filter(
      (rule) => normalizeWeeklyFlightNo(rule.flightNo) === requested
    );
    if (!flightRules.length) {
      const source = normalizeWeeklyFlightNo(
        flightPositionSource(state, flight.flightNo)
      );
      flightRules = state.positionRules.filter(
        (rule) => normalizeWeeklyFlightNo(rule.flightNo) === source
      );
    }
  }
  const administrativePositions = new Set(
    flightRules
      .filter((rule) => rule.category === "行政支援")
      .map((rule) => rule.name.trim())
  );
  const configured = state.settings.adminSupportEnabled
    ? flightRules
        .filter(
          (rule) =>
            rule.category === "行政支援" ||
            !administrativePositions.has(rule.name.trim())
        )
        .map((rule) => administrativeSupportAutomaticRule(state, rule))
    : flightRules.filter((rule) => rule.category !== "行政支援");
  const primary = configured.filter(
    (rule) => rule.category !== "引导" && !isFixedBottomPosition(rule.name)
  );
  const fixedBottom = configured.filter(
    (rule) => rule.category === "引导" || isFixedBottomPosition(rule.name)
  );
  const orderedPrimary = primary
    .map((rule, index) => ({ rule, index }))
    .sort(
      (left, right) =>
        Number(
          right.rule.category === "机动督导" ||
            isSupervisorPosition(right.rule.name)
        ) -
          Number(
            left.rule.category === "机动督导" ||
              isSupervisorPosition(left.rule.name)
          ) || left.index - right.index
    )
    .map(({ rule }) => rule);
  return [...orderedPrimary, ...fixedBottom];
}

export function administrativeSupportAutomaticRule(
  state: Pick<FlightRuleFacts, "positionRules">,
  rule: PositionRule
): PositionRule {
  if (rule.category !== "行政支援") return rule;
  const regularCounterpartStaffIds = state.positionRules
    .filter(
      (candidate) =>
        candidate.flightNo === rule.flightNo &&
        candidate.name.trim() === rule.name.trim() &&
        candidate.category === "常规"
    )
    .flatMap((candidate) => candidate.qualifiedStaffIds);
  const qualifiedStaffIds = [
    ...new Set([...rule.qualifiedStaffIds, ...regularCounterpartStaffIds]),
  ];
  return qualifiedStaffIds.length === rule.qualifiedStaffIds.length &&
    qualifiedStaffIds.every(
      (staffId, index) => staffId === rule.qualifiedStaffIds[index]
    )
    ? rule
    : { ...rule, qualifiedStaffIds };
}

export function activeFlightPositions(
  state: Pick<FlightRuleFacts, "positionRules" | "settings"> &
    FlightIdentityFacts,
  flight: Flight
): string[] {
  return activeFlightRules(state, flight).map((rule) => rule.name);
}
