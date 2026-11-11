import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import type { AssignmentTask } from "../flights/schedule-tasks";
import type {
  LinearConstraint,
  LexicographicObjective,
  DecisionVariable,
} from "../solver/solver-port";
import {
  dailyFlightCountParticipantIds,
  groupStaffFlightsByNormalizedNumber,
} from "../statistics/staff-flight-count";
import type { SchedulePreparation } from "./schedule-preparation";
import { isPreNoonFlight } from "../flights/schedule-tasks";

export function buildDutyFlightCountModel(
  state: ScheduleGenerationFacts,
  preparation: SchedulePreparation,
  choices: readonly {
    readonly id: string;
    readonly person: { readonly id: string };
    readonly task: AssignmentTask;
  }[]
): {
  variables: DecisionVariable[];
  constraints: LinearConstraint[];
  objectives: LexicographicObjective[];
} {
  const variables: DecisionVariable[] = [],
    constraints: LinearConstraint[] = [];
  const dutyStaffId = preparation.dutyStaffId;
  if (!dutyStaffId || !choices.some((c) => c.person.id === dutyStaffId))
    return { variables, constraints, objectives: [] };
  const participants = dailyFlightCountParticipantIds(state, {
    dutyStaffId,
    halfRestStaffIds: preparation.runFacts.halfRest.activeStaffIds,
    candidateStaffIds: new Set(choices.map((c) => c.person.id)),
  });
  if (!participants.size) return { variables, constraints, objectives: [] };
  const grouped = groupStaffFlightsByNormalizedNumber(
    choices
      .filter(
        (c) => c.person.id === dutyStaffId || participants.has(c.person.id)
      )
      .map((choice) => ({
        staffId: choice.person.id,
        flightNo: choice.task.flight.flightNo,
        choice,
      }))
  );
  const counts = new Map<string, string[]>();
  for (const [staffId, flights] of grouped) {
    const ids: string[] = [];
    for (const entries of flights.values()) {
      const id = `duty-count:flight:${variables.length}`;
      variables.push({ id, type: "binary" });
      ids.push(id);
      constraints.push(
        {
          id: `${id}:used`,
          terms: [
            { variableId: id, coefficient: 1 },
            ...entries.map((e) => ({
              variableId: e.choice.id,
              coefficient: -1,
            })),
          ],
          upperBound: 0,
        },
        {
          id: `${id}:choice`,
          terms: [
            { variableId: id, coefficient: -entries.length },
            ...entries.map((e) => ({
              variableId: e.choice.id,
              coefficient: 1,
            })),
          ],
          upperBound: 0,
        }
      );
    }
    counts.set(staffId, ids);
  }
  const deficit = "duty-count:shortfall";
  variables.push({
    id: deficit,
    type: "continuous",
    lowerBound: 0,
    upperBound: state.flights.length,
  });
  for (const peer of participants)
    constraints.push({
      id: `duty-count:peer:${peer}`,
      terms: [
        ...(counts.get(peer) ?? []).map((variableId) => ({
          variableId,
          coefficient: 1,
        })),
        ...(counts.get(dutyStaffId) ?? []).map((variableId) => ({
          variableId,
          coefficient: -1,
        })),
        { variableId: deficit, coefficient: -1 },
      ],
      upperBound: 1,
    });
  // Freeze the minimum extra morning work required by higher-priority coverage.
  // Catch-up may then add afternoon work, not create extra morning work to count.
  const morningKey = preparation.preferredDutyMorningTaskKey;
  return {
    variables,
    constraints,
    objectives: [
      {
        id: "duty-position:avoid-extra-morning",
        direction: "minimize",
        terms: choices
          .filter(
            (c) =>
              c.person.id === dutyStaffId &&
              isPreNoonFlight(c.task.flight) &&
              c.task.key !== morningKey
          )
          .map((c) => ({ variableId: c.id, coefficient: 1 })),
      },
      {
        id: "duty-position:flight-count-shortfall",
        direction: "minimize",
        terms: [{ variableId: deficit, coefficient: 1 }],
      },
    ],
  };
}
