import type {
  Assignment,
  Flight,
  PositionRule,
  ScheduleResult,
} from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import {
  assignmentDecisionMessages,
  attachAssignmentDecisionEvidence,
} from "../assignments/assignment-evidence";
import { strictOverrideNotes } from "../assignments/schedule-decision-notes";
import type { ScheduleLedger } from "./schedule-ledger";
import {
  runCoveragePipeline,
  runPostSchedulePipeline,
} from "./schedule-pipeline";
import {
  assignmentRule,
  makeUnfilled,
} from "../flights/schedule-position-rules";
import type { ScheduleProgressStage } from "./schedule-progress";
import type { ScheduleRunFacts } from "../shared/schedule-run-facts";
import { isPreNoonFlight, isMobileSupervisor } from "../flights/schedule-tasks";
import type { SolverPort } from "../solver/solver-port";
import {
  crossWorkdayReservationStatuses,
  crossWorkdayReservationWarning,
} from "../reviews/cross-workday-qualification-reservation";
import type { AssignmentTask } from "../flights/schedule-tasks";
import type { DailySchedulePlan } from "./daily-schedule-result";
import { assertDailyScheduleSafety } from "./daily-schedule-safety";
import { evaluateAutomaticHardConstraints } from "../rules/built-in-rule-registry";
import { scheduleOptimizationWarning } from "../reviews/schedule-warning-message";
import {
  halfRestAllowedAssignmentCount,
  isHalfRestWarning,
  HALF_REST_WARNING_PREFIX,
} from "../rules/half-rest";
import type { ScheduleSafetySession } from "./schedule-safety-session";
import { scheduleRuleFingerprint } from "../rules/schedule-rule-fingerprint";
import { enforceDailyFlightCountBalance } from "../assignments/daily-flight-count-balance";
import { recoverLocalScheduleIssues } from "./schedule-local-recovery";
import { dutyRosterStatusIssues } from "../duty-roster/roster";
import { fillConfiguredSupervisorTargets } from "../assignments/supervisor-fill";
import { ScheduleGuardError } from "./schedule-guard";
import type { SchedulePipelineContext } from "./schedule-pipeline";
import { guardExplanation } from "../shared/schedule-issue-explanation";
import {
  refreshVacancyDiagnostics,
  type VacancyDiagnosticFacts,
} from "../reviews/vacancy-diagnostics";

export interface ScheduleFinalizerOptions {
  vacancyDiagnosticFacts?: VacancyDiagnosticFacts;
  solver: SolverPort;
  state: ScheduleGenerationFacts;
  date: string;
  ledger: ScheduleLedger;
  safetySession: ScheduleSafetySession;
  warnings: string[];
  flights: readonly Flight[];
  displayRulesByFlight: ReadonlyMap<string, readonly PositionRule[]>;
  lockedAssignmentIds: Set<string>;
  dailyFlightCountBalanceFallback: boolean;
  candidateStaffIds: ReadonlySet<string>;
  runFacts: ScheduleRunFacts;
  automaticTasks: readonly AssignmentTask[];
  preservedAssignments: readonly Assignment[];
  optimizationQuality: DailySchedulePlan["optimizationQuality"];
  finalizeMobileSupervisors: () => Promise<void>;
  reportProgress: (stage: ScheduleProgressStage, percent: number) => void;
  scheduleRunId: string;
}

function workingAssignments(ledger: ScheduleLedger): Assignment[] {
  return ledger
    .snapshot()
    .map((assignment) => structuredClone(assignment) as Assignment);
}

function applyPreNoonDecisionNotes(
  state: ScheduleGenerationFacts,
  assignments: Assignment[]
): void {
  assignments
    .filter(
      (assignment) =>
        assignment.status === "assigned" &&
        assignment.staffId &&
        isPreNoonFlight(assignment)
    )
    .forEach((assignment) => {
      const rule = assignmentRule(state, assignment);
      const flight = state.flights.find(
        (item) => item.id === assignment.flightId
      );
      const person = state.staff.find((item) => item.id === assignment.staffId);
      if (!rule || rule.category !== "常规" || !flight || !person) return;
      const preserved = (assignment.systemNotes ?? []).filter(
        (note) => !note.startsWith("已突破严格限制仍安排：")
      );
      const strictNotes = strictOverrideNotes(
        state,
        assignments.filter((item) => item.id !== assignment.id),
        person,
        { key: `${flight.id}:${rule.id}`, flight, rule }
      );
      assignment.systemNotes = [...preserved, ...strictNotes];
      if (!assignment.systemNotes.length) delete assignment.systemNotes;
    });
}

function rebuildWarnings(
  state: ScheduleGenerationFacts,
  assignments: readonly Assignment[],
  postReviewWarnings: readonly string[],
  optimizationQuality: DailySchedulePlan["optimizationQuality"],
  persistentRunWarnings: readonly string[]
): string[] {
  const warnings = assignments.flatMap((assignment) => {
    if (assignment.status === "unfilled" && assignment.systemNotes?.length) {
      return [
        ...assignment.systemNotes.map(
          (note) => `${assignment.flightNo} / ${assignment.position} ${note}`
        ),
      ];
    }
    if (assignment.systemNotes?.length)
      return assignment.systemNotes.map(
        (note) => `${assignment.flightNo} / ${assignment.position} ${note}`
      );
    if (assignment.status !== "unfilled") return [];
    const category = assignmentRule(state, assignment)?.category;
    return [
      `${assignment.flightNo} / ${assignment.position} 空岗：${category === "引导" ? "未找到可复用的常规人员，" : ""}具体原因未记录`,
    ];
  });
  const reservationWarnings = crossWorkdayReservationStatuses(
    state,
    assignments
  )
    .filter((status) => status.shortfall > 0)
    .map(crossWorkdayReservationWarning);
  const optimizationWarning = scheduleOptimizationWarning(optimizationQuality);
  return [
    ...new Set([
      ...warnings,
      ...reservationWarnings,
      ...postReviewWarnings,
      ...persistentRunWarnings,
      ...(optimizationWarning ? [optimizationWarning] : []),
    ]),
  ];
}

function sortAssignments(
  assignments: Assignment[],
  flights: readonly Flight[],
  displayRulesByFlight: ReadonlyMap<string, readonly PositionRule[]>
): void {
  const flightOrder = new Map(
    flights.map((flight, index) => [flight.id, index])
  );
  assignments.sort(
    (left, right) =>
      (flightOrder.get(left.flightId) ?? flights.length) -
        (flightOrder.get(right.flightId) ?? flights.length) ||
      ((displayRulesByFlight
        .get(left.flightId)
        ?.findIndex((rule) => rule.id === left.positionRuleId) ?? -1) + 1 ||
        Number.MAX_SAFE_INTEGER) -
        ((displayRulesByFlight
          .get(right.flightId)
          ?.findIndex((rule) => rule.id === right.positionRuleId) ?? -1) + 1 ||
          Number.MAX_SAFE_INTEGER)
  );
}

export async function finalizeSchedule({
  vacancyDiagnosticFacts,
  solver,
  state,
  date,
  ledger,
  safetySession,
  warnings,
  flights,
  displayRulesByFlight,
  lockedAssignmentIds,
  candidateStaffIds,
  runFacts,
  automaticTasks,
  preservedAssignments,
  optimizationQuality,
  finalizeMobileSupervisors,
  reportProgress,
  scheduleRunId,
}: ScheduleFinalizerOptions): Promise<ScheduleResult> {
  const rejectedSupervisorNotes: string[] = [];
  const pipelineContext: SchedulePipelineContext = {
    solver,
    state,
    ledger,
    date,
    lockedAssignmentIds,
    runFacts,
    flights,
    displayRulesByFlight,
    finalizeMobileSupervisors,
    onProgress: reportProgress,
    onMutationRejected: (item, violations) => {
      if (item.stage !== "mobile-supervisor-finalize") return;
      rejectedSupervisorNotes.push(
        ...violations.map(
          (violation) =>
            `这一轮督导换人未采用：${guardExplanation(violation)}已恢复换人前的柜台，因此这个督导岗位暂时留空。`
        )
      );
    },
  };
  const postReviewWarnings = await runCoveragePipeline(pipelineContext);
  postReviewWarnings.push(...(await runPostSchedulePipeline(pipelineContext)));
  for (const message of assignmentDecisionMessages(ledger.snapshot(), {
    ruleIds: new Set(["position-rotation"]),
    outcomes: new Set(["fallback"]),
  })) {
    if (!postReviewWarnings.includes(message)) postReviewWarnings.push(message);
  }

  const assignments = workingAssignments(ledger);
  for (const task of automaticTasks) {
    if (
      assignments.some(
        (row) =>
          row.flightId === task.flight.id && row.positionRuleId === task.rule.id
      )
    )
      continue;
    assignments.push({
      ...makeUnfilled(task.flight, task.rule.name, task.rule),
      status: "unfilled",
      systemNotes: [
        "这个岗位没有找到合法安排，已留空；其他合法岗位照常保留。请核对该岗位的人员名单和相关设置。",
        ...(isMobileSupervisor(task.flight, task.rule)
          ? rejectedSupervisorNotes
          : []),
      ],
    });
  }
  const assertFinalSafety = (current: readonly Assignment[]): void => {
    safetySession.assertAssignmentsSafe(current);
    assertDailyScheduleSafety({
      state,
      date,
      assignments: current,
      tasks: automaticTasks,
      evaluateEligibility: evaluateAutomaticHardConstraints,
      allowFinalizedConcurrency: true,
      preservedAssignments,
      halfRestFacts: runFacts.halfRest,
    });
  };
  // Recovery explanations live on the final rows. Rebuilding below must not
  // keep a stale "left vacant" warning after that vacancy is safely refilled.
  recoverLocalScheduleIssues(state, assignments, (current) => {
    assertFinalSafety(current);
    // First try the original safe transfers/unlocked releases. Only an
    // impossible locked balance may release a locked automatic group.
    const balanceOptions = {
      dutyStaffId: runFacts.currentDutyStaffId,
      halfRestStaffIds: runFacts.halfRest.activeStaffIds,
      candidateStaffIds,
      useFullEligibility: true,
    };
    const balance = enforceDailyFlightCountBalance(state, assignments, {
      ...balanceOptions,
      lockedAssignmentIds,
    });
    if (balance.spread > 1)
      enforceDailyFlightCountBalance(state, assignments, {
        ...balanceOptions,
        allowTransfers: false,
      });
    assertFinalSafety(assignments);
  });
  // A final guard may remove a now-invalid supervisor/counter link after
  // supervisor finalization. Reuse the same configured-fill facts to complete
  // the empty counter with a regular worker; never bypass final safety.
  for (const source of [...assignments]) {
    if (
      source.status !== "assigned" ||
      assignmentRule(state, source)?.category !== "机动督导"
    )
      continue;
    fillConfiguredSupervisorTargets(state, assignments, source, "automatic", {
      regularOnly: true,
      validateRegularAssignments: (proposed) => {
        if (
          proposed.some(
            (row) =>
              lockedAssignmentIds.has(row.id) &&
              row.staffId !==
                assignments.find((original) => original.id === row.id)?.staffId
          )
        )
          return false;
        try {
          assertFinalSafety(proposed);
          const balanceProbe = structuredClone(proposed);
          const balance = enforceDailyFlightCountBalance(state, balanceProbe, {
            dutyStaffId: runFacts.currentDutyStaffId,
            halfRestStaffIds: runFacts.halfRest.activeStaffIds,
            candidateStaffIds,
            useFullEligibility: true,
            lockedAssignmentIds,
          });
          return balance.spread <= 1 && !balance.changed;
        } catch (error) {
          if (!(error instanceof ScheduleGuardError)) throw error;
          return false;
        }
      },
    });
  }
  assertFinalSafety(assignments);
  for (const staffId of runFacts.halfRest.activeStaffIds) {
    const mode =
      runFacts.halfRest.modesByStaffId.get(staffId) ?? "early-finish";
    if (halfRestAllowedAssignmentCount(assignments, staffId, mode)) continue;
    const name =
      state.staff.find((person) => person.id === staffId)?.name ?? "所选人员";
    postReviewWarnings.push(
      `${HALF_REST_WARNING_PREFIX}${name}今天没有排到符合半休时段的岗位，允许当天无岗；其他合法安排已保留。`
    );
  }
  postReviewWarnings.push(
    ...dutyRosterStatusIssues(state, date).map(
      (issue) =>
        `${issue}。计划选择已保留，本次不给休假或病假人员安排自动岗位；请在准备窗口选择实际在岗人员，或按真实情况修正状态。`
    )
  );
  if (
    runFacts.currentDutyStaffId &&
    !assignments.some(
      (row) =>
        row.status === "assigned" &&
        row.staffId === runFacts.currentDutyStaffId &&
        isPreNoonFlight(row)
    )
  ) {
    const name =
      state.staff.find((person) => person.id === runFacts.currentDutyStaffId)
        ?.name ?? "计划主值班人员";
    postReviewWarnings.push(
      `${name}没有落实12点前的值班岗位；其他合法岗位已保留。请核对主值班选择、半休时段与岗位名单。`
    );
  }
  applyPreNoonDecisionNotes(state, assignments);
  refreshVacancyDiagnostics(
    state,
    assignments,
    automaticTasks,
    runFacts,
    vacancyDiagnosticFacts
  );
  sortAssignments(assignments, flights, displayRulesByFlight);
  ledger.commit({ type: "replace", assignments });
  const resultAssignments = workingAssignments(ledger);
  const ruleFingerprint = scheduleRuleFingerprint(state);
  resultAssignments.forEach((assignment) =>
    attachAssignmentDecisionEvidence(assignment, {
      scheduleRunId,
      ruleFingerprint,
    })
  );
  ledger.commit({ type: "replace", assignments: resultAssignments });
  safetySession.resetWarnings();
  safetySession.assertAssignmentsSafe(resultAssignments);
  assertDailyScheduleSafety({
    state,
    date,
    assignments: resultAssignments,
    tasks: automaticTasks,
    evaluateEligibility: evaluateAutomaticHardConstraints,
    allowFinalizedConcurrency: true,
    preservedAssignments,
    halfRestFacts: runFacts.halfRest,
  });
  warnings.splice(
    0,
    warnings.length,
    ...rebuildWarnings(
      state,
      resultAssignments,
      postReviewWarnings,
      optimizationQuality,
      [...warnings.filter(isHalfRestWarning), ...safetySession.warnings()]
    )
  );
  return {
    assignments: resultAssignments,
    unfilledCount: resultAssignments.filter(
      (assignment) => assignment.status === "unfilled"
    ).length,
    warnings: [...warnings],
    safetyCredential: safetySession.createCredential(date, resultAssignments),
  };
}
