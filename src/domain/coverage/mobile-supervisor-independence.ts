import type { Assignment } from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import type { ScheduleRunFacts } from "../shared/schedule-run-facts";
import type { SolverPort } from "../solver/solver-port";
import type { RotationStaffChange } from "../reviews/rotation-review-safety";
import { optimizeReassignment } from "../solver/reassignment-optimizer";
import { assignmentRule } from "../flights/schedule-position-rules";
import { durationHours, intervalsOverlap } from "../shared/time";
import {
  isAutomaticRegularStaff,
  isDisplayOnlyGuideReuse,
} from "../candidates/assignment-eligibility-facts";
import { isAutomaticRegularAssignment } from "./automatic-regular-coverage";
import { clearSupervisorFillLink } from "./supervisor-fill-facts";
import {
  clearAutomaticAssignmentEvidence,
  replaceAssignmentDecisions,
} from "../assignments/assignment-evidence";
import { schedulingDecision } from "../rules/schedule-rule-contract";
import { refreshReusableGuides } from "./schedule-coverage";

interface IndependenceOptions {
  solver: SolverPort;
  state: ScheduleGenerationFacts;
  assignments: Assignment[];
  source: Assignment;
  date: string;
  facts: ScheduleRunFacts;
  lockedAssignmentIds: ReadonlySet<string>;
  validateAssignments(rows: Assignment[]): boolean;
  timeoutMs?: number;
  includeOverlappingFlights?: boolean;
  directOnly?: boolean;
}

/** One complete model for both freeing an occupied supervisor initially and
 * splitting a recorded counter link later. Existing supervisors stay fixed. */
export async function arrangeIndependentMobileSupervisor({
  solver,
  state,
  assignments,
  source,
  date,
  facts,
  lockedAssignmentIds,
  validateAssignments,
  timeoutMs = 4_000,
  includeOverlappingFlights = true,
  directOnly = false,
}: IndependenceOptions): Promise<boolean> {
  const automatic = (row: Assignment) =>
    row.status !== "manual" &&
    !row.countBaseline &&
    !lockedAssignmentIds.has(row.id) &&
    !assignmentRule(state, row)?.manual;
  if (
    !automatic(source) ||
    assignmentRule(state, source)?.category !== "机动督导"
  )
    return false;
  const targets = assignments.filter(
    (row) => row.supervisorSourceAssignmentId === source.id
  );
  if (
    source.staffId &&
    (!targets.length ||
      targets.some(
        (row) => !automatic(row) || !isAutomaticRegularAssignment(state, row)
      ))
  )
    return false;
  const targetIds = new Set(targets.map((row) => row.id));
  const working = structuredClone(assignments);
  for (const row of working) {
    if (!targetIds.has(row.id)) continue;
    clearSupervisorFillLink(row);
    row.workHours = durationHours(row.startTime, row.endTime);
    row.fatiguePoints = assignmentRule(state, row)!.fatiguePoints;
  }
  const primary = working.find(
    (row) => row.id === (source.staffId ? targets[0]!.id : source.id)
  )!;
  const movable = working.filter(
    (row) =>
      automatic(row) &&
      row.status === "assigned" &&
      row.staffId &&
      !row.supervisorSourceAssignmentId &&
      !row.teamLeaderGapFill &&
      isAutomaticRegularAssignment(state, row) &&
      (!directOnly || targetIds.has(row.id)) &&
      (row.flightId === source.flightId ||
        (includeOverlappingFlights &&
          intervalsOverlap(
            row.startTime,
            row.endTime,
            source.startTime,
            source.endTime
          )))
  );
  const proposal = (changes: readonly RotationStaffChange[]) => {
    const planned = structuredClone(assignments);
    const changedFlights = new Set<string>();
    for (const change of changes) {
      const row = planned.find((a) => a.id === change.assignmentId)!;
      const person = state.staff.find((p) => p.id === change.staffId)!;
      clearAutomaticAssignmentEvidence(row);
      clearSupervisorFillLink(row);
      Object.assign(row, {
        staffId: person.id,
        staffName: person.name,
        status: "assigned",
        workHours: durationHours(row.startTime, row.endTime),
        fatiguePoints: assignmentRule(state, row)!.fatiguePoints,
      });
      changedFlights.add(row.flightId);
    }
    refreshReusableGuides(state, planned, changedFlights);
    return planned;
  };
  const valid = (changes: readonly RotationStaffChange[]) => {
    const planned = proposal(changes);
    return (
      !planned.some((row) => row.supervisorSourceAssignmentId === source.id) &&
      assignments.every(
        (before) =>
          before.status !== "assigned" ||
          planned.some(
            (after) =>
              after.id === before.id &&
              after.status === "assigned" &&
              after.staffId
          )
      ) &&
      planned.some(
        (row) =>
          row.id === source.id &&
          row.status === "assigned" &&
          row.staffId &&
          (!source.staffId || row.staffId === source.staffId)
      ) &&
      validateAssignments(planned)
    );
  };
  const result = await optimizeReassignment({
    solver,
    state,
    assignments: working.filter(
      (row) => !isDisplayOnlyGuideReuse(state, working, row)
    ),
    primary,
    movableAssignments: movable,
    date,
    facts,
    intent: { kind: "mobile-supervisor-counter-coverage" },
    candidateAllowed: (_row, person) => isAutomaticRegularStaff(person),
    primaryCandidateAllowed: () => true,
    validateChanges: (changes) =>
      valid(changes) ? [] : ["独立督导方案未通过完整岗位或最终安全检查"],
    maxParticipants: 5,
    timeoutMs,
    acceptTimeLimitedFeasible: true,
  });
  if (!result.changes || !valid(result.changes)) return false;
  const planned = proposal(result.changes);
  const supervisor = planned.find((row) => row.id === source.id)!;
  const message = `${supervisor.staffName}独立担任${source.flightNo}/${source.position}，普通人员经完整安全安排接替柜台，无新增空岗。`;
  replaceAssignmentDecisions(supervisor, "mobile-supervisor", [
    schedulingDecision("mobile-supervisor", "selected", message),
  ]);
  replaceAssignmentDecisions(supervisor, "ke166-supervisor", []);
  for (const change of result.changes) {
    const row = planned.find((a) => a.id === change.assignmentId)!;
    if (row.id !== source.id)
      row.decisionTrace = [
        schedulingDecision("mobile-supervisor", "selected", message),
      ];
  }
  assignments.splice(0, assignments.length, ...planned);
  return true;
}

export async function restoreIndependentMobileSupervisors(
  options: Omit<
    IndependenceOptions,
    "source" | "timeoutMs" | "directOnly" | "includeOverlappingFlights"
  >
): Promise<void> {
  const deadline = Date.now() + 4_000;
  const sourceIds = [
    ...new Set(
      options.assignments
        .map((row) => row.supervisorSourceAssignmentId)
        .filter((id): id is string => Boolean(id))
    ),
  ];
  // Complete direct replacements for every flight before a longer chain can
  // consume the only spare needed by another flight's direct replacement.
  for (const directOnly of [true, false]) {
    for (const id of sourceIds) {
      if (Date.now() >= deadline) return;
      const source = options.assignments.find((row) => row.id === id);
      if (source?.status !== "assigned") continue;
      await arrangeIndependentMobileSupervisor({
        ...options,
        source,
        directOnly,
        timeoutMs: Math.max(1, deadline - Date.now()),
      });
    }
  }
}
