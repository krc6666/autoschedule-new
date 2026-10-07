import type { Assignment, PositionRule } from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import {
  minimumFlightTransitionMessage,
  minimumFlightTransitionViolationBetweenTasks,
} from "../assignments/minimum-flight-transition";
import {
  isNextWorkdayCutoffConflict,
  nextWorkdayCutoffProtection,
  type CrossDayRecoveryFacts,
} from "../reviews/cross-day-recovery";
import {
  isStrictNextWorkdayRecoveryTarget,
  previousWorkdayLateProtection,
} from "../reviews/cross-day-recovery";
import {
  crossWorkdayReservationStatuses,
  crossWorkdayReservationWarning,
} from "../reviews/cross-workday-qualification-reservation";
import {
  assessLatePriorityAggregateBalance,
  assessLatePriorityFrequencyBalance,
} from "../reviews/late-priority-frequency-balance";
import {
  LATE_PRIORITY_FREQUENCY_ORDER,
  latePriorityKindLabel,
} from "../reviews/late-priority-policy";
import {
  isHighFatigueOrdinaryRotationPosition,
  isOrdinaryPriorityPosition,
} from "../reviews/position-rotation-policy";
import { violatedPositionTransitionPoliciesForInsertion } from "../reviews/schedule-protection";
import { assessPositionFrequencyAlert } from "../reviews/position-frequency-alert";
import { evaluateWorkloadBalance } from "../reviews/workload-balance";
import {
  assessSameDayLateObligationSnapshot,
  assessLateShiftPositionReliefSnapshot,
} from "./daily-same-day-late-obligation-model";
import {
  assessKe166AssignmentSnapshot,
  assessKe166DistinctStaffCapacitySnapshot,
} from "../assignments/ke166-assignment";
import { assessDutyPositionSnapshot } from "../assignments/duty-assignment";
import { assessScarceQualificationSnapshot } from "../candidates/candidate-priority";
import { timeToMinutes } from "../shared/time";
import {
  sameAirlinePriorityAssignmentConflict,
  sameAirlinePriorityConflictMessage,
} from "../rules/airline-rotation";
import {
  halfRestMinimumWorkViolation,
  halfRestPeriodViolation,
  isStrictRecoveryHalfRestBackfill,
  type HalfRestFacts,
} from "../rules/half-rest";
import {
  consecutivePositionAssignments,
  type ScheduleFrequencyFacts,
} from "../statistics/schedule-frequency";
import {
  SAME_FLIGHT_STAFF_EXCLUSION_RULE_ID,
  sameFlightStaffExclusionMessage,
  sameFlightStaffExclusionViolations,
} from "../rules/same-flight-staff-exclusion";
import { evaluateMobileSupervisorCoverage } from "../coverage/mobile-supervisor-coverage";
import {
  evaluateSupervisorFillFacts,
  hasRecordedSupervisorFillLink,
} from "../coverage/supervisor-fill-facts";
import {
  assignmentRule,
  isGuideAssignment,
} from "../flights/schedule-position-rules";
import { isDailyPrimaryPosition } from "../rules/daily-primary-position";

/**
 * The phase controls which invariants are meaningful for a partial result.
 * Automatic post-stage proposals may leave vacancies, but they may not
 * introduce a hard-constraint violation. Final results additionally enforce
 * minimum-work invariants owned by the corresponding rule module.
 */
export type ScheduleGuardPhase = "partial" | "final";

export interface AirlineRotationFacts {
  readonly enabled?: boolean;
  readonly positionRules: readonly Pick<
    PositionRule,
    "id" | "flightNo" | "category" | "name" | "remark"
  >[];
}

export type MinimumFlightTransitionFacts = Pick<
  ScheduleGenerationFacts,
  "flights" | "positionRules" | "settings"
>;

export type LateShiftCutoffFacts = {
  state: Pick<ScheduleGenerationFacts, "history" | "settings">;
  date: string;
  crossDayRecovery?: CrossDayRecoveryFacts;
};

export type CrossWorkdayQualificationReservationFacts = {
  state: ScheduleGenerationFacts;
};

export type LatePriorityFrequencyFacts = {
  state: ScheduleGenerationFacts;
  date: string;
  scheduleFrequency?: ScheduleFrequencyFacts;
};

export type StrictNextWorkdayRecoveryFacts = {
  state: ScheduleGenerationFacts;
  date: string;
  crossDayRecovery?: CrossDayRecoveryFacts;
  halfRestFacts?: HalfRestFacts;
};

export type PositionRotationFacts = {
  state: ScheduleGenerationFacts;
  date: string;
  scheduleFrequency?: ScheduleFrequencyFacts;
};

export type PositionTransitionFacts = {
  state: Pick<ScheduleGenerationFacts, "settings">;
};

export type WorkloadBalanceFacts = {
  state: ScheduleGenerationFacts;
  date: string;
  dutyStaffId?: string | null;
};
export type SnapshotRuleFacts = {
  state: ScheduleGenerationFacts;
  date: string;
};

export interface ScheduleGuardContext {
  phase: ScheduleGuardPhase;
  /** Facts are supplied by the run boundary; rules remain the fact owners. */
  halfRestFacts?: HalfRestFacts;
  airlineRotationFacts?: AirlineRotationFacts;
  minimumFlightTransitionFacts?: MinimumFlightTransitionFacts;
  lateShiftCutoffFacts?: LateShiftCutoffFacts;
  crossWorkdayQualificationReservationFacts?: CrossWorkdayQualificationReservationFacts;
  latePriorityFrequencyFacts?: LatePriorityFrequencyFacts;
  latePriorityAggregateRotationFacts?: LatePriorityFrequencyFacts;
  strictNextWorkdayRecoveryFacts?: StrictNextWorkdayRecoveryFacts;
  highFatiguePositionFacts?: PositionRotationFacts;
  positionTransitionFacts?: PositionTransitionFacts;
  positionFrequencyFacts?: Pick<PositionRotationFacts, "state" | "date">;
  workloadBalanceFacts?: WorkloadBalanceFacts;
  sameDayLateObligationFacts?: SnapshotRuleFacts;
  lateShiftPositionReliefFacts?: SnapshotRuleFacts;
  mobileSupervisorCoverageFacts?: SnapshotRuleFacts;
  ke166SnapshotFacts?: SnapshotRuleFacts;
  scarceQualificationFacts?: SnapshotRuleFacts;
  dutyPositionFacts?: SnapshotRuleFacts;
  sameFlightStaffExclusionFacts?: {
    state: Pick<ScheduleGenerationFacts, "settings" | "staff">;
  };
  dailyPrimaryPositionFacts?: {
    state: Pick<
      ScheduleGenerationFacts,
      "settings" | "positionRules" | "flights"
    >;
  };
  warningSink?: string[];
}

export function createSameFlightStaffExclusionScheduleGuard(): ScheduleGuard {
  return Object.freeze({
    id: SAME_FLIGHT_STAFF_EXCLUSION_RULE_ID,
    validate: (
      assignments: readonly Assignment[],
      context: ScheduleGuardContext
    ): readonly ScheduleGuardViolation[] => {
      const facts = context.sameFlightStaffExclusionFacts;
      if (!facts) return [];
      return sameFlightStaffExclusionViolations(facts.state, assignments).map(
        (violation) => ({
          ruleId: SAME_FLIGHT_STAFF_EXCLUSION_RULE_ID,
          assignmentId: violation.secondAssignmentIds[0],
          message: `${sameFlightStaffExclusionMessage(
            facts.state,
            violation
          )}，自动排班拒绝提交`,
        })
      );
    },
  });
}

export function createDailyPrimaryPositionScheduleGuard(): ScheduleGuard {
  return Object.freeze({
    id: "daily-primary-position-unique",
    validate: (
      assignments: readonly Assignment[],
      context: ScheduleGuardContext
    ): readonly ScheduleGuardViolation[] => {
      const facts = context.dailyPrimaryPositionFacts;
      if (
        !facts ||
        facts.state.settings.dailyPrimaryPositionUniqueEnabled === false
      )
        return [];
      const seen = new Map<string, Assignment>();
      const violations: ScheduleGuardViolation[] = [];
      for (const assignment of assignments) {
        if (assignment.status !== "assigned" || !assignment.staffId) continue;
        const rule = assignmentRule(facts.state, assignment);
        const flight = facts.state.flights.find(
          (item) => item.id === assignment.flightId
        );
        if (
          !rule ||
          !flight ||
          !isDailyPrimaryPosition(facts.state, flight, rule)
        )
          continue;
        const prior = seen.get(assignment.staffId);
        if (prior) {
          violations.push({
            ruleId: "daily-primary-position-unique",
            assignmentId: assignment.id,
            message: `${assignment.staffName}在${prior.flightNo}/${prior.position}和${assignment.flightNo}/${assignment.position}重复承担非督导一号岗位，自动排班拒绝提交`,
          });
        } else {
          seen.set(assignment.staffId, assignment);
        }
      }
      return violations;
    },
  });
}

export interface ScheduleGuardViolation {
  readonly ruleId: string;
  readonly assignmentId?: string;
  readonly message: string;
  readonly severity?: "error" | "warning";
}

export interface ScheduleGuard {
  readonly id: string;
  validate(
    assignments: readonly Assignment[],
    context: ScheduleGuardContext
  ): readonly ScheduleGuardViolation[];
}

export class ScheduleGuardError extends Error {
  constructor(readonly violations: readonly ScheduleGuardViolation[]) {
    super(
      violations.length
        ? violations.map((violation) => violation.message).join("；")
        : "排班结果未通过统一安全守卫"
    );
    this.name = "ScheduleGuardError";
  }
}

/**
 * Composes independent rule-owned guards behind one proposal boundary.
 * Callers must pass the complete candidate snapshot they intend to commit;
 * this function never mutates that snapshot.
 */
export function assertScheduleAssignmentsSafe(options: {
  assignments: readonly Assignment[];
  context: ScheduleGuardContext;
  guards: readonly ScheduleGuard[];
}): void {
  const violations = options.guards.flatMap((guard) =>
    guard.validate(options.assignments, options.context)
  );
  const blockingViolations = violations.filter(
    (violation) => violation.severity !== "warning"
  );
  for (const warning of violations.filter(
    (violation) => violation.severity === "warning"
  )) {
    if (
      options.context.warningSink &&
      !options.context.warningSink.includes(warning.message)
    ) {
      options.context.warningSink.push(warning.message);
    }
  }
  if (blockingViolations.length)
    throw new ScheduleGuardError(blockingViolations);
}

/**
 * Adapter for the half-rest rule. The rule's facts and predicates stay in
 * half-rest.ts; every other pipeline stage only consumes this guard contract.
 */
export function createHalfRestScheduleGuard(): ScheduleGuard {
  return Object.freeze({
    id: "half-rest",
    validate: (
      assignments: readonly Assignment[],
      context: ScheduleGuardContext
    ): readonly ScheduleGuardViolation[] => {
      const facts = context.halfRestFacts;
      if (!facts) return [];

      const violations: ScheduleGuardViolation[] = [];
      for (const assignment of assignments) {
        // Manual adjustments are intentionally outside the first automatic
        // guard boundary. They retain the existing manual-override flow.
        if (assignment.status !== "assigned" || !assignment.staffId) continue;
        const message = halfRestPeriodViolation({
          facts,
          staffId: assignment.staffId,
          startTime: assignment.startTime,
        });
        if (message) {
          violations.push({
            ruleId: "half-rest",
            assignmentId: assignment.id,
            message,
          });
        }
      }

      if (context.phase === "final") {
        violations.push(
          ...halfRestMinimumWorkViolation({ assignments, facts }).map(
            (message) => ({ ruleId: "half-rest", message })
          )
        );
      }
      return violations;
    },
  });
}

/**
 * Adapter for the same-airline priority rule. The conflict predicate remains
 * owned by airline-rotation.ts; this guard only supplies the snapshot context
 * and applies the predicate to assigned workers across different flights.
 */
export function createSameAirlinePriorityScheduleGuard(): ScheduleGuard {
  return Object.freeze({
    id: "same-day-cross-flight-priority",
    validate: (
      assignments: readonly Assignment[],
      context: ScheduleGuardContext
    ): readonly ScheduleGuardViolation[] => {
      const facts = context.airlineRotationFacts;
      if (!facts || facts.enabled === false) return [];

      const rulesById = new Map(
        facts.positionRules.map((rule) => [rule.id, rule])
      );
      const assignedByStaff = new Map<string, Assignment[]>();
      for (const assignment of assignments) {
        if (assignment.status !== "assigned" || !assignment.staffId) continue;
        const staffAssignments = assignedByStaff.get(assignment.staffId) ?? [];
        staffAssignments.push(assignment);
        assignedByStaff.set(assignment.staffId, staffAssignments);
      }

      const violations: ScheduleGuardViolation[] = [];
      for (const staffAssignments of assignedByStaff.values()) {
        for (
          let leftIndex = 0;
          leftIndex < staffAssignments.length;
          leftIndex += 1
        ) {
          const left = staffAssignments[leftIndex]!;
          const leftRule = left.positionRuleId
            ? rulesById.get(left.positionRuleId)
            : undefined;
          if (!leftRule) continue;

          for (
            let rightIndex = leftIndex + 1;
            rightIndex < staffAssignments.length;
            rightIndex += 1
          ) {
            const right = staffAssignments[rightIndex]!;
            if (left.flightId === right.flightId) continue;
            const rightRule = right.positionRuleId
              ? rulesById.get(right.positionRuleId)
              : undefined;
            if (
              !rightRule ||
              !sameAirlinePriorityAssignmentConflict(
                { ...left, positionRule: leftRule },
                { ...right, positionRule: rightRule }
              )
            ) {
              continue;
            }

            violations.push({
              ruleId: "same-day-cross-flight-priority",
              assignmentId: right.id,
              severity: "warning",
              message: sameAirlinePriorityConflictMessage(left, right),
            });
          }
        }
      }
      return violations;
    },
  });
}

/**
 * Adapter for the global minimum-flight-transition rule. The transition
 * interval, night boundary, and diversion exception remain owned by
 * minimum-flight-transition.ts.
 */
export function createMinimumFlightTransitionScheduleGuard(): ScheduleGuard {
  return Object.freeze({
    id: "minimum-flight-transition",
    validate: (
      assignments: readonly Assignment[],
      context: ScheduleGuardContext
    ): readonly ScheduleGuardViolation[] => {
      const facts = context.minimumFlightTransitionFacts;
      if (!facts) return [];

      const transitionFacts = { ...facts, assignments: [] };
      const flightsById = new Map(
        facts.flights.map((flight) => [flight.id, flight])
      );
      const rulesById = new Map(
        facts.positionRules.map((rule) => [rule.id, rule])
      );
      const assignedByStaff = new Map<string, Assignment[]>();
      for (const assignment of assignments) {
        if (assignment.status !== "assigned" || !assignment.staffId) continue;
        const staffAssignments = assignedByStaff.get(assignment.staffId) ?? [];
        staffAssignments.push(assignment);
        assignedByStaff.set(assignment.staffId, staffAssignments);
      }

      const violations: ScheduleGuardViolation[] = [];
      for (const staffAssignments of assignedByStaff.values()) {
        for (
          let leftIndex = 0;
          leftIndex < staffAssignments.length;
          leftIndex += 1
        ) {
          const left = staffAssignments[leftIndex]!;
          const leftFlight = flightsById.get(left.flightId);
          const leftRule = left.positionRuleId
            ? rulesById.get(left.positionRuleId)
            : undefined;
          if (!leftFlight || !leftRule) continue;

          for (
            let rightIndex = leftIndex + 1;
            rightIndex < staffAssignments.length;
            rightIndex += 1
          ) {
            const right = staffAssignments[rightIndex]!;
            if (left.flightId === right.flightId) continue;
            const rightFlight = flightsById.get(right.flightId);
            const rightRule = right.positionRuleId
              ? rulesById.get(right.positionRuleId)
              : undefined;
            if (!rightFlight || !rightRule) continue;

            const violation = minimumFlightTransitionViolationBetweenTasks(
              transitionFacts,
              leftFlight,
              leftRule,
              rightFlight,
              rightRule
            );
            if (!violation) continue;

            violations.push({
              ruleId: "minimum-flight-transition",
              assignmentId: right.id,
              message: minimumFlightTransitionMessage(
                left.staffName || left.staffId!,
                violation
              ),
            });
          }
        }
      }
      return violations;
    },
  });
}

/**
 * Adapter for the next-workday cutoff protection. This is a best-effort
 * objective: violations are recorded as warnings and never block a commit.
 */
export function createLateShiftCutoffScheduleGuard(): ScheduleGuard {
  return Object.freeze({
    id: "late-shift-cutoff",
    validate: (
      assignments: readonly Assignment[],
      context: ScheduleGuardContext
    ): readonly ScheduleGuardViolation[] => {
      const facts = context.lateShiftCutoffFacts;
      if (!facts) return [];

      return assignments.flatMap((assignment) => {
        if (assignment.status !== "assigned" || !assignment.staffId) return [];
        if (
          !isNextWorkdayCutoffConflict(
            facts.state,
            assignment.staffId,
            assignment.startTime,
            facts.date,
            facts.crossDayRecovery
          )
        ) {
          return [];
        }
        const protection = nextWorkdayCutoffProtection(
          facts.state,
          assignment.staffId,
          facts.date,
          facts.crossDayRecovery
        );
        return [
          {
            ruleId: "late-shift-cutoff",
            assignmentId: assignment.id,
            severity: "warning" as const,
            message: `${assignment.staffName || assignment.staffId}被安排在次班截止时间${protection?.cutoffTime ?? ""}之后的${assignment.flightNo}/${assignment.position}`,
          },
        ];
      });
    },
  });
}

/**
 * Adapter for cross-workday qualification reservation. Reservation shortfalls
 * are best-effort warnings: today's complete proposal remains committable.
 */
export function createCrossWorkdayQualificationReservationScheduleGuard(): ScheduleGuard {
  return Object.freeze({
    id: "cross-workday-qualification-reservation",
    validate: (
      assignments: readonly Assignment[],
      context: ScheduleGuardContext
    ): readonly ScheduleGuardViolation[] => {
      const facts = context.crossWorkdayQualificationReservationFacts;
      if (!facts) return [];

      return crossWorkdayReservationStatuses(facts.state, assignments)
        .filter((status) => status.shortfall > 0)
        .map((status) => ({
          ruleId: "cross-workday-qualification-reservation",
          severity: "warning" as const,
          message: crossWorkdayReservationWarning(status),
        }));
    },
  });
}

/**
 * Adapter for late-priority category frequency fairness. This is a
 * best-effort objective: the rule owner evaluates the complete snapshot and
 * the guard records warnings without rejecting the proposal.
 */
export function createLatePriorityFrequencyScheduleGuard(): ScheduleGuard {
  return Object.freeze({
    id: "late-priority-frequency",
    validate: (
      assignments: readonly Assignment[],
      context: ScheduleGuardContext
    ): readonly ScheduleGuardViolation[] => {
      const facts = context.latePriorityFrequencyFacts;
      if (!facts) return [];

      const violations: ScheduleGuardViolation[] = [];
      for (const assignment of assignments) {
        if (assignment.status !== "assigned" || !assignment.staffId) continue;
        for (const kind of LATE_PRIORITY_FREQUENCY_ORDER) {
          const assessment = assessLatePriorityFrequencyBalance(
            facts.state,
            assignment,
            assignments,
            facts.date,
            facts.scheduleFrequency,
            kind
          );
          if (!assessment?.needsAttention) continue;
          violations.push({
            ruleId: "late-priority-frequency",
            assignmentId: assignment.id,
            severity: "warning",
            message: `${assignment.staffName || assignment.staffId}的末班重点岗位分类公平需要复核：${latePriorityKindLabel(kind)}次数差已超过允许范围`,
          });
        }
      }
      return violations;
    },
  });
}

/** Adapter for aggregate late-priority rotation. This is best-effort. */
export function createLatePriorityAggregateRotationScheduleGuard(): ScheduleGuard {
  return Object.freeze({
    id: "late-priority-aggregate-rotation",
    validate: (
      assignments: readonly Assignment[],
      context: ScheduleGuardContext
    ): readonly ScheduleGuardViolation[] => {
      const facts = context.latePriorityAggregateRotationFacts;
      if (!facts) return [];
      return assignments.flatMap((assignment) => {
        if (assignment.status !== "assigned" || !assignment.staffId) return [];
        const assessment = assessLatePriorityAggregateBalance(
          facts.state,
          assignment,
          assignments,
          facts.date,
          facts.scheduleFrequency
        );
        return assessment?.needsAttention
          ? [
              {
                ruleId: "late-priority-aggregate-rotation",
                assignmentId: assignment.id,
                severity: "warning" as const,
                message: `${assignment.staffName || assignment.staffId}的末班重点岗位合计轮换需要复核：当前人员不是合计次数优先人选`,
              },
            ]
          : [];
      });
    },
  });
}

/** Adapter for the strict next-workday recovery hard constraint. */
export function createStrictNextWorkdayRecoveryScheduleGuard(): ScheduleGuard {
  return Object.freeze({
    id: "strict-next-workday-recovery",
    validate: (
      assignments: readonly Assignment[],
      context: ScheduleGuardContext
    ): readonly ScheduleGuardViolation[] => {
      const facts = context.strictNextWorkdayRecoveryFacts;
      if (!facts) return [];
      const protectedStaffIds = (
        facts.crossDayRecovery?.previousWorkday ??
        previousWorkdayLateProtection(facts.state, facts.date)
      ).protectedStaffIds;
      if (!protectedStaffIds.size) return [];

      const violations: ScheduleGuardViolation[] = [];
      for (const assignment of assignments) {
        if (
          assignment.status !== "assigned" ||
          !assignment.staffId ||
          !protectedStaffIds.has(assignment.staffId) ||
          !isStrictNextWorkdayRecoveryTarget(facts.state, assignment)
        )
          continue;
        const flight = facts.state.flights.find(
          (item) => item.id === assignment.flightId
        );
        const rule = facts.state.positionRules.find(
          (item) => item.id === assignment.positionRuleId
        );
        if (
          facts.halfRestFacts &&
          flight &&
          rule &&
          isStrictRecoveryHalfRestBackfill({
            state: facts.state,
            facts: facts.halfRestFacts,
            protectedStaffIds,
            staffId: assignment.staffId,
            flight,
            rule,
          })
        )
          continue;
        violations.push({
          ruleId: "strict-next-workday-recovery",
          assignmentId: assignment.id,
          message: `${assignment.staffName || assignment.staffId}上一工作班晚班后不得安排${assignment.flightNo}/${assignment.position}，违反严格跨工作日恢复目标`,
        });
      }
      return violations;
    },
  });
}

/** Adapter for high-fatigue ordinary-position consecutive protection. */
export function createHighFatiguePositionConsecutiveScheduleGuard(): ScheduleGuard {
  return Object.freeze({
    id: "high-fatigue-position-consecutive",
    validate: (
      assignments: readonly Assignment[],
      context: ScheduleGuardContext
    ): readonly ScheduleGuardViolation[] => {
      const facts = context.highFatiguePositionFacts;
      if (!facts || !facts.state.settings.positionRotationEnabled) return [];
      return assignments.flatMap((assignment) => {
        if (assignment.status !== "assigned" || !assignment.staffId) return [];
        const rule = facts.state.positionRules.find(
          (item) => item.id === assignment.positionRuleId
        );
        if (
          !rule ||
          !isHighFatigueOrdinaryRotationPosition(
            rule,
            facts.state.settings.highLoadFatigueThreshold,
            facts.state.settings.ordinaryPriorityPositions
          ) ||
          isOrdinaryPriorityPosition(
            rule,
            facts.state.settings.ordinaryPriorityPositions
          )
        )
          return [];
        const runs = consecutivePositionAssignments(
          facts.state,
          assignment.staffId,
          assignment.flightNo,
          assignment.position,
          assignment.remark,
          facts.date,
          facts.scheduleFrequency
        );
        return runs > 0
          ? [
              {
                ruleId: "high-fatigue-position-consecutive",
                assignmentId: assignment.id,
                severity: "warning" as const,
                message: `${assignment.staffName || assignment.staffId}已连续${runs}个工作班承担高疲劳普通岗位${assignment.flightNo}/${assignment.position}，本班继续承担需要复核`,
              },
            ]
          : [];
      });
    },
  });
}

/** Adapter for configured strict position-transition policies. */
export function createStrictPositionTransitionScheduleGuard(): ScheduleGuard {
  return Object.freeze({
    id: "position-transition",
    validate: (
      assignments: readonly Assignment[],
      context: ScheduleGuardContext
    ): readonly ScheduleGuardViolation[] => {
      const facts = context.positionTransitionFacts;
      // Before-noon strict transitions may be intentionally breached for
      // vacancy preservation; the final safety gate has the complete task
      // context needed to distinguish that documented exception.
      if (!facts || context.phase !== "final") return [];
      const assigned = assignments.filter(
        (assignment) => assignment.status === "assigned" && assignment.staffId
      );
      return assigned.flatMap((assignment) => {
        if (timeToMinutes(assignment.startTime) < 12 * 60) return [];
        if (
          assignment.decisionTrace?.some(
            (decision) =>
              decision.ruleId === "duty-position" &&
              decision.outcome === "selected"
          )
        )
          return [];
        const earlierAssignments = assigned.filter(
          (other) =>
            other.id !== assignment.id && other.staffId === assignment.staffId
        );
        const violations = violatedPositionTransitionPoliciesForInsertion(
          earlierAssignments,
          assignment.staffId!,
          assignment.flightNo,
          assignment.position,
          assignment.startTime,
          assignment.endTime,
          facts.state,
          "forbid"
        ).filter(
          (policy) =>
            policy.targetFlightNo.trim().toUpperCase() ===
              assignment.flightNo.trim().toUpperCase() &&
            policy.targetPosition.trim().toUpperCase() ===
              assignment.position.trim().toUpperCase()
        );
        return violations.map((policy) => ({
          ruleId: "position-transition",
          assignmentId: assignment.id,
          message: `${assignment.staffName || assignment.staffId}安排${assignment.flightNo}/${assignment.position}违反严格岗位衔接规则${policy.id}`,
        }));
      });
    },
  });
}

/** Adapter for general priority-position frequency fairness. */
export function createPositionFrequencyScheduleGuard(): ScheduleGuard {
  return Object.freeze({
    id: "position-frequency",
    validate: (
      assignments: readonly Assignment[],
      context: ScheduleGuardContext
    ): readonly ScheduleGuardViolation[] => {
      const facts = context.positionFrequencyFacts;
      if (!facts || !facts.state.settings.positionRotationEnabled) return [];
      return assignments.flatMap((assignment) => {
        if (assignment.status !== "assigned" || !assignment.staffId) return [];
        const assessment = assessPositionFrequencyAlert(
          facts.state,
          assignment,
          facts.date
        );
        return assessment?.needsAttention
          ? [
              {
                ruleId: "position-frequency",
                assignmentId: assignment.id,
                severity: "warning" as const,
                message: `${assignment.staffName || assignment.staffId}的重点岗位频率需要复核：${assignment.flightNo}/${assignment.position}当前频率差距超过允许范围`,
              },
            ]
          : [];
      });
    },
  });
}

/** Adapter for the workload-balance objective. This is best-effort. */
export function createWorkloadBalanceScheduleGuard(): ScheduleGuard {
  return Object.freeze({
    id: "workload-balance",
    validate: (
      assignments: readonly Assignment[],
      context: ScheduleGuardContext
    ): readonly ScheduleGuardViolation[] => {
      const facts = context.workloadBalanceFacts;
      if (!facts || context.phase !== "final") return [];
      const metrics = evaluateWorkloadBalance(
        facts.state,
        facts.date,
        assignments as Assignment[],
        facts.dutyStaffId
      );
      if (!metrics.enabled || metrics.withinConfiguredTargets) return [];
      return [
        {
          ruleId: "workload-balance",
          severity: "warning",
          message: `最终班表负荷平衡需要复核：${metrics.summary}`,
        },
      ];
    },
  });
}

export function createSameDayLateObligationScheduleGuard(): ScheduleGuard {
  return Object.freeze({
    id: "same-day-late-obligation",
    validate: (
      assignments: readonly Assignment[],
      context: ScheduleGuardContext
    ) => {
      const facts = context.sameDayLateObligationFacts;
      if (!facts || context.phase !== "final") return [];
      return assessSameDayLateObligationSnapshot(facts.state, assignments).map(
        (staffId) => ({
          ruleId: "same-day-late-obligation",
          severity: "warning" as const,
          message: `${staffId}同日同时承担早班和晚班，早晚负荷分散需要复核`,
        })
      );
    },
  });
}

export function createLateShiftPositionReliefScheduleGuard(): ScheduleGuard {
  return Object.freeze({
    id: "late-shift-position-relief",
    validate: (
      assignments: readonly Assignment[],
      context: ScheduleGuardContext
    ) => {
      if (!context.lateShiftPositionReliefFacts || context.phase !== "final")
        return [];
      return assessLateShiftPositionReliefSnapshot(assignments).map(
        (assignmentId) => ({
          ruleId: "late-shift-position-relief",
          severity: "warning" as const,
          assignmentId,
          message: `末班重点岗位轻岗恢复未完成，保留原安排并记录复核`,
        })
      );
    },
  });
}

export function createMobileSupervisorCoverageScheduleGuard(): ScheduleGuard {
  return Object.freeze({
    id: "mobile-supervisor",
    validate: (
      assignments: readonly Assignment[],
      context: ScheduleGuardContext
    ): readonly ScheduleGuardViolation[] => {
      const facts = context.mobileSupervisorCoverageFacts;
      if (!facts) return [];
      const configuredFill = (supervisor: Assignment, target: Assignment) =>
        (["automatic", "manual"] as const)
          .map((mode) =>
            evaluateSupervisorFillFacts(
              facts.state,
              assignments,
              supervisor,
              target,
              mode,
              { ignoreSafeRegularCandidate: true }
            )
          )
          .find((evaluation) =>
            hasRecordedSupervisorFillLink(evaluation, target)
          );
      const linkedViolations = assignments.flatMap((counter) => {
        if (
          counter.supervisorFillRuleId &&
          !counter.supervisorSourceAssignmentId
        ) {
          return [
            {
              ruleId: "mobile-supervisor",
              assignmentId: counter.id,
              message: `${counter.flightNo}/${counter.position}的督导补位关联缺少来源，拒绝提交`,
            },
          ];
        }
        if (!counter.supervisorSourceAssignmentId) return [];
        const supervisor = assignments.find(
          (assignment) => assignment.id === counter.supervisorSourceAssignmentId
        );
        const supervisorRule = supervisor
          ? assignmentRule(facts.state, supervisor)
          : undefined;
        const counterRule = assignmentRule(facts.state, counter);
        const fill = supervisor
          ? configuredFill(supervisor, counter)
          : undefined;
        if (
          !supervisor ||
          supervisorRule?.category !== "机动督导" ||
          (counterRule?.coverageRole === "supervisor-fill" && !fill) ||
          (supervisor.flightId !== counter.flightId && !fill)
        ) {
          return [
            {
              ruleId: "mobile-supervisor",
              assignmentId: counter.id,
              message:
                counterRule?.coverageRole === "supervisor-fill" ||
                Boolean(counter.supervisorFillRuleId)
                  ? `${counter.flightNo}/${counter.position}的督导补位关联无效，拒绝提交`
                  : `${counter.flightNo}/${counter.position}的机动督导兼任关联无效，拒绝提交`,
            },
          ];
        }
        if (
          supervisor.status !== "assigned" ||
          counter.status !== "assigned" ||
          !supervisor.staffId ||
          supervisor.staffId !== counter.staffId
        ) {
          return [
            {
              ruleId: "mobile-supervisor",
              assignmentId: counter.id,
              message: `${counter.flightNo}机动督导与兼任柜台必须保持同一人员，拒绝提交`,
            },
          ];
        }
        const coverage = fill
          ? { allowed: true, reason: null }
          : evaluateMobileSupervisorCoverage(facts.state, {
              flightNo: counter.flightNo,
              position: counter.position,
              remark: counter.remark,
            });
        if (!coverage.allowed || (counter.supervisorFillRuleId && !fill)) {
          return [
            {
              ruleId: "mobile-supervisor",
              assignmentId: counter.id,
              message: `${counter.flightNo}/${counter.position}不允许机动督导兼任：${coverage.reason}`,
            },
          ];
        }
        return counter.workHours === 0 && (!fill || counter.fatiguePoints === 0)
          ? []
          : [
              {
                ruleId: "mobile-supervisor",
                assignmentId: counter.id,
                message: `${counter.flightNo}/${counter.position}机动督导补位工时与疲劳必须去重，拒绝提交`,
              },
            ];
      });
      const missingLinkViolations = assignments.flatMap((supervisor) => {
        const rule = assignmentRule(facts.state, supervisor);
        if (
          rule?.category !== "机动督导" ||
          supervisor.status !== "assigned" ||
          !supervisor.staffId
        )
          return [];
        const unlinked = assignments.find(
          (assignment) =>
            assignment.id !== supervisor.id &&
            assignment.status === "assigned" &&
            assignment.staffId === supervisor.staffId &&
            !isGuideAssignment(facts.state, assignment) &&
            assignment.supervisorSourceAssignmentId !== supervisor.id &&
            (assignment.flightId === supervisor.flightId ||
              Boolean(
                (["automatic", "manual"] as const).some(
                  (mode) =>
                    evaluateSupervisorFillFacts(
                      facts.state,
                      assignments,
                      supervisor,
                      assignment,
                      mode
                    ).allowed
                )
              ))
        );
        return unlinked
          ? [
              {
                ruleId: "mobile-supervisor",
                assignmentId: unlinked.id,
                message: `${supervisor.flightNo}机动督导与${unlinked.position}的兼任关联被拆开，拒绝提交`,
              },
            ]
          : [];
      });
      return [...linkedViolations, ...missingLinkViolations];
    },
  });
}

export function createKe166SnapshotScheduleGuard(): ScheduleGuard {
  return Object.freeze({
    id: "ke166-supervisor",
    validate: (
      assignments: readonly Assignment[],
      context: ScheduleGuardContext
    ) => {
      const facts = context.ke166SnapshotFacts;
      if (!facts || context.phase !== "final") return [];
      return [
        ...assessKe166DistinctStaffCapacitySnapshot(
          facts.state,
          assignments
        ).map((assignmentId) => ({
          ruleId: "ke166-supervisor",
          assignmentId,
          message: `KE166机动督导兼任时仍有第二名常规真人可用，拒绝把该人员让给较低优先航班`,
        })),
        ...assessKe166AssignmentSnapshot(facts.state, assignments).map(
          (assignmentId) => ({
            ruleId: "ke166-supervisor",
            severity: "warning" as const,
            assignmentId,
            message: `KE166机动督导未安排，岗位已留空，请人工复核`,
          })
        ),
      ];
    },
  });
}

export function createScarceQualificationScheduleGuard(): ScheduleGuard {
  return Object.freeze({
    id: "scarce-qualification",
    validate: (
      assignments: readonly Assignment[],
      context: ScheduleGuardContext
    ) => {
      const facts = context.scarceQualificationFacts;
      if (!facts || context.phase !== "final") return [];
      return assessScarceQualificationSnapshot(facts.state, assignments).map(
        (assignmentId) => ({
          ruleId: "scarce-qualification",
          severity: "warning" as const,
          assignmentId,
          message: `安排人员不具备岗位资质，需要复核`,
        })
      );
    },
  });
}

export function createDutyPositionScheduleGuard(): ScheduleGuard {
  return Object.freeze({
    id: "duty-position",
    validate: (
      assignments: readonly Assignment[],
      context: ScheduleGuardContext
    ) => {
      if (!context.dutyPositionFacts || context.phase !== "final") return [];
      return assessDutyPositionSnapshot(assignments).map((assignmentId) => ({
        ruleId: "duty-position",
        assignmentId,
        message: `值班锁定岗位在最终班表中丢失，拒绝提交`,
      }));
    },
  });
}

export function createDefaultScheduleGuards(): readonly ScheduleGuard[] {
  return Object.freeze([
    createSameFlightStaffExclusionScheduleGuard(),
    createDailyPrimaryPositionScheduleGuard(),
    createHalfRestScheduleGuard(),
    createSameAirlinePriorityScheduleGuard(),
    createMinimumFlightTransitionScheduleGuard(),
    createLateShiftCutoffScheduleGuard(),
    createCrossWorkdayQualificationReservationScheduleGuard(),
    createLatePriorityFrequencyScheduleGuard(),
    createLatePriorityAggregateRotationScheduleGuard(),
    createStrictNextWorkdayRecoveryScheduleGuard(),
    createHighFatiguePositionConsecutiveScheduleGuard(),
    createStrictPositionTransitionScheduleGuard(),
    createPositionFrequencyScheduleGuard(),
    createWorkloadBalanceScheduleGuard(),
    createSameDayLateObligationScheduleGuard(),
    createLateShiftPositionReliefScheduleGuard(),
    createMobileSupervisorCoverageScheduleGuard(),
    createKe166SnapshotScheduleGuard(),
    createScarceQualificationScheduleGuard(),
    createDutyPositionScheduleGuard(),
  ]);
}
