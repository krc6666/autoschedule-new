import { flightRuleSettings } from "../flights/flight-rule-settings";
import type { Assignment, Flight } from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import { isPriorityRotationPosition } from "../reviews/position-rotation-policy";
import type { AssignmentTask } from "../flights/schedule-tasks";
import {
  diagnoseBaseAssignmentEligibility,
  eligibleStaffForRule,
} from "../candidates/assignment-eligibility";
import { getDutyRosterForDate } from "../duty-roster/roster";
import { isSupervisorPosition } from "../flights/schedule-position-rules";
import { durationHours, timeToMinutes } from "../shared/time";
import {
  consecutivePositionAssignments,
  type ScheduleFrequencyFacts,
} from "../statistics/schedule-frequency";
import { tr121H02CooldownProfile } from "../rules/tr121-h02-cooldown";
import { improvesAutomaticRegularCoverage } from "../coverage/automatic-regular-coverage";

function repeatsPriorityPosition(
  state: ScheduleGenerationFacts,
  task: AssignmentTask,
  staffId: string,
  date: string
): boolean {
  return (
    isPriorityRotationPosition(task.rule) &&
    consecutivePositionAssignments(
      state,
      staffId,
      task.flight.flightNo,
      task.rule.name,
      task.rule.remark,
      date
    ) > 0
  );
}

export function dutyLatePositionPriority(
  position: string,
  remark: string
): number {
  const value = `${position} ${remark}`;
  if (value.includes("一号")) return 0;
  if (isSupervisorPosition(position)) return 1;
  if (value.includes("申报")) return 2;
  if (value.includes("送资料")) return 3;
  return 4;
}

export function normalizeDutyPriorityFlightNo(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]/g, "");
}

export function matchesDutyPositionPriority(
  priority: ScheduleGenerationFacts["settings"]["dutyPositionPriorities"][number],
  target: Pick<Assignment, "flightNo" | "position" | "remark">
): boolean {
  const flightNo = normalizeDutyPriorityFlightNo(target.flightNo);
  const positionText = `${target.position} ${target.remark}`
    .trim()
    .toLowerCase();
  return (
    priority.enabled &&
    normalizeDutyPriorityFlightNo(priority.flightNo) === flightNo &&
    (!priority.positionKeyword.trim() ||
      positionText.includes(priority.positionKeyword.trim().toLowerCase()))
  );
}

export function configuredDutyPositionPriority(
  state: ScheduleGenerationFacts,
  target: Pick<Assignment, "flightNo" | "position" | "remark">
): number {
  return flightRuleSettings(state).dutyPositionPriorities.findIndex((item) =>
    matchesDutyPositionPriority(item, target)
  );
}

export const DUTY_MORNING_CUTOFF = "12:00";

export function isDutyMorningFlight(
  target: Pick<Flight, "startTime">,
  state: Pick<ScheduleGenerationFacts, "settings">
): boolean {
  const start = timeToMinutes(target.startTime);
  const morningStart = timeToMinutes(state.settings.nightEnd);
  const cutoff = timeToMinutes(DUTY_MORNING_CUTOFF);
  return (
    [start, morningStart, cutoff].every(Number.isFinite) &&
    start >= morningStart &&
    start < cutoff
  );
}

export function hasDutyMorningAssignment(
  state: ScheduleGenerationFacts,
  assignments: Assignment[],
  dutyStaffId: string
): boolean {
  return dutyMorningStart(state, assignments, dutyStaffId) !== null;
}

/** Compare actual arrival times, allowing another counter in the same flight. */
export function dutyMorningStart(
  state: Pick<ScheduleGenerationFacts, "flights" | "settings">,
  assignments: readonly Assignment[],
  dutyStaffId: string
): number | null {
  const starts = assignments.flatMap((assignment) => {
    if (
      assignment.status !== "assigned" ||
      assignment.staffId !== dutyStaffId ||
      assignment.workHours <= 0
    )
      return [];
    const flight = state.flights.find(
      (item) => item.id === assignment.flightId
    );
    const target = flight ?? assignment;
    return isDutyMorningFlight(target, state)
      ? [timeToMinutes(target.startTime)]
      : [];
  });
  return starts.length ? Math.min(...starts) : null;
}

export const DUTY_MORNING_DELAY_REASON =
  "调整会推迟值班人员已落实的上午上岗时间";

/** Coverage may improve, but ordinary soft reviews cannot postpone duty work. */
export function dutyMorningRegressionReason(
  state: ScheduleGenerationFacts,
  original: readonly Assignment[],
  planned: readonly Assignment[],
  dutyStaffId: string | null
): string | null {
  if (!dutyStaffId) return null;
  const before = dutyMorningStart(state, original, dutyStaffId);
  if (before === null) return null;
  const after = dutyMorningStart(state, planned, dutyStaffId);
  if (after !== null && after <= before) return null;
  if (improvesAutomaticRegularCoverage(state, original, planned)) return null;
  return after === null
    ? "交换后值班人员没有12点前开始的航班"
    : DUTY_MORNING_DELAY_REASON;
}

function operationalStartMinutes(
  startTime: string,
  state: ScheduleGenerationFacts
): number {
  const start = timeToMinutes(startTime);
  const nightEnd = timeToMinutes(state.settings.nightEnd);
  return start < nightEnd ? start + 24 * 60 : start;
}

export function preferredDutyLateTasks(
  state: ScheduleGenerationFacts,
  date: string,
  tasks: AssignmentTask[],
  knownDutyStaffId?: string | null,
  frequencyFacts?: ScheduleFrequencyFacts
): AssignmentTask[] {
  const dutyStaffId =
    knownDutyStaffId === undefined
      ? getDutyRosterForDate(state, date).dutyStaffId
      : knownDutyStaffId;
  if (!dutyStaffId || !tasks.length) return [];
  const eligibleTasks = tasks
    .filter(
      (task) =>
        durationHours(task.flight.startTime, task.flight.endTime) <=
        state.settings.maxDailyHours
    )
    .filter((task) =>
      eligibleStaffForRule(state, task.flight, task.rule).some(
        (person) => person.id === dutyStaffId
      )
    );
  const ordered: AssignmentTask[] = [];
  for (const priority of flightRuleSettings(
    state
  ).dutyPositionPriorities.filter((item) => item.enabled)) {
    const target = eligibleTasks.find((task) =>
      matchesDutyPositionPriority(priority, {
        flightNo: task.flight.flightNo,
        position: task.rule.name,
        remark: task.rule.remark,
      })
    );
    if (target && !ordered.includes(target)) ordered.push(target);
  }
  const latestStarts = [
    ...new Set(
      state.flights.map((flight) =>
        operationalStartMinutes(flight.startTime, state)
      )
    ),
  ]
    .sort((left, right) => right - left)
    .slice(0, 2);
  for (const start of latestStarts) {
    const targets = tasks
      .filter(
        (task) =>
          operationalStartMinutes(task.flight.startTime, state) === start
      )
      .filter(
        (task) => dutyLatePositionPriority(task.rule.name, task.rule.remark) < 4
      )
      .filter((task) => eligibleTasks.includes(task))
      .sort(
        (left, right) =>
          dutyLatePositionPriority(left.rule.name, left.rule.remark) -
          dutyLatePositionPriority(right.rule.name, right.rule.remark)
      );
    targets.forEach((target) => {
      if (!ordered.includes(target)) ordered.push(target);
    });
  }
  const orderedWithCooldown = frequencyFacts
    ? [
        ...ordered.filter(
          (task) =>
            !tr121H02CooldownProfile(
              state,
              dutyStaffId,
              task.flight.flightNo,
              task.rule,
              date,
              frequencyFacts
            ).inCooldown
        ),
        ...ordered.filter(
          (task) =>
            tr121H02CooldownProfile(
              state,
              dutyStaffId,
              task.flight.flightNo,
              task.rule,
              date,
              frequencyFacts
            ).inCooldown
        ),
      ]
    : ordered;
  return orderedWithCooldown
    .map((task, index) => ({ task, index }))
    .sort(
      (left, right) =>
        left.index - right.index ||
        Number(repeatsPriorityPosition(state, left.task, dutyStaffId, date)) -
          Number(repeatsPriorityPosition(state, right.task, dutyStaffId, date))
    )
    .map(({ task }) => task);
}

export function configuredDutyTaskPriority(
  state: ScheduleGenerationFacts,
  task: AssignmentTask
): number {
  return flightRuleSettings(state).dutyPositionPriorities.findIndex(
    (priority) =>
      matchesDutyPositionPriority(priority, {
        flightNo: task.flight.flightNo,
        position: task.rule.name,
        remark: task.rule.remark,
      })
  );
}

export function dutyHardConstraintReason(
  state: ScheduleGenerationFacts,
  dutyStaffId: string,
  task: AssignmentTask
): string | null {
  const person = state.staff.find((item) => item.id === dutyStaffId);
  if (!person) return "值班人员不存在";
  return (
    diagnoseBaseAssignmentEligibility(state, task.flight, task.rule, person)
      .violations[0]?.message ?? null
  );
}

export function preferredDutyMorningTask(
  state: ScheduleGenerationFacts,
  date: string,
  tasks: AssignmentTask[],
  knownDutyStaffId?: string | null
): AssignmentTask | undefined {
  const dutyStaffId =
    knownDutyStaffId === undefined
      ? getDutyRosterForDate(state, date).dutyStaffId
      : knownDutyStaffId;
  if (!dutyStaffId) return undefined;
  return tasks
    .filter((task) => isDutyMorningFlight(task.flight, state))
    .filter(
      (task) =>
        durationHours(task.flight.startTime, task.flight.endTime) <=
        state.settings.maxDailyHours
    )
    .filter((task) =>
      eligibleStaffForRule(state, task.flight, task.rule).some(
        (person) => person.id === dutyStaffId
      )
    )
    .sort(
      (left, right) =>
        timeToMinutes(left.flight.startTime) -
          timeToMinutes(right.flight.startTime) ||
        Number(repeatsPriorityPosition(state, left, dutyStaffId, date)) -
          Number(repeatsPriorityPosition(state, right, dutyStaffId, date)) ||
        left.rule.fatiguePoints - right.rule.fatiguePoints
    )[0];
}

export function dutyPositionPriority(
  staffId: string,
  taskKey: string,
  dutyStaffId: string | null,
  targetTaskKeys: ReadonlySet<string>
): DutyPositionDisposition {
  if (!dutyStaffId || !targetTaskKeys.size || staffId !== dutyStaffId)
    return "unrelated";
  return targetTaskKeys.has(taskKey) ? "reserved-target" : "reserved-elsewhere";
}

/** Snapshot evidence for duty locks: selected duty targets must remain assigned. */
export function assessDutyPositionSnapshot(
  assignments: readonly Assignment[]
): string[] {
  return assignments
    .filter((assignment) =>
      assignment.decisionTrace?.some(
        (decision) =>
          decision.ruleId === "duty-position" && decision.outcome === "selected"
      )
    )
    .filter(
      (assignment) => assignment.status !== "assigned" || !assignment.staffId
    )
    .map((assignment) => assignment.id);
}

export type DutyPositionDisposition =
  "reserved-target" | "unrelated" | "reserved-elsewhere";
