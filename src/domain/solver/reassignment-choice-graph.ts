import type { Assignment, Staff } from "../../model";
import { isDutyMorningFlight } from "../assignments/duty-assignment";
import { applyConfiguredEarlyReleases } from "../assignments/assignment-timing";
import {
  diagnoseBaseAssignmentEligibility,
  diagnoseDailyPrimaryPositionEligibility,
  diagnoseSameAirlinePriorityEligibility,
} from "../candidates/assignment-eligibility";
import {
  assignmentRule,
  isGapFillGuidePosition,
  isLegalGuideReuse,
} from "../flights/schedule-position-rules";
import {
  reassignmentCandidateSafetyReasons,
  reassignmentDynamicSafetyReasons,
  ROTATION_REVIEW_POLICIES,
} from "../reviews/reassignment-safety-policy";
import type { RotationStaffChange } from "../reviews/rotation-review-safety";
import { intervalsOverlap } from "../shared/time";
import type { ReassignmentOptimizationOptions } from "./reassignment-contract";
import {
  reassignmentIntentReview,
  reassignmentIntentPolicy,
  type ReassignmentIntentPolicy,
} from "./reassignment-intent";
import type {
  IncompatibleReassignmentChoices,
  ReassignmentChoice,
  ReassignmentChoiceRequirement,
} from "./reassignment-model";

export interface ReassignmentChoiceFacts {
  choice: ReassignmentChoice;
  assignment: Assignment;
  person: Staff;
}

export interface PreparedReassignmentChoices {
  choices: ReassignmentChoiceFacts[];
  movable: Assignment[];
  fixed: Assignment[];
  candidateRejectionReasons: string[];
  candidateRejections: {
    assignmentId: string;
    flightNo: string;
    position: string;
    startTime: string;
    endTime: string;
    staffId: string;
    staffName: string;
    reasons: string[];
  }[];
}

function projectedAssignment(
  assignment: Assignment,
  person: Staff
): Assignment {
  return {
    ...assignment,
    staffId: person.id,
    staffName: person.name,
  };
}

function canUseDirectGuideException(
  intentPolicy: ReassignmentIntentPolicy,
  options: ReassignmentOptimizationOptions,
  assignment: Assignment,
  person: Staff
): boolean {
  if (!intentPolicy.allowDirectGuideReassignment) return false;
  const rule = assignmentRule(options.state, assignment);
  return (
    Boolean(rule && isGapFillGuidePosition(rule)) &&
    (person.id === assignment.staffId || person.teamLeader === true)
  );
}

function dynamicChoiceSafetyReasons(
  intentPolicy: ReassignmentIntentPolicy,
  options: ReassignmentOptimizationOptions,
  assignment: Assignment,
  person: Staff,
  surroundingAssignments: readonly Assignment[]
): string[] {
  const projected = [
    ...surroundingAssignments.map((item) => ({ ...item })),
    projectedAssignment(assignment, person),
  ];
  applyConfiguredEarlyReleases(projected, options.state, new Set([person.id]));
  return reassignmentDynamicSafetyReasons({
    state: options.state,
    assignments: projected,
    assignment: projected.at(-1)!,
    primaryAssignment: options.primary,
    review: reassignmentIntentReview(options.intent),
    allowLoadProtectionRegression: intentPolicy.allowLoadProtectionRegression,
    allowPositionTransitionRegression:
      intentPolicy.allowPositionTransitionRegression,
  });
}

function fixedAssignments(
  assignments: readonly Assignment[],
  movableAssignmentIds: ReadonlySet<string>
): Assignment[] {
  return assignments.filter(
    (assignment) => !movableAssignmentIds.has(assignment.id)
  );
}

export function fixedHoursForStaff(
  assignments: readonly Assignment[],
  staffId: string
): number {
  return assignments
    .filter(
      (assignment) =>
        assignment.staffId === staffId && assignment.status === "assigned"
    )
    .reduce((total, assignment) => total + assignment.workHours, 0);
}

function conflictsWithFixedAssignment(
  options: ReassignmentOptimizationOptions,
  assignment: Assignment,
  person: Staff,
  fixed: readonly Assignment[],
  permittedConcurrentAssignmentIds: ReadonlySet<string>
): Assignment | null {
  const ownFixedAssignments = fixed.filter(
    (item) => item.staffId === person.id
  );
  const projected = [
    ...ownFixedAssignments.map((item) => ({ ...item })),
    projectedAssignment(assignment, person),
  ];
  applyConfiguredEarlyReleases(projected, options.state, new Set([person.id]));
  const projectedChoice = projected.at(-1)!;
  return projected
    .slice(0, -1)
    .some(
      (other) =>
        other.staffId === person.id &&
        intervalsOverlap(
          projectedChoice.startTime,
          projectedChoice.endTime,
          other.startTime,
          other.endTime
        ) &&
        !(
          permittedConcurrentAssignmentIds.has(assignment.id) &&
          permittedConcurrentAssignmentIds.has(other.id)
        ) &&
        !isLegalGuideReuse(options.state, projectedChoice, other)
    )
    ? (projected
        .slice(0, -1)
        .find(
          (other) =>
            other.staffId === person.id &&
            intervalsOverlap(
              projectedChoice.startTime,
              projectedChoice.endTime,
              other.startTime,
              other.endTime
            ) &&
            !(
              permittedConcurrentAssignmentIds.has(assignment.id) &&
              permittedConcurrentAssignmentIds.has(other.id)
            ) &&
            !isLegalGuideReuse(options.state, projectedChoice, other)
        ) ?? null)
    : null;
}

function createChoices(
  options: ReassignmentOptimizationOptions,
  movable: readonly Assignment[],
  fixed: readonly Assignment[]
): Pick<
  PreparedReassignmentChoices,
  "choices" | "candidateRejectionReasons" | "candidateRejections"
> {
  const permittedConcurrentAssignmentIds =
    options.permittedConcurrentAssignmentIds ?? new Set<string>();
  const activeStaff = options.state.staff.filter(
    (person) => person.status === "正常" && person.staffType === "常规"
  );
  const choices: ReassignmentChoiceFacts[] = [];
  const candidateRejectionReasons: string[] = [];
  const candidateRejections: PreparedReassignmentChoices["candidateRejections"] =
    [];
  const intentPolicy = reassignmentIntentPolicy(options.intent);
  for (const assignment of movable) {
    const flight = options.state.flights.find(
      (item) => item.id === assignment.flightId
    );
    const rule = assignmentRule(options.state, assignment);
    if (!flight || !rule) continue;
    const recordRejection = (person: Staff, reasons: string[]) => {
      candidateRejectionReasons.push(...reasons);
      if (
        (options.collectAllCandidateRejections ||
          assignment.id === options.primary.id) &&
        person.id !== assignment.staffId &&
        reasons.length
      ) {
        candidateRejections.push({
          assignmentId: assignment.id,
          flightNo: assignment.flightNo,
          position: assignment.position,
          startTime: assignment.startTime,
          endTime: assignment.endTime,
          staffId: person.id,
          staffName: person.name,
          reasons,
        });
      }
    };
    const candidates = activeStaff
      .filter((person) => {
        const diagnostic = diagnoseBaseAssignmentEligibility(
          options.state,
          flight,
          rule,
          person
        );
        if (
          !diagnostic.eligible &&
          !canUseDirectGuideException(
            intentPolicy,
            options,
            assignment,
            person
          ) &&
          rule.qualifiedStaffIds.includes(person.id)
        )
          recordRejection(
            person,
            diagnostic.violations.map((item) => item.message)
          );
        return (
          diagnostic.eligible ||
          canUseDirectGuideException(intentPolicy, options, assignment, person)
        );
      })
      .filter(
        (person) => options.candidateAllowed?.(assignment, person) ?? true
      )
      .filter((person) => {
        const diagnostic = diagnoseDailyPrimaryPositionEligibility({
          state: options.state,
          assignments: [...fixed],
          flight,
          rule,
          person,
          workHours: assignment.workHours,
        });
        recordRejection(
          person,
          diagnostic.violations.map((item) => item.message)
        );
        return diagnostic.eligible;
      })
      .filter((person) => {
        if (person.id === assignment.staffId) return true;
        const diagnostic = diagnoseSameAirlinePriorityEligibility(
          {
            state: options.state,
            assignments: options.assignments,
            flight,
            rule,
            person,
          },
          new Set([assignment.id])
        );
        if (!diagnostic.eligible)
          recordRejection(
            person,
            diagnostic.violations.map((item) => item.message)
          );
        return diagnostic.eligible;
      })
      .filter((person) => {
        const conflict = conflictsWithFixedAssignment(
          options,
          assignment,
          person,
          fixed,
          permittedConcurrentAssignmentIds
        );
        if (conflict)
          recordRejection(person, [
            `这个时段已经安排了其他岗位：${conflict.flightNo}/${conflict.position}（${conflict.startTime}-${conflict.endTime}）`,
          ]);
        return !conflict;
      })
      .filter((person) => {
        if (person.id === assignment.staffId) return true;
        const projected = projectedAssignment(assignment, person);
        const reasons = [
          ...reassignmentCandidateSafetyReasons({
            state: options.state,
            assignment: projected,
            originalAssignment: assignment,
            primaryAssignment: options.primary,
            date: options.date,
            review: reassignmentIntentReview(options.intent),
            facts: options.facts,
            frequencyFacts: options.frequencyFacts,
            latePriorityFatigueRelief: options.latePriorityFatigueRelief,
            allowCutoffProtectionRegression:
              intentPolicy.allowCutoffProtectionRegression,
            allowCrossWorkdayRecoveryRegression:
              intentPolicy.allowCrossWorkdayRecoveryRegression,
            allowTr121CooldownRegression:
              intentPolicy.allowTr121CooldownRegression,
            allowDirectGuideReassignment:
              intentPolicy.allowDirectGuideReassignment,
          }),
          ...dynamicChoiceSafetyReasons(
            intentPolicy,
            options,
            assignment,
            person,
            fixed.filter((item) => item.staffId === person.id)
          ),
        ];
        recordRejection(person, reasons);
        return reasons.length === 0;
      })
      .filter((person) => {
        if (assignment.id !== options.primary.id) return true;
        if (person.id === assignment.staffId) return false;
        if (options.primaryCandidateAllowed(person)) return true;
        const reason = options.primaryCandidateRejectionReason?.(person);
        recordRejection(person, [reason ?? "换上后仍会连续承担这个岗位"]);
        return false;
      })
      .sort((left, right) =>
        options.compareCandidates
          ? options.compareCandidates(assignment, left, right)
          : left.id.localeCompare(right.id, undefined, { numeric: true })
      );
    candidates.forEach((person, preferenceRank) => {
      choices.push({
        choice: {
          id: String(choices.length),
          assignmentId: assignment.id,
          staffId: person.id,
          keepsCurrentStaff: person.id === assignment.staffId,
          preferenceRank,
          workHours:
            options.choiceWorkHours?.(assignment, person) ??
            assignment.workHours,
        },
        assignment,
        person,
      });
    });
  }
  return {
    choices,
    candidateRejectionReasons: [...new Set(candidateRejectionReasons)],
    candidateRejections,
  };
}

export function prepareReassignmentChoices(
  options: ReassignmentOptimizationOptions
): PreparedReassignmentChoices {
  const movable = [
    options.primary,
    ...options.movableAssignments.filter(
      (assignment) => assignment.id !== options.primary.id
    ),
  ];
  const movableIds = new Set(movable.map((assignment) => assignment.id));
  const fixed = fixedAssignments(options.assignments, movableIds);
  return { movable, fixed, ...createChoices(options, movable, fixed) };
}

export function incompatibleReassignmentChoices(
  choices: readonly ReassignmentChoiceFacts[],
  options: ReassignmentOptimizationOptions,
  fixed: readonly Assignment[],
  permittedConcurrentAssignmentIds: ReadonlySet<string>
): IncompatibleReassignmentChoices[] {
  const intentPolicy = reassignmentIntentPolicy(options.intent);
  const conflicts: IncompatibleReassignmentChoices[] = [];
  const choicesByStaffId = new Map<string, ReassignmentChoiceFacts[]>();
  for (const choice of choices) {
    const ownChoices = choicesByStaffId.get(choice.person.id) ?? [];
    ownChoices.push(choice);
    choicesByStaffId.set(choice.person.id, ownChoices);
  }
  for (const [staffId, ownChoices] of choicesByStaffId) {
    const ownFixedAssignments = fixed.filter(
      (assignment) => assignment.staffId === staffId
    );
    for (let leftIndex = 0; leftIndex < ownChoices.length; leftIndex += 1) {
      const left = ownChoices[leftIndex]!;
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < ownChoices.length;
        rightIndex += 1
      ) {
        const right = ownChoices[rightIndex]!;
        if (left.assignment.id === right.assignment.id) continue;
        const rightFlight = options.state.flights.find(
          (flight) => flight.id === right.assignment.flightId
        );
        const rightRule = assignmentRule(options.state, right.assignment);
        if (
          rightFlight &&
          rightRule &&
          !diagnoseDailyPrimaryPositionEligibility({
            state: options.state,
            assignments: [projectedAssignment(left.assignment, left.person)],
            flight: rightFlight,
            rule: rightRule,
            person: right.person,
            workHours: right.assignment.workHours,
          }).eligible
        ) {
          conflicts.push({
            leftChoiceId: left.choice.id,
            rightChoiceId: right.choice.id,
          });
          continue;
        }
        const projected = [
          ...ownFixedAssignments.map((assignment) => ({ ...assignment })),
          projectedAssignment(left.assignment, left.person),
          projectedAssignment(right.assignment, right.person),
        ];
        applyConfiguredEarlyReleases(
          projected,
          options.state,
          new Set([staffId])
        );
        const leftAssignment = projected.at(-2)!;
        const rightAssignment = projected.at(-1)!;
        const concurrencyPermitted =
          permittedConcurrentAssignmentIds.has(left.assignment.id) &&
          permittedConcurrentAssignmentIds.has(right.assignment.id);
        const timingConflict =
          !concurrencyPermitted &&
          !isLegalGuideReuse(options.state, leftAssignment, rightAssignment) &&
          intervalsOverlap(
            leftAssignment.startTime,
            leftAssignment.endTime,
            rightAssignment.startTime,
            rightAssignment.endTime
          );
        const dynamicReasons = [left, right].flatMap((choice, index) =>
          choice.choice.keepsCurrentStaff
            ? []
            : reassignmentDynamicSafetyReasons({
                state: options.state,
                assignments: permittedConcurrentAssignmentIds.has(
                  choice.assignment.id
                )
                  ? projected.filter(
                      (assignment) =>
                        assignment.id === choice.assignment.id ||
                        !permittedConcurrentAssignmentIds.has(assignment.id)
                    )
                  : projected,
                assignment: index === 0 ? leftAssignment : rightAssignment,
                primaryAssignment: options.primary,
                review: reassignmentIntentReview(options.intent),
                allowLoadProtectionRegression:
                  intentPolicy.allowLoadProtectionRegression,
                allowPositionTransitionRegression:
                  intentPolicy.allowPositionTransitionRegression,
              })
        );
        if (!timingConflict && !dynamicReasons.length) continue;
        conflicts.push({
          leftChoiceId: left.choice.id,
          rightChoiceId: right.choice.id,
        });
      }
    }
  }
  return conflicts;
}

export function decodeReassignmentChanges(
  selectedVariableIds: ReadonlySet<string>,
  choices: readonly ReassignmentChoiceFacts[]
): RotationStaffChange[] {
  return choices.flatMap(({ choice }) =>
    selectedVariableIds.has(choice.id) && !choice.keepsCurrentStaff
      ? [{ assignmentId: choice.assignmentId, staffId: choice.staffId }]
      : []
  );
}

function hasActualWork(
  assignments: readonly Assignment[],
  staffId: string
): boolean {
  return assignments.some(
    (assignment) =>
      assignment.staffId === staffId &&
      assignment.status === "assigned" &&
      assignment.workHours > 0
  );
}

export function reassignmentChoiceRequirements(
  options: ReassignmentOptimizationOptions,
  choices: readonly ReassignmentChoiceFacts[],
  movable: readonly Assignment[],
  fixed: readonly Assignment[]
): ReassignmentChoiceRequirement[] {
  const policy =
    ROTATION_REVIEW_POLICIES[reassignmentIntentReview(options.intent)];
  const requirements: ReassignmentChoiceRequirement[] = [];
  for (const staffId of options.requiredStaffIds ?? []) {
    requirements.push({
      id: `required-staff:${staffId}`,
      choiceIds: choices.flatMap(({ choice }) =>
        choice.staffId === staffId ? [choice.id] : []
      ),
      minimum: 1,
    });
  }
  if (policy.preventStaffWithoutWork) {
    const originalStaffIds = new Set(
      movable.flatMap((assignment) =>
        assignment.status === "assigned" && assignment.staffId
          ? [assignment.staffId]
          : []
      )
    );
    for (const staffId of originalStaffIds) {
      if (hasActualWork(fixed, staffId)) continue;
      requirements.push({
        id: `retain-work:${staffId}`,
        choiceIds: choices.flatMap(({ choice }) =>
          choice.staffId === staffId ? [choice.id] : []
        ),
        minimum: 1,
      });
    }
  }

  const dutyStaffId = options.facts?.currentDutyStaffId;
  if (
    policy.protectDutyMorning &&
    dutyStaffId &&
    !fixed.some(
      (assignment) =>
        assignment.staffId === dutyStaffId &&
        assignment.status === "assigned" &&
        assignment.workHours > 0 &&
        isDutyMorningFlight({ startTime: assignment.startTime }, options.state)
    )
  ) {
    requirements.push({
      id: `duty-morning:${dutyStaffId}`,
      choiceIds: choices.flatMap(({ choice, assignment }) =>
        choice.staffId === dutyStaffId &&
        choice.workHours > 0 &&
        isDutyMorningFlight({ startTime: assignment.startTime }, options.state)
          ? [choice.id]
          : []
      ),
      minimum: 1,
    });
  }
  return requirements;
}
