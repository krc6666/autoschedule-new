import type { Assignment } from "../../model";
import { hasDutyMorningAssignment } from "../assignments/duty-assignment";
import { applyConfiguredEarlyReleases } from "../assignments/assignment-timing";
import { diversionTransferCount } from "../assignments/diversion-release-usage";
import {
  canAssignStaff,
  diagnoseDailyPrimaryPositionEligibility,
} from "../candidates/assignment-eligibility";
import {
  assignmentRule,
  isGapFillGuidePosition,
  isLegalGuideReuse,
} from "../flights/schedule-position-rules";
import type { ScheduleRunFacts } from "../shared/schedule-run-facts";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import { intervalsOverlap } from "../shared/time";
import type { ScheduleFrequencyFacts } from "../statistics/schedule-frequency";
import { latePriorityFrequencyRegressionReasons } from "./late-priority-frequency-balance";
import {
  reassignmentCandidateSafetyReasons,
  reassignmentDynamicSafetyReasons,
  ROTATION_REVIEW_POLICIES,
  type LatePriorityFatigueReliefPolicy,
  type RotationReview,
} from "./reassignment-safety-policy";
import { evaluateWorkloadBalance } from "./workload-balance";
import { crossWorkdayReservationStatuses } from "./cross-workday-qualification-reservation";
import { crossFlightPriorityReassignmentReasons } from "../rules/cross-flight-priority";
import { isDutyReliefPriorityPosition } from "./position-rotation-policy";
import {
  halfRestRegressionReasons,
  strictRecoveryHalfRestBackfillCount,
} from "../rules/half-rest";
import { worsensTr121H02Cooldown } from "../rules/tr121-h02-cooldown";
import {
  SAME_DAY_PRIORITY_CONFLICT_REASON,
  sameAirlinePriorityConflictPairs,
} from "../rules/airline-rotation";
import {
  reassignmentIntentReview,
  reassignmentIntentPolicy,
  type ReassignmentIntent,
  type ReassignmentIntentPolicy,
} from "../solver/reassignment-intent";

function dutyReliefProfile(
  state: ScheduleGenerationFacts,
  assignments: readonly Assignment[],
  dutyStaffId: string
): readonly [assignmentCount: number, priorityCount: number, fatigue: number] {
  const dutyAssignments = assignments.filter(
    (assignment) =>
      assignment.status === "assigned" &&
      assignment.staffId === dutyStaffId &&
      assignment.workHours > 0
  );
  return [
    dutyAssignments.length,
    dutyAssignments.filter((assignment) => {
      const rule = assignmentRule(state, assignment);
      return Boolean(
        rule && isDutyReliefPriorityPosition(assignment.flightNo, rule)
      );
    }).length,
    dutyAssignments.reduce(
      (total, assignment) => total + Math.max(0, assignment.fatiguePoints),
      0
    ),
  ];
}

function worsensDutyRelief(
  state: ScheduleGenerationFacts,
  assignments: readonly Assignment[],
  planned: readonly Assignment[],
  dutyStaffId: string
): boolean {
  const before = dutyReliefProfile(state, assignments, dutyStaffId);
  const after = dutyReliefProfile(state, planned, dutyStaffId);
  for (let index = 0; index < before.length; index += 1) {
    if (after[index]! === before[index]!) continue;
    return after[index]! > before[index]!;
  }
  return false;
}

export function isRotationLocked(
  state: ScheduleGenerationFacts,
  assignment: Assignment,
  lockedAssignmentIds: ReadonlySet<string>
): boolean {
  const rule = assignmentRule(state, assignment);
  return (
    lockedAssignmentIds.has(assignment.id) ||
    assignment.status !== "assigned" ||
    !assignment.staffId ||
    !assignment.positionRuleId ||
    assignment.supervisorSourceAssignmentId !== undefined ||
    !rule ||
    rule.category !== "常规" ||
    rule.manual
  );
}

function sameDayPriorityConflictKeys(
  state: ScheduleGenerationFacts,
  assignments: readonly Assignment[]
): Set<string> {
  return new Set(
    sameAirlinePriorityConflictPairs(assignments, state.positionRules).map(
      ([left, right]) =>
        `${left.staffId}:${[left.id, right.id]
          .sort((a, b) => a.localeCompare(b))
          .join("|")}`
    )
  );
}

export function rotationCandidateAssignments(
  assignments: Assignment[],
  primary: Assignment,
  state: ScheduleGenerationFacts,
  lockedAssignmentIds: ReadonlySet<string>
): Assignment[] {
  const available = assignments.filter(
    (assignment) =>
      assignment.id !== primary.id &&
      !isRotationLocked(state, assignment, lockedAssignmentIds)
  );
  const sameFlight = available.filter(
    (assignment) => assignment.flightId === primary.flightId
  );
  const overlappingFlights = available.filter(
    (assignment) =>
      assignment.flightId !== primary.flightId &&
      intervalsOverlap(
        assignment.startTime,
        assignment.endTime,
        primary.startTime,
        primary.endTime
      )
  );
  return [...sameFlight, ...overlappingFlights];
}

export function rotationCycleReason(reason: string): string {
  if (reason.includes("夜班")) return "候选人不具备夜班能力";
  if (reason.includes("不具备")) return "没有具备双向岗位资质的人员";
  if (reason.includes("已有排班")) return "交换后会产生时间冲突";
  if (reason.includes("超过每日")) return "交换后超过每日工时上限";
  if (reason.includes("衔接")) return "交换后违反严格岗位衔接保护";
  return reason;
}

function plannedAssignmentSafetyReasons(
  state: ScheduleGenerationFacts,
  assignments: Assignment[],
  planned: Assignment[],
  changedAssignmentIds: ReadonlySet<string>,
  primaryAssignmentId: string,
  date: string,
  review: RotationReview,
  intentPolicy: ReassignmentIntentPolicy,
  facts?: ScheduleRunFacts,
  permittedConcurrentAssignmentIds: ReadonlySet<string> = new Set(),
  frequencyFacts?: ScheduleFrequencyFacts,
  latePriorityFatigueRelief?: LatePriorityFatigueReliefPolicy
): string[] {
  const originalById = new Map(
    assignments.map((assignment) => [assignment.id, assignment])
  );
  const changedStaffIds = new Set(
    planned
      .filter((assignment) => changedAssignmentIds.has(assignment.id))
      .flatMap((assignment) => (assignment.staffId ? [assignment.staffId] : []))
  );
  planned = planned.map((assignment) => ({ ...assignment }));
  applyConfiguredEarlyReleases(planned, state, changedStaffIds);
  const plannedState: ScheduleGenerationFacts = {
    ...state,
    assignments: planned,
  };
  const policy = ROTATION_REVIEW_POLICIES[review];
  const primaryAssignment = originalById.get(primaryAssignmentId)!;
  const reasons: string[] = [];
  if (state.settings.sameDayCrossFlightPriorityEnabled !== false) {
    const before = sameDayPriorityConflictKeys(state, assignments);
    const after = sameDayPriorityConflictKeys(state, planned);
    if ([...after].some((key) => !before.has(key))) {
      reasons.push(SAME_DAY_PRIORITY_CONFLICT_REASON);
    }
  }
  if (!intentPolicy.allowCrossFlightPriorityRegression) {
    reasons.push(
      ...crossFlightPriorityReassignmentReasons(
        state,
        assignments,
        planned,
        date,
        frequencyFacts
      )
    );
  }
  if (facts) {
    const beforeStrictBackfills = strictRecoveryHalfRestBackfillCount({
      state,
      assignments,
      facts: facts.halfRest,
      protectedStaffIds:
        facts.crossDayRecovery.previousWorkday.protectedStaffIds,
    });
    const afterStrictBackfills = strictRecoveryHalfRestBackfillCount({
      state: plannedState,
      assignments: planned,
      facts: facts.halfRest,
      protectedStaffIds:
        facts.crossDayRecovery.previousWorkday.protectedStaffIds,
    });
    const assignedBefore = assignments.filter(
      (assignment) => assignment.status === "assigned" && assignment.staffId
    ).length;
    const assignedAfter = planned.filter(
      (assignment) => assignment.status === "assigned" && assignment.staffId
    ).length;
    if (
      afterStrictBackfills - beforeStrictBackfills >
      assignedAfter - assignedBefore
    ) {
      reasons.push("调整会在未补齐半休空缺时新增严格恢复突破");
    }
  }
  for (const assignment of planned.filter((item) =>
    changedAssignmentIds.has(item.id)
  )) {
    if (!assignment.staffId) {
      reasons.push("交换后会造成其他岗位空缺");
      continue;
    }
    const conflicts = planned.filter(
      (other) =>
        other.id !== assignment.id &&
        other.staffId === assignment.staffId &&
        intervalsOverlap(
          other.startTime,
          other.endTime,
          assignment.startTime,
          assignment.endTime
        ) &&
        !(
          permittedConcurrentAssignmentIds.has(assignment.id) &&
          permittedConcurrentAssignmentIds.has(other.id)
        ) &&
        !isLegalGuideReuse(state, assignment, other)
    );
    if (conflicts.length) reasons.push("交换后会产生时间冲突");
    const validationState = permittedConcurrentAssignmentIds.has(assignment.id)
      ? {
          ...plannedState,
          assignments: planned.filter(
            (item) =>
              item.id === assignment.id ||
              !permittedConcurrentAssignmentIds.has(item.id)
          ),
        }
      : plannedState;
    const assignedPerson = state.staff.find(
      (person) => person.id === assignment.staffId
    );
    const assignmentRuleForChange = assignmentRule(state, assignment);
    const flightForChange = state.flights.find(
      (flight) => flight.id === assignment.flightId
    );
    if (assignedPerson && assignmentRuleForChange && flightForChange) {
      reasons.push(
        ...diagnoseDailyPrimaryPositionEligibility({
          state,
          assignments: planned,
          flight: flightForChange,
          rule: assignmentRuleForChange,
          person: assignedPerson,
          workHours: assignment.workHours,
        }).violations.map((item) => item.message)
      );
    }
    const directGuideException = Boolean(
      intentPolicy.allowDirectGuideReassignment &&
      assignmentRuleForChange &&
      isGapFillGuidePosition(assignmentRuleForChange) &&
      assignedPerson?.teamLeader === true
    );
    const assignmentError = directGuideException
      ? null
      : canAssignStaff(validationState, assignment.id, assignment.staffId);
    if (assignmentError) reasons.push(rotationCycleReason(assignmentError));
    reasons.push(
      ...reassignmentCandidateSafetyReasons({
        state,
        assignment,
        originalAssignment: originalById.get(assignment.id)!,
        primaryAssignment,
        date,
        review,
        facts,
        frequencyFacts,
        latePriorityFatigueRelief,
        allowCutoffProtectionRegression:
          intentPolicy.allowCutoffProtectionRegression,
        allowCrossWorkdayRecoveryRegression:
          intentPolicy.allowCrossWorkdayRecoveryRegression,
        allowTr121CooldownRegression: intentPolicy.allowTr121CooldownRegression,
      })
    );
    const safetyAssignments = permittedConcurrentAssignmentIds.has(
      assignment.id
    )
      ? planned.filter(
          (item) =>
            item.id === assignment.id ||
            !permittedConcurrentAssignmentIds.has(item.id)
        )
      : planned;
    reasons.push(
      ...reassignmentDynamicSafetyReasons({
        state,
        assignments: safetyAssignments,
        assignment,
        primaryAssignment,
        review,
        allowLoadProtectionRegression:
          intentPolicy.allowLoadProtectionRegression,
        allowPositionTransitionRegression:
          intentPolicy.allowPositionTransitionRegression,
      })
    );
  }
  const originalAssigned = assignments.filter(
    (assignment) => assignment.status === "assigned" && assignment.staffId
  ).length;
  const plannedAssigned = planned.filter(
    (assignment) => assignment.status === "assigned" && assignment.staffId
  ).length;
  if (
    policy.assignedCount === "may-increase"
      ? plannedAssigned < originalAssigned
      : originalAssigned !== plannedAssigned
  ) {
    reasons.push("交换后会造成其他岗位空缺");
  }
  if (
    review !== "coverage" &&
    diversionTransferCount(planned, state) >
      diversionTransferCount(assignments, state)
  ) {
    reasons.push("调整会在岗位无需补缺时增加分流转派");
  }
  if (policy.preventStaffWithoutWork) {
    const changedIds = new Set(
      planned
        .filter(
          (assignment) =>
            originalById.get(assignment.id)?.staffId !== assignment.staffId
        )
        .map((assignment) => assignment.id)
    );
    const originalStaffIds = new Set(
      assignments
        .filter(
          (assignment) => changedIds.has(assignment.id) && assignment.staffId
        )
        .map((assignment) => assignment.staffId!)
    );
    const incomingStaffIds = new Set(
      planned
        .filter(
          (assignment) => changedIds.has(assignment.id) && assignment.staffId
        )
        .map((assignment) => assignment.staffId!)
    );
    for (const staffId of originalStaffIds) {
      if (incomingStaffIds.has(staffId)) continue;
      const hasOtherWork = planned.some(
        (assignment) =>
          !changedIds.has(assignment.id) &&
          assignment.staffId === staffId &&
          assignment.status === "assigned" &&
          assignment.workHours > 0
      );
      if (!hasOtherWork) reasons.push("重排会使原人员当日无实际岗位");
    }
  }
  if (
    policy.protectDutyMorning &&
    facts?.currentDutyStaffId &&
    !hasDutyMorningAssignment(plannedState, planned, facts.currentDutyStaffId)
  ) {
    reasons.push("交换后值班人员没有12点前开始的航班");
  }
  if (
    review !== "coverage" &&
    facts?.currentDutyStaffId &&
    worsensDutyRelief(state, assignments, planned, facts.currentDutyStaffId)
  ) {
    reasons.push("调整会增加值班人员的额外航班、重点岗位或疲劳");
  }
  reasons.push(
    ...halfRestRegressionReasons(
      assignments,
      planned,
      facts?.halfRest ?? {
        requestedStaffIds: [],
        activeStaffIds: new Set<string>(),
        minimumWorkStaffIds: new Set<string>(),
        ignoredWarnings: [],
        modesByStaffId: new Map(),
        earlyFinishStaffIds: new Set<string>(),
        lateStartStaffIds: new Set<string>(),
      }
    )
  );
  if (
    policy.protectWorkloadBalance &&
    state.settings.workloadBalanceEnabled &&
    !intentPolicy.allowWorkloadBalanceRegression
  ) {
    const before = evaluateWorkloadBalance(
      state,
      date,
      assignments,
      facts?.currentDutyStaffId
    );
    const after = evaluateWorkloadBalance(
      plannedState,
      date,
      planned,
      facts?.currentDutyStaffId
    );
    if (
      after.workHoursDifference > before.workHoursDifference ||
      after.rollingWorkHoursDifference > before.rollingWorkHoursDifference ||
      after.todayFatigueDifference > before.todayFatigueDifference
    ) {
      reasons.push("调整会扩大工时或疲劳差");
    }
  }
  if (policy.protectLatePriorityFrequency) {
    reasons.push(
      ...latePriorityFrequencyRegressionReasons(
        state,
        assignments,
        planned,
        date,
        frequencyFacts
      )
    );
  }
  if (
    !(review === "coverage" && plannedAssigned > originalAssigned) &&
    frequencyFacts &&
    worsensTr121H02Cooldown(state, assignments, planned, date, frequencyFacts)
  ) {
    reasons.push("调整会扩大 TR121/H02 冷却违反");
  }
  const reservationBefore = new Map(
    crossWorkdayReservationStatuses(state, assignments).map((status) => [
      status.target.reservation.id,
      status.shortfall,
    ])
  );
  if (
    !intentPolicy.allowCrossWorkdayReservationRegression &&
    crossWorkdayReservationStatuses(state, planned).some(
      (status) =>
        status.shortfall >
        (reservationBefore.get(status.target.reservation.id) ??
          status.shortfall)
    )
  ) {
    reasons.push("调整会减少跨工作日资质预留人数");
  }
  return [...new Set(reasons)];
}

export interface RotationStaffChange {
  assignmentId: string;
  staffId: string;
  startTime?: string;
  endTime?: string;
  workHours?: number;
  status?: Assignment["status"];
}

interface ReassignmentSafetyOptionsBase {
  state: ScheduleGenerationFacts;
  assignments: Assignment[];
  date: string;
  facts?: ScheduleRunFacts;
  frequencyFacts?: ScheduleFrequencyFacts;
  latePriorityFatigueRelief?: LatePriorityFatigueReliefPolicy;
  intent: ReassignmentIntent;
}

interface RotationCycleSafetyOptions extends ReassignmentSafetyOptionsBase {
  kind: "cycle";
  cycle: Assignment[];
}

interface ReassignmentPlanSafetyOptions extends ReassignmentSafetyOptionsBase {
  kind: "plan";
  changes: readonly RotationStaffChange[];
  primaryAssignmentId: string;
  permittedConcurrentAssignmentIds?: ReadonlySet<string>;
}

interface DirectReassignmentSafetyOptions extends ReassignmentSafetyOptionsBase {
  kind: "direct";
  assignmentId: string;
  staffId: string;
}

export type ReassignmentSafetyOptions =
  | RotationCycleSafetyOptions
  | ReassignmentPlanSafetyOptions
  | DirectReassignmentSafetyOptions;

export function reassignmentSafetyReasons(
  options: ReassignmentSafetyOptions
): string[] {
  const { state, assignments, date, facts } = options;
  const frequencyFacts = options.frequencyFacts ?? facts?.scheduleFrequency;
  const intentPolicy = reassignmentIntentPolicy(options.intent);
  const review = reassignmentIntentReview(options.intent);
  if (options.kind === "cycle") {
    const planned = assignments.map((assignment) => {
      const index = options.cycle.findIndex(
        (item) => item.id === assignment.id
      );
      if (index < 0) return assignment;
      const incoming = options.cycle[(index + 1) % options.cycle.length]!;
      const person = incoming.staffId
        ? state.staff.find((item) => item.id === incoming.staffId)
        : undefined;
      return {
        ...assignment,
        staffId: incoming.staffId,
        staffName: person?.name ?? incoming.staffName,
      };
    });
    return plannedAssignmentSafetyReasons(
      state,
      assignments,
      planned,
      new Set(options.cycle.map((assignment) => assignment.id)),
      options.cycle[0]!.id,
      date,
      review,
      intentPolicy,
      facts,
      undefined,
      frequencyFacts,
      options.latePriorityFatigueRelief
    );
  }

  if (options.kind === "plan") {
    const personById = new Map(
      state.staff.map((person) => [person.id, person])
    );
    const incomingByAssignmentId = new Map(
      options.changes.map((change) => [change.assignmentId, change.staffId])
    );
    const planned = assignments.map((assignment) => {
      const incomingStaffId = incomingByAssignmentId.get(assignment.id);
      if (!incomingStaffId) return assignment;
      const person = personById.get(incomingStaffId);
      const change = options.changes.find(
        (item) => item.assignmentId === assignment.id
      )!;
      return {
        ...assignment,
        staffId: incomingStaffId,
        staffName: person?.name ?? assignment.staffName,
        ...(change.startTime !== undefined
          ? { startTime: change.startTime }
          : {}),
        ...(change.endTime !== undefined ? { endTime: change.endTime } : {}),
        ...(change.workHours !== undefined
          ? { workHours: change.workHours }
          : {}),
        ...(change.status !== undefined ? { status: change.status } : {}),
      };
    });
    return plannedAssignmentSafetyReasons(
      state,
      assignments,
      planned,
      new Set(options.changes.map((change) => change.assignmentId)),
      options.primaryAssignmentId,
      date,
      review,
      intentPolicy,
      facts,
      options.permittedConcurrentAssignmentIds,
      frequencyFacts,
      options.latePriorityFatigueRelief
    );
  }

  const person = state.staff.find((item) => item.id === options.staffId);
  const planned = assignments.map((assignment) =>
    assignment.id === options.assignmentId
      ? {
          ...assignment,
          staffId: options.staffId,
          staffName: person?.name ?? assignment.staffName,
        }
      : assignment
  );
  return plannedAssignmentSafetyReasons(
    state,
    assignments,
    planned,
    new Set([options.assignmentId]),
    options.assignmentId,
    date,
    review,
    intentPolicy,
    facts,
    undefined,
    frequencyFacts,
    undefined
  );
}
