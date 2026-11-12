import { DirectedGraph } from "graphology";
import { hasCycle, topologicalGenerations } from "graphology-dag";

import type { Assignment, Flight, PositionRule, Staff } from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import {
  SCHEDULING_STAGE_ORDER,
  type SchedulingRuleStage,
} from "./schedule-rule-contract";
import type {
  AssignmentEligibilityDiagnostic,
  AutomaticAssignmentEligibilityOptions,
} from "../candidates/assignment-eligibility";
import type { CandidatePriority } from "../candidates/candidate-priority";
import type { ScheduleLedger } from "../kernel/schedule-ledger";
import type { ScheduleRunFacts } from "../shared/schedule-run-facts";
import type { AssignmentTask } from "../flights/schedule-tasks";
import type { SolverPort } from "../solver/solver-port";
import type { balanceRelaxedShifts } from "../reviews/relaxed-shift-balance";

export interface CandidateComparisonContext {
  task: AssignmentTask;
  left: Staff;
  leftPriority: CandidatePriority;
  right: Staff;
  rightPriority: CandidatePriority;
}

export interface ScheduleMutationContext {
  solver: SolverPort;
  state: ScheduleGenerationFacts;
  ledger: ScheduleLedger;
  date: string;
  lockedAssignmentIds: Set<string>;
  runFacts: ScheduleRunFacts;
  flights: readonly Flight[];
  displayRulesByFlight: ReadonlyMap<string, readonly PositionRule[]>;
  finalizeMobileSupervisors(): Promise<void>;
}

export interface ScheduleMutationProposal {
  assignments?: readonly Assignment[];
  warnings: readonly string[];
}

export interface HardConstraintExecutor {
  kind: "hard-constraint";
  execute(
    context: AutomaticAssignmentEligibilityOptions
  ): AssignmentEligibilityDiagnostic;
}

export interface CandidatePriorityExecutor {
  kind: "candidate-priority";
  execute(context: CandidateComparisonContext): number;
}

export interface DailyModelExecutor {
  kind: "daily-model";
  id:
    | "cross-flight-priority"
    | "cross-workday-qualification-reservation"
    | "strict-next-workday-recovery"
    | "half-rest-morning"
    | "half-rest-early-finish"
    | "same-day-late-obligation"
    | "late-shift-position-relief";
}

export interface ScheduleMutationExecutor {
  kind: "coverage" | "post-schedule";
  id: string;
  pass: "primary" | "mobile-supervisor-finalize" | "after-mobile-supervisor";
  execute(
    context: ScheduleMutationContext
  ): ScheduleMutationProposal | Promise<ScheduleMutationProposal>;
}

export type SchedulingHookExecutor =
  | HardConstraintExecutor
  | CandidatePriorityExecutor
  | DailyModelExecutor
  | ScheduleMutationExecutor
  | {
      kind: "final-review";
      execute: typeof balanceRelaxedShifts;
    };

export interface SchedulingHook {
  id: string;
  label: string;
  stage: SchedulingRuleStage;
  defaultEnabled: boolean;
  configurable: boolean;
  before: readonly string[];
  after: readonly string[];
  source: "built-in";
  execute: readonly [SchedulingHookExecutor, ...SchedulingHookExecutor[]];
}

export interface RulePreference {
  id: string;
  enabled: boolean;
  order?: number;
}

export interface PlannedSchedulingHook extends SchedulingHook {
  enabled: boolean;
}

export type RuleRegistryErrorCode =
  | "duplicate-id"
  | "missing-dependency"
  | "dependency-cycle"
  | "invalid-stage-dependency";

export class RuleRegistryError extends Error {
  constructor(
    readonly code: RuleRegistryErrorCode,
    readonly detail: string
  ) {
    super(detail);
    this.name = "RuleRegistryError";
  }
}

export interface RuleRegistry {
  definitions(): readonly SchedulingHook[];
  executionPlan(
    preferences?: readonly RulePreference[]
  ): readonly PlannedSchedulingHook[];
  definition(id: string): SchedulingHook | undefined;
}

const stageIndex = new Map(
  SCHEDULING_STAGE_ORDER.map((stage, index) => [stage, index])
);

function validateDefinitions(definitions: readonly SchedulingHook[]): void {
  const byId = new Map<string, SchedulingHook>();
  for (const definition of definitions) {
    if (byId.has(definition.id))
      throw new RuleRegistryError("duplicate-id", definition.id);
    byId.set(definition.id, definition);
  }
  for (const definition of definitions) {
    for (const dependencyId of [...definition.before, ...definition.after]) {
      const dependency = byId.get(dependencyId);
      if (!dependency)
        throw new RuleRegistryError(
          "missing-dependency",
          `${definition.id} -> ${dependencyId}`
        );
      const definitionStage = stageIndex.get(definition.stage)!;
      const dependencyStage = stageIndex.get(dependency.stage)!;
      const violatesStage = definition.before.includes(dependencyId)
        ? definitionStage > dependencyStage
        : definitionStage < dependencyStage;
      if (violatesStage)
        throw new RuleRegistryError(
          "invalid-stage-dependency",
          `${definition.id} -> ${dependencyId}`
        );
    }
  }
}

function stableTopologicalOrder(
  definitions: readonly SchedulingHook[],
  preferences: ReadonlyMap<string, RulePreference>
): SchedulingHook[] {
  const originalOrder = new Map(
    definitions.map((definition, index) => [definition.id, index])
  );
  const byId = new Map(
    definitions.map((definition) => [definition.id, definition])
  );
  const graph = new DirectedGraph();
  definitions.forEach((definition) => graph.addNode(definition.id));
  const addEdge = (from: string, to: string): void => {
    graph.mergeDirectedEdge(from, to);
  };
  for (const definition of definitions) {
    definition.after.forEach((id) => addEdge(id, definition.id));
    definition.before.forEach((id) => addEdge(definition.id, id));
  }
  for (let left = 0; left < definitions.length; left += 1) {
    for (let right = left + 1; right < definitions.length; right += 1) {
      const leftDefinition = definitions[left]!;
      const rightDefinition = definitions[right]!;
      if (
        stageIndex.get(leftDefinition.stage)! <
        stageIndex.get(rightDefinition.stage)!
      )
        addEdge(leftDefinition.id, rightDefinition.id);
    }
  }
  const compareAvailable = (left: string, right: string): number => {
    const leftDefinition = byId.get(left)!;
    const rightDefinition = byId.get(right)!;
    return (
      stageIndex.get(leftDefinition.stage)! -
        stageIndex.get(rightDefinition.stage)! ||
      (preferences.get(left)?.order ?? originalOrder.get(left)!) -
        (preferences.get(right)?.order ?? originalOrder.get(right)!) ||
      originalOrder.get(left)! - originalOrder.get(right)!
    );
  };
  if (hasCycle(graph)) {
    const cyclic = definitions
      .map((item) => item.id)
      .sort(
        (left, right) => originalOrder.get(left)! - originalOrder.get(right)!
      );
    throw new RuleRegistryError("dependency-cycle", cyclic.join(", "));
  }
  return topologicalGenerations(graph).flatMap((generation) =>
    generation.sort(compareAvailable).map((id) => byId.get(id)!)
  );
}

export function createRuleRegistry(
  input: readonly SchedulingHook[]
): RuleRegistry {
  const definitions: readonly SchedulingHook[] = input.map((item) =>
    Object.freeze({
      ...item,
      execute: Object.freeze([...item.execute]) as SchedulingHook["execute"],
    })
  );
  validateDefinitions(definitions);
  const byId = new Map(definitions.map((item) => [item.id, item]));
  stableTopologicalOrder(definitions, new Map());
  return Object.freeze({
    definitions: () => definitions,
    definition: (id: string) => byId.get(id),
    executionPlan: (preferences: readonly RulePreference[] = []) => {
      const preferenceById = new Map(
        preferences.map((preference) => [preference.id, preference])
      );
      return stableTopologicalOrder(definitions, preferenceById).map(
        (definition) =>
          Object.freeze({
            ...definition,
            enabled: definition.configurable
              ? (preferenceById.get(definition.id)?.enabled ??
                definition.defaultEnabled)
              : true,
          })
      );
    },
  });
}
