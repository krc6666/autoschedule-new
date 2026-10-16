import type { Assignment, Flight, PositionRule } from "../../model";
import type { AssignmentTimingFacts } from "../shared/scheduling-facts";
import { timeToMinutes } from "../shared/time";
import { isValidDiversionTransfer } from "./assignment-timing";

interface TransitionWork {
  flightId: string;
  flightNo: string;
  startTime: string;
  endTime: string;
  rule: PositionRule | undefined;
  workHours: number;
}

export interface OperationalWorkInterval {
  start: number;
  end: number;
}

export interface MinimumFlightTransitionViolation {
  previousFlightNo: string;
  nextFlightNo: string;
  gapMinutes: number;
  requiredMinutes: number;
  relationToCandidate: "previous" | "next";
}

function operationalStart(time: string, state: AssignmentTimingFacts): number {
  const minutes = timeToMinutes(time);
  const operationalBoundary = timeToMinutes(state.settings.nightEnd);
  return minutes < operationalBoundary ? minutes + 24 * 60 : minutes;
}

function intervalForWork(
  state: AssignmentTimingFacts,
  work: TransitionWork
): OperationalWorkInterval {
  const rawStart = timeToMinutes(work.startTime);
  const rawEnd = timeToMinutes(work.endTime);
  const start = operationalStart(work.startTime, state);
  let duration = rawEnd - rawStart;
  if (duration <= 0) duration += 24 * 60;
  let end = start + duration;
  if (work.rule?.category === "分流" && work.rule.earlyReleaseMinutes > 0) {
    end = Math.max(start, end - work.rule.earlyReleaseMinutes);
  }
  return { start, end };
}

function assignmentWork(
  state: AssignmentTimingFacts,
  assignment: Assignment
): TransitionWork {
  const flight = state.flights.find((item) => item.id === assignment.flightId);
  const rule = assignment.positionRuleId
    ? state.positionRules.find((item) => item.id === assignment.positionRuleId)
    : undefined;
  return {
    flightId: assignment.flightId,
    flightNo: assignment.flightNo,
    startTime: flight?.startTime ?? assignment.startTime,
    endTime: flight?.endTime ?? assignment.endTime,
    rule,
    workHours: assignment.workHours,
  };
}

function taskWork(flight: Flight, rule: PositionRule): TransitionWork {
  return {
    flightId: flight.id,
    flightNo: flight.flightNo,
    startTime: flight.startTime,
    endTime: flight.endTime,
    rule,
    workHours: 1,
  };
}

function participatesInTransition(work: TransitionWork): boolean {
  return work.workHours > 0 && work.rule?.category !== "引导";
}

function transitionViolation(
  state: AssignmentTimingFacts,
  existing: TransitionWork,
  candidate: TransitionWork
): MinimumFlightTransitionViolation | null {
  const requiredMinutes = state.settings.minimumRegularTransitionMinutes;
  if (
    requiredMinutes <= 0 ||
    existing.flightId === candidate.flightId ||
    !participatesInTransition(existing) ||
    !participatesInTransition(candidate)
  ) {
    return null;
  }
  const existingInterval = intervalForWork(state, existing);
  const candidateInterval = intervalForWork(state, candidate);
  const existingFirst = existingInterval.start <= candidateInterval.start;
  const previous = existingFirst ? existing : candidate;
  const next = existingFirst ? candidate : existing;
  const previousInterval = existingFirst ? existingInterval : candidateInterval;
  const nextInterval = existingFirst ? candidateInterval : existingInterval;
  if (isValidDiversionTransfer(previous, previous.rule, next)) return null;
  const gapMinutes = nextInterval.start - previousInterval.end;
  if (gapMinutes < 0 || gapMinutes >= requiredMinutes) return null;
  return {
    previousFlightNo: previous.flightNo,
    nextFlightNo: next.flightNo,
    gapMinutes,
    requiredMinutes,
    relationToCandidate: existingFirst ? "previous" : "next",
  };
}

export function operationalAssignmentInterval(
  state: AssignmentTimingFacts,
  assignment: Assignment
): OperationalWorkInterval {
  return intervalForWork(state, assignmentWork(state, assignment));
}

export function operationalTaskInterval(
  state: AssignmentTimingFacts,
  flight: Flight,
  rule: PositionRule
): OperationalWorkInterval {
  return intervalForWork(state, taskWork(flight, rule));
}

export function minimumFlightTransitionViolationBetweenTasks(
  state: AssignmentTimingFacts,
  leftFlight: Flight,
  leftRule: PositionRule,
  rightFlight: Flight,
  rightRule: PositionRule
): MinimumFlightTransitionViolation | null {
  return transitionViolation(
    state,
    taskWork(leftFlight, leftRule),
    taskWork(rightFlight, rightRule)
  );
}

export function minimumFlightTransitionViolationsForInsertion(
  state: AssignmentTimingFacts,
  assignments: readonly Assignment[],
  staffId: string,
  flight: Flight,
  rule: PositionRule
): MinimumFlightTransitionViolation[] {
  const candidate = taskWork(flight, rule);
  return assignments.flatMap((assignment) => {
    if (assignment.staffId !== staffId || assignment.status !== "assigned") {
      return [];
    }
    const violation = transitionViolation(
      state,
      assignmentWork(state, assignment),
      candidate
    );
    return violation ? [violation] : [];
  });
}

export function minimumFlightTransitionMessage(
  personName: string,
  violation: MinimumFlightTransitionViolation
): string {
  const adjacent =
    violation.relationToCandidate === "previous" ? "上一航班" : "下一航班";
  return `${personName}与${adjacent}间隔只有 ${violation.gapMinutes} 分钟，少于要求的 ${violation.requiredMinutes} 分钟。涉及航班：${violation.previousFlightNo}→${violation.nextFlightNo}`;
}
