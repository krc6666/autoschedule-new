import type { Assignment, Staff } from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import type { LatePriorityFatigueReliefPolicy } from "../reviews/reassignment-safety-policy";
import type { RotationStaffChange } from "../reviews/rotation-review-safety";
import type { ScheduleRunFacts } from "../shared/schedule-run-facts";
import type { ScheduleFrequencyFacts } from "../statistics/schedule-frequency";
import type { SolverPort } from "./solver-port";
import type { ReassignmentIntent } from "./reassignment-intent";

export interface ReassignmentChoiceObjective {
  id: string;
  direction: "minimize" | "maximize";
  coefficient(input: {
    assignment: Assignment;
    person: Staff;
    keepsCurrentStaff: boolean;
  }): number;
}

export interface ReassignmentOptimizationOptions {
  solver: SolverPort;
  state: ScheduleGenerationFacts;
  assignments: Assignment[];
  primary: Assignment;
  movableAssignments: readonly Assignment[];
  date: string;
  facts?: ScheduleRunFacts;
  frequencyFacts?: ScheduleFrequencyFacts;
  permittedConcurrentAssignmentIds?: ReadonlySet<string>;
  coupledAssignmentGroups?: readonly (readonly string[])[];
  latePriorityFatigueRelief?: LatePriorityFatigueReliefPolicy;
  candidateAllowed?(assignment: Assignment, staff: Staff): boolean;
  primaryCandidateAllowed(staff: Staff): boolean;
  primaryCandidateRejectionReason?(staff: Staff): string | null;
  compareCandidates?(assignment: Assignment, left: Staff, right: Staff): number;
  choiceWorkHours?(assignment: Assignment, staff: Staff): number;
  normalizeChanges?(
    changes: readonly RotationStaffChange[]
  ): readonly RotationStaffChange[];
  leadingObjectives?: readonly ReassignmentChoiceObjective[];
  intent: ReassignmentIntent;
  collectAllCandidateRejections?: boolean;
  validateChanges?(changes: readonly RotationStaffChange[]): readonly string[];
  requiredStaffIds?: readonly string[];
  maxParticipants?: number;
  maxChangedAssignments?: number;
  timeoutMs?: number;
  acceptTimeLimitedFeasible?: boolean;
  /** Preserve each worker's number of movable assignments during an exchange. */
  preserveStaffAssignmentCounts?: boolean;
}

export interface ReassignmentOptimizationResult {
  changes: RotationStaffChange[] | null;
  attemptedReasons: string[];
  candidateRejections?: {
    assignmentId?: string;
    flightNo?: string;
    position?: string;
    startTime?: string;
    endTime?: string;
    staffId: string;
    staffName: string;
    reasons: string[];
  }[];
  termination:
    "optimal" | "infeasible" | "timed-out" | "time-limited-feasible" | "failed";
}
