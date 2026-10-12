import type { Assignment, Flight, PositionRule } from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import type { CrossWorkdayQualificationReservation } from "../rules/structured-policy-contract";
import {
  operationalAssignmentInterval,
  operationalTaskInterval,
  type OperationalWorkInterval,
} from "../assignments/minimum-flight-transition";
import { timeToMinutes } from "../shared/time";

export interface CrossWorkdayReservationTarget {
  reservation: CrossWorkdayQualificationReservation;
  positionRules: PositionRule[];
  qualifiedStaffIds: Set<string>;
  interval: OperationalWorkInterval | null;
}

export interface CrossWorkdayReservationStatus {
  target: CrossWorkdayReservationTarget;
  preservedStaffIds: string[];
  shortfall: number;
}

function normalized(value: string): string {
  return value.trim().toUpperCase();
}

export function matchingPositionRules(
  state: Pick<ScheduleGenerationFacts, "positionRules">,
  reservation: CrossWorkdayQualificationReservation
): PositionRule[] {
  const flightNo = normalized(reservation.flightNo);
  const keyword = normalized(reservation.keyword);
  if (!flightNo || !keyword) return [];
  return state.positionRules.filter((rule) => {
    if (normalized(rule.flightNo) !== flightNo) return false;
    const value =
      reservation.matchField === "position" ? rule.name : rule.remark;
    return normalized(value).includes(keyword);
  });
}

function targetFlight(
  state: ScheduleGenerationFacts,
  flightNo: string
): Flight | undefined {
  const normalizedFlightNo = normalized(flightNo);
  const current = state.flights.find(
    (flight) => normalized(flight.flightNo) === normalizedFlightNo
  );
  if (current) return current;
  const template = state.templates.find(
    (flight) => normalized(flight.flightNo) === normalizedFlightNo
  );
  return template ? { ...template, bookedPassengers: 0 } : undefined;
}

function targetInterval(
  state: ScheduleGenerationFacts,
  reservation: CrossWorkdayQualificationReservation,
  rules: readonly PositionRule[]
): OperationalWorkInterval | null {
  const flight = targetFlight(state, reservation.flightNo);
  const rule = rules[0];
  return flight && rule ? operationalTaskInterval(state, flight, rule) : null;
}

export function crossWorkdayReservationTargets(
  state: ScheduleGenerationFacts
): CrossWorkdayReservationTarget[] {
  return state.settings.crossWorkdayQualificationReservations
    .filter((reservation) => reservation.enabled)
    .map((reservation) => {
      const positionRules = matchingPositionRules(state, reservation);
      const configuredStaffIds = new Set(
        positionRules.flatMap((rule) => rule.qualifiedStaffIds)
      );
      const qualifiedStaffIds = new Set(
        state.staff
          .filter(
            (person) =>
              person.status === "正常" &&
              person.staffType === "常规" &&
              configuredStaffIds.has(person.id)
          )
          .map((person) => person.id)
      );
      return {
        reservation,
        positionRules,
        qualifiedStaffIds,
        interval: targetInterval(state, reservation, positionRules),
      };
    });
}

function operationalCutoff(state: ScheduleGenerationFacts): number {
  const cutoff = timeToMinutes(state.settings.lateShiftEndTime);
  const boundary = timeToMinutes(state.settings.nightEnd);
  return cutoff < boundary ? cutoff + 24 * 60 : cutoff;
}

export function assignmentConsumesCrossWorkdayReservation(
  state: ScheduleGenerationFacts,
  assignment: Assignment
): boolean {
  return (
    assignment.status === "assigned" &&
    Boolean(assignment.staffId) &&
    assignment.workHours > 0 &&
    operationalAssignmentInterval(state, assignment).end >
      operationalCutoff(state)
  );
}

export function taskConsumesCrossWorkdayReservation(
  state: ScheduleGenerationFacts,
  flight: Flight,
  rule: PositionRule
): boolean {
  return (
    operationalTaskInterval(state, flight, rule).end > operationalCutoff(state)
  );
}

export function crossWorkdayReservationTargetsOverlap(
  left: CrossWorkdayReservationTarget,
  right: CrossWorkdayReservationTarget
): boolean {
  if (!left.interval || !right.interval) return true;
  return (
    left.interval.start < right.interval.end &&
    right.interval.start < left.interval.end
  );
}

interface ReservationAllocation {
  counts: number[];
  staffIdsByTarget: string[][];
}

function compareCounts(
  left: readonly number[],
  right: readonly number[]
): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function reservationAllocation(
  targets: readonly CrossWorkdayReservationTarget[],
  staffIds: readonly string[],
  consumedStaffIds: ReadonlySet<string>
): ReservationAllocation {
  const staffOrder = new Map(
    staffIds.map((staffId, index) => [staffId, index])
  );
  const theoreticalMax = targets.map((target) =>
    Math.min(
      target.reservation.minimumStaffCount,
      staffIds.filter(
        (staffId) =>
          !consumedStaffIds.has(staffId) &&
          target.qualifiedStaffIds.has(staffId)
      ).length
    )
  );

  function search(
    targetIndex: number,
    priorStaffIdsByTarget: readonly string[][]
  ): ReservationAllocation {
    if (targetIndex >= targets.length) {
      return { counts: [], staffIdsByTarget: [] };
    }
    const target = targets[targetIndex]!;
    const blockedStaffIds = new Set(
      priorStaffIdsByTarget.flatMap((assignedStaffIds, priorIndex) =>
        crossWorkdayReservationTargetsOverlap(targets[priorIndex]!, target)
          ? assignedStaffIds
          : []
      )
    );
    const candidates = staffIds
      .filter(
        (staffId) =>
          !consumedStaffIds.has(staffId) &&
          !blockedStaffIds.has(staffId) &&
          target.qualifiedStaffIds.has(staffId)
      )
      .sort((left, right) => {
        const futureDemand = (staffId: string) =>
          targets
            .slice(targetIndex + 1)
            .filter(
              (futureTarget) =>
                crossWorkdayReservationTargetsOverlap(target, futureTarget) &&
                futureTarget.qualifiedStaffIds.has(staffId)
            ).length;
        return (
          futureDemand(left) - futureDemand(right) ||
          (staffOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
            (staffOrder.get(right) ?? Number.MAX_SAFE_INTEGER)
        );
      });
    const targetCount = Math.min(
      target.reservation.minimumStaffCount,
      candidates.length
    );
    let best: ReservationAllocation | null = null;
    let reachedTheoreticalMaximum = false;

    const evaluate = (selected: readonly string[]) => {
      const stableSelection = [...selected].sort(
        (left, right) =>
          (staffOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
          (staffOrder.get(right) ?? Number.MAX_SAFE_INTEGER)
      );
      const future = search(targetIndex + 1, [
        ...priorStaffIdsByTarget,
        stableSelection,
      ]);
      const result: ReservationAllocation = {
        counts: [targetCount, ...future.counts],
        staffIdsByTarget: [stableSelection, ...future.staffIdsByTarget],
      };
      if (!best || compareCounts(result.counts, best.counts) > 0) best = result;
      reachedTheoreticalMaximum = result.counts.every(
        (count, offset) => count === theoreticalMax[targetIndex + offset]
      );
    };

    const select = (startIndex: number, selected: string[]): void => {
      if (reachedTheoreticalMaximum) return;
      const remaining = targetCount - selected.length;
      if (remaining === 0) {
        evaluate(selected);
        return;
      }
      for (
        let candidateIndex = startIndex;
        candidateIndex <= candidates.length - remaining;
        candidateIndex += 1
      ) {
        selected.push(candidates[candidateIndex]!);
        select(candidateIndex + 1, selected);
        selected.pop();
        if (reachedTheoreticalMaximum) return;
      }
    };

    select(0, []);
    return best ?? { counts: [0], staffIdsByTarget: [[]] };
  }

  return search(0, []);
}

export function crossWorkdayReservationStatuses(
  state: ScheduleGenerationFacts,
  assignments: readonly Assignment[] = state.assignments
): CrossWorkdayReservationStatus[] {
  const targets = crossWorkdayReservationTargets(state);
  const consumedStaffIds = new Set(
    assignments
      .filter((assignment) =>
        assignmentConsumesCrossWorkdayReservation(state, assignment)
      )
      .map((assignment) => assignment.staffId!)
  );
  const allocation = reservationAllocation(
    targets,
    state.staff.map((person) => person.id),
    consumedStaffIds
  );
  return targets.map((target, targetIndex) => {
    const preservedStaffIds = allocation.staffIdsByTarget[targetIndex] ?? [];
    return {
      target,
      preservedStaffIds,
      shortfall: Math.max(
        0,
        target.reservation.minimumStaffCount - preservedStaffIds.length
      ),
    };
  });
}

export function crossWorkdayReservationWarning(
  status: CrossWorkdayReservationStatus
): string {
  const { reservation } = status.target;
  return `下一工作班 ${reservation.flightNo}/${reservation.keyword}需要保留 ${reservation.minimumStaffCount} 名合格人员，当前安排会使可用人数少 ${status.shortfall} 名。`;
}
