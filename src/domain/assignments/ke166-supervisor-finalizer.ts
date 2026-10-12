import type { Assignment } from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import { buildAssignmentDecisionTrace } from "./assignment-decision-trace";
import { createAssignedPosition } from "./assignment-factory";
import { applyEarlyReleases } from "./assignment-timing";
import { diversionTransferCount } from "./diversion-release-usage";
import {
  assignMobileSupervisorByCounterCoverage,
  assessKe166DistinctStaffCapacityFacts,
} from "./ke166-assignment";
import { strictOverrideNotes } from "./schedule-decision-notes";
import { selectAssignmentCandidate } from "../candidates/candidate-selection";
import { makeUnfilled } from "../flights/schedule-position-rules";
import {
  isKe166MobileSupervisor,
  isMobileSupervisor,
  type AssignmentTask,
} from "../flights/schedule-tasks";
import { consecutivePositionAssignments } from "../statistics/schedule-frequency";
import { createCandidateRulePlan } from "../rules/candidate-rule-plan";
import { evaluateAutomaticHardConstraints } from "../rules/built-in-rule-registry";
import type { SolverPort } from "../solver/solver-port";
import { durationHours } from "../shared/time";
import type { SchedulePreparation } from "../kernel/schedule-preparation";
import { halfRestPeriodViolation } from "../rules/half-rest";
import { schedulingDecision } from "../rules/schedule-rule-contract";
import {
  fillConfiguredSupervisorTargets,
  prepareConfiguredSupervisorFillUnderShortage,
  prepareConfiguredSupervisorFillUnderShortageByReassignment,
} from "./supervisor-fill";

export interface FinalizeMobileSupervisorsOptions {
  solver: SolverPort;
  state: ScheduleGenerationFacts;
  date: string;
  assignments: Assignment[];
  preparation: SchedulePreparation;
  lockedAssignmentIds: ReadonlySet<string>;
}

function mobileSupervisorTasks(
  preparation: SchedulePreparation
): AssignmentTask[] {
  return preparation.tasks
    .filter((task) => isMobileSupervisor(task.flight, task.rule))
    .sort(
      (left, right) =>
        Number(!isKe166MobileSupervisor(left.flight, left.rule)) -
        Number(!isKe166MobileSupervisor(right.flight, right.rule))
    );
}

export async function finalizeMobileSupervisors({
  solver,
  state,
  date,
  assignments,
  preparation,
  lockedAssignmentIds,
}: FinalizeMobileSupervisorsOptions): Promise<Assignment[]> {
  const tasks = mobileSupervisorTasks(preparation);
  const processedTasks = new Set(
    preparation.tasks
      .filter((task) => !isMobileSupervisor(task.flight, task.rule))
      .map((task) => task.key)
  );
  const dutyTargetTaskKeys = new Set([
    ...(preparation.preferredDutyMorningTaskKey
      ? [preparation.preferredDutyMorningTaskKey]
      : []),
    ...preparation.preferredDutyLateTaskCandidates.map((task) => task.key),
  ]);
  const candidateRulePlan = createCandidateRulePlan(state.settings);

  for (const task of tasks) {
    const ke166 = isKe166MobileSupervisor(task.flight, task.rule);
    const originalCounters = ke166 ? structuredClone(assignments) : [];
    const hours = durationHours(task.flight.startTime, task.flight.endTime);
    const preserveLegalCounters = (supervisor: Assignment): void => {
      if (!ke166) return;
      const violation = assessKe166DistinctStaffCapacityFacts(
        state,
        assignments
      ).find((item) => item.supervisor.id === supervisor.id);
      if (!violation) return;
      assignments.splice(0, assignments.length, ...originalCounters);
      const independent = orderedCandidates[0];
      if (independent) {
        const restored = createAssignedPosition(
          task,
          independent,
          hours,
          [],
          [
            schedulingDecision(
              "ke166-supervisor",
              "fallback",
              "兼任方案仍有安全普通候选，已恢复原柜台并保留合法独立督导"
            ),
          ]
        );
        assignments.push(restored);
        return;
      }
      const unfilled = makeUnfilled(task.flight, task.rule.name, task.rule);
      unfilled.decisionTrace = [
        schedulingDecision(
          "ke166-supervisor",
          "fallback",
          `${violation.candidate.name}仍可安全承担${violation.counter.flightNo}/${violation.counter.position}，不能采用督导兼任方案；已恢复原柜台安排，KE166机动督导留空，请人工复核`
        ),
      ];
      assignments.push(unfilled);
    };
    const selection = selectAssignmentCandidate({
      state,
      date,
      assignments,
      task,
      tasks: preparation.tasks,
      processedTasks,
      eligibleStaffIds: preparation.eligibleStaffIds,
      eligibleCounts: preparation.eligibleCounts,
      runFacts: preparation.runFacts,
      dutyStaffId: preparation.dutyStaffId,
      hours,
      isDutyTarget: dutyTargetTaskKeys.has(task.key),
      reserveDutyForPendingTarget: false,
      protectDutyFromAdditionalPriorityPosition: false,
      currentDutyTargetTaskKeys: dutyTargetTaskKeys,
      preNoonRequired: false,
      canBreakStrictTransition: true,
      finalizingKe166Supervisor: ke166,
      candidateRulePlan,
      evaluateEligibility: evaluateAutomaticHardConstraints,
    });
    const existingDiversionCount = diversionTransferCount(assignments, state);
    const candidateDiversionCount = (staffId: string): number => {
      const person = state.staff.find((item) => item.id === staffId)!;
      return (
        diversionTransferCount(
          [...assignments, createAssignedPosition(task, person, hours, [], [])],
          state
        ) - existingDiversionCount
      );
    };
    const orderedCandidates = selection.candidates
      .filter(
        (person) =>
          !halfRestPeriodViolation({
            facts: preparation.runFacts.halfRest,
            staffId: person.id,
            startTime: task.flight.startTime,
          })
      )
      .sort(
        (left, right) =>
          candidateDiversionCount(left.id) -
            candidateDiversionCount(right.id) ||
          selection.candidates.indexOf(left) -
            selection.candidates.indexOf(right)
      );
    let selected = orderedCandidates[0];
    const runnerUp = orderedCandidates[1];
    let preferredConfiguredFill = false;
    let configuredFillFallbackReason: string | null = null;
    const recordConfiguredFillFailure = (reason: string): void => {
      configuredFillFallbackReason = `配置的督导补位失败：${reason}；已恢复原班表，改走原有安排`;
    };
    const addConfiguredFillFallback = (assignment: Assignment): void => {
      if (!configuredFillFallbackReason) return;
      assignment.decisionTrace = [
        ...(assignment.decisionTrace ?? []),
        schedulingDecision(
          "mobile-supervisor",
          "fallback",
          configuredFillFallbackReason
        ),
      ];
    };
    const preparePreferredConfiguredFill = async () => {
      const proposedAssignments = structuredClone(assignments);
      const byReassignment =
        await prepareConfiguredSupervisorFillUnderShortageByReassignment(
          solver,
          state,
          proposedAssignments,
          task.flight,
          task.rule,
          date,
          preparation.runFacts,
          lockedAssignmentIds,
          "automatic",
          (staffId) =>
            !halfRestPeriodViolation({
              facts: preparation.runFacts.halfRest,
              staffId,
              startTime: task.flight.startTime,
            }),
          recordConfiguredFillFailure
        );
      const proposedSupervisor =
        byReassignment ??
        prepareConfiguredSupervisorFillUnderShortage(
          state,
          proposedAssignments,
          task.flight,
          task.rule,
          lockedAssignmentIds,
          "automatic",
          (staffId) =>
            !halfRestPeriodViolation({
              facts: preparation.runFacts.halfRest,
              staffId,
              startTime: task.flight.startTime,
            }),
          recordConfiguredFillFailure
        );
      if (!proposedSupervisor) return null;
      if (ke166) {
        const probeAssignments = structuredClone(proposedAssignments);
        const probeSource = createAssignedPosition(
          task,
          proposedSupervisor,
          hours,
          [],
          []
        );
        probeAssignments.push(probeSource);
        fillConfiguredSupervisorTargets(
          state,
          probeAssignments,
          probeSource,
          "automatic",
          { ignoreSafeRegularCandidate: true }
        );
        const violation = assessKe166DistinctStaffCapacityFacts(
          state,
          probeAssignments
        ).find((item) => item.supervisor.id === probeSource.id);
        if (violation) {
          const target = proposedAssignments.find(
            (item) => item.id === violation.counter.id
          );
          const targetFlight = state.flights.find(
            (item) => item.id === target?.flightId
          );
          const targetRule = state.positionRules.find(
            (item) => item.id === target?.positionRuleId
          );
          const candidate = state.staff.find(
            (item) => item.id === violation.candidate.id
          );
          if (
            !violation.blockingAssignment &&
            target &&
            targetFlight &&
            targetRule &&
            candidate &&
            !halfRestPeriodViolation({
              facts: preparation.runFacts.halfRest,
              staffId: candidate.id,
              startTime: target.startTime,
            }) &&
            evaluateAutomaticHardConstraints({
              state,
              assignments: probeAssignments.filter(
                (item) => item.id !== target.id
              ),
              flight: targetFlight,
              rule: targetRule,
              person: candidate,
              workHours: durationHours(target.startTime, target.endTime),
              transitionMode: "forbid",
            }).eligible
          ) {
            Object.assign(target, {
              staffId: candidate.id,
              staffName: candidate.name,
              status: "assigned",
              workHours: durationHours(target.startTime, target.endTime),
              fatiguePoints: targetRule.fatiguePoints,
            });
            configuredFillFallbackReason = `腾挪后${candidate.name}可安全承担${target.flightNo}/${target.position}，已恢复普通柜台并独立安排督导`;
            assignments.splice(0, assignments.length, ...proposedAssignments);
            return proposedSupervisor;
          }
          recordConfiguredFillFailure(
            `腾挪后${violation.candidate.name}仍可安全承担${violation.counter.flightNo}/${violation.counter.position}，无需让督导补位该柜台`
          );
          return null;
        }
      }
      assignments.splice(0, assignments.length, ...proposedAssignments);
      return proposedSupervisor;
    };
    const repeatedIndependentSupervisorCanBeReleased = Boolean(
      ke166 &&
      selected &&
      consecutivePositionAssignments(
        state,
        selected.id,
        task.flight.flightNo,
        task.rule.name,
        task.rule.remark,
        date
      ) > 0 &&
      (selected.teamLeader ||
        assignments.some(
          (assignment) =>
            assignment.staffId === selected!.id &&
            assignment.status === "assigned" &&
            assignment.workHours > 0
        ))
    );
    if (repeatedIndependentSupervisorCanBeReleased) {
      const fillPreferred = await preparePreferredConfiguredFill();
      if (fillPreferred) {
        selected = fillPreferred;
        preferredConfiguredFill = true;
      }
    }
    if (
      repeatedIndependentSupervisorCanBeReleased &&
      !preferredConfiguredFill
    ) {
      const reused = await assignMobileSupervisorByCounterCoverage(
        solver,
        state,
        assignments,
        task.flight,
        task.rule,
        date,
        preparation.runFacts,
        lockedAssignmentIds,
        selected!.id
      );
      if (reused) {
        addConfiguredFillFallback(reused);
        assignments.push(reused);
        preserveLegalCounters(reused);
        processedTasks.add(task.key);
        continue;
      }
    }
    if (!selected) {
      const fillPreferred = await preparePreferredConfiguredFill();
      if (fillPreferred) {
        selected = fillPreferred;
        preferredConfiguredFill = true;
      }
    }
    if (!selected) {
      const reused = await assignMobileSupervisorByCounterCoverage(
        solver,
        state,
        assignments,
        task.flight,
        task.rule,
        date,
        preparation.runFacts,
        lockedAssignmentIds
      );
      if (reused) {
        addConfiguredFillFallback(reused);
        assignments.push(reused);
        preserveLegalCounters(reused);
        processedTasks.add(task.key);
        continue;
      }
    }
    if (!selected) {
      const unfilled = makeUnfilled(task.flight, task.rule.name, task.rule);
      if (configuredFillFallbackReason) {
        unfilled.decisionTrace = [
          schedulingDecision(
            "mobile-supervisor",
            "fallback",
            configuredFillFallbackReason
          ),
        ];
      }
      assignments.push(unfilled);
      processedTasks.add(task.key);
      continue;
    }

    applyEarlyReleases(assignments, selected.id, task.flight, state);
    const systemNotes = strictOverrideNotes(state, assignments, selected, task);
    const decisionTrace = buildAssignmentDecisionTrace({
      state,
      date,
      assignments,
      task,
      selected,
      runnerUp,
      candidates: selection.candidates,
      candidatePriorities: selection.priorities,
      candidateRulePlan,
      decisiveCandidateRule:
        selected?.id === selection.selected?.id &&
        runnerUp?.id === selection.runnerUp?.id
          ? selection.decisiveRule
          : null,
      runFacts: preparation.runFacts,
      dutyStaffId: preparation.dutyStaffId,
      isDutyTarget: dutyTargetTaskKeys.has(task.key),
      hasAssignedDutyLateTask: preparation.preferredDutyLateTaskCandidates.some(
        (candidate) =>
          assignments.some(
            (assignment) =>
              assignment.flightId === candidate.flight.id &&
              assignment.positionRuleId === candidate.rule.id &&
              assignment.staffId === preparation.dutyStaffId
          )
      ),
      finalizingKe166Supervisor: ke166,
    });
    if (!ke166) {
      decisionTrace.push(
        schedulingDecision(
          "mobile-supervisor",
          "selected",
          `${selected.name}在普通岗位排班完成后独立担任${task.flight.flightNo}/${task.rule.name}`
        )
      );
    }
    if (configuredFillFallbackReason) {
      decisionTrace.push(
        schedulingDecision(
          "mobile-supervisor",
          "fallback",
          configuredFillFallbackReason
        )
      );
    }
    const supervisorAssignment = createAssignedPosition(
      task,
      selected,
      hours,
      systemNotes,
      decisionTrace
    );
    assignments.push(supervisorAssignment);
    fillConfiguredSupervisorTargets(
      state,
      assignments,
      supervisorAssignment,
      "automatic",
      preferredConfiguredFill ? { ignoreSafeRegularCandidate: true } : undefined
    );
    preserveLegalCounters(supervisorAssignment);
    processedTasks.add(task.key);
  }
  return assignments;
}
