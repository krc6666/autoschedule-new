import type { Assignment, Flight, PositionRule, Staff } from "../../model";
import type {
  AssignmentEligibilityFacts,
  ScheduleGenerationFacts,
} from "../shared/scheduling-facts";
import {
  clearSupervisorFillLink,
  evaluateSupervisorFillFacts,
  setSupervisorFillLink,
  type SupervisorFillMode,
} from "../coverage/supervisor-fill-facts";
import { eligibleStaffForRule } from "../candidates/assignment-eligibility";
import { assignmentRule } from "../flights/schedule-position-rules";
import {
  isNumberedRegularPosition,
  shouldAutoAssign,
} from "../flights/schedule-tasks";
import { evaluateAutomaticHardConstraints } from "../rules/built-in-rule-registry";
import { clearAutomaticAssignmentEvidence } from "./assignment-evidence";
import { schedulingDecision } from "../rules/schedule-rule-contract";
import { durationHours } from "../shared/time";
import type { ScheduleRunFacts } from "../shared/schedule-run-facts";
import { optimizeReassignment } from "../solver/reassignment-optimizer";
import type { SolverPort } from "../solver/solver-port";

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN");
}

function matches(value: string, keyword: string): boolean {
  const normalizedKeyword = normalize(keyword);
  return (
    Boolean(normalizedKeyword) && normalize(value).includes(normalizedKeyword)
  );
}

function clearStaffFromAssignment(
  state: AssignmentEligibilityFacts,
  assignment: Assignment
): void {
  const flight = state.flights.find((item) => item.id === assignment.flightId);
  const rule = assignmentRule(state, assignment);
  clearAutomaticAssignmentEvidence(assignment);
  clearSupervisorFillLink(assignment);
  assignment.staffId = null;
  assignment.staffName = "";
  assignment.status =
    !assignment.positionRuleId || rule?.manual || rule?.category === "行政支援"
      ? "manual"
      : "unfilled";
  assignment.workHours = flight
    ? durationHours(flight.startTime, flight.endTime)
    : assignment.workHours;
  assignment.fatiguePoints = rule?.fatiguePoints ?? assignment.workHours;
}

function placeStaffOnAssignment(
  state: AssignmentEligibilityFacts,
  assignment: Assignment,
  person: Staff
): void {
  const flight = state.flights.find((item) => item.id === assignment.flightId);
  const rule = assignmentRule(state, assignment);
  clearAutomaticAssignmentEvidence(assignment);
  clearSupervisorFillLink(assignment);
  assignment.staffId = person.id;
  assignment.staffName = person.name;
  assignment.status = "assigned";
  assignment.workHours = flight
    ? durationHours(flight.startTime, flight.endTime)
    : assignment.workHours;
  assignment.fatiguePoints = rule?.fatiguePoints ?? assignment.workHours;
}

/** Auto-schedulable numbered counters only — skip manual / below-threshold posts. */
function sameFlightMovableAutoCounters(
  state: AssignmentEligibilityFacts,
  assignments: readonly Assignment[],
  flightId: string
): Assignment[] {
  return assignments.filter((assignment) => {
    if (assignment.flightId !== flightId) return false;
    if (assignment.status === "manual") return false;
    const rule = assignmentRule(state, assignment);
    const flight = state.flights.find(
      (item) => item.id === assignment.flightId
    );
    if (!rule || !flight || !isNumberedRegularPosition(rule) || rule.manual)
      return false;
    return shouldAutoAssign(flight, rule, state.settings.adminSupportEnabled);
  });
}

function configuredFillTargets(
  state: AssignmentEligibilityFacts,
  assignments: readonly Assignment[],
  sourceFlight: Flight,
  sourceRule: PositionRule,
  mode: SupervisorFillMode
): Assignment[] {
  const rules = state.settings.mobileSupervisorFillRules.filter(
    (rule) =>
      rule.enabled &&
      (mode === "automatic" ? rule.allowAutomatic : rule.allowManual) &&
      normalize(rule.sourceFlightNo) === normalize(sourceFlight.flightNo) &&
      matches(sourceRule.name, rule.sourcePositionKeyword)
  );
  if (!rules.length) return [];
  return assignments.filter((assignment) => {
    const rule = assignmentRule(state, assignment);
    const flight = state.flights.find(
      (item) => item.id === assignment.flightId
    );
    if (!rule || !flight || rule.coverageRole !== "supervisor-fill")
      return false;
    return rules.some(
      (fillRule) =>
        normalize(fillRule.targetFlightNo) === normalize(flight.flightNo) &&
        matches(rule.name, fillRule.targetPositionKeyword)
    );
  });
}

function personIsFree(
  assignments: readonly Assignment[],
  staffId: string,
  exceptAssignmentId?: string
): boolean {
  return !assignments.some(
    (assignment) =>
      assignment.id !== exceptAssignmentId &&
      assignment.staffId === staffId &&
      assignment.status === "assigned"
  );
}

function canPersonTakeCounter(
  state: AssignmentEligibilityFacts,
  assignments: readonly Assignment[],
  vacancy: Assignment,
  person: Staff
): boolean {
  const rule = assignmentRule(state, vacancy);
  const flight = state.flights.find((item) => item.id === vacancy.flightId);
  if (!rule || !flight) return false;
  const workHours = durationHours(flight.startTime, flight.endTime);
  return evaluateAutomaticHardConstraints({
    state,
    assignments: assignments.filter(
      (assignment) => assignment.id !== vacancy.id
    ),
    flight,
    rule,
    person,
    workHours,
    transitionMode: "forbid",
  }).eligible;
}

/**
 * Assign free eligible people to vacated non-fill counters.
 * Uses depth-first search so a greedy dead-end does not miss a full legal cover.
 */
function refillEmptyNonFillCounters(
  state: AssignmentEligibilityFacts,
  assignments: Assignment[],
  counters: readonly Assignment[],
  fillTargets: readonly Assignment[],
  supervisorId: string,
  lockedAssignmentIds: ReadonlySet<string>,
  isStaffAllowed: (staffId: string) => boolean
): boolean {
  const fillIds = new Set(fillTargets.map((target) => target.id));
  const vacancies = counters.filter(
    (assignment) =>
      !fillIds.has(assignment.id) &&
      !lockedAssignmentIds.has(assignment.id) &&
      !assignment.staffId
  );
  if (!vacancies.length) return true;

  const tryAssign = (index: number): boolean => {
    if (index >= vacancies.length) return true;
    const vacancy = vacancies[index]!;
    const candidates = state.staff
      .filter(
        (person) =>
          person.id !== supervisorId &&
          person.status === "正常" &&
          person.staffType === "常规" &&
          isStaffAllowed(person.id) &&
          personIsFree(assignments, person.id)
      )
      .sort((left, right) =>
        left.id.localeCompare(right.id, undefined, { numeric: true })
      );
    for (const person of candidates) {
      if (!canPersonTakeCounter(state, assignments, vacancy, person)) continue;
      placeStaffOnAssignment(state, vacancy, person);
      if (tryAssign(index + 1)) return true;
      clearStaffFromAssignment(state, vacancy);
    }
    return false;
  };

  return tryAssign(0);
}

type AssignmentSnapshot = {
  assignment: Assignment;
  staffId: string | null;
  staffName: string;
  status: Assignment["status"];
  workHours: number;
  fatiguePoints: number;
  supervisorSourceAssignmentId?: string;
  supervisorFillRuleId?: string;
  decisionTrace?: Assignment["decisionTrace"];
  systemNotes?: string[];
  decisionEvidence?: Assignment["decisionEvidence"];
  teamLeaderGapFill?: true;
};

function snapshotAssignments(assignments: Assignment[]): AssignmentSnapshot[] {
  return assignments.map((assignment) => ({
    assignment,
    staffId: assignment.staffId,
    staffName: assignment.staffName,
    status: assignment.status,
    workHours: assignment.workHours,
    fatiguePoints: assignment.fatiguePoints,
    supervisorSourceAssignmentId: assignment.supervisorSourceAssignmentId,
    supervisorFillRuleId: assignment.supervisorFillRuleId,
    decisionTrace: assignment.decisionTrace,
    systemNotes: assignment.systemNotes,
    decisionEvidence: assignment.decisionEvidence,
    teamLeaderGapFill: assignment.teamLeaderGapFill,
  }));
}

function restoreAssignments(snapshot: readonly AssignmentSnapshot[]): void {
  for (const entry of snapshot) {
    entry.assignment.staffId = entry.staffId;
    entry.assignment.staffName = entry.staffName;
    entry.assignment.status = entry.status;
    entry.assignment.workHours = entry.workHours;
    entry.assignment.fatiguePoints = entry.fatiguePoints;
    if (entry.supervisorSourceAssignmentId)
      setSupervisorFillLink(
        entry.assignment,
        entry.supervisorSourceAssignmentId,
        entry.supervisorFillRuleId
      );
    else clearSupervisorFillLink(entry.assignment);
    if (entry.decisionTrace)
      entry.assignment.decisionTrace = entry.decisionTrace;
    else delete entry.assignment.decisionTrace;
    if (entry.systemNotes) entry.assignment.systemNotes = entry.systemNotes;
    else delete entry.assignment.systemNotes;
    if (entry.decisionEvidence)
      entry.assignment.decisionEvidence = entry.decisionEvidence;
    else delete entry.assignment.decisionEvidence;
    if (entry.teamLeaderGapFill)
      entry.assignment.teamLeaderGapFill = entry.teamLeaderGapFill;
    else delete entry.assignment.teamLeaderGapFill;
  }
}

/**
 * When no idle independent mobile supervisor exists, free the configured
 * supervisor-fill counter so the later independent+fill path can bind there
 * instead of generic 兼任 onto another counter.
 *
 * Displaced people are only placed on counters they pass hard constraints for;
 * other qualified staff may be used to cover vacated non-fill counters.
 */
export function prepareConfiguredSupervisorFillUnderShortage(
  state: AssignmentEligibilityFacts,
  assignments: Assignment[],
  sourceFlight: Flight,
  sourceRule: PositionRule,
  lockedAssignmentIds: ReadonlySet<string> = new Set(),
  mode: SupervisorFillMode = "automatic",
  isStaffAllowed: (staffId: string) => boolean = () => true,
  onFailure?: (reason: string) => void
): Staff | null {
  const fillTargets = configuredFillTargets(
    state,
    assignments,
    sourceFlight,
    sourceRule,
    mode
  );
  if (!fillTargets.length) {
    onFailure?.("没有启用且允许自动执行的配置督导补位岗位");
    return null;
  }
  if (fillTargets.some((target) => lockedAssignmentIds.has(target.id))) {
    onFailure?.("配置的督导补位岗位已锁定，不能腾挪");
    return null;
  }

  const counters = sameFlightMovableAutoCounters(
    state,
    assignments,
    sourceFlight.id
  );
  const eligible = eligibleStaffForRule(state, sourceFlight, sourceRule).filter(
    (person) =>
      person.status === "正常" &&
      person.staffType === "常规" &&
      isStaffAllowed(person.id)
  );
  if (!eligible.length) {
    onFailure?.("没有通过人员状态、类型、资质和半休条件的督导候选");
    return null;
  }

  const ranked = [...eligible].sort((left, right) => {
    const leftOnCounter = Number(
      counters.some((assignment) => assignment.staffId === left.id)
    );
    const rightOnCounter = Number(
      counters.some((assignment) => assignment.staffId === right.id)
    );
    return (
      rightOnCounter - leftOnCounter ||
      left.id.localeCompare(right.id, undefined, { numeric: true })
    );
  });

  const sourceWorkHours = durationHours(
    sourceFlight.startTime,
    sourceFlight.endTime
  );

  let lastFailureReason = "没有能安全腾挪并完成配置督导补位的方案";
  for (const person of ranked) {
    if (
      counters.some(
        (assignment) =>
          assignment.staffId === person.id &&
          lockedAssignmentIds.has(assignment.id)
      )
    ) {
      lastFailureReason = `${person.name} 当前柜台已锁定，不能腾挪`;
      continue;
    }

    const snapshot = snapshotAssignments(assignments);
    const restore = () => restoreAssignments(snapshot);

    for (const counter of counters) {
      if (counter.staffId === person.id && !lockedAssignmentIds.has(counter.id))
        clearStaffFromAssignment(state, counter);
    }
    for (const target of fillTargets) {
      if (target.staffId) clearStaffFromAssignment(state, target);
    }

    if (
      !refillEmptyNonFillCounters(
        state,
        assignments,
        counters,
        fillTargets,
        person.id,
        lockedAssignmentIds,
        isStaffAllowed
      )
    ) {
      lastFailureReason = `${person.name} 腾出督导补位后，其他普通柜台没有合法替补`;
      restore();
      continue;
    }

    const sourceEligibility = evaluateAutomaticHardConstraints({
      state,
      assignments,
      flight: sourceFlight,
      rule: sourceRule,
      person,
      workHours: sourceWorkHours,
      transitionMode: "forbid",
    });
    if (!sourceEligibility.eligible) {
      lastFailureReason =
        sourceEligibility.violations[0]?.message ??
        `${person.name} 未通过督导硬约束`;
      restore();
      continue;
    }

    const probeSource: Assignment = {
      id: "probe-supervisor-fill",
      flightId: sourceFlight.id,
      flightNo: sourceFlight.flightNo,
      positionRuleId: sourceRule.id,
      position: sourceRule.name,
      staffId: person.id,
      staffName: person.name,
      startTime: sourceFlight.startTime,
      endTime: sourceFlight.endTime,
      workHours: sourceWorkHours,
      fatiguePoints: sourceRule.fatiguePoints,
      remark: sourceRule.remark,
      manualRemark: "",
      status: "assigned",
    };
    const probeAssignments = [...assignments, probeSource];
    const fillEvaluation = fillTargets
      .map((target) => {
        const liveTarget = probeAssignments.find(
          (item) => item.id === target.id
        );
        return liveTarget
          ? evaluateSupervisorFillFacts(
              state,
              probeAssignments,
              probeSource,
              liveTarget,
              mode,
              { ignoreSafeRegularCandidate: true }
            )
          : null;
      })
      .find((evaluation) => evaluation?.allowed);
    if (!fillEvaluation) {
      lastFailureReason =
        fillTargets
          .map((target) => {
            const liveTarget = probeAssignments.find(
              (item) => item.id === target.id
            );
            return liveTarget
              ? evaluateSupervisorFillFacts(
                  state,
                  probeAssignments,
                  probeSource,
                  liveTarget,
                  mode,
                  { ignoreSafeRegularCandidate: true }
                ).reason
              : null;
          })
          .find(Boolean) ?? `${person.name} 无法合法承担配置督导补位`;
      restore();
      continue;
    }
    return person;
  }
  onFailure?.(lastFailureReason);
  return null;
}

/**
 * Finds a complete same-flight counter chain before the generic supervisor
 * fallback. The actual H05 binding remains in fillConfiguredSupervisorTargets.
 */
export async function prepareConfiguredSupervisorFillUnderShortageByReassignment(
  solver: SolverPort,
  state: ScheduleGenerationFacts,
  assignments: Assignment[],
  sourceFlight: Flight,
  sourceRule: PositionRule,
  date: string,
  facts: ScheduleRunFacts,
  lockedAssignmentIds: ReadonlySet<string> = new Set(),
  mode: SupervisorFillMode = "automatic",
  isStaffAllowed: (staffId: string) => boolean = () => true,
  onFailure?: (reason: string) => void
): Promise<Staff | null> {
  const fillTargets = configuredFillTargets(
    state,
    assignments,
    sourceFlight,
    sourceRule,
    mode
  ).filter((target) => !lockedAssignmentIds.has(target.id));
  if (!fillTargets.length) return null;

  const counters = sameFlightMovableAutoCounters(
    state,
    assignments,
    sourceFlight.id
  );
  const eligible = eligibleStaffForRule(state, sourceFlight, sourceRule)
    .filter(
      (person) =>
        person.status === "正常" &&
        person.staffType === "常规" &&
        isStaffAllowed(person.id)
    )
    .sort((left, right) => {
      const leftOnCounter = Number(
        counters.some((assignment) => assignment.staffId === left.id)
      );
      const rightOnCounter = Number(
        counters.some((assignment) => assignment.staffId === right.id)
      );
      return (
        rightOnCounter - leftOnCounter ||
        left.id.localeCompare(right.id, undefined, { numeric: true })
      );
    });
  if (!eligible.length) return null;

  let lastFailureReason = "没有能完成同航班连环腾挪的合法方案";
  for (const target of fillTargets) {
    const targetRule = assignmentRule(state, target);
    if (!targetRule) continue;
    for (const supervisor of eligible) {
      const sourceProbe: Assignment = {
        id: `probe-supervisor-fill-${supervisor.id}`,
        flightId: sourceFlight.id,
        flightNo: sourceFlight.flightNo,
        positionRuleId: sourceRule.id,
        position: sourceRule.name,
        staffId: supervisor.id,
        staffName: supervisor.name,
        startTime: sourceFlight.startTime,
        endTime: sourceFlight.endTime,
        workHours: durationHours(sourceFlight.startTime, sourceFlight.endTime),
        fatiguePoints: sourceRule.fatiguePoints,
        remark: sourceRule.remark,
        manualRemark: "",
        status: "assigned",
      };
      const optimizationState: ScheduleGenerationFacts = {
        ...state,
        positionRules: state.positionRules.map((rule) =>
          rule.id === targetRule.id
            ? {
                ...rule,
                qualifiedStaffIds: [
                  ...new Set([...rule.qualifiedStaffIds, supervisor.id]),
                ],
              }
            : rule
        ),
      };
      const result = await optimizeReassignment({
        solver,
        state: optimizationState,
        assignments: [...assignments, sourceProbe],
        primary: target,
        movableAssignments: [
          sourceProbe,
          ...counters.filter(
            (counter) =>
              counter.id !== target.id && !lockedAssignmentIds.has(counter.id)
          ),
        ],
        date,
        facts,
        intent: { kind: "configured-supervisor-fill-under-shortage" },
        permittedConcurrentAssignmentIds: new Set([sourceProbe.id, target.id]),
        coupledAssignmentGroups: [[sourceProbe.id, target.id]],
        candidateAllowed: (assignment, person) =>
          assignment.id === sourceProbe.id
            ? person.id === supervisor.id
            : isStaffAllowed(person.id),
        primaryCandidateAllowed: (person) => person.id === supervisor.id,
        primaryCandidateRejectionReason: () => "不是当前配置的督导补位候选",
        choiceWorkHours: (assignment) =>
          assignment.id === target.id ? 0 : assignment.workHours,
        normalizeChanges: (changes) =>
          changes.map((change) =>
            change.assignmentId === target.id
              ? { ...change, workHours: 0, status: "assigned" }
              : change
          ),
        maxParticipants: 5,
        acceptTimeLimitedFeasible: true,
      });
      if (!result.changes) {
        lastFailureReason = result.attemptedReasons[0] ?? lastFailureReason;
        continue;
      }

      const targetChange = result.changes.find(
        (change) => change.assignmentId === target.id
      );
      if (targetChange?.staffId !== supervisor.id) {
        lastFailureReason = "连环腾挪未能把配置补位柜台留给督导";
        continue;
      }

      for (const change of result.changes) {
        if (change.assignmentId === target.id) continue;
        const assignment = assignments.find(
          (item) => item.id === change.assignmentId
        );
        const person = state.staff.find((item) => item.id === change.staffId);
        if (assignment && person)
          placeStaffOnAssignment(state, assignment, person);
      }
      clearStaffFromAssignment(state, target);
      return supervisor;
    }
  }
  onFailure?.(lastFailureReason);
  return null;
}

export function fillConfiguredSupervisorTargets(
  state: AssignmentEligibilityFacts,
  assignments: Assignment[],
  source: Assignment,
  mode: "automatic" | "manual",
  options: {
    ignoreSafeRegularCandidate?: boolean;
    /** Automatic callers validate all run-specific rules before filling a regular vacancy. */
    validateRegularAssignments?: (assignments: Assignment[]) => boolean;
    /** Final vacancy repair must not recreate a supervisor link removed by a guard. */
    regularOnly?: boolean;
  } = {}
): Assignment[] {
  const filled: Assignment[] = [];
  for (const target of assignments) {
    if (
      target.id === source.id ||
      target.status === "assigned" ||
      target.staffId
    )
      continue;
    const evaluation = evaluateSupervisorFillFacts(
      state,
      assignments,
      source,
      target,
      mode,
      options
    );
    if (!evaluation.allowed) {
      if (
        mode === "automatic" &&
        target.status === "unfilled" &&
        options.validateRegularAssignments
      ) {
        for (const person of evaluation.safeRegularCandidates ?? []) {
          const proposed = structuredClone(assignments);
          const proposedTarget = proposed.find((row) => row.id === target.id)!;
          placeStaffOnAssignment(state, proposedTarget, person);
          if (!options.validateRegularAssignments(proposed)) continue;
          clearAutomaticAssignmentEvidence(target);
          clearSupervisorFillLink(target);
          Object.assign(target, proposedTarget);
          target.decisionTrace = [
            schedulingDecision(
              "mobile-supervisor",
              "selected",
              `${person.name}可安全承担${target.flightNo}/${target.position}，已补上普通柜台，督导保持原安排`
            ),
          ];
          filled.push(target);
          break;
        }
      }
      continue;
    }
    if (options.regularOnly) continue;
    target.staffId = source.staffId;
    target.staffName = source.staffName;
    target.status = "assigned";
    target.workHours = 0;
    target.fatiguePoints = 0;
    setSupervisorFillLink(target, source.id, evaluation.rule?.id);
    clearAutomaticAssignmentEvidence(target);
    target.decisionTrace = [
      ...(target.decisionTrace ?? []),
      schedulingDecision(
        "mobile-supervisor",
        "selected",
        `${source.staffName}在人手不足时由${source.flightNo}/${source.position}补位${target.flightNo}/${target.position}`
      ),
    ];
    filled.push(target);
  }
  return filled;
}
