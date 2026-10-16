import type { Assignment, Flight, PositionRule, Staff } from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import type { SchedulingDecision } from "../rules/schedule-rule-contract";
import {
  analyzeAutomaticEligibilityPool,
  diagnoseAutomaticStaffEligibility,
  eligibleStaffForRule,
} from "../candidates/assignment-eligibility";
import { canMobileSupervisorCoverPosition } from "./mobile-supervisor-coverage";
import {
  activeFlightRules,
  assignmentRule,
  compareGuideSourceAssignments,
  guideSourceStaff,
} from "../flights/schedule-position-rules";
import { positionTransitionInsertionCost } from "../reviews/schedule-protection";
import { isPreNoonFlight } from "../flights/schedule-tasks";
import { schedulingDecision } from "../rules/schedule-rule-contract";
import { durationHours } from "../shared/time";
import type { ScheduleFrequencyFacts } from "../statistics/schedule-frequency";
import type { HalfRestFacts } from "../rules/half-rest";
import { halfRestPeriodViolation } from "../rules/half-rest";
import { exceedsTr121NumberOneAutomaticLimit } from "../statistics/late-priority-frequency";
import { isOrdinaryPriorityPosition } from "../reviews/position-rotation-policy";
import {
  clearSupervisorFillLink,
  setSupervisorFillLink,
} from "./supervisor-fill-facts";
import { clearAutomaticVacancyEvidence } from "../assignments/vacancy-evidence";

export function preNoonShortageNote(
  state: ScheduleGenerationFacts,
  assignments: Assignment[],
  flight: Flight,
  rule: PositionRule
): string {
  const pool = analyzeAutomaticEligibilityPool({
    state,
    assignments,
    flight,
    rule,
  });
  const reasons = pool.configured.map((person) => {
    const diagnostic = diagnoseAutomaticStaffEligibility({
      state,
      assignments,
      flight,
      rule,
      person,
      transitionMode: "forbid",
      ignoreSameFlightReusable: true,
    });
    return diagnostic.violations.length
      ? diagnostic.violations.map((v) => v.message).join("；")
      : `${person.name}：当前直接检查可通过，完整换人方案的具体原因未记录`;
  });
  return `空岗：${reasons.join("；") || "岗位资质名单无当前常规人员（0人）"}；这里只核对当前直接安排，不代表多岗换人无解`;
}

interface RegularPlacement {
  person: Staff;
  sourceAssignment: Assignment;
  sourceRule: PositionRule;
  originalIndex: number;
  manualRemark: string;
  decisionTrace: SchedulingDecision[] | undefined;
  supervisorSourceAssignmentId: string | undefined;
}

interface RegularSlot {
  assignment: Assignment;
  rule: PositionRule;
}

function canMoveRegularPlacement(
  state: ScheduleGenerationFacts,
  assignments: Assignment[],
  flight: Flight,
  placement: RegularPlacement,
  targetRule: PositionRule,
  date: string,
  frequencyFacts: ScheduleFrequencyFacts,
  halfRestFacts?: HalfRestFacts
): boolean {
  if (
    halfRestFacts &&
    halfRestPeriodViolation({
      facts: halfRestFacts,
      staffId: placement.person.id,
      startTime: flight.startTime,
    })
  )
    return false;
  if (
    exceedsTr121NumberOneAutomaticLimit(
      state,
      placement.person.id,
      flight.flightNo,
      targetRule,
      date,
      frequencyFacts
    )
  )
    return false;
  if (
    !eligibleStaffForRule(state, flight, targetRule).some(
      (person) => person.id === placement.person.id
    )
  )
    return false;
  if (
    placement.supervisorSourceAssignmentId &&
    !canMobileSupervisorCoverPosition(state, {
      flightNo: flight.flightNo,
      position: targetRule.name,
      remark: targetRule.remark,
    })
  )
    return false;
  const otherFlights = assignments.filter(
    (assignment) => assignment.flightId !== flight.id
  );
  const sourceCost = positionTransitionInsertionCost(
    otherFlights,
    placement.person.id,
    {
      key: `${flight.id}:${placement.sourceRule.id}`,
      flight,
      rule: placement.sourceRule,
    },
    state,
    "forbid"
  );
  const targetCost = positionTransitionInsertionCost(
    otherFlights,
    placement.person.id,
    { key: `${flight.id}:${targetRule.id}`, flight, rule: targetRule },
    state,
    "forbid"
  );
  return targetCost <= sourceCost;
}

function canMatchEveryPlacement(
  placements: RegularPlacement[],
  slots: RegularSlot[],
  canPlace: (placement: RegularPlacement, slot: RegularSlot) => boolean
): boolean {
  return matchEveryPlacement(placements, slots, canPlace) !== null;
}

function matchEveryPlacement(
  placements: RegularPlacement[],
  slots: RegularSlot[],
  canPlace: (placement: RegularPlacement, slot: RegularSlot) => boolean
): Map<string, RegularPlacement> | null {
  if (placements.length > slots.length) return null;
  const placementById = new Map(
    placements.map((placement) => [placement.sourceAssignment.id, placement])
  );
  const matchedPlacementBySlot = new Map<string, string>();

  const tryMatch = (
    placement: RegularPlacement,
    visitedSlots: Set<string>
  ): boolean => {
    for (const slot of slots) {
      if (visitedSlots.has(slot.assignment.id) || !canPlace(placement, slot))
        continue;
      visitedSlots.add(slot.assignment.id);
      const matchedId = matchedPlacementBySlot.get(slot.assignment.id);
      const matched = matchedId ? placementById.get(matchedId) : undefined;
      if (!matched || tryMatch(matched, visitedSlots)) {
        matchedPlacementBySlot.set(
          slot.assignment.id,
          placement.sourceAssignment.id
        );
        return true;
      }
    }
    return false;
  };

  const matched = [...placements]
    .sort((left, right) => left.originalIndex - right.originalIndex)
    .every((placement) => tryMatch(placement, new Set()));
  if (!matched) return null;
  return new Map(
    [...matchedPlacementBySlot].map(([slotId, placementId]) => [
      slotId,
      placementById.get(placementId)!,
    ])
  );
}

function canCoverRegularSlots(
  placements: RegularPlacement[],
  allSlots: RegularSlot[],
  requiredSlots: RegularSlot[],
  canPlace: (placement: RegularPlacement, slot: RegularSlot) => boolean
): boolean {
  if (requiredSlots.length > placements.length) return false;
  const requiredIds = new Set(requiredSlots.map((slot) => slot.assignment.id));
  const optionalSlots = allSlots.filter(
    (slot) => !requiredIds.has(slot.assignment.id)
  );
  const memo = new Map<string, boolean>();

  const search = (
    requiredIndex: number,
    usedPlacementIds: Set<string>
  ): boolean => {
    const key = `${requiredIndex}:${[...usedPlacementIds].sort().join(",")}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    if (requiredIndex >= requiredSlots.length) {
      const remaining = placements.filter(
        (placement) => !usedPlacementIds.has(placement.sourceAssignment.id)
      );
      const result = canMatchEveryPlacement(remaining, optionalSlots, canPlace);
      memo.set(key, result);
      return result;
    }
    const requiredSlot = requiredSlots[requiredIndex]!;
    const result = placements.some((placement) => {
      if (
        usedPlacementIds.has(placement.sourceAssignment.id) ||
        !canPlace(placement, requiredSlot)
      )
        return false;
      const nextUsed = new Set(usedPlacementIds);
      nextUsed.add(placement.sourceAssignment.id);
      return search(requiredIndex + 1, nextUsed);
    });
    memo.set(key, result);
    return result;
  };

  return search(0, new Set());
}

export function compactRegularAssignments(
  state: ScheduleGenerationFacts,
  assignments: Assignment[],
  lockedAssignmentIds: ReadonlySet<string>,
  date: string,
  frequencyFacts: ScheduleFrequencyFacts,
  halfRestFacts?: HalfRestFacts
): Set<string> {
  const changedFlightIds = new Set<string>();

  for (const flight of state.flights) {
    const orderedRules = activeFlightRules(state, flight).filter(
      (rule) => rule.category === "常规"
    );
    const slots = orderedRules
      .map((rule) => ({
        rule,
        assignment: assignments.find(
          (assignment) =>
            assignment.flightId === flight.id &&
            assignment.positionRuleId === rule.id
        ),
      }))
      .filter((slot): slot is RegularSlot =>
        Boolean(slot.assignment && slot.assignment.status !== "manual")
      );
    const firstVacancy = slots.findIndex(
      (slot, index) =>
        slot.assignment.status !== "assigned" &&
        slots
          .slice(index + 1)
          .some((later) => later.assignment.status === "assigned")
    );
    if (firstVacancy < 0) continue;

    const tailSlots = slots;
    const placements = tailSlots
      .map((slot, index) => {
        if (slot.assignment.status !== "assigned" || !slot.assignment.staffId)
          return null;
        const person = state.staff.find(
          (item) => item.id === slot.assignment.staffId
        );
        return person
          ? {
              person,
              sourceAssignment: slot.assignment,
              sourceRule: slot.rule,
              originalIndex: index,
              manualRemark: slot.assignment.manualRemark,
              decisionTrace: slot.assignment.decisionTrace,
              supervisorSourceAssignmentId:
                slot.assignment.supervisorSourceAssignmentId,
            }
          : null;
      })
      .filter((placement): placement is RegularPlacement => Boolean(placement));
    const canPlace = (placement: RegularPlacement, slot: RegularSlot) => {
      if (
        isOrdinaryPriorityPosition(
          placement.sourceRule,
          state.settings.ordinaryPriorityPositions
        ) &&
        placement.sourceAssignment.id !== slot.assignment.id
      )
        return false;
      if (
        lockedAssignmentIds.has(placement.sourceAssignment.id) &&
        placement.sourceAssignment.id !== slot.assignment.id
      )
        return false;
      if (
        lockedAssignmentIds.has(slot.assignment.id) &&
        placement.sourceAssignment.id !== slot.assignment.id
      )
        return false;
      return canMoveRegularPlacement(
        state,
        assignments,
        flight,
        placement,
        slot.rule,
        date,
        frequencyFacts,
        halfRestFacts
      );
    };
    const occupiedSlots: RegularSlot[] = [];
    for (const slot of tailSlots) {
      if (
        canCoverRegularSlots(
          placements,
          tailSlots,
          [...occupiedSlots, slot],
          canPlace
        )
      )
        occupiedSlots.push(slot);
      if (occupiedSlots.length === placements.length) break;
    }
    const placementBySlot = matchEveryPlacement(
      placements,
      occupiedSlots,
      canPlace
    );
    if (!placementBySlot) continue;
    const changed = tailSlots.some(
      (slot) =>
        placementBySlot.get(slot.assignment.id)?.sourceAssignment.id !==
          slot.assignment.id &&
        (placementBySlot.has(slot.assignment.id) ||
          slot.assignment.status === "assigned")
    );
    if (!changed) continue;

    for (const slot of tailSlots) {
      const placement = placementBySlot.get(slot.assignment.id);
      delete slot.assignment.systemNotes;
      delete slot.assignment.decisionTrace;
      clearSupervisorFillLink(slot.assignment);
      if (!placement) {
        slot.assignment.staffId = null;
        slot.assignment.staffName = "";
        slot.assignment.workHours = durationHours(
          flight.startTime,
          flight.endTime
        );
        slot.assignment.manualRemark = "";
        slot.assignment.status = "unfilled";
        continue;
      }
      clearAutomaticVacancyEvidence(slot.assignment);
      slot.assignment.staffId = placement.person.id;
      slot.assignment.staffName = placement.person.name;
      slot.assignment.workHours = placement.supervisorSourceAssignmentId
        ? 0
        : durationHours(flight.startTime, flight.endTime);
      slot.assignment.manualRemark = placement.manualRemark;
      slot.assignment.status = "assigned";
      slot.assignment.decisionTrace =
        placement.sourceAssignment.id === slot.assignment.id
          ? placement.decisionTrace
          : [
              ...(placement.decisionTrace ?? []),
              schedulingDecision(
                "position-compaction",
                "selected",
                `为保持${flight.flightNo}岗位连续性，从${placement.sourceRule.name}调整至${slot.rule.name}`
              ),
            ];
      if (placement.supervisorSourceAssignmentId) {
        setSupervisorFillLink(
          slot.assignment,
          placement.supervisorSourceAssignmentId
        );
      }
    }
    changedFlightIds.add(flight.id);
  }

  for (const flightId of changedFlightIds) {
    const flight = state.flights.find((item) => item.id === flightId)!;
    const displayRules = activeFlightRules(state, flight);
    const displayIndex = new Map(
      displayRules.map((rule, index) => [rule.id, index])
    );
    const guideSources = assignments
      .filter((assignment) => assignment.flightId === flightId)
      .map((assignment) => ({
        assignment,
        person: guideSourceStaff(state, assignment),
      }))
      .filter(
        (
          item
        ): item is typeof item & {
          person: NonNullable<typeof item.person>;
        } => Boolean(item.person)
      )
      .sort((left, right) =>
        compareGuideSourceAssignments(
          state,
          displayIndex,
          left.assignment,
          right.assignment
        )
      );
    const usedStaffIds = new Set<string>();
    assignments
      .filter(
        (assignment) =>
          assignment.flightId === flightId &&
          assignmentRule(state, assignment)?.category === "引导"
      )
      .sort(
        (left, right) =>
          (displayIndex.get(left.positionRuleId ?? "") ?? 0) -
          (displayIndex.get(right.positionRuleId ?? "") ?? 0)
      )
      .forEach((guide) => {
        const source = guideSources.find(
          (item) => !usedStaffIds.has(item.person.id)
        );
        guide.staffId = source?.person.id ?? null;
        guide.staffName = source?.person.name ?? "";
        guide.workHours = 0;
        guide.status = source ? "assigned" : "unfilled";
        delete guide.systemNotes;
        clearAutomaticVacancyEvidence(guide);
        if (source) usedStaffIds.add(source.person.id);
      });
  }

  assignments
    .filter(
      (assignment) =>
        changedFlightIds.has(assignment.flightId) &&
        assignment.status === "unfilled" &&
        isPreNoonFlight(assignment) &&
        assignmentRule(state, assignment)?.category === "常规"
    )
    .forEach((assignment) => {
      if (assignment.vacancyEvidence) return;
      const flight = state.flights.find(
        (item) => item.id === assignment.flightId
      )!;
      const rule = assignmentRule(state, assignment)!;
      assignment.systemNotes = [
        preNoonShortageNote(state, assignments, flight, rule),
      ];
    });

  return changedFlightIds;
}
