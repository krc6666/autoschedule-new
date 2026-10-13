import { reassignmentSafetyReasons } from "../reviews/rotation-review-safety";
import {
  decodeReassignmentChanges,
  fixedHoursForStaff,
  incompatibleReassignmentChoices,
  prepareReassignmentChoices,
  reassignmentChoiceRequirements,
} from "./reassignment-choice-graph";
import type {
  ReassignmentOptimizationOptions,
  ReassignmentOptimizationResult,
} from "./reassignment-contract";
import { buildReassignmentProblem } from "./reassignment-model";

function participantLimitReasons(
  options: ReassignmentOptimizationOptions,
  changes: readonly { assignmentId: string; staffId: string }[]
): string[] {
  if (!options.maxParticipants) return [];
  const originalStaffByAssignmentId = new Map(
    options.assignments.flatMap((assignment) =>
      assignment.staffId ? [[assignment.id, assignment.staffId] as const] : []
    )
  );
  const participants = new Set(
    changes.flatMap((change) => [
      originalStaffByAssignmentId.get(change.assignmentId),
      change.staffId,
    ])
  );
  participants.delete(undefined);
  const limitLabel =
    options.maxParticipants === 5 ? "五" : options.maxParticipants;
  return participants.size > options.maxParticipants
    ? [`整体重排最多允许${limitLabel}人参与`]
    : [];
}

function changedAssignmentLimitReasons(
  options: ReassignmentOptimizationOptions,
  changes: readonly { assignmentId: string; staffId: string }[]
): string[] {
  if (!options.maxChangedAssignments) return [];
  const changedAssignmentIds = new Set(
    changes.flatMap((change) => {
      const original = options.assignments.find(
        (assignment) => assignment.id === change.assignmentId
      );
      return original?.staffId === change.staffId ? [] : [change.assignmentId];
    })
  );
  return changedAssignmentIds.size > options.maxChangedAssignments
    ? [`整体方案最多改变${options.maxChangedAssignments}个岗位`]
    : [];
}

export async function optimizeReassignment(
  options: ReassignmentOptimizationOptions
): Promise<ReassignmentOptimizationResult> {
  options = {
    ...options,
    frequencyFacts: options.frequencyFacts ?? options.facts?.scheduleFrequency,
  };
  const deadline = Date.now() + (options.timeoutMs ?? 4_000);
  const {
    choices,
    movable,
    fixed,
    candidateRejectionReasons,
    candidateRejections,
  } = prepareReassignmentChoices(options);
  if (!choices.some(({ assignment }) => assignment.id === options.primary.id)) {
    return {
      changes: null,
      candidateRejections,
      attemptedReasons: candidateRejectionReasons.length
        ? candidateRejectionReasons
        : ["没有具备连续腾挪岗位资质的人员"],
      termination: "infeasible",
    };
  }
  const permittedConcurrentAssignmentIds =
    options.permittedConcurrentAssignmentIds ?? new Set<string>();
  const incompatibilities = incompatibleReassignmentChoices(
    choices,
    options,
    fixed,
    permittedConcurrentAssignmentIds
  );
  const requirements = reassignmentChoiceRequirements(
    options,
    choices,
    movable,
    fixed
  );
  const excludedSelections: ReadonlySet<string>[] = [];
  const attemptedReasons: string[] = [...candidateRejectionReasons];

  while (Date.now() < deadline) {
    const result = await options.solver.solve(
      buildReassignmentProblem({
        choices: choices.map(({ choice }) => choice),
        assignmentIds: movable.map((assignment) => assignment.id),
        incompatibilities,
        capacities: options.state.staff.map((person) => ({
          staffId: person.id,
          fixedWorkHours: fixedHoursForStaff(fixed, person.id),
          maximumWorkHours: options.state.settings.maxDailyHours,
        })),
        choiceRequirements: requirements,
        coupledAssignmentGroups: options.coupledAssignmentGroups,
        excludedSelections,
        leadingObjectives: options.leadingObjectives?.map((objective) => ({
          id: objective.id,
          direction: objective.direction,
          terms: choices.map(({ choice, assignment, person }) => ({
            variableId: choice.id,
            coefficient: objective.coefficient({
              assignment,
              person,
              keepsCurrentStaff: choice.keepsCurrentStaff,
            }),
          })),
        })),
        timeoutMs: Math.max(1, deadline - Date.now()),
      })
    );
    const acceptsTimeLimitedFeasible =
      options.acceptTimeLimitedFeasible === true &&
      result.termination === "time-limited-feasible";
    if (result.termination !== "optimal" && !acceptsTimeLimitedFeasible) {
      if (result.diagnostic) attemptedReasons.push(result.diagnostic);
      if (result.termination === "infeasible")
        attemptedReasons.push("没有具备双向岗位资质的完整重排方案");
      return {
        changes: null,
        candidateRejections,
        attemptedReasons: [...new Set(attemptedReasons)],
        termination:
          result.termination === "time-limited-feasible" ||
          result.termination === "gap-limited-feasible"
            ? "failed"
            : result.termination,
      };
    }
    const decodedChanges = decodeReassignmentChanges(
      result.selectedVariableIds,
      choices
    );
    const changes = options.normalizeChanges
      ? [...options.normalizeChanges(decodedChanges)]
      : decodedChanges;
    const reasons = [
      ...participantLimitReasons(options, changes),
      ...changedAssignmentLimitReasons(options, changes),
      ...reassignmentSafetyReasons({
        kind: "plan",
        state: options.state,
        assignments: options.assignments,
        changes,
        primaryAssignmentId: options.primary.id,
        date: options.date,
        facts: options.facts,
        frequencyFacts: options.frequencyFacts,
        permittedConcurrentAssignmentIds,
        latePriorityFatigueRelief: options.latePriorityFatigueRelief,
        intent: options.intent,
      }),
      ...(options.validateChanges?.(changes) ?? []),
    ];
    if (!reasons.length) {
      return {
        changes,
        candidateRejections,
        attemptedReasons: [...new Set(attemptedReasons)],
        termination: acceptsTimeLimitedFeasible
          ? "time-limited-feasible"
          : "optimal",
      };
    }
    attemptedReasons.push(...reasons);
    excludedSelections.push(new Set(result.selectedVariableIds));
  }

  attemptedReasons.push("整体重排达到时间上限，未提交部分结果");
  return {
    changes: null,
    candidateRejections,
    attemptedReasons: [...new Set(attemptedReasons)],
    termination: "timed-out",
  };
}
