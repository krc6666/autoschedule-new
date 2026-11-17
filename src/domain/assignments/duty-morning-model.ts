import type { ScheduleSettings } from "../../model";
import type {
  DecisionVariable,
  LinearConstraint,
  LexicographicObjective,
} from "../solver/solver-port";
import { isDutyMorningFlight } from "./duty-assignment";
import { timeToMinutes } from "../shared/time";

/** Select one worked start time, without rewarding additional duty assignments. */
export function buildDutyMorningModel(
  state: { settings: ScheduleSettings },
  choices: readonly { id: string; startTime: string; workHours: number }[]
): {
  variables: DecisionVariable[];
  constraints: LinearConstraint[];
  objectives: LexicographicObjective[];
} {
  const morning = choices.filter(
    (choice) => choice.workHours > 0 && isDutyMorningFlight(choice, state)
  );
  if (!morning.length)
    return { variables: [], constraints: [], objectives: [] };
  const worked = "duty:morning-worked";
  const starts = [
    ...new Set(morning.map((choice) => timeToMinutes(choice.startTime))),
  ].sort((a, b) => a - b);
  const selected = starts.map((start) => ({
    start,
    id: `duty:morning-start:${start}`,
  }));
  return {
    variables: [worked, ...selected.map((slot) => slot.id)].map((id) => ({
      id,
      type: "binary",
    })),
    constraints: [
      {
        id: "duty:one-morning-start",
        terms: [
          { variableId: worked, coefficient: -1 },
          ...selected.map((slot) => ({ variableId: slot.id, coefficient: 1 })),
        ],
        lowerBound: 0,
        upperBound: 0,
      },
      ...selected.map((slot) => ({
        id: `${slot.id}:worked`,
        terms: [
          { variableId: slot.id, coefficient: 1 },
          ...morning
            .filter((choice) => timeToMinutes(choice.startTime) === slot.start)
            .map((choice) => ({ variableId: choice.id, coefficient: -1 })),
        ],
        upperBound: 0,
      })),
    ],
    objectives: [
      {
        id: "duty:morning",
        direction: "maximize",
        terms: [{ variableId: worked, coefficient: 1 }],
      },
      {
        id: "duty:preferred-morning",
        direction: "minimize",
        terms: selected.map((slot) => ({
          variableId: slot.id,
          coefficient: slot.start,
        })),
      },
    ],
  };
}
