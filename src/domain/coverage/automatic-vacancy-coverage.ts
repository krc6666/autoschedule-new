import type { Assignment } from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import type { ScheduleRunFacts } from "../shared/schedule-run-facts";
import type { SolverPort } from "../solver/solver-port";
import type { RotationStaffChange } from "../reviews/rotation-review-safety";
import { optimizeReassignment } from "../solver/reassignment-optimizer";
import { assignmentRule } from "../flights/schedule-position-rules";
import { isPreNoonFlight } from "../flights/schedule-tasks";
import { intervalsOverlap, durationHours } from "../shared/time";
import {
  isAutomaticRegularStaff,
  isDisplayOnlyGuideReuse,
} from "../candidates/assignment-eligibility-facts";
import { configuredFillTargets } from "../assignments/supervisor-fill";
import { clearAutomaticAssignmentEvidence } from "../assignments/assignment-evidence";
import { schedulingDecision } from "../rules/schedule-rule-contract";
import {
  crossFlightPriorityDisplacedFlights,
  crossFlightPriorityPolicyMatches,
  enabledCrossFlightPriorityPolicies,
} from "../rules/cross-flight-priority";
import { refreshReusableGuides } from "./schedule-coverage";
import {
  isAutomaticRegularAssignment,
  improvesAutomaticRegularCoverage,
} from "./automatic-regular-coverage";
import {
  clearSupervisorFillLink,
  evaluateSupervisorFillFacts,
  setSupervisorFillLink,
} from "./supervisor-fill-facts";

interface SupervisorFillPair {
  source: Assignment;
  target: Assignment;
}

/** Finish real vacancies after mobile supervisors are known. Every search is a
 * complete assignment model; an unsuccessful proposal never mutates the rows. */
export async function fillAutomaticVacancies(
  solver: SolverPort,
  state: ScheduleGenerationFacts,
  assignments: Assignment[],
  date: string,
  lockedAssignmentIds: ReadonlySet<string>,
  facts: ScheduleRunFacts,
  validateAssignments: (rows: Assignment[]) => boolean
): Promise<void> {
  const vacancies = assignments
    .filter(
      (row) =>
        row.status === "unfilled" &&
        !lockedAssignmentIds.has(row.id) &&
        isAutomaticRegularAssignment(state, row)
    )
    .sort((a, b) => Number(isPreNoonFlight(b)) - Number(isPreNoonFlight(a)));
  if (!vacancies.length) return;
  // Bound the whole repair pass, including failed alternatives, not each branch.
  const deadline = Date.now() + 4_000;
  for (const vacancy of vacancies) {
    if (Date.now() >= deadline) break;
    const movable = assignments.filter(
      (row) =>
        row.status === "assigned" &&
        row.staffId &&
        !lockedAssignmentIds.has(row.id) &&
        !row.supervisorSourceAssignmentId &&
        !row.teamLeaderGapFill &&
        isAutomaticRegularAssignment(state, row) &&
        (!isPreNoonFlight(vacancy) || isPreNoonFlight(row)) &&
        (row.flightId === vacancy.flightId ||
          intervalsOverlap(
            row.startTime,
            row.endTime,
            vacancy.startTime,
            vacancy.endTime
          ))
    );
    const pairs: SupervisorFillPair[] = [];
    for (const source of assignments) {
      const rule = assignmentRule(state, source);
      const flight = state.flights.find((f) => f.id === source.flightId);
      if (
        !rule ||
        !flight ||
        rule.category !== "机动督导" ||
        rule.manual ||
        source.status !== "assigned" ||
        !source.staffId ||
        !state.staff.some(
          (person) =>
            person.id === source.staffId && isAutomaticRegularStaff(person)
        ) ||
        (isPreNoonFlight(vacancy) && !isPreNoonFlight(source)) ||
        !intervalsOverlap(
          source.startTime,
          source.endTime,
          vacancy.startTime,
          vacancy.endTime
        )
      )
        continue;
      for (const target of configuredFillTargets(
        state,
        assignments,
        flight,
        rule,
        "automatic"
      )) {
        if (
          movable.some((row) => row.id === target.id) &&
          target.staffId !== source.staffId
        )
          pairs.push({ source, target });
      }
    }
    for (const pair of [undefined, ...pairs]) {
      if (Date.now() >= deadline) break;
      const pairIds = new Set(pair ? [pair.source.id, pair.target.id] : []);
      const optimizationState = pair
        ? {
            ...state,
            positionRules: state.positionRules.map((rule) =>
              rule.id === pair.target.positionRuleId
                ? { ...rule, qualifiedStaffIds: [pair.source.staffId!] }
                : rule
            ),
          }
        : state;
      const working = assignments.filter(
        (row) => !isDisplayOnlyGuideReuse(state, assignments, row)
      );
      const proposal = (
        changes: readonly RotationStaffChange[]
      ): Assignment[] => {
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
            workHours:
              pair?.target.id === row.id
                ? 0
                : durationHours(row.startTime, row.endTime),
            fatiguePoints:
              pair?.target.id === row.id
                ? 0
                : assignmentRule(state, row)!.fatiguePoints,
          });
          changedFlights.add(row.flightId);
        }
        if (pair) {
          const source = planned.find((row) => row.id === pair.source.id)!;
          const target = planned.find((row) => row.id === pair.target.id)!;
          const fill = evaluateSupervisorFillFacts(
            state,
            planned,
            source,
            target,
            "automatic"
          );
          if (fill.allowed)
            setSupervisorFillLink(target, source.id, fill.rule?.id);
        }
        refreshReusableGuides(state, planned, changedFlights);
        return planned;
      };
      const valid = (changes: readonly RotationStaffChange[]): boolean => {
        const planned = proposal(changes);
        return (
          improvesAutomaticRegularCoverage(state, assignments, planned) &&
          (!pair ||
            planned.find((row) => row.id === pair.target.id)
              ?.supervisorSourceAssignmentId === pair.source.id) &&
          validateAssignments(planned)
        );
      };
      const result = await optimizeReassignment({
        solver,
        state: optimizationState,
        assignments: working,
        primary: vacancy,
        movableAssignments: [...movable, ...(pair ? [pair.source] : [])],
        date,
        facts,
        intent: { kind: "automatic-vacancy-coverage" },
        leadingObjectives: enabledCrossFlightPriorityPolicies(state).map(
          (policy) => ({
            id: `coverage-priority:${policy.id}`,
            direction: "maximize",
            coefficient: ({ assignment, person }) =>
              pair?.target.id === assignment.id
                ? 0
                : Number(
                    crossFlightPriorityPolicyMatches(policy, {
                      flightNo: assignment.flightNo,
                      staffId: person.id,
                    })
                  ),
          })
        ),
        primaryCandidateAllowed: () => true,
        candidateAllowed: (row, person) =>
          isAutomaticRegularStaff(person) &&
          (pair && pairIds.has(row.id)
            ? person.id === pair.source.staffId
            : true),
        permittedConcurrentAssignmentIds: pairIds,
        coupledAssignmentGroups: pair ? [[pair.source.id, pair.target.id]] : [],
        choiceWorkHours: (row) =>
          pair?.target.id === row.id ? 0 : row.workHours,
        normalizeChanges: (changes) =>
          changes.map((change) => ({
            ...change,
            status: "assigned",
            ...(pair?.target.id === change.assignmentId
              ? { workHours: 0 }
              : {}),
          })),
        validateChanges: (changes) =>
          valid(changes)
            ? []
            : ["补空方案未通过完整岗位、补位关联或最终安全检查"],
        maxParticipants: 5,
        timeoutMs: Math.max(1, deadline - Date.now()),
        acceptTimeLimitedFeasible: true,
      });
      if (!result.changes || !valid(result.changes)) continue;
      const planned = proposal(result.changes);
      const yielded =
        crossFlightPriorityDisplacedFlights(state, assignments, planned)
          .length > 0;
      const route = result.changes
        .map((change) => {
          const row = planned.find((a) => a.id === change.assignmentId)!;
          return `${row.staffName}接${row.flightNo}/${row.position}`;
        })
        .join(" → ");
      const message = `为补齐${vacancy.flightNo}/${vacancy.position}，已安全换人：${route}；原已覆盖岗位保持完整${yielded ? "，跨航班人员优先为本次补空让步" : ""}。`;
      for (const change of result.changes)
        planned.find((row) => row.id === change.assignmentId)!.decisionTrace = [
          schedulingDecision("position-compaction", "selected", message),
        ];
      assignments.splice(0, assignments.length, ...planned);
      break;
    }
  }
}
