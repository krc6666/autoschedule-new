import type { Assignment } from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import type {
  AssignmentEligibilityDiagnostic,
  AutomaticAssignmentEligibilityOptions,
} from "../candidates/assignment-eligibility";
import type { AssignmentTask } from "../flights/schedule-tasks";
import type { SolverProblem, SolverResult } from "../solver/solver-port";
import { isControlledConcurrentAssignmentPair } from "../assignments/assignment-time-conflicts";
import {
  evaluateSupervisorFillFacts,
  hasRecordedSupervisorFillLink,
} from "../coverage/supervisor-fill-facts";
import {
  isStrictNextWorkdayRecoveryTarget,
  previousWorkdayLateProtection,
} from "../reviews/cross-day-recovery";
import {
  halfRestPeriodViolation,
  isStrictRecoveryHalfRestBackfill,
  type HalfRestFacts,
} from "../rules/half-rest";
import { ScheduleGuardError } from "./schedule-guard";
import {
  guideSourceStaff,
  isGuideAssignment,
} from "../flights/schedule-position-rules";

function rejectAssignment(
  ruleId: string,
  assignment: Assignment,
  message: string
): never {
  throw new ScheduleGuardError([
    { ruleId, assignmentId: assignment.id, message },
  ]);
}

export interface DailyScheduleSafetyOptions {
  state: ScheduleGenerationFacts;
  date: string;
  assignments: readonly Assignment[];
  tasks: readonly AssignmentTask[];
  evaluateEligibility: (
    options: AutomaticAssignmentEligibilityOptions
  ) => AssignmentEligibilityDiagnostic;
  allowFinalizedConcurrency?: boolean;
  preservedAssignments?: readonly Assignment[];
  halfRestFacts?: HalfRestFacts;
}

function assignmentMatchesTask(
  assignment: Assignment,
  task: AssignmentTask
): boolean {
  return (
    assignment.flightId === task.flight.id &&
    assignment.positionRuleId === task.rule.id
  );
}

export function assertTimeLimitedResultIsEligible(
  problem: SolverProblem,
  result: SolverResult
): void {
  if (
    result.termination !== "time-limited-feasible" &&
    result.termination !== "gap-limited-feasible"
  )
    return;
  const stoppedObjective = result.bestEffort
    ? problem.objectives.find(
        (objective) => objective.id === result.bestEffort!.stoppedAtObjectiveId
      )
    : undefined;
  const completed = new Set(result.bestEffort?.completedObjectiveIds ?? []);
  const requiredCompleted = problem.objectives
    .filter((objective) => objective.optimality !== "best-effort")
    .every((objective) => completed.has(objective.id));
  if (
    !result.bestEffort ||
    stoppedObjective?.optimality !== "best-effort" ||
    !requiredCompleted
  ) {
    throw new Error("当天班表未采用：关键排班规则未全部完成");
  }
}

export function assertDailyScheduleSafety({
  state,
  date,
  assignments,
  tasks,
  evaluateEligibility,
  allowFinalizedConcurrency = false,
  preservedAssignments = [],
  halfRestFacts,
}: DailyScheduleSafetyOptions): void {
  for (const preserved of preservedAssignments) {
    const current = assignments.find(
      (assignment) => assignment.id === preserved.id
    );
    if (
      !current ||
      (current.status !== "unfilled" &&
        (current.status !== preserved.status ||
          current.staffId !== preserved.staffId)) ||
      current.flightId !== preserved.flightId ||
      current.positionRuleId !== preserved.positionRuleId
    ) {
      if (!current) throw new Error("最终安全复核未通过：已锁定岗位缺失");
      rejectAssignment(
        "duty-position",
        current,
        "最终安全复核未通过：已锁定岗位在后续排班中发生变化"
      );
    }
  }
  const assignmentsByTask = new Map(
    tasks.map((task) => [
      task.key,
      assignments.filter((assignment) =>
        assignmentMatchesTask(assignment, task)
      ),
    ])
  );

  // For symmetric conflicts/hours violations keep the earlier planned work
  // and report the later task first. Rule-specific guards keep their own order.
  for (const task of [...tasks].reverse()) {
    const matches = assignmentsByTask.get(task.key) ?? [];
    if (matches.length !== 1) {
      throw new Error(
        `最终安全复核未通过：${task.flight.flightNo}/${task.rule.name}必须且只能保留一个排班结果`
      );
    }
    const assignment = matches[0]!;
    if (
      assignment.status === "unfilled" ||
      (assignment.status === "manual" && !assignment.staffId)
    )
      continue;
    if (assignment.status !== "assigned" || !assignment.staffId) {
      rejectAssignment(
        "invalid-assignment",
        assignment,
        `最终安全复核未通过：${task.flight.flightNo}/${task.rule.name}没有形成有效自动排班结果`
      );
    }
    const halfRestViolation = halfRestFacts
      ? halfRestPeriodViolation({
          facts: halfRestFacts,
          staffId: assignment.staffId,
          startTime: task.flight.startTime,
        })
      : null;
    if (halfRestViolation) {
      rejectAssignment("half-rest", assignment, halfRestViolation);
    }
    const person = state.staff.find((item) => item.id === assignment.staffId);
    if (!person) {
      rejectAssignment(
        "staff-unavailable",
        assignment,
        `最终安全复核未通过：${task.flight.flightNo}/${task.rule.name}的人员不存在`
      );
    }
    if (
      state.settings.nextWorkdayRecoveryMode === "forbid" &&
      state.settings.lateShiftRecoveryEnabled &&
      previousWorkdayLateProtection(state, date).protectedStaffIds.has(
        person.id
      ) &&
      isStrictNextWorkdayRecoveryTarget(state, {
        flightNo: task.flight.flightNo,
        position: task.rule.name,
        remark: task.rule.remark,
      }) &&
      !(
        halfRestFacts &&
        isStrictRecoveryHalfRestBackfill({
          state,
          facts: halfRestFacts,
          protectedStaffIds: previousWorkdayLateProtection(state, date)
            .protectedStaffIds,
          staffId: person.id,
          flight: task.flight,
          rule: task.rule,
        })
      )
    ) {
      rejectAssignment(
        "strict-next-workday-recovery",
        assignment,
        `最终安全复核未通过：${task.flight.flightNo}/${task.rule.name}违反严格跨工作日恢复目标`
      );
    }
    const otherAutomaticAssignments = tasks.flatMap((otherTask) =>
      (assignmentsByTask.get(otherTask.key) ?? []).filter(
        (other) =>
          other.id !== assignment.id &&
          other.status === "assigned" &&
          Boolean(other.staffId) &&
          !(
            allowFinalizedConcurrency &&
            isControlledConcurrentAssignmentPair(
              state,
              assignments,
              assignment,
              other
            )
          )
      )
    );
    const supervisorSource = assignment.supervisorSourceAssignmentId
      ? assignments.find(
          (candidate) =>
            candidate.id === assignment.supervisorSourceAssignmentId
        )
      : undefined;
    const configuredSupervisorFill = supervisorSource
      ? hasRecordedSupervisorFillLink(
          evaluateSupervisorFillFacts(
            state,
            assignments,
            supervisorSource,
            assignment,
            "automatic",
            { ignoreSafeRegularCandidate: true }
          ),
          assignment
        )
      : false;
    const diagnostic = evaluateEligibility({
      state,
      assignments: otherAutomaticAssignments,
      flight: task.flight,
      rule: configuredSupervisorFill
        ? {
            ...task.rule,
            qualifiedStaffIds: [
              ...new Set([...task.rule.qualifiedStaffIds, person.id]),
            ],
          }
        : task.rule,
      person,
      workHours: assignment.workHours,
    });
    if (!diagnostic.eligible) {
      rejectAssignment(
        diagnostic.violations[0]?.code ?? "invalid-assignment",
        assignment,
        `最终安全复核未通过：${task.flight.flightNo}/${task.rule.name}${diagnostic.violations[0]?.message ?? "不满足排班要求"}`
      );
    }
  }
  for (const guide of assignments) {
    if (
      guide.status !== "assigned" ||
      !guide.staffId ||
      !isGuideAssignment(state, guide)
    )
      continue;
    if (
      !assignments.some(
        (source) =>
          source.flightId === guide.flightId &&
          guideSourceStaff(state, source)?.id === guide.staffId
      )
    ) {
      rejectAssignment("guide-source", guide, "引导岗位缺少可复用的常规人员");
    }
  }
}
