import type { Assignment } from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import { buildAssignmentDecisionTrace } from "../assignments/assignment-decision-trace";
import { createAssignedPosition } from "../assignments/assignment-factory";
import { applyConfiguredEarlyReleases } from "../assignments/assignment-timing";
import { diversionTransferAssignmentIds } from "../assignments/diversion-release-usage";
import { makeUnfilled } from "../flights/schedule-position-rules";
import { isMobileSupervisor, isPreNoonFlight } from "../flights/schedule-tasks";
import { evaluateAutomaticHardConstraints } from "../rules/built-in-rule-registry";
import {
  compareCandidateRulePlan,
  firstDifferentCandidateRulePlan,
} from "../rules/candidate-rule-plan";
import {
  crossWorkdayReservationStatuses,
  crossWorkdayReservationWarning,
} from "../reviews/cross-workday-qualification-reservation";
import { violatedPositionTransitionPoliciesForInsertion } from "../reviews/schedule-protection";
import { durationHours, intervalsOverlap } from "../shared/time";
import { schedulingDecision } from "../rules/schedule-rule-contract";
import { isCrossFlightPriorityAssignment } from "../rules/cross-flight-priority";
import type {
  DailyScheduleModel,
  DailyScheduleStaffChoice,
} from "./daily-schedule-model";
import type { SolverResult } from "../solver/solver-port";
import type { SchedulePreparation } from "./schedule-preparation";
import { assertDailyScheduleSafety } from "./daily-schedule-safety";
import { recoverLocalScheduleIssues } from "./schedule-local-recovery";
import {
  HALF_REST_WARNING_PREFIX,
  isHalfRestMorningStart,
} from "../rules/half-rest";
import {
  setAutomaticVacancyEvidence,
  clearAutomaticVacancyEvidence,
} from "../assignments/vacancy-evidence";
import { enforceDailyFlightCountBalance } from "../assignments/daily-flight-count-balance";

export interface DailySchedulePlan {
  assignments: Assignment[];
  lockedAssignmentIds: Set<string>;
  dailyFlightCountBalanceFallback: boolean;
  warnings: string[];
  optimizationQuality:
    | "all-objectives-optimal"
    | "fairness-gap-limited"
    | "fairness-time-limited"
    | "fairness-user-stopped";
}

function choiceAssignment(choice: DailyScheduleStaffChoice): Assignment {
  return createAssignedPosition(
    choice.task,
    choice.person,
    choice.workHours,
    [],
    []
  );
}

function attachDecisionTraces(
  state: ScheduleGenerationFacts,
  date: string,
  preparation: SchedulePreparation,
  model: DailyScheduleModel,
  assignments: Assignment[]
): void {
  const dutyTargetTaskKeys = new Set([
    ...(preparation.preferredDutyMorningTaskKey
      ? [preparation.preferredDutyMorningTaskKey]
      : []),
    ...preparation.preferredDutyLateTaskCandidates.map((task) => task.key),
  ]);
  const assignedDutyLateTask = preparation.preferredDutyLateTaskCandidates.find(
    (task) =>
      assignments.some(
        (assignment) =>
          assignment.positionRuleId === task.rule.id &&
          assignment.flightId === task.flight.id &&
          assignment.staffId === preparation.dutyStaffId
      )
  );
  for (const assignment of assignments) {
    if (assignment.status !== "assigned" || !assignment.staffId) continue;
    const task = preparation.tasks.find(
      (item) =>
        item.flight.id === assignment.flightId &&
        item.rule.id === assignment.positionRuleId
    );
    if (!task) continue;
    const taskChoices = model.staffChoices.filter(
      (choice) => choice.task.key === task.key
    );
    const selectedChoice = taskChoices.find(
      (choice) => choice.person.id === assignment.staffId
    );
    if (!selectedChoice) continue;
    const sortedAlternatives = taskChoices
      .filter((choice) => choice.person.id !== assignment.staffId)
      .sort((left, right) =>
        compareCandidateRulePlan(
          model.rulePlan,
          task,
          left.person,
          left.priority,
          right.person,
          right.priority
        )
      );
    const runnerUp = sortedAlternatives[0];
    const selectedBeatsRunnerUp = Boolean(
      runnerUp &&
      compareCandidateRulePlan(
        model.rulePlan,
        task,
        selectedChoice.person,
        selectedChoice.priority,
        runnerUp.person,
        runnerUp.priority
      ) < 0
    );
    assignment.decisionTrace = buildAssignmentDecisionTrace({
      state,
      date,
      assignments: assignments.filter((item) => item.id !== assignment.id),
      task,
      selected: selectedChoice.person,
      runnerUp: runnerUp?.person,
      candidates: taskChoices.map((choice) => choice.person),
      candidatePriorities: new Map(
        taskChoices.map((choice) => [choice.person.id, choice.priority])
      ),
      candidateRulePlan: model.rulePlan,
      decisiveCandidateRule:
        selectedBeatsRunnerUp && runnerUp
          ? firstDifferentCandidateRulePlan(
              model.rulePlan,
              task,
              selectedChoice.person,
              selectedChoice.priority,
              runnerUp.person,
              runnerUp.priority
            )
          : null,
      runFacts: preparation.runFacts,
      dutyStaffId: preparation.dutyStaffId,
      isDutyTarget: dutyTargetTaskKeys.has(task.key),
      hasAssignedDutyLateTask: Boolean(assignedDutyLateTask),
      finalizingKe166Supervisor: false,
    });
    if (selectedChoice.strictRecoveryHalfRestBackfill) {
      const halfRestNames = (
        model.halfRestAffectedStaffIdsByTask.get(task.key) ?? []
      )
        .map(
          (staffId) => state.staff.find((person) => person.id === staffId)?.name
        )
        .filter((name): name is string => Boolean(name));
      assignment.decisionTrace.push(
        schedulingDecision(
          "strict-next-workday-recovery",
          "fallback",
          `${assignment.staffName}命中严格跨工作日恢复目标；为避免${halfRestNames.join("、")}半休造成后续岗位空缺，本次继续安排${assignment.flightNo}/${assignment.position}。`
        )
      );
    }
    if (!assignment.decisionTrace.length) delete assignment.decisionTrace;
  }
}

function attachVacancyEvidence(
  state: ScheduleGenerationFacts,
  preparation: SchedulePreparation,
  model: DailyScheduleModel,
  assignments: Assignment[]
): void {
  for (const assignment of assignments) {
    if (assignment.status !== "unfilled") continue;
    const task = preparation.tasks.find(
      (item) =>
        item.flight.id === assignment.flightId &&
        item.rule.id === assignment.positionRuleId
    );
    if (!task) continue;
    if (assignment.vacancyEvidence) continue;
    const halfRestStaffIds =
      model.halfRestAffectedStaffIdsByTask.get(task.key) ?? [];
    if (halfRestStaffIds.length) {
      clearAutomaticVacancyEvidence(assignment);
      const names = halfRestStaffIds
        .map(
          (staffId) => state.staff.find((person) => person.id === staffId)?.name
        )
        .filter((name): name is string => Boolean(name));
      assignment.systemNotes = [
        `${HALF_REST_WARNING_PREFIX}为落实${names.join("、")}半休，后续可用人员不足，岗位保持空缺`,
      ];
      continue;
    }
    const recoveryExcludedIds =
      model.strictRecoveryExcludedStaffIdsByTask.get(task.key) ?? [];
    if (
      recoveryExcludedIds.length &&
      !model.staffChoices.some((choice) => choice.task.key === task.key)
    ) {
      const names = recoveryExcludedIds
        .map((id) => state.staff.find((person) => person.id === id)?.name)
        .filter(Boolean);
      assignment.systemNotes = [
        `${names.join("、")}上一班做了需要休息保护的晚班岗位，按“次班重点岗位避让”的严格设置不能做这个岗位；没有其他安全人选，因此留空。请核对该设置和上一班记录，其他合法安排已保留。`,
      ];
      continue;
    }
    const reallocatedTo = assignments.find(
      (candidate) =>
        candidate.status === "assigned" &&
        candidate.staffId &&
        candidate.flightId !== assignment.flightId &&
        isPreNoonFlight(candidate) &&
        intervalsOverlap(
          assignment.startTime,
          assignment.endTime,
          candidate.startTime,
          candidate.endTime
        ) &&
        model.staffChoices.some(
          (choice) =>
            choice.task.key === task.key &&
            choice.person.id === candidate.staffId
        )
    );
    if (reallocatedTo) {
      clearAutomaticVacancyEvidence(assignment);
      assignment.systemNotes = [
        `因抽调至 ${reallocatedTo.flightNo}/${reallocatedTo.position} 而空缺`,
      ];
      continue;
    }
    const strictTransitionNames = [
      ...new Set(
        model.staffChoices
          .filter((choice) => choice.task.key === task.key)
          .flatMap((choice) =>
            violatedPositionTransitionPoliciesForInsertion(
              assignments,
              choice.person.id,
              task.flight.flightNo,
              task.rule.name,
              task.flight.startTime,
              task.flight.endTime,
              state,
              "forbid"
            ).map((policy) => policy.name)
          )
      ),
    ];
    if (!isPreNoonFlight(assignment) && strictTransitionNames.length) {
      clearAutomaticVacancyEvidence(assignment);
      assignment.systemNotes = [
        `严格岗位衔接限制未满足：${strictTransitionNames.join("、")}`,
      ];
      continue;
    }
    const eligibleIds = preparation.eligibleStaffIds.get(task.key) ?? new Set();
    if (eligibleIds.size === 0) {
      setAutomaticVacancyEvidence(assignment, {
        reason: "no-qualified-candidate",
        blockers: ["没有通过人员状态、资质、时段和安全约束的候选人员"],
      });
      continue;
    }
    setAutomaticVacancyEvidence(assignment, {
      reason: "daily-flight-count-balance",
      blockers: [
        `候选人员 ${eligibleIds.size} 人均未形成安全替代`,
        "岗位只能在航班数均衡阶段保留空缺",
      ],
    });
    continue;
  }
}

function attachCrossFlightPriorityEvidence(
  state: ScheduleGenerationFacts,
  model: DailyScheduleModel,
  assignments: Assignment[]
): void {
  for (const assignment of assignments) {
    if (
      assignment.status !== "assigned" ||
      !assignment.staffId ||
      !isCrossFlightPriorityAssignment(state, assignment)
    )
      continue;
    const competing = assignments.find(
      (other) =>
        other.status === "assigned" &&
        other.staffId &&
        other.flightId !== assignment.flightId &&
        intervalsOverlap(
          assignment.startTime,
          assignment.endTime,
          other.startTime,
          other.endTime
        ) &&
        model.staffChoices.some(
          (choice) =>
            choice.task.flight.id === other.flightId &&
            choice.person.id === assignment.staffId
        )
    );
    if (!competing) continue;
    const message = `${assignment.staffName}安排在${assignment.flightNo}/${assignment.position}。该人员也能承担同时段的${competing.flightNo}，因此本次按规则先留在${assignment.flightNo}；如需调整，必须重新通过完整安全复核。`;
    assignment.decisionTrace = [
      ...(assignment.decisionTrace ?? []),
      schedulingDecision("cross-flight-priority", "preserved", message),
    ];
  }
}

function decodeAssignments(
  selectedVariableIds: ReadonlySet<string>,
  model: DailyScheduleModel
): Assignment[] {
  const assignments = model.staffChoices.flatMap((choice) =>
    selectedVariableIds.has(choice.id) ? [choiceAssignment(choice)] : []
  );
  assignments.push(
    ...model.vacancyChoices.flatMap((choice) =>
      selectedVariableIds.has(choice.id)
        ? [
            makeUnfilled(
              choice.task.flight,
              choice.task.rule.name,
              choice.task.rule
            ),
          ]
        : []
    )
  );
  return assignments;
}

export function materializeDailySchedulePlan({
  state,
  date,
  preparation,
  model,
  selectedVariableIds,
}: {
  state: ScheduleGenerationFacts;
  date: string;
  preparation: SchedulePreparation;
  model: DailyScheduleModel;
  selectedVariableIds: ReadonlySet<string>;
}): DailySchedulePlan {
  const assignments = decodeAssignments(selectedVariableIds, model);
  const diversionAssignmentIds = diversionTransferAssignmentIds(
    assignments,
    state
  );
  applyConfiguredEarlyReleases(assignments, state);
  assignments.forEach((assignment) => {
    if (
      assignment.status === "assigned" &&
      !diversionAssignmentIds.has(assignment.id)
    ) {
      assignment.workHours = durationHours(
        assignment.startTime,
        assignment.endTime
      );
    }
  });
  attachDecisionTraces(state, date, preparation, model, assignments);
  attachCrossFlightPriorityEvidence(state, model, assignments);
  attachVacancyEvidence(state, preparation, model, assignments);
  const lockedAssignmentIds = new Set(
    assignments.flatMap((assignment) =>
      assignment.staffId === preparation.dutyStaffId &&
      preparation.preferredDutyLateTaskCandidates.some(
        (task) =>
          task.flight.id === assignment.flightId &&
          task.rule.id === assignment.positionRuleId
      )
        ? [assignment.id]
        : []
    )
  );
  if (!model.dailyFlightCountBalanceEnforced && state.flights.length <= 5) {
    enforceDailyFlightCountBalance(state, assignments, {
      dutyStaffId: preparation.dutyStaffId,
      halfRestStaffIds: preparation.runFacts.halfRest.activeStaffIds,
      lockedAssignmentIds,
      candidateStaffIds: new Set(
        model.staffChoices.map((choice) => choice.person.id)
      ),
    });
  }
  const warnings = [
    ...preparation.runFacts.halfRest.ignoredWarnings,
    ...[...preparation.runFacts.halfRest.activeStaffIds].flatMap((staffId) => {
      const person = state.staff.find((item) => item.id === staffId);
      const lateStart =
        preparation.runFacts.halfRest.lateStartStaffIds.has(staffId);
      if (lateStart) {
        const hasLate = assignments.some(
          (assignment) =>
            assignment.status === "assigned" &&
            assignment.staffId === staffId &&
            !isHalfRestMorningStart(assignment.startTime)
        );
        const hasLateCandidate = model.staffChoices.some(
          (choice) =>
            choice.person.id === staffId &&
            !isHalfRestMorningStart(choice.task.flight.startTime)
        );
        if (hasLate) return [];
        return [
          hasLateCandidate
            ? `${HALF_REST_WARNING_PREFIX}${person?.name ?? "所选人员"}未能落实最晚结束航班`
            : `${HALF_REST_WARNING_PREFIX}${person?.name ?? "所选人员"}没有可合法承担的午后岗位，仍保留上午半休`,
        ];
      }
      const hasMorning = assignments.some(
        (assignment) =>
          assignment.status === "assigned" &&
          assignment.staffId === staffId &&
          isPreNoonFlight(assignment)
      );
      if (hasMorning) return [];
      const hasMorningCandidate = model.staffChoices.some(
        (choice) =>
          choice.person.id === staffId && isPreNoonFlight(choice.task.flight)
      );
      return [
        hasMorningCandidate
          ? `${HALF_REST_WARNING_PREFIX}12点前岗位数量不足，${person?.name ?? "所选人员"}未能落实至少一个早班岗位`
          : `${HALF_REST_WARNING_PREFIX}${person?.name ?? "所选人员"}没有可合法承担的12点前岗位，仍保留下午半休`,
      ];
    }),
    ...assignments.flatMap((assignment) =>
      assignment.status === "unfilled"
        ? [`${assignment.flightNo} / ${assignment.position} 无可用人员`]
        : []
    ),
    ...crossWorkdayReservationStatuses(state, assignments)
      .filter((status) => status.shortfall > 0)
      .map(crossWorkdayReservationWarning),
  ];
  return {
    assignments,
    lockedAssignmentIds,
    dailyFlightCountBalanceFallback: !model.dailyFlightCountBalanceEnforced,
    warnings,
    optimizationQuality: "all-objectives-optimal",
  };
}

export function materializeValidatedDailySchedulePlan(options: {
  state: ScheduleGenerationFacts;
  date: string;
  preparation: SchedulePreparation;
  model: DailyScheduleModel;
  selectedVariableIds: ReadonlySet<string>;
  optimizationQuality: DailySchedulePlan["optimizationQuality"];
}): DailySchedulePlan {
  const plan = materializeDailySchedulePlan(options);
  plan.warnings.push(
    ...recoverLocalScheduleIssues(
      options.state,
      plan.assignments,
      (assignments) =>
        assertDailyScheduleSafety({
          state: options.state,
          date: options.date,
          assignments,
          tasks: options.preparation.tasks.filter(
            (task) => !isMobileSupervisor(task.flight, task.rule)
          ),
          evaluateEligibility: evaluateAutomaticHardConstraints,
          halfRestFacts: options.preparation.runFacts.halfRest,
        })
    )
  );
  return { ...plan, optimizationQuality: options.optimizationQuality };
}

export function validatedPlanCallback(
  base: Omit<
    Parameters<typeof materializeValidatedDailySchedulePlan>[0],
    "selectedVariableIds" | "optimizationQuality"
  >,
  receive: ((plan: DailySchedulePlan) => void) | undefined,
  quality: (result: SolverResult) => DailySchedulePlan["optimizationQuality"]
): ((result: SolverResult) => void) | undefined {
  return receive
    ? (result) =>
        receive(
          materializeValidatedDailySchedulePlan({
            ...base,
            selectedVariableIds: result.selectedVariableIds,
            optimizationQuality: quality(result),
          })
        )
    : undefined;
}
