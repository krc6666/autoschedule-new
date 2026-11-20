import type { Flight, PositionRule } from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import type {
  AssignmentEligibilityDiagnostic,
  AutomaticAssignmentEligibilityOptions,
} from "../candidates/assignment-eligibility";
import {
  preferredDutyLateTasks,
  preferredDutyMorningTask,
} from "../assignments/duty-assignment";
import { activeFlightRules } from "../flights/schedule-position-rules";
import {
  createScheduleRunFacts,
  type ScheduleRunFacts,
} from "../shared/schedule-run-facts";
import {
  shouldAutoAssign,
  type AssignmentTask,
} from "../flights/schedule-tasks";
import type { ScheduleRunPreferences } from "../shared/schedule-run-preferences";
import { restrictHalfRestToEligiblePeriodCandidates } from "../rules/half-rest";

export interface SchedulePreparation {
  flights: Flight[];
  displayRulesByFlight: Map<string, PositionRule[]>;
  tasks: AssignmentTask[];
  eligibleStaffIds: Map<string, Set<string>>;
  eligibleCounts: Map<string, number>;
  runFacts: ScheduleRunFacts;
  dutyStaffId: string | null;
  preferredDutyMorningTaskKey: string | null;
  preferredDutyLateTaskCandidates: AssignmentTask[];
}

export function prepareSchedule(
  state: ScheduleGenerationFacts,
  date: string,
  evaluateEligibility: (
    context: AutomaticAssignmentEligibilityOptions
  ) => AssignmentEligibilityDiagnostic,
  preferences?: ScheduleRunPreferences
): SchedulePreparation {
  const flights = [...state.flights].sort((left, right) =>
    left.startTime.localeCompare(right.startTime)
  );
  const displayRulesByFlight = new Map(
    flights.map((flight) => [flight.id, activeFlightRules(state, flight)])
  );
  const tasks = flights.flatMap((flight) =>
    (displayRulesByFlight.get(flight.id) ?? [])
      .filter((rule) =>
        shouldAutoAssign(
          flight,
          rule,
          state.settings.adminSupportEnabled,
          state
        )
      )
      .map((rule) => ({ key: `${flight.id}:${rule.id}`, flight, rule }))
  );
  const eligibleStaffIds = new Map(
    tasks.map((task) => [
      task.key,
      new Set(
        state.staff
          .filter(
            (person) =>
              evaluateEligibility({
                state,
                assignments: [],
                flight: task.flight,
                rule: task.rule,
                person,
              }).eligible
          )
          .map((person) => person.id)
      ),
    ])
  );
  const eligibleCounts = new Map(
    tasks.map((task) => [task.key, eligibleStaffIds.get(task.key)?.size ?? 0])
  );
  const runFacts = createScheduleRunFacts(state, date, preferences);
  runFacts.halfRest = restrictHalfRestToEligiblePeriodCandidates(
    runFacts.halfRest
  );
  const dutyStaffId = runFacts.currentDutyStaffId;
  const preferredDutyMorningTaskKey =
    preferredDutyMorningTask(state, date, tasks, dutyStaffId)?.key ?? null;
  const preferredDutyLateTaskCandidates = preferredDutyLateTasks(
    state,
    date,
    tasks,
    dutyStaffId,
    runFacts.scheduleFrequency
  ).filter((task) => task.key !== preferredDutyMorningTaskKey);
  return {
    flights,
    displayRulesByFlight,
    tasks,
    eligibleStaffIds,
    eligibleCounts,
    runFacts,
    dutyStaffId,
    preferredDutyMorningTaskKey,
    preferredDutyLateTaskCandidates,
  };
}
