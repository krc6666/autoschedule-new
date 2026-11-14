import type {
  LexicographicObjective,
  LinearConstraint,
  SolverProblem,
} from "./solver-port";

export interface ReassignmentChoice {
  id: string;
  assignmentId: string;
  staffId: string;
  keepsCurrentStaff: boolean;
  preferenceRank: number;
  workHours: number;
}

export interface IncompatibleReassignmentChoices {
  leftChoiceId: string;
  rightChoiceId: string;
}

export interface ReassignmentStaffCapacity {
  staffId: string;
  fixedWorkHours: number;
  maximumWorkHours: number;
}

export interface ReassignmentChoiceRequirement {
  id: string;
  choiceIds: readonly string[];
  minimum: number;
}

export interface ReassignmentModelInput {
  choices: readonly ReassignmentChoice[];
  assignmentIds: readonly string[];
  incompatibilities: readonly IncompatibleReassignmentChoices[];
  capacities: readonly ReassignmentStaffCapacity[];
  choiceRequirements?: readonly ReassignmentChoiceRequirement[];
  coupledAssignmentGroups?: readonly (readonly string[])[];
  excludedSelections: readonly ReadonlySet<string>[];
  leadingObjectives?: readonly LexicographicObjective[];
  timeoutMs: number;
  staffAssignmentCounts?: readonly { staffId: string; count: number }[];
}

function assignmentConstraints(
  input: ReassignmentModelInput
): LinearConstraint[] {
  return input.assignmentIds.map((assignmentId, index) => ({
    id: `assignment:${index}`,
    terms: input.choices
      .filter((choice) => choice.assignmentId === assignmentId)
      .map((choice) => ({ variableId: choice.id, coefficient: 1 })),
    lowerBound: 1,
    upperBound: 1,
  }));
}

function incompatibilityConstraints(
  input: ReassignmentModelInput
): LinearConstraint[] {
  return input.incompatibilities.map((pair, index) => ({
    id: `incompatible:${index}`,
    terms: [pair.leftChoiceId, pair.rightChoiceId].map((variableId) => ({
      variableId,
      coefficient: 1,
    })),
    upperBound: 1,
  }));
}

function capacityConstraints(
  input: ReassignmentModelInput
): LinearConstraint[] {
  return input.capacities.map((capacity, index) => ({
    id: `capacity:${index}`,
    terms: input.choices
      .filter((choice) => choice.staffId === capacity.staffId)
      .map((choice) => ({
        variableId: choice.id,
        coefficient: choice.workHours,
      })),
    upperBound: capacity.maximumWorkHours - capacity.fixedWorkHours,
  }));
}

function exclusionConstraints(
  input: ReassignmentModelInput
): LinearConstraint[] {
  return input.excludedSelections.map((selection, index) => ({
    id: `excluded:${index}`,
    terms: [...selection].map((variableId) => ({
      variableId,
      coefficient: 1,
    })),
    upperBound: selection.size - 1,
  }));
}

function choiceRequirementConstraints(
  input: ReassignmentModelInput
): LinearConstraint[] {
  return (input.choiceRequirements ?? []).map((requirement) => ({
    id: `required:${requirement.id}`,
    terms: requirement.choiceIds.map((variableId) => ({
      variableId,
      coefficient: 1,
    })),
    lowerBound: requirement.minimum,
  }));
}

function coupledAssignmentConstraints(
  input: ReassignmentModelInput
): LinearConstraint[] {
  const constraints: LinearConstraint[] = [];
  for (const [groupIndex, group] of (
    input.coupledAssignmentGroups ?? []
  ).entries()) {
    for (
      let assignmentIndex = 1;
      assignmentIndex < group.length;
      assignmentIndex += 1
    ) {
      const leftAssignmentId = group[assignmentIndex - 1]!;
      const rightAssignmentId = group[assignmentIndex]!;
      const staffIds = new Set(
        input.choices
          .filter(
            (choice) =>
              choice.assignmentId === leftAssignmentId ||
              choice.assignmentId === rightAssignmentId
          )
          .map((choice) => choice.staffId)
      );
      for (const staffId of staffIds) {
        const terms = input.choices.flatMap((choice) => {
          if (choice.staffId !== staffId) return [];
          if (choice.assignmentId === leftAssignmentId)
            return [{ variableId: choice.id, coefficient: 1 }];
          if (choice.assignmentId === rightAssignmentId)
            return [{ variableId: choice.id, coefficient: -1 }];
          return [];
        });
        constraints.push({
          id: `coupled:${groupIndex}:${assignmentIndex}:${staffId}`,
          terms,
          lowerBound: 0,
          upperBound: 0,
        });
      }
    }
  }
  return constraints;
}

export function buildReassignmentProblem(
  input: ReassignmentModelInput
): SolverProblem {
  const builtInObjectives: [
    LexicographicObjective,
    ...LexicographicObjective[],
  ] = [
    {
      id: "changed-assignment-count",
      direction: "minimize",
      terms: input.choices.map((choice) => ({
        variableId: choice.id,
        coefficient: choice.keepsCurrentStaff ? 0 : 1,
      })),
    },
    {
      id: "candidate-preference",
      direction: "minimize",
      terms: input.choices.map((choice) => ({
        variableId: choice.id,
        coefficient: choice.preferenceRank,
      })),
    },
    {
      id: "stable-choice-order",
      direction: "minimize",
      terms: input.choices.map((choice, index) => ({
        variableId: choice.id,
        coefficient: index,
      })),
    },
  ];
  const objectives: [LexicographicObjective, ...LexicographicObjective[]] =
    input.leadingObjectives?.length
      ? [
          input.leadingObjectives[0]!,
          ...input.leadingObjectives.slice(1),
          ...builtInObjectives,
        ]
      : builtInObjectives;
  return {
    variables: input.choices.map((choice) => ({ id: choice.id })),
    constraints: [
      ...assignmentConstraints(input),
      ...(input.staffAssignmentCounts ?? []).map(
        ({ staffId, count }, index) => ({
          id: `staff-assignment-count:${index}`,
          terms: input.choices
            .filter((c) => c.staffId === staffId)
            .map((c) => ({ variableId: c.id, coefficient: 1 })),
          lowerBound: count,
          upperBound: count,
        })
      ),
      ...incompatibilityConstraints(input),
      ...capacityConstraints(input),
      ...choiceRequirementConstraints(input),
      ...coupledAssignmentConstraints(input),
      ...exclusionConstraints(input),
    ],
    objectives,
    timeoutMs: input.timeoutMs,
  };
}
