import { expect, it } from "vitest";
import {
  dutyEarliestScenario,
  dutyEarliestAssignments,
  DUTY_EARLIEST_DATE as date,
} from "../helpers/duty-earliest-scenario";
import { createScheduleRunFacts } from "../../src/domain/shared/schedule-run-facts";
import { reassignmentChoiceRequirements } from "../../src/domain/solver/reassignment-choice-graph";
import type { ReassignmentOptimizationOptions } from "../../src/domain/solver/reassignment-contract";

it("requires the established earliest time even when a later morning assignment is fixed", () => {
  const state = dutyEarliestScenario();
  const assignments = dutyEarliestAssignments(state);
  // Move the later flight to 10:30 to keep both morning assignments legal.
  state.flights[1]!.startTime = "10:30";
  assignments[1]!.startTime = "10:30";
  assignments[1]!.staffId = "p0";
  const options: ReassignmentOptimizationOptions = {
    state,
    date,
    assignments,
    primary: assignments[0]!,
    movableAssignments: [assignments[0]!],
    facts: createScheduleRunFacts(state, date),
    intent: { kind: "consecutive-rotation-review" },
    primaryCandidateAllowed: () => true,
    solver: {
      solve: async () => {
        throw new Error("unused");
      },
    },
  };
  const choices = assignments.slice(0, 2).map((assignment, index) => ({
    assignment,
    person: state.staff[0]!,
    choice: {
      id: `choice-${index}`,
      assignmentId: assignment.id,
      staffId: "p0",
      keepsCurrentStaff: true,
      preferenceRank: 0,
      workHours: 1,
    },
  }));
  const requirements = reassignmentChoiceRequirements(
    options,
    choices,
    [assignments[0]!],
    [assignments[1]!, assignments[2]!]
  );
  expect(
    requirements.find((item) => item.id === "duty-morning:p0")?.choiceIds
  ).toEqual(["choice-0"]);
  // No original morning baseline must not invent a mandatory duty assignment.
  options.assignments = [assignments[2]!];
  expect(
    reassignmentChoiceRequirements(
      options,
      choices,
      [assignments[0]!],
      [assignments[2]!]
    ).some((item) => item.id === "duty-morning:p0")
  ).toBe(false);
});
