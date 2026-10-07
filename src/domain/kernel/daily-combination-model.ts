import type { Assignment, Staff } from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import { createAssignedPosition } from "../assignments/assignment-factory";
import { canReleaseForFlight } from "../assignments/assignment-timing";
import { minimumFlightTransitionViolationBetweenTasks } from "../assignments/minimum-flight-transition";
import { tasksRequireDiversionRelease } from "../assignments/diversion-release-usage";
import type { CandidatePriority } from "../candidates/candidate-priority";
import { isConcurrentSupervisor } from "../coverage/team-leader-concurrent-plan";
import {
  isPreNoonFlight,
  type AssignmentTask,
} from "../flights/schedule-tasks";
import {
  LATE_PRIORITY_ALLOWED_DIFFERENCE,
  LATE_PRIORITY_FREQUENCY_ORDER,
} from "../reviews/late-priority-policy";
import {
  hasHighLoadTransition,
  isHighLoadPosition,
  normalizedPolicyValue,
  rollingLoadCost,
  violatedPositionTransitionPolicies,
} from "../reviews/schedule-protection";
import type {
  LexicographicObjective,
  LinearConstraint,
  SolverProblem,
} from "../solver/solver-port";
import { intervalsOverlap } from "../shared/time";
import {
  isSameAirlinePriorityPosition,
  sameAirlinePriorityConflict,
} from "../rules/airline-rotation";
import { sameFlightStaffExclusionApplies } from "../rules/same-flight-staff-exclusion";
import { isDailyPrimaryPosition } from "../rules/daily-primary-position";

export interface DailyCombinationChoice {
  id: string;
  task: AssignmentTask;
  person: Staff;
  priority: Pick<CandidatePriority, "dutyPosition" | "latePriorityFrequency">;
  workHours: number;
}

export interface DailyCombinationModel {
  variables: Array<SolverProblem["variables"][number]>;
  incompatibilityConstraints: LinearConstraint[];
  constraints: LinearConstraint[];
  objectiveTerms: ReadonlyMap<
    string,
    { variableId: string; coefficient: number }[]
  >;
}

interface SoftCombinationGroup {
  objectiveId: string;
  targets: Map<string, DailyCombinationChoice>;
  sources: Map<string, DailyCombinationChoice>;
  coefficient: number;
}

interface EnabledCombinationGroup {
  group: SoftCombinationGroup;
  variableId: string;
}

const INDEPENDENT_CAPACITY_NODE_LIMIT = 10;

function maximumIndependentSetSize(
  adjacency: readonly ReadonlySet<number>[]
): number {
  let maximum = 0;
  const visit = (index: number, selected: number[]): void => {
    if (selected.length + adjacency.length - index <= maximum) return;
    if (index === adjacency.length) {
      maximum = Math.max(maximum, selected.length);
      return;
    }
    if (selected.every((other) => !adjacency[index]!.has(other))) {
      selected.push(index);
      visit(index + 1, selected);
      selected.pop();
    }
    visit(index + 1, selected);
  };
  visit(0, []);
  return maximum;
}

function highLoadIndependentCapacityConstraints(
  groups: readonly EnabledCombinationGroup[]
): LinearConstraint[] {
  const byStaffId = new Map<string, EnabledCombinationGroup[]>();
  for (const item of groups) {
    if (item.group.objectiveId !== "candidate:high-load-recovery") continue;
    const targetStaffIds = new Set(
      [...item.group.targets.values()].map((choice) => choice.person.id)
    );
    const targetFlightIds = new Set(
      [...item.group.targets.values()].map((choice) => choice.task.flight.id)
    );
    if (targetStaffIds.size !== 1 || targetFlightIds.size !== 1) continue;
    const staffId = [...targetStaffIds][0]!;
    const own = byStaffId.get(staffId) ?? [];
    own.push(item);
    byStaffId.set(staffId, own);
  }

  const constraints: LinearConstraint[] = [];
  for (const [staffId, ownGroups] of byStaffId) {
    if (
      ownGroups.length < 2 ||
      ownGroups.length > INDEPENDENT_CAPACITY_NODE_LIMIT
    )
      continue;
    const targetIds = ownGroups.map(
      ({ group }) => new Set(group.targets.keys())
    );
    const sourceIds = ownGroups.map(
      ({ group }) => new Set(group.sources.keys())
    );
    const adjacency = ownGroups.map(() => new Set<number>());
    for (let left = 0; left < ownGroups.length; left += 1) {
      for (let right = left + 1; right < ownGroups.length; right += 1) {
        const linked =
          [...targetIds[left]!].some((id) => sourceIds[right]!.has(id)) ||
          [...targetIds[right]!].some((id) => sourceIds[left]!.has(id));
        if (!linked) continue;
        adjacency[left]!.add(right);
        adjacency[right]!.add(left);
      }
    }
    const alpha = maximumIndependentSetSize(adjacency);
    if (alpha <= 0 || alpha === ownGroups.length) continue;
    constraints.push({
      id: `high-load-independent-capacity:${staffId}`,
      terms: [
        ...ownGroups.map(({ variableId }) => ({
          variableId,
          coefficient: 1,
        })),
        ...[...new Set(targetIds.flatMap((ids) => [...ids]))].map(
          (variableId) => ({ variableId, coefficient: -1 })
        ),
      ],
      lowerBound: -alpha,
    });
  }
  return constraints;
}

interface CombinationTaskPair {
  sourceTaskKey: string;
  strictPolicyIds: readonly string[];
  preferredPolicyIds: readonly string[];
  highLoadTransition: boolean;
  rollingExcess: number;
}

type ChoiceConflictKind = "overlap" | "minimum-transition";

function choiceAssignment(choice: DailyCombinationChoice): Assignment {
  return createAssignedPosition(
    choice.task,
    choice.person,
    choice.workHours,
    [],
    []
  );
}

function choiceConflictKind(
  state: ScheduleGenerationFacts,
  left: DailyCombinationChoice,
  right: DailyCombinationChoice
): ChoiceConflictKind | null {
  if (
    minimumFlightTransitionViolationBetweenTasks(
      state,
      left.task.flight,
      left.task.rule,
      right.task.flight,
      right.task.rule
    )
  )
    return "minimum-transition";
  if (
    !intervalsOverlap(
      left.task.flight.startTime,
      left.task.flight.endTime,
      right.task.flight.startTime,
      right.task.flight.endTime
    )
  )
    return null;
  if (
    isConcurrentSupervisor(left.task.rule, left.task.flight) &&
    isConcurrentSupervisor(right.task.rule, right.task.flight)
  )
    return "overlap";
  const leftAssignment = choiceAssignment(left);
  const rightAssignment = choiceAssignment(right);
  return canReleaseForFlight(leftAssignment, right.task.flight, state) ||
    canReleaseForFlight(rightAssignment, left.task.flight, state)
    ? null
    : "overlap";
}

function choicesCanShareStaff(
  state: ScheduleGenerationFacts,
  left: DailyCombinationChoice,
  right: DailyCombinationChoice
): boolean {
  return choiceConflictKind(state, left, right) === null;
}

function incompatibilityConstraints(
  state: ScheduleGenerationFacts,
  staffChoices: readonly DailyCombinationChoice[]
): LinearConstraint[] {
  const constraints: LinearConstraint[] = [];
  const choicesByStaffId = new Map<string, DailyCombinationChoice[]>();
  for (const choice of staffChoices) {
    const own = choicesByStaffId.get(choice.person.id) ?? [];
    own.push(choice);
    choicesByStaffId.set(choice.person.id, own);
  }
  for (const ownChoices of choicesByStaffId.values()) {
    const choicesByFlightId = new Map<string, DailyCombinationChoice[]>();
    for (const choice of ownChoices) {
      const flightChoices = choicesByFlightId.get(choice.task.flight.id) ?? [];
      flightChoices.push(choice);
      choicesByFlightId.set(choice.task.flight.id, flightChoices);
    }
    const flightChoiceGroups = [...choicesByFlightId.values()];
    for (const flightChoices of flightChoiceGroups) {
      if (flightChoices.length < 2) continue;
      constraints.push({
        id: `same-flight:${constraints.length}`,
        terms: flightChoices.map((choice) => ({
          variableId: choice.id,
          coefficient: 1,
        })),
        upperBound: 1,
      });
    }
    for (
      let leftGroupIndex = 0;
      leftGroupIndex < flightChoiceGroups.length;
      leftGroupIndex += 1
    ) {
      for (
        let rightGroupIndex = leftGroupIndex + 1;
        rightGroupIndex < flightChoiceGroups.length;
        rightGroupIndex += 1
      ) {
        const leftChoices = flightChoiceGroups[leftGroupIndex]!;
        const rightChoices = flightChoiceGroups[rightGroupIndex]!;
        const incompatiblePairs: Array<
          readonly [
            DailyCombinationChoice,
            DailyCombinationChoice,
            ChoiceConflictKind,
          ]
        > = [];
        for (const left of leftChoices) {
          for (const right of rightChoices) {
            const kind = choiceConflictKind(state, left, right);
            if (kind) incompatiblePairs.push([left, right, kind]);
          }
        }
        if (!incompatiblePairs.length) continue;
        if (
          incompatiblePairs.length ===
          leftChoices.length * rightChoices.length
        ) {
          const kinds = new Set(incompatiblePairs.map((pair) => pair[2]));
          const kind = kinds.size === 1 ? incompatiblePairs[0]![2] : "overlap";
          constraints.push({
            id: `${kind}:${constraints.length}`,
            terms: [...leftChoices, ...rightChoices].map((choice) => ({
              variableId: choice.id,
              coefficient: 1,
            })),
            upperBound: 1,
          });
          continue;
        }
        for (const [left, right, kind] of incompatiblePairs) {
          constraints.push({
            id: `${kind}:${constraints.length}`,
            terms: [left.id, right.id].map((variableId) => ({
              variableId,
              coefficient: 1,
            })),
            upperBound: 1,
          });
        }
      }
    }
  }
  return constraints;
}

function dailyPrimaryPositionConstraints(
  state: ScheduleGenerationFacts,
  staffChoices: readonly DailyCombinationChoice[]
): LinearConstraint[] {
  if (state.settings.dailyPrimaryPositionUniqueEnabled === false) return [];
  const byStaff = new Map<string, DailyCombinationChoice[]>();
  for (const choice of staffChoices) {
    if (!isDailyPrimaryPosition(state, choice.task.flight, choice.task.rule))
      continue;
    const own = byStaff.get(choice.person.id) ?? [];
    own.push(choice);
    byStaff.set(choice.person.id, own);
  }
  const constraints: LinearConstraint[] = [];
  for (const [staffId, choices] of byStaff) {
    for (let left = 0; left < choices.length; left += 1) {
      for (let right = left + 1; right < choices.length; right += 1) {
        const a = choices[left]!;
        const b = choices[right]!;
        if (a.task.flight.id === b.task.flight.id) continue;
        constraints.push({
          id: `daily-primary-position-unique:${staffId}:${a.id}:${b.id}`,
          terms: [a, b].map((choice) => ({
            variableId: choice.id,
            coefficient: 1,
          })),
          upperBound: 1,
        });
      }
    }
  }
  return constraints;
}

function sameAirlinePrioritySoftPenalty(
  staffChoices: readonly DailyCombinationChoice[],
  variables: Array<SolverProblem["variables"][number]>,
  constraints: LinearConstraint[],
  enabled: boolean,
  addObjectiveTerm: (
    objectiveId: string,
    variableId: string,
    coefficient: number
  ) => void
): void {
  if (!enabled) return;
  const choicesByStaffId = new Map<string, DailyCombinationChoice[]>();
  for (const choice of staffChoices) {
    if (!isSameAirlinePriorityPosition(choice.task.rule)) continue;
    const own = choicesByStaffId.get(choice.person.id) ?? [];
    own.push(choice);
    choicesByStaffId.set(choice.person.id, own);
  }

  for (const choices of choicesByStaffId.values()) {
    for (let leftIndex = 0; leftIndex < choices.length; leftIndex += 1) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < choices.length;
        rightIndex += 1
      ) {
        const left = choices[leftIndex]!;
        const right = choices[rightIndex]!;
        if (
          left.task.flight.id === right.task.flight.id ||
          !sameAirlinePriorityConflict(
            {
              flightNo: left.task.flight.flightNo,
              category: left.task.rule.category,
              name: left.task.rule.name,
              remark: left.task.rule.remark,
            },
            {
              flightNo: right.task.flight.flightNo,
              category: right.task.rule.category,
              name: right.task.rule.name,
              remark: right.task.rule.remark,
            }
          )
        )
          continue;
        const variableId = `same-airline-priority:${left.id}:${right.id}`;
        variables.push({
          id: variableId,
          type: "continuous",
          lowerBound: 0,
          upperBound: 1,
        });
        constraints.push(
          {
            id: `${variableId}:lower`,
            terms: [
              { variableId, coefficient: 1 },
              { variableId: left.id, coefficient: -1 },
              { variableId: right.id, coefficient: -1 },
            ],
            lowerBound: -1,
          },
          {
            id: `${variableId}:left`,
            terms: [
              { variableId, coefficient: 1 },
              { variableId: left.id, coefficient: -1 },
            ],
            upperBound: 0,
          },
          {
            id: `${variableId}:right`,
            terms: [
              { variableId, coefficient: 1 },
              { variableId: right.id, coefficient: -1 },
            ],
            upperBound: 0,
          }
        );
        addObjectiveTerm(
          "candidate:same-day-cross-flight-priority",
          variableId,
          1
        );
      }
    }
  }
}

function sameFlightStaffExclusionConstraints(
  state: ScheduleGenerationFacts,
  staffChoices: readonly DailyCombinationChoice[]
): LinearConstraint[] {
  const constraints: LinearConstraint[] = [];
  for (const [exclusionIndex, exclusion] of (
    state.settings.sameFlightStaffExclusions ?? []
  ).entries()) {
    const relevant = staffChoices.filter(
      (choice) =>
        (choice.person.id === exclusion.firstStaffId ||
          choice.person.id === exclusion.secondStaffId) &&
        sameFlightStaffExclusionApplies(exclusion, choice.task.flight.flightNo)
    );
    const byFlightId = new Map<string, DailyCombinationChoice[]>();
    for (const choice of relevant) {
      const own = byFlightId.get(choice.task.flight.id) ?? [];
      own.push(choice);
      byFlightId.set(choice.task.flight.id, own);
    }
    for (const [flightId, choices] of byFlightId) {
      const firstChoices = choices.filter(
        (choice) => choice.person.id === exclusion.firstStaffId
      );
      const secondChoices = choices.filter(
        (choice) => choice.person.id === exclusion.secondStaffId
      );
      for (const firstChoice of firstChoices) {
        for (const secondChoice of secondChoices) {
          constraints.push({
            id: `same-flight-staff-exclusion:${exclusionIndex}:${flightId}:${firstChoice.id}:${secondChoice.id}`,
            terms: [firstChoice, secondChoice].map((choice) => ({
              variableId: choice.id,
              coefficient: 1,
            })),
            upperBound: 1,
          });
        }
      }
    }
  }
  return constraints;
}

function combinationTaskPairIndex(
  state: ScheduleGenerationFacts,
  staffChoices: readonly DailyCombinationChoice[]
): ReadonlyMap<string, readonly CombinationTaskPair[]> {
  const representativeByTaskKey = new Map<string, DailyCombinationChoice>();
  for (const choice of staffChoices) {
    if (!representativeByTaskKey.has(choice.task.key))
      representativeByTaskKey.set(choice.task.key, choice);
  }
  const representatives = [...representativeByTaskKey.values()];
  const pairsByTargetTaskKey = new Map<string, CombinationTaskPair[]>();
  const transitionModesByTargetTaskKey = new Map<
    string,
    ReadonlySet<"forbid" | "prefer">
  >();
  for (const target of representatives) {
    const targetFlight = normalizedPolicyValue(target.task.flight.flightNo);
    const targetPosition = normalizedPolicyValue(target.task.rule.name);
    transitionModesByTargetTaskKey.set(
      target.task.key,
      new Set(
        state.settings.positionTransitionPolicies.flatMap((policy) =>
          policy.enabled &&
          normalizedPolicyValue(policy.targetFlightNo) === targetFlight &&
          normalizedPolicyValue(policy.targetPosition) === targetPosition
            ? [policy.mode]
            : []
        )
      )
    );
  }

  for (const target of representatives) {
    const transitionModes = transitionModesByTargetTaskKey.get(
      target.task.key
    )!;
    const targetIsHighLoad = isHighLoadPosition(
      target.task.rule.fatiguePoints,
      target.task.rule.remark,
      state
    );
    const canHaveHighLoadTransition =
      state.settings.highLoadProtectionEnabled && targetIsHighLoad;
    const canHaveRollingLoad =
      state.settings.rollingLoadProtectionEnabled && targetIsHighLoad;
    if (
      !transitionModes.size &&
      !canHaveHighLoadTransition &&
      !canHaveRollingLoad
    )
      continue;

    const targetPairs: CombinationTaskPair[] = [];
    for (const source of representatives) {
      const sourceCanParticipate =
        transitionModes.size > 0 ||
        canHaveRollingLoad ||
        (canHaveHighLoadTransition &&
          isHighLoadPosition(
            source.task.rule.fatiguePoints,
            source.task.rule.remark,
            state
          ));
      if (
        !sourceCanParticipate ||
        source.task.key === target.task.key ||
        !choicesCanShareStaff(state, source, target)
      )
        continue;
      const sourceForTarget =
        source.person.id === target.person.id
          ? source
          : { ...source, person: target.person };
      const sourceAssignment = choiceAssignment(sourceForTarget);
      const strictPolicyIds = transitionModes.has("forbid")
        ? violatedPositionTransitionPolicies(
            [sourceAssignment],
            target.person.id,
            target.task.flight.flightNo,
            target.task.rule.name,
            target.task.flight.startTime,
            state,
            "forbid"
          ).map((policy) => policy.id)
        : [];
      const preferredPolicyIds = transitionModes.has("prefer")
        ? violatedPositionTransitionPolicies(
            [sourceAssignment],
            target.person.id,
            target.task.flight.flightNo,
            target.task.rule.name,
            target.task.flight.startTime,
            state,
            "prefer"
          ).map((policy) => policy.id)
        : [];
      const highLoadTransition = canHaveHighLoadTransition
        ? hasHighLoadTransition(
            [sourceAssignment],
            target.person.id,
            target.task.flight.startTime,
            target.task.flight.endTime,
            target.task.rule.fatiguePoints,
            target.task.rule.remark,
            state
          )
        : false;
      const rollingExcess = canHaveRollingLoad
        ? rollingLoadCost(
            [sourceAssignment],
            target.person.id,
            target.task.flight.startTime,
            target.task.rule.fatiguePoints,
            target.task.rule.remark,
            state
          )
        : 0;
      if (
        !strictPolicyIds.length &&
        !preferredPolicyIds.length &&
        !highLoadTransition &&
        !rollingExcess
      )
        continue;
      targetPairs.push({
        sourceTaskKey: source.task.key,
        strictPolicyIds,
        preferredPolicyIds,
        highLoadTransition,
        rollingExcess,
      });
    }
    if (targetPairs.length)
      pairsByTargetTaskKey.set(target.task.key, targetPairs);
  }
  return pairsByTargetTaskKey;
}

export function buildDailyCombinationModel(
  state: ScheduleGenerationFacts,
  staffChoices: readonly DailyCombinationChoice[],
  enabledObjectiveIds: ReadonlySet<string>
): DailyCombinationModel {
  const variables: Array<SolverProblem["variables"][number]> = [];
  const constraints: LinearConstraint[] = [];
  const objectiveTerms = new Map<
    string,
    { variableId: string; coefficient: number }[]
  >();
  const addObjectiveTerm = (
    objectiveId: string,
    variableId: string,
    coefficient: number
  ): void => {
    if (!coefficient) return;
    const terms = objectiveTerms.get(objectiveId) ?? [];
    terms.push({ variableId, coefficient });
    objectiveTerms.set(objectiveId, terms);
  };
  const choicesByStaffId = new Map<string, DailyCombinationChoice[]>();
  for (const choice of staffChoices) {
    const own = choicesByStaffId.get(choice.person.id) ?? [];
    own.push(choice);
    choicesByStaffId.set(choice.person.id, own);
  }
  const taskPairIndex = combinationTaskPairIndex(state, staffChoices);
  const groups = new Map<string, SoftCombinationGroup>();
  const addGroupSource = (
    key: string,
    objectiveId: string,
    target: DailyCombinationChoice,
    source: DailyCombinationChoice,
    coefficient: number
  ): void => {
    const group = groups.get(key) ?? {
      objectiveId,
      targets: new Map<string, DailyCombinationChoice>(),
      sources: new Map<string, DailyCombinationChoice>(),
      coefficient,
    };
    group.targets.set(target.id, target);
    group.sources.set(source.id, source);
    groups.set(key, group);
  };
  for (const ownChoices of choicesByStaffId.values()) {
    const ownChoiceByTaskKey = new Map(
      ownChoices.map((choice) => [choice.task.key, choice])
    );
    for (const target of ownChoices) {
      for (const pair of taskPairIndex.get(target.task.key) ?? []) {
        const source = ownChoiceByTaskKey.get(pair.sourceTaskKey);
        if (!source) continue;
        for (const policyId of pair.strictPolicyIds) {
          if (
            !isPreNoonFlight(target.task.flight) &&
            target.priority.dutyPosition !== "reserved-target"
          ) {
            constraints.push({
              id: `strict-transition:${constraints.length}`,
              terms: [target.id, source.id].map((variableId) => ({
                variableId,
                coefficient: 1,
              })),
              upperBound: 1,
            });
          } else {
            addGroupSource(
              `forbid:${target.id}:${policyId}`,
              "candidate:position-transition",
              target,
              source,
              1
            );
          }
        }
        for (const policyId of pair.preferredPolicyIds) {
          addGroupSource(
            `prefer:${target.id}:${policyId}`,
            "candidate:preferred-position-transition",
            target,
            source,
            1
          );
        }
        if (pair.highLoadTransition) {
          addGroupSource(
            `high-load:${target.person.id}:${target.task.flight.startTime}:${target.task.flight.endTime}`,
            "candidate:high-load-recovery",
            target,
            source,
            1
          );
        }
        if (pair.rollingExcess) {
          addGroupSource(
            `rolling:${target.person.id}:${target.task.flight.startTime}:${target.task.rule.fatiguePoints}:${pair.rollingExcess}`,
            "candidate:rolling-load",
            target,
            source,
            pair.rollingExcess
          );
        }
      }
    }
  }

  // Diversion is a coverage fallback: when several complete schedules exist,
  // prefer the one that uses fewer diversion transfers.
  for (const ownChoices of choicesByStaffId.values()) {
    for (let leftIndex = 0; leftIndex < ownChoices.length; leftIndex += 1) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < ownChoices.length;
        rightIndex += 1
      ) {
        const left = ownChoices[leftIndex]!;
        const right = ownChoices[rightIndex]!;
        if (
          left.task.flight.id === right.task.flight.id ||
          !tasksRequireDiversionRelease(
            state,
            left.task.flight,
            left.task.rule,
            right.task.flight,
            right.task.rule
          )
        ) {
          continue;
        }
        const variableId = `diversion:${left.id}:${right.id}`;
        variables.push({
          id: variableId,
          type: "continuous",
          lowerBound: 0,
          upperBound: 1,
        });
        constraints.push(
          {
            id: `${variableId}:active`,
            terms: [
              { variableId, coefficient: 1 },
              { variableId: left.id, coefficient: -1 },
              { variableId: right.id, coefficient: -1 },
            ],
            lowerBound: -1,
          },
          {
            id: `${variableId}:left`,
            terms: [
              { variableId, coefficient: 1 },
              { variableId: left.id, coefficient: -1 },
            ],
            upperBound: 0,
          },
          {
            id: `${variableId}:right`,
            terms: [
              { variableId, coefficient: 1 },
              { variableId: right.id, coefficient: -1 },
            ],
            upperBound: 0,
          }
        );
        addObjectiveTerm(
          "minimum-flight-transition:diversion-usage",
          variableId,
          1
        );
      }
    }
  }

  const aggregateMonthObjective =
    "candidate:late-priority-aggregate-rotation:current-month";
  const aggregateRecentObjective =
    "candidate:late-priority-aggregate-rotation:recent-eight-workdays";
  for (const ownChoices of choicesByStaffId.values()) {
    const applicableChoices = ownChoices.filter(
      (choice) =>
        choice.priority.latePriorityFrequency.applies &&
        choice.priority.dutyPosition !== "reserved-target"
    );
    for (
      let leftIndex = 0;
      leftIndex < applicableChoices.length;
      leftIndex += 1
    ) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < applicableChoices.length;
        rightIndex += 1
      ) {
        const left = applicableChoices[leftIndex]!;
        const right = applicableChoices[rightIndex]!;
        if (!choicesCanShareStaff(state, left, right)) continue;
        addGroupSource(
          `late-aggregate-month:${left.id}:${right.id}`,
          aggregateMonthObjective,
          left,
          right,
          1
        );
        addGroupSource(
          `late-aggregate-recent:${left.id}:${right.id}`,
          aggregateRecentObjective,
          left,
          right,
          1
        );
      }
    }
  }

  const choicesByTaskKey = new Map<string, DailyCombinationChoice[]>();
  for (const choice of staffChoices) {
    const taskChoices = choicesByTaskKey.get(choice.task.key) ?? [];
    taskChoices.push(choice);
    choicesByTaskKey.set(choice.task.key, taskChoices);
  }
  const boundaryObjective =
    "candidate:late-priority-aggregate-rotation:category-boundary";
  if (enabledObjectiveIds.has(boundaryObjective)) {
    for (const [staffId, ownChoices] of choicesByStaffId) {
      for (const kind of LATE_PRIORITY_FREQUENCY_ORDER) {
        const applicable = ownChoices.filter(
          (choice) =>
            choice.priority.latePriorityFrequency.applies &&
            choice.priority.dutyPosition !== "reserved-target" &&
            choice.priority.latePriorityFrequency.targetKinds.includes(kind)
        );
        if (!applicable.length) continue;
        const baseCount =
          applicable[0]!.priority.latePriorityFrequency.counts[kind]
            .currentMonthCount;
        const taskMinimums = applicable.map((choice) =>
          Math.min(
            ...(choicesByTaskKey.get(choice.task.key) ?? [choice])
              .filter((candidate) =>
                candidate.priority.latePriorityFrequency.targetKinds.includes(
                  kind
                )
              )
              .map(
                (candidate) =>
                  candidate.priority.latePriorityFrequency.counts[kind]
                    .currentMonthCount
              )
          )
        );
        const allowedAdditional = Math.max(
          0,
          Math.min(...taskMinimums) +
            LATE_PRIORITY_ALLOWED_DIFFERENCE[kind] -
            baseCount
        );
        const excessVariableId = `late-category-excess:${staffId}:${kind}`;
        variables.push({
          id: excessVariableId,
          type: "continuous",
          lowerBound: 0,
          upperBound: applicable.length,
        });
        constraints.push({
          id: `${excessVariableId}:limit`,
          terms: [
            ...applicable.map((choice) => ({
              variableId: choice.id,
              coefficient: 1,
            })),
            { variableId: excessVariableId, coefficient: -1 },
          ],
          upperBound: allowedAdditional,
        });
        addObjectiveTerm(boundaryObjective, excessVariableId, 1);
      }
    }
  }

  const signatureForGroup = (group: SoftCombinationGroup): string =>
    `${[...group.targets.keys()].sort().join(",")}|${[...group.sources.keys()]
      .sort()
      .join(",")}`;
  const variableIdBySignature = new Map<string, string>();
  for (const group of groups.values()) {
    const signature = signatureForGroup(group);
    if (!variableIdBySignature.has(signature))
      variableIdBySignature.set(
        signature,
        `combination:${variableIdBySignature.size}`
      );
  }
  const enabledVariableIds = new Set<string>();
  const enabledGroups: EnabledCombinationGroup[] = [];
  for (const group of groups.values()) {
    if (!enabledObjectiveIds.has(group.objectiveId)) continue;
    const targetIds = [...group.targets.keys()];
    const variableId = variableIdBySignature.get(signatureForGroup(group))!;
    enabledGroups.push({ group, variableId });
    if (enabledVariableIds.has(variableId)) {
      addObjectiveTerm(group.objectiveId, variableId, group.coefficient);
      continue;
    }
    enabledVariableIds.add(variableId);
    const sourcesByFlightId = new Map<string, DailyCombinationChoice[]>();
    for (const source of group.sources.values()) {
      const ownSources = sourcesByFlightId.get(source.task.flight.id) ?? [];
      ownSources.push(source);
      sourcesByFlightId.set(source.task.flight.id, ownSources);
    }
    variables.push({
      id: variableId,
      type: "continuous",
      lowerBound: 0,
      upperBound: 1,
      lowerEnvelope: true,
    });
    constraints.push(
      ...[...sourcesByFlightId.values()].map((sourceChoices, index) => ({
        id: `${variableId}:source-flight:${index}`,
        terms: [
          { variableId, coefficient: 1 },
          ...targetIds.map((targetId) => ({
            variableId: targetId,
            coefficient: -1,
          })),
          ...sourceChoices.map((source) => ({
            variableId: source.id,
            coefficient: -1,
          })),
        ],
        lowerBound: -1,
      }))
    );
    addObjectiveTerm(group.objectiveId, variableId, group.coefficient);
  }
  sameAirlinePrioritySoftPenalty(
    staffChoices,
    variables,
    constraints,
    enabledObjectiveIds.has("candidate:same-day-cross-flight-priority"),
    addObjectiveTerm
  );
  constraints.push(...highLoadIndependentCapacityConstraints(enabledGroups));

  return {
    variables,
    incompatibilityConstraints: [
      ...incompatibilityConstraints(state, staffChoices),
      ...dailyPrimaryPositionConstraints(state, staffChoices),
      ...sameFlightStaffExclusionConstraints(state, staffChoices),
    ],
    constraints,
    objectiveTerms,
  };
}

function objectiveValueStep(
  terms: readonly { coefficient: number }[]
): number | undefined {
  const scale = 1_000_000;
  const values = terms.map((term) => Math.abs(term.coefficient));
  if (
    !values.length ||
    values.some(
      (value) =>
        !Number.isFinite(value) ||
        value <= 0 ||
        Math.abs(value * scale - Math.round(value * scale)) > 1e-7
    )
  )
    return undefined;
  const greatestCommonDivisor = (left: number, right: number): number => {
    let a = left;
    let b = right;
    while (b) [a, b] = [b, a % b];
    return a;
  };
  const scaledStep = values
    .map((value) => Math.round(value * scale))
    .reduce(greatestCommonDivisor);
  return scaledStep > 0 ? scaledStep / scale : undefined;
}

export function withDailyCombinationObjectives(
  objectives: readonly LexicographicObjective[],
  combination: DailyCombinationModel
): LexicographicObjective[] {
  return objectives.map((objective) => {
    const combinationTerms = combination.objectiveTerms.get(objective.id) ?? [];
    const terms = [...objective.terms, ...combinationTerms];
    return {
      ...objective,
      terms,
      ...(combinationTerms.length && objective.direction === "minimize"
        ? { objectiveValueStep: objectiveValueStep(terms) }
        : {}),
    };
  });
}
