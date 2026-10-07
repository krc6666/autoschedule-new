import type { Assignment } from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import type { ScheduleRunFacts } from "../shared/schedule-run-facts";
import {
  assertScheduleAssignmentsSafe,
  createDefaultScheduleGuards,
  type ScheduleGuard,
  type ScheduleGuardContext,
  type ScheduleGuardPhase,
} from "./schedule-guard";
import {
  assertScheduleSafetyCredential,
  createScheduleSafetyCredential,
  type ScheduleSafetyCredential,
} from "./schedule-safety-credential";

export interface ScheduleSafetySession {
  readonly context: ScheduleGuardContext;
  assertAssignmentsSafe(assignments: readonly Assignment[]): void;
  resetWarnings(): void;
  warnings(): readonly string[];
  createCredential(
    date: string,
    assignments: readonly Assignment[]
  ): ScheduleSafetyCredential;
}

export interface ScheduleSafetySessionOptions {
  phase: ScheduleGuardPhase;
  state: ScheduleGenerationFacts;
  date: string;
  runFacts: ScheduleRunFacts;
  warningSink?: string[];
  guards?: readonly ScheduleGuard[];
}

export function createScheduleGuardContext({
  phase,
  state,
  date,
  runFacts,
  warningSink,
}: Omit<ScheduleSafetySessionOptions, "guards">): ScheduleGuardContext {
  return {
    phase,
    sameFlightStaffExclusionFacts: { state },
    dailyPrimaryPositionFacts: { state },
    halfRestFacts: runFacts.halfRest,
    airlineRotationFacts: {
      enabled: state.settings.sameDayCrossFlightPriorityEnabled,
      positionRules: state.positionRules,
    },
    minimumFlightTransitionFacts: {
      flights: state.flights,
      positionRules: state.positionRules,
      settings: state.settings,
    },
    lateShiftCutoffFacts: {
      state,
      date,
      crossDayRecovery: runFacts.crossDayRecovery,
    },
    crossWorkdayQualificationReservationFacts: { state },
    latePriorityFrequencyFacts: {
      state,
      date,
      scheduleFrequency: runFacts.scheduleFrequency,
    },
    latePriorityAggregateRotationFacts: {
      state,
      date,
      scheduleFrequency: runFacts.scheduleFrequency,
    },
    strictNextWorkdayRecoveryFacts: {
      state,
      date,
      crossDayRecovery: runFacts.crossDayRecovery,
      halfRestFacts: runFacts.halfRest,
    },
    highFatiguePositionFacts: {
      state,
      date,
      scheduleFrequency: runFacts.scheduleFrequency,
    },
    positionTransitionFacts: { state },
    positionFrequencyFacts: {
      state,
      date,
    },
    workloadBalanceFacts: {
      state,
      date,
      dutyStaffId: runFacts.currentDutyStaffId,
    },
    sameDayLateObligationFacts: { state, date },
    lateShiftPositionReliefFacts: { state, date },
    mobileSupervisorCoverageFacts: { state, date },
    ke166SnapshotFacts: { state, date },
    scarceQualificationFacts: { state, date },
    dutyPositionFacts: { state, date },
    warningSink,
  };
}

function createSession(
  context: ScheduleGuardContext,
  guards: readonly ScheduleGuard[]
): ScheduleSafetySession {
  return Object.freeze({
    context,
    assertAssignmentsSafe(assignments: readonly Assignment[]): void {
      assertScheduleAssignmentsSafe({ assignments, context, guards });
    },
    resetWarnings(): void {
      context.warningSink?.splice(0, context.warningSink.length);
    },
    warnings(): readonly string[] {
      return [...(context.warningSink ?? [])];
    },
    createCredential(
      date: string,
      assignments: readonly Assignment[]
    ): ScheduleSafetyCredential {
      return createScheduleSafetyCredential({
        date,
        assignments,
        context,
      });
    },
  });
}

export function createScheduleSafetySession(
  options: ScheduleSafetySessionOptions
): ScheduleSafetySession {
  return createSession(
    createScheduleGuardContext(options),
    options.guards ?? createDefaultScheduleGuards()
  );
}

export { assertScheduleSafetyCredential };
