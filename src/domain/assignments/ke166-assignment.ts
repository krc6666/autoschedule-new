import type { Assignment, Flight, PositionRule } from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import { createId } from "../../utils";
import {
  canAssignStaff,
  eligibleStaffForRule,
} from "../candidates/assignment-eligibility";
import { canMobileSupervisorCoverPosition } from "../coverage/mobile-supervisor-coverage";
import { assignmentRule } from "../flights/schedule-position-rules";
import { totalFatiguePriority } from "../reviews/schedule-protection";
import {
  isKe166MobileSupervisor,
  isMobileSupervisor,
  isNumberedRegularPosition,
} from "../flights/schedule-tasks";
import { durationHours, intervalsOverlap } from "../shared/time";
import { consecutivePositionAssignments } from "../statistics/schedule-frequency";
import { schedulingDecision } from "../rules/schedule-rule-contract";
import type { ScheduleRunFacts } from "../shared/schedule-run-facts";
import { clearAutomaticAssignmentEvidence } from "./assignment-evidence";
import { lateShiftRecoveryRisk } from "../reviews/schedule-protection";
import {
  rotationCandidateAssignments,
  type RotationStaffChange,
} from "../reviews/rotation-review-safety";
import { optimizeReassignment } from "../solver/reassignment-optimizer";
import type { ReassignmentOptimizationResult } from "../solver/reassignment-contract";
import type { SolverPort } from "../solver/solver-port";
import { assignmentWarningMessage } from "../reviews/schedule-warning-message";
import { halfRestPeriodViolation } from "../rules/half-rest";
import { crossFlightPriorityPolicyRank } from "../rules/cross-flight-priority";
import { setSupervisorFillLink } from "../coverage/supervisor-fill-facts";

interface CounterPlacementPlan {
  target: Assignment;
  changes: Array<{
    assignment: Assignment;
    staffId: string;
    staffName: string;
  }>;
  description: string;
}

export function compareKe166SupervisorRotation(
  state: ScheduleGenerationFacts,
  flight: Flight,
  rule: PositionRule,
  date: string,
  leftStaffId: string,
  rightStaffId: string
): number {
  return (
    Number(
      consecutivePositionAssignments(
        state,
        leftStaffId,
        flight.flightNo,
        rule.name,
        rule.remark,
        date
      ) > 0
    ) -
    Number(
      consecutivePositionAssignments(
        state,
        rightStaffId,
        flight.flightNo,
        rule.name,
        rule.remark,
        date
      ) > 0
    )
  );
}

/** Snapshot-level KE166 completeness check used by the final safety guard. */
export function assessKe166AssignmentSnapshot(
  state: ScheduleGenerationFacts,
  assignments: readonly Assignment[]
): string[] {
  return assignments.flatMap((assignment) => {
    if (assignment.status !== "unfilled") return [];
    const flight = state.flights.find(
      (item) => item.id === assignment.flightId
    );
    const rule = state.positionRules.find(
      (item) => item.id === assignment.positionRuleId
    );
    return flight && rule && isKe166MobileSupervisor(flight, rule)
      ? [assignment.id]
      : [];
  });
}

export interface Ke166DistinctStaffCapacityViolation {
  counter: Assignment;
  supervisor: Assignment;
  candidate: { id: string; name: string };
  blockingAssignment: Assignment | null;
}

export function assessKe166DistinctStaffCapacityFacts(
  state: ScheduleGenerationFacts,
  assignments: readonly Assignment[]
): Ke166DistinctStaffCapacityViolation[] {
  const plannedState: ScheduleGenerationFacts = {
    ...state,
    assignments: assignments.map((assignment) => ({ ...assignment })),
  };
  const violations: Ke166DistinctStaffCapacityViolation[] = [];
  for (const supervisor of assignments) {
    if (
      supervisor.status !== "assigned" ||
      !supervisor.staffId ||
      !supervisor.positionRuleId
    )
      continue;
    const supervisorFlight = state.flights.find(
      (flight) => flight.id === supervisor.flightId
    );
    const supervisorRule = state.positionRules.find(
      (rule) => rule.id === supervisor.positionRuleId
    );
    if (
      !supervisorFlight ||
      !supervisorRule ||
      !isKe166MobileSupervisor(supervisorFlight, supervisorRule)
    )
      continue;
    const counter = assignments.find(
      (assignment) =>
        assignment.supervisorSourceAssignmentId === supervisor.id &&
        assignment.staffId === supervisor.staffId &&
        assignment.status === "assigned"
    );
    if (!counter?.positionRuleId) continue;
    const counterRule = state.positionRules.find(
      (rule) => rule.id === counter.positionRuleId
    );
    if (!counterRule) continue;
    let blockingAssignment: Assignment | null = null;
    const candidate = eligibleStaffForRule(
      plannedState,
      supervisorFlight,
      counterRule
    )
      .filter(
        (person) =>
          person.staffType === "常规" && person.id !== supervisor.staffId
      )
      .find((person) => {
        const ke166Rank = crossFlightPriorityPolicyRank(state, {
          flightNo: supervisorFlight.flightNo,
          staffId: person.id,
        });
        if (ke166Rank === null) return false;
        const blockingAssignments = assignments.filter(
          (assignment) =>
            assignment.id !== counter.id &&
            assignment.staffId === person.id &&
            assignment.status === "assigned" &&
            intervalsOverlap(
              assignment.startTime,
              assignment.endTime,
              counter.startTime,
              counter.endTime
            )
        );
        if (!blockingAssignments.length)
          return canAssignStaff(plannedState, counter.id, person.id) === null;
        if (blockingAssignments.length !== 1) return false;
        const blocking = blockingAssignments[0]!;
        const blockingRank = crossFlightPriorityPolicyRank(state, blocking);
        const available =
          blockingRank !== null &&
          blockingRank > ke166Rank &&
          canAssignStaff(plannedState, counter.id, person.id, blocking.id) ===
            null;
        if (available) blockingAssignment = blocking;
        return available;
      });
    if (candidate)
      violations.push({ counter, supervisor, candidate, blockingAssignment });
  }
  return violations;
}

function isAutomaticRegularAssignment(
  state: ScheduleGenerationFacts,
  assignment: Assignment
): boolean {
  const rule = assignmentRule(state, assignment);
  return Boolean(
    rule &&
    rule.category === "常规" &&
    !rule.manual &&
    assignment.positionRuleId &&
    assignment.staffId &&
    assignment.status === "assigned" &&
    assignment.workHours > 0
  );
}

function counterPlacementChanges(
  state: ScheduleGenerationFacts,
  assignments: Assignment[],
  changes: readonly RotationStaffChange[]
): CounterPlacementPlan["changes"] {
  const assignmentById = new Map(
    assignments.map((assignment) => [assignment.id, assignment])
  );
  const personById = new Map(state.staff.map((person) => [person.id, person]));
  return changes.flatMap((change) => {
    const assignment = assignmentById.get(change.assignmentId);
    const person = personById.get(change.staffId);
    return assignment && person
      ? [
          {
            assignment,
            staffId: person.id,
            staffName: person.name,
          },
        ]
      : [];
  });
}

function eligibleSupervisorOrder(
  state: ScheduleGenerationFacts,
  assignments: Assignment[],
  flight: Flight,
  rule: PositionRule,
  date: string,
  facts?: ScheduleRunFacts,
  requireNonRepeated = false
): string[] {
  const prioritizeKe166Rotation = isKe166MobileSupervisor(flight, rule);
  return eligibleStaffForRule(state, flight, rule)
    .filter(
      (person) =>
        !requireNonRepeated ||
        consecutivePositionAssignments(
          state,
          person.id,
          flight.flightNo,
          rule.name,
          rule.remark,
          date
        ) === 0
    )
    .sort(
      (left, right) =>
        Number(
          prioritizeKe166Rotation &&
            consecutivePositionAssignments(
              state,
              left.id,
              flight.flightNo,
              rule.name,
              rule.remark,
              date
            ) > 0
        ) -
          Number(
            prioritizeKe166Rotation &&
              consecutivePositionAssignments(
                state,
                right.id,
                flight.flightNo,
                rule.name,
                rule.remark,
                date
              ) > 0
          ) ||
        totalFatiguePriority(
          left,
          assignments,
          state,
          date,
          facts?.currentDutyStaffId,
          facts?.historicalFatigueByStaff.get(left.id)
        ) -
          totalFatiguePriority(
            right,
            assignments,
            state,
            date,
            facts?.currentDutyStaffId,
            facts?.historicalFatigueByStaff.get(right.id)
          ) ||
        left.id.localeCompare(right.id, undefined, { numeric: true })
    )
    .map((person) => person.id);
}

async function findSupervisorCounterPlan(
  solver: SolverPort,
  state: ScheduleGenerationFacts,
  assignments: Assignment[],
  flight: Flight,
  supervisorRule: PositionRule,
  date: string,
  facts?: ScheduleRunFacts,
  lockedAssignmentIds: ReadonlySet<string> = new Set(),
  requireNonRepeated = false,
  excludedSupervisorIds: ReadonlySet<string> = new Set(),
  onSearchFailure?: (
    target: Assignment,
    result: ReassignmentOptimizationResult
  ) => void
): Promise<CounterPlacementPlan | null> {
  const supervisorIds = eligibleSupervisorOrder(
    state,
    assignments,
    flight,
    supervisorRule,
    date,
    facts,
    requireNonRepeated
  ).filter((staffId) => !excludedSupervisorIds.has(staffId));
  const supervisorIdSet = new Set(supervisorIds);
  const supervisorOrder = new Map(
    supervisorIds.map((staffId, index) => [staffId, index])
  );
  const targets = assignments
    .filter(
      (assignment) =>
        assignment.flightId === flight.id && assignment.positionRuleId
    )
    .filter((assignment) => {
      const targetRule = assignmentRule(state, assignment);
      return Boolean(
        targetRule &&
        targetRule.category === "常规" &&
        !targetRule.manual &&
        isNumberedRegularPosition(targetRule) &&
        canMobileSupervisorCoverPosition(state, {
          flightNo: flight.flightNo,
          position: targetRule.name,
          remark: targetRule.remark,
        })
      );
    });

  for (const target of targets) {
    if (
      target.status === "assigned" &&
      target.staffId &&
      supervisorIdSet.has(target.staffId)
    )
      return {
        target,
        changes: [],
        description: `已在允许兼任的${flight.flightNo}柜台`,
      };
  }

  for (const target of targets.filter(
    (assignment) => assignment.status === "assigned" && assignment.staffId
  )) {
    const result = await optimizeReassignment({
      solver,
      state,
      assignments,
      primary: target,
      movableAssignments: rotationCandidateAssignments(
        assignments,
        target,
        state,
        lockedAssignmentIds
      ).filter((assignment) => isAutomaticRegularAssignment(state, assignment)),
      date,
      facts,
      intent: { kind: "mobile-supervisor-counter-coverage" },
      primaryCandidateAllowed: (person) => supervisorIdSet.has(person.id),
      primaryCandidateRejectionReason: (person) =>
        supervisorIdSet.has(person.id)
          ? null
          : "候选人不具备未连续的机动督导资质",
      compareCandidates: (assignment, left, right) =>
        assignment.id === target.id
          ? (supervisorOrder.get(left.id) ?? supervisorIds.length) -
            (supervisorOrder.get(right.id) ?? supervisorIds.length)
          : left.id.localeCompare(right.id, undefined, { numeric: true }),
      maxParticipants: 5,
      acceptTimeLimitedFeasible: true,
    });
    if (!result.changes) {
      onSearchFailure?.(target, result);
      continue;
    }
    const changes = counterPlacementChanges(state, assignments, result.changes);
    const participantIds = new Set(
      changes.flatMap((change) => [change.assignment.staffId!, change.staffId])
    );
    return {
      target,
      changes,
      description: `通过${participantIds.size}人整体安全重排，将合格督导放入允许兼任柜台`,
    };
  }
  return null;
}

export async function assignMobileSupervisorByCounterCoverage(
  solver: SolverPort,
  state: ScheduleGenerationFacts,
  assignments: Assignment[],
  flight: Flight,
  rule: PositionRule,
  date: string,
  facts?: ScheduleRunFacts,
  lockedAssignmentIds: ReadonlySet<string> = new Set(),
  rotationReplacementForStaffId?: string,
  onSearchFailure?: (
    target: Assignment,
    result: ReassignmentOptimizationResult
  ) => void
): Promise<Assignment | undefined> {
  if (!isMobileSupervisor(flight, rule)) return undefined;
  const ke166 = isKe166MobileSupervisor(flight, rule);
  const requireNonRepeated = ke166 && Boolean(rotationReplacementForStaffId);
  const eligibleIds = new Set(
    eligibleStaffForRule(state, flight, rule)
      .filter(
        (person) =>
          (!facts ||
            !halfRestPeriodViolation({
              facts: facts.halfRest,
              staffId: person.id,
              startTime: flight.startTime,
            })) &&
          (!requireNonRepeated ||
            consecutivePositionAssignments(
              state,
              person.id,
              flight.flightNo,
              rule.name,
              rule.remark,
              date
            ) === 0)
      )
      .map((person) => person.id)
  );
  let regularAssignment = assignments
    .filter((assignment) => {
      const sourceRule = assignmentRule(state, assignment);
      return (
        assignment.flightId === flight.id &&
        assignment.status === "assigned" &&
        assignment.staffId &&
        eligibleIds.has(assignment.staffId) &&
        Boolean(
          sourceRule &&
          sourceRule.coverageRole !== "supervisor-fill" &&
          isNumberedRegularPosition(sourceRule) &&
          canMobileSupervisorCoverPosition(state, {
            flightNo: flight.flightNo,
            position: sourceRule.name,
            remark: sourceRule.remark,
          })
        )
      );
    })
    .sort((left, right) => {
      const leftPerson = state.staff.find(
        (person) => person.id === left.staffId
      )!;
      const rightPerson = state.staff.find(
        (person) => person.id === right.staffId
      )!;
      return (
        Number(
          ke166 &&
            consecutivePositionAssignments(
              state,
              leftPerson.id,
              flight.flightNo,
              rule.name,
              rule.remark,
              date
            ) > 0
        ) -
          Number(
            ke166 &&
              consecutivePositionAssignments(
                state,
                rightPerson.id,
                flight.flightNo,
                rule.name,
                rule.remark,
                date
              ) > 0
          ) ||
        totalFatiguePriority(
          leftPerson,
          assignments,
          state,
          date,
          facts?.currentDutyStaffId,
          facts?.historicalFatigueByStaff.get(leftPerson.id)
        ) -
          totalFatiguePriority(
            rightPerson,
            assignments,
            state,
            date,
            facts?.currentDutyStaffId,
            facts?.historicalFatigueByStaff.get(rightPerson.id)
          ) ||
        leftPerson.id.localeCompare(rightPerson.id, undefined, {
          numeric: true,
        })
      );
    })[0];
  if (!regularAssignment) {
    const plan = await findSupervisorCounterPlan(
      solver,
      state,
      assignments,
      flight,
      rule,
      date,
      facts,
      lockedAssignmentIds,
      requireNonRepeated,
      new Set(),
      onSearchFailure
    );
    if (plan) {
      for (const change of plan.changes) {
        clearAutomaticAssignmentEvidence(change.assignment);
        change.assignment.staffId = change.staffId;
        change.assignment.staffName = change.staffName;
        change.assignment.status = "assigned";
      }
      regularAssignment = plan.target;
      if (plan.changes.length) {
        regularAssignment.decisionTrace = [
          schedulingDecision(
            ke166 ? "ke166-supervisor" : "mobile-supervisor",
            "selected",
            `${flight.flightNo}没有独立督导人选，柜台完成后置安全重排：${plan.description}，随后启用督导兼任兜底。`
          ),
        ];
      }
    }
  }
  if (!regularAssignment?.staffId) return undefined;
  const currentRepeated =
    ke166 &&
    consecutivePositionAssignments(
      state,
      regularAssignment.staffId,
      flight.flightNo,
      rule.name,
      rule.remark,
      date
    ) > 0;
  if (currentRepeated) {
    const excludedSupervisorIds = new Set([regularAssignment.staffId]);
    const plan = await findSupervisorCounterPlan(
      solver,
      state,
      assignments,
      flight,
      rule,
      date,
      facts,
      lockedAssignmentIds,
      currentRepeated,
      excludedSupervisorIds,
      onSearchFailure
    );
    if (plan) {
      const originalName = regularAssignment.staffName;
      for (const change of plan.changes) {
        clearAutomaticAssignmentEvidence(change.assignment);
        change.assignment.staffId = change.staffId;
        change.assignment.staffName = change.staffName;
        change.assignment.status = "assigned";
      }
      regularAssignment = plan.target;
      regularAssignment.decisionTrace = [
        schedulingDecision(
          "position-rotation",
          "selected",
          `KE166机动督导后置绑定前已完成整体安全重排：${originalName}退出原兼任方案；${plan.description}，先保证柜台轮换再启用督导兼任兜底。`
        ),
      ];
    }
  }
  if (!regularAssignment.staffId) return undefined;
  const regularStaffId = regularAssignment.staffId;

  const replacedIndependentSupervisor =
    ke166 && rotationReplacementForStaffId
      ? state.staff.find(
          (person) => person.id === rotationReplacementForStaffId
        )
      : undefined;
  const rotationImprovementMessage = replacedIndependentSupervisor
    ? `KE166机动督导连续轮岗已落实：${replacedIndependentSupervisor.name}上一工作班已承担${flight.flightNo}/${rule.name}，本班改由${regularAssignment.staffName}保留${flight.flightNo}/${regularAssignment.position}并兼任机动督导。`
    : null;

  const repeatedSupervisorRuns = ke166
    ? consecutivePositionAssignments(
        state,
        regularStaffId,
        flight.flightNo,
        rule.name,
        rule.remark,
        date
      )
    : 0;
  const repeatedMessage =
    repeatedSupervisorRuns > 0
      ? assignmentWarningMessage({
          staffName: regularAssignment.staffName,
          fact: `已连续${repeatedSupervisorRuns}次承担${flight.flightNo}/${rule.name}`,
          reasons: ["没有其他未连续且满足全部要求的机动督导人选"],
          decision: "机动督导岗位完整性优先",
          result: `保留原安排，当前连续第${repeatedSupervisorRuns + 1}次`,
        })
      : undefined;
  const boundCounterRule = assignmentRule(state, regularAssignment);
  const recoveryOverride =
    boundCounterRule &&
    lateShiftRecoveryRisk(
      state,
      regularStaffId,
      {
        ...flight,
        position: regularAssignment.position,
        remark: regularAssignment.remark,
        fatiguePoints: regularAssignment.fatiguePoints,
      },
      date,
      facts?.crossDayRecovery
    ).excess > 0
      ? schedulingDecision(
          "late-shift-recovery",
          "fallback",
          assignmentWarningMessage({
            staffName: regularAssignment.staffName,
            fact: `上一班较晚结束，本班仍承担${flight.flightNo}/${regularAssignment.position}`,
            reasons: [
              ke166 ? "KE166机动督导锁定优先" : "机动督导岗位完整性优先",
            ],
          })
        )
      : null;
  const decisionTrace = [
    schedulingDecision(
      ke166 ? "ke166-supervisor" : "mobile-supervisor",
      "selected",
      rotationImprovementMessage
        ? `${regularAssignment.staffName}为解除连续督导，由KE166柜台兼任机动督导`
        : `${regularAssignment.staffName}在人手不足时由${flight.flightNo}柜台兼任机动督导`
    ),
    ...(regularAssignment.decisionTrace?.filter(
      (decision) => decision.ruleId === "position-rotation"
    ) ?? []),
    ...(rotationImprovementMessage
      ? [
          schedulingDecision(
            "position-rotation",
            "selected",
            rotationImprovementMessage
          ),
        ]
      : []),
    ...(repeatedMessage
      ? [schedulingDecision("position-rotation", "fallback", repeatedMessage)]
      : []),
    ...(recoveryOverride ? [recoveryOverride] : []),
  ];

  const supervisorAssignment: Assignment = {
    id: createId("assignment"),
    flightId: flight.id,
    flightNo: flight.flightNo,
    positionRuleId: rule.id,
    position: rule.name,
    staffId: regularStaffId,
    staffName: regularAssignment.staffName,
    startTime: flight.startTime,
    endTime: flight.endTime,
    workHours: durationHours(flight.startTime, flight.endTime),
    fatiguePoints: rule.fatiguePoints,
    remark: rule.remark,
    manualRemark: "",
    status: "assigned",
    ...(decisionTrace.length ? { decisionTrace } : {}),
  };
  regularAssignment.decisionTrace = [
    ...(regularAssignment.decisionTrace ?? []).filter(
      (decision) =>
        decision.ruleId !== "ke166-supervisor" &&
        decision.ruleId !== "mobile-supervisor" &&
        decision.ruleId !== "late-shift-recovery" &&
        (!rotationImprovementMessage || decision.ruleId !== "position-rotation")
    ),
    schedulingDecision(
      ke166 ? "ke166-supervisor" : "mobile-supervisor",
      "selected",
      `${regularAssignment.staffName}在人手不足时兼任${flight.flightNo}/${rule.name}`
    ),
    ...(rotationImprovementMessage
      ? [
          schedulingDecision(
            "position-rotation",
            "selected",
            rotationImprovementMessage
          ),
        ]
      : []),
    ...(recoveryOverride ? [recoveryOverride] : []),
  ];
  regularAssignment.workHours = 0;
  setSupervisorFillLink(regularAssignment, supervisorAssignment.id);
  return supervisorAssignment;
}
