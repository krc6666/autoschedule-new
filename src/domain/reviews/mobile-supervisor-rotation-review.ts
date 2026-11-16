import type { Assignment } from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import { schedulingDecision } from "../rules/schedule-rule-contract";
import {
  rebuildAutomaticAssignmentEvidence,
  replaceAssignmentDecisions,
} from "../assignments/assignment-evidence";
import {
  isOrdinaryPriorityPosition,
  isPriorityRotationPosition,
} from "./position-rotation-policy";
import {
  comparePositionFrequency,
  consecutivePositionAssignments,
  createScheduleFrequencyFacts,
  positionFrequencyProfileForAssignment,
} from "../statistics/schedule-frequency";
import { assignmentRule } from "../flights/schedule-position-rules";
import type { ScheduleRunFacts } from "../shared/schedule-run-facts";
import {
  isKe166MobileSupervisor,
  isMobileSupervisor,
} from "../flights/schedule-tasks";
import {
  isRotationLocked,
  type RotationStaffChange,
} from "./rotation-review-safety";
import { optimizeReassignment } from "../solver/reassignment-optimizer";
import type { SolverPort } from "../solver/solver-port";
import { intervalsOverlap } from "../shared/time";
import {
  assignmentWarningMessage,
  rotationCandidateWarningMessage,
  rotationWarningCandidates,
} from "./schedule-warning-message";

interface MobileSupervisorRotationReviewResult {
  warnings: string[];
  reviewedAssignmentIds: string[];
  attemptedReasonsByAssignment: ReadonlyMap<string, readonly string[]>;
}

interface MobileSupervisorRotationRole {
  id: string;
  assignments: Assignment[];
  staffId: string;
  staffName: string;
  mobileSupervisorGroup: boolean;
  boundCounterGroup: boolean;
}

function hasSelectedDutyLock(assignment: Assignment): boolean {
  return (
    assignment.decisionTrace?.some(
      (decision) =>
        decision.ruleId === "duty-position" && decision.outcome === "selected"
    ) ?? false
  );
}

function configuredForAssignment(
  state: ScheduleGenerationFacts,
  assignment: Assignment,
  staffId: string
): boolean {
  const rule = assignmentRule(state, assignment);
  const person = state.staff.find((item) => item.id === staffId);
  return Boolean(
    rule &&
    person?.status === "正常" &&
    person.staffType === "常规" &&
    rule.qualifiedStaffIds.includes(staffId)
  );
}

function previousRuns(
  state: ScheduleGenerationFacts,
  assignment: Assignment,
  staffId: string,
  date: string,
  facts?: ScheduleRunFacts
): number {
  return consecutivePositionAssignments(
    state,
    staffId,
    assignment.flightNo,
    assignment.position,
    assignment.remark,
    date,
    facts?.scheduleFrequency
  );
}

function applyRotationPlan(
  state: ScheduleGenerationFacts,
  assignments: Assignment[],
  primaryRole: MobileSupervisorRotationRole,
  repeatedAssignment: Assignment,
  changes: readonly RotationStaffChange[],
  mobileAssignmentIds: ReadonlySet<string>,
  review: "consecutive" | "frequency"
): void {
  const originalById = new Map(
    assignments.map((assignment) => [
      assignment.id,
      { staffId: assignment.staffId!, staffName: assignment.staffName },
    ])
  );
  const changedAssignments: Assignment[] = [];
  for (const change of changes) {
    const assignment = assignments.find(
      (item) => item.id === change.assignmentId
    );
    const person = state.staff.find((item) => item.id === change.staffId);
    if (!assignment || !person) continue;
    assignment.staffId = person.id;
    assignment.staffName = person.name;
    changedAssignments.push(assignment);
  }
  const participants = new Set(
    changes.flatMap((change) => [
      originalById.get(change.assignmentId)!.staffId,
      change.staffId,
    ])
  ).size;
  const ruleId =
    review === "frequency" ? "position-frequency-review" : "position-rotation";
  const message =
    review === "frequency"
      ? `${primaryRole.staffName}承担${repeatedAssignment.flightNo}/${repeatedAssignment.position}的同岗次数较高，本班已通过${participants}人整体安全重排改由低频人员；机动督导关系、岗位完整性及全部安全约束验证通过。`
      : `${primaryRole.staffName}上一工作班已承担${repeatedAssignment.flightNo}/${repeatedAssignment.position}，本班已通过${participants}人整体安全重排解除连续岗位；机动督导关系、岗位完整性及全部安全约束验证通过。`;
  changedAssignments.forEach((assignment) => {
    rebuildAutomaticAssignmentEvidence(
      assignment,
      mobileAssignmentIds.has(assignment.id)
        ? [
            schedulingDecision(
              assignment.flightNo.trim().toUpperCase() === "KE166"
                ? "ke166-supervisor"
                : "mobile-supervisor",
              "selected",
              `${assignment.staffName}已安排为${assignment.flightNo}机动督导组人员`
            ),
            schedulingDecision(ruleId, "selected", message),
          ]
        : [schedulingDecision(ruleId, "selected", message)]
    );
  });
}

function unresolvedMessage(
  primaryRole: MobileSupervisorRotationRole,
  repeatedAssignment: Assignment,
  runs: number,
  reasons: readonly string[]
): string {
  return assignmentWarningMessage({
    staffName: primaryRole.staffName,
    fact: `已连续${runs}次承担${repeatedAssignment.flightNo}/${repeatedAssignment.position}`,
    reasons,
    decision: primaryRole.boundCounterGroup
      ? "机动督导和兼任柜台完整性优先"
      : "岗位完整性优先",
    result: `保留原安排，当前连续第${runs + 1}次`,
  });
}

export async function reviewMobileSupervisorGroupRotation(
  solver: SolverPort,
  state: ScheduleGenerationFacts,
  assignments: Assignment[],
  date: string,
  lockedAssignmentIds: ReadonlySet<string>,
  facts: ScheduleRunFacts | undefined,
  review: "consecutive" | "frequency"
): Promise<MobileSupervisorRotationReviewResult> {
  const warnings: string[] = [];
  const reviewedAssignmentIds = new Set<string>();
  const attemptedReasonsByAssignment = new Map<string, readonly string[]>();
  const frequencyFacts =
    facts?.scheduleFrequency ?? createScheduleFrequencyFacts(state, date);
  const supervisors = assignments.filter((assignment) => {
    const flight = state.flights.find(
      (item) => item.id === assignment.flightId
    );
    const rule = assignmentRule(state, assignment);
    return Boolean(
      flight &&
      rule &&
      isMobileSupervisor(flight, rule) &&
      !rule.manual &&
      assignment.status === "assigned" &&
      assignment.staffId
    );
  });

  for (const supervisor of supervisors) {
    const linked = assignments.filter(
      (assignment) => assignment.supervisorSourceAssignmentId === supervisor.id
    );
    const group = [supervisor, ...linked];
    const supervisorRule = assignmentRule(state, supervisor)!;
    const supervisorFlight = state.flights.find(
      (f) => f.id === supervisor.flightId
    )!;
    const ke166 = isKe166MobileSupervisor(supervisorFlight, supervisorRule);
    const priority = (assignment: Assignment) => {
      const rule = assignmentRule(state, assignment);
      return Boolean(
        rule &&
        isOrdinaryPriorityPosition(
          rule,
          state.settings.ordinaryPriorityPositions
        )
      );
    };
    if (!(review === "consecutive" && ke166) && !group.some(priority)) continue;
    const profile = (assignment: Assignment, staffId: string) =>
      positionFrequencyProfileForAssignment(
        state,
        assignment,
        staffId,
        date,
        frequencyFacts
      );
    const groupIds = new Set(group.map((assignment) => assignment.id));
    const groupRole: MobileSupervisorRotationRole = {
      id: `mobile-group:${supervisor.id}`,
      assignments: group,
      staffId: supervisor.staffId!,
      staffName: supervisor.staffName,
      mobileSupervisorGroup: true,
      boundCounterGroup: linked.length > 0,
    };
    const ordinaryRoles: MobileSupervisorRotationRole[] = assignments
      .filter(
        (assignment) =>
          !groupIds.has(assignment.id) &&
          !isRotationLocked(state, assignment, lockedAssignmentIds) &&
          (assignment.flightId === supervisor.flightId ||
            intervalsOverlap(
              assignment.startTime,
              assignment.endTime,
              supervisor.startTime,
              supervisor.endTime
            ))
      )
      .map((assignment) => ({
        id: `assignment:${assignment.id}`,
        assignments: [assignment],
        staffId: assignment.staffId!,
        staffName: assignment.staffName,
        mobileSupervisorGroup: false,
        boundCounterGroup: false,
      }));
    const roles = [groupRole, ...ordinaryRoles];
    const roleLocked = (role: MobileSupervisorRotationRole) =>
      role.assignments.some(
        (a) => hasSelectedDutyLock(a) || assignmentRule(state, a)?.manual
      ) ||
      (!ke166 &&
        role.mobileSupervisorGroup &&
        role.assignments.some(
          (a) =>
            lockedAssignmentIds.has(a.id) &&
            a.supervisorSourceAssignmentId === undefined
        ));
    const roleByAssignmentId = new Map(
      roles.flatMap((role) =>
        role.assignments.map((assignment) => [assignment.id, role] as const)
      )
    );
    const repeatedRoles = roles
      .map((role) => {
        const repeatedAssignments = role.assignments.filter((assignment) => {
          const rule = assignmentRule(state, assignment);
          return review === "frequency"
            ? priority(assignment) &&
                (profile(assignment, role.staffId).currentMonthCount > 0 ||
                  profile(assignment, role.staffId).recentWorkdayCount > 0)
            : previousRuns(state, assignment, role.staffId, date, facts) > 0 &&
                (priority(assignment) ||
                  (ke166 &&
                    (role.mobileSupervisorGroup ||
                      Boolean(rule && isPriorityRotationPosition(rule)))));
        });
        return {
          role,
          repeatedAssignment: repeatedAssignments.sort(
            (left, right) =>
              (review === "frequency"
                ? comparePositionFrequency(
                    profile(right, role.staffId),
                    profile(left, role.staffId)
                  )
                : 0) || right.fatiguePoints - left.fatiguePoints
          )[0],
          runs: Math.max(
            0,
            ...repeatedAssignments.map((assignment) =>
              previousRuns(state, assignment, role.staffId, date, facts)
            )
          ),
        };
      })
      .filter((item) => Boolean(item.repeatedAssignment))
      .sort(
        (left, right) =>
          (review === "frequency"
            ? comparePositionFrequency(
                profile(right.repeatedAssignment!, right.role.staffId),
                profile(left.repeatedAssignment!, left.role.staffId)
              )
            : 0) ||
          right.runs - left.runs ||
          right.repeatedAssignment!.fatiguePoints -
            left.repeatedAssignment!.fatiguePoints ||
          left.role.id.localeCompare(right.role.id)
      );

    for (const {
      role: primaryRole,
      repeatedAssignment,
      runs,
    } of repeatedRoles) {
      if (
        !repeatedAssignment ||
        primaryRole.assignments.some((assignment) =>
          reviewedAssignmentIds.has(assignment.id)
        )
      )
        continue;
      let attemptedReasons: string[] = [];
      let candidateRejections:
        { staffId: string; reasons: string[] }[] | undefined;
      let searchTimedOut = false;
      let changes: readonly RotationStaffChange[] | null = null;
      if (roleLocked(primaryRole)) {
        attemptedReasons = [
          "机动督导岗位或兼任组包含人工指定、值班或显式锁定岗位",
        ];
      } else {
        const availableRoles = roles.filter(
          (role) =>
            !roleLocked(role) &&
            role.assignments.every(
              (assignment) =>
                !reviewedAssignmentIds.has(assignment.id) &&
                !hasSelectedDutyLock(assignment) &&
                !assignmentRule(state, assignment)?.manual
            )
        );
        const beforeRuns = previousRuns(
          state,
          repeatedAssignment,
          primaryRole.staffId,
          date,
          facts
        );
        const result = await optimizeReassignment({
          solver,
          state,
          assignments,
          primary: repeatedAssignment,
          movableAssignments: availableRoles
            .flatMap((role) => role.assignments)
            .filter((assignment) => assignment.id !== repeatedAssignment.id),
          date,
          facts,
          frequencyFacts,
          intent:
            review === "frequency"
              ? { kind: "position-frequency-review" }
              : {
                  kind: ke166
                    ? "ke166-rotation-review"
                    : "consecutive-rotation-review",
                },
          permittedConcurrentAssignmentIds: groupIds,
          coupledAssignmentGroups:
            group.length > 1 ? [group.map((assignment) => assignment.id)] : [],
          primaryCandidateAllowed: (person) =>
            primaryRole.assignments.every((assignment) =>
              configuredForAssignment(state, assignment, person.id)
            ) &&
            (review === "frequency"
              ? comparePositionFrequency(
                  profile(repeatedAssignment, person.id),
                  profile(repeatedAssignment, primaryRole.staffId)
                ) < 0
              : previousRuns(
                  state,
                  repeatedAssignment,
                  person.id,
                  date,
                  facts
                ) < beforeRuns),
          compareCandidates: (assignment, left, right) =>
            comparePositionFrequency(
              profile(assignment, left.id),
              profile(assignment, right.id)
            ),
          primaryCandidateRejectionReason: (person) =>
            primaryRole.boundCounterGroup &&
            configuredForAssignment(state, repeatedAssignment, person.id) &&
            !primaryRole.assignments.every((assignment) =>
              configuredForAssignment(state, assignment, person.id)
            )
              ? "候选人不具备机动督导或兼任柜台的完整资质"
              : null,
          maxParticipants: 5,
          validateChanges: (proposed) => {
            const incoming = new Map(
              proposed.map((change) => [change.assignmentId, change.staffId])
            );
            for (const role of availableRoles.filter(
              (item) => item.mobileSupervisorGroup
            )) {
              const staffIds = new Set(
                role.assignments.map(
                  (assignment) =>
                    incoming.get(assignment.id) ?? assignment.staffId!
                )
              );
              if (staffIds.size !== 1)
                return ["机动督导与兼任柜台必须保持同一人员"];
              const staffId = [...staffIds][0]!;
              if (
                !role.assignments.every((assignment) =>
                  configuredForAssignment(state, assignment, staffId)
                )
              )
                return ["候选人不具备机动督导或兼任柜台的完整资质"];
            }
            return [];
          },
        });
        changes = result.changes;
        attemptedReasons = result.attemptedReasons;
        candidateRejections = result.candidateRejections;
        searchTimedOut = result.termination !== "infeasible";
      }
      if (changes) {
        applyRotationPlan(
          state,
          assignments,
          primaryRole,
          repeatedAssignment,
          changes,
          groupIds,
          review
        );
        changes.forEach((change) => {
          const role = roleByAssignmentId.get(change.assignmentId);
          role?.assignments.forEach((assignment) =>
            reviewedAssignmentIds.add(assignment.id)
          );
        });
        continue;
      }
      if (review === "frequency") {
        attemptedReasonsByAssignment.set(
          repeatedAssignment.id,
          attemptedReasons
        );
        primaryRole.assignments.forEach((a) => reviewedAssignmentIds.add(a.id));
        continue;
      }
      const originalMessage = unresolvedMessage(
        primaryRole,
        repeatedAssignment,
        runs,
        attemptedReasons
      );
      const message =
        candidateRejections && !primaryRole.mobileSupervisorGroup
          ? rotationCandidateWarningMessage({
              staffName: repeatedAssignment.staffName,
              fact: `已连续${runs}次承担${repeatedAssignment.flightNo}/${repeatedAssignment.position}`,
              targetFlightNo: repeatedAssignment.flightNo,
              candidates: rotationWarningCandidates(
                state,
                repeatedAssignment,
                date,
                candidateRejections,
                facts
              ),
              timedOut: searchTimedOut,
            })
          : originalMessage;
      primaryRole.assignments.forEach((assignment) => {
        replaceAssignmentDecisions(assignment, "position-rotation", [
          schedulingDecision("position-rotation", "fallback", message),
        ]);
        reviewedAssignmentIds.add(assignment.id);
      });
      warnings.push(message);
    }
  }

  return {
    warnings,
    reviewedAssignmentIds: [...reviewedAssignmentIds],
    attemptedReasonsByAssignment,
  };
}
