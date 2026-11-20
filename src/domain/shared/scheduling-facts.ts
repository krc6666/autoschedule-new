import type {
  AppState,
  Assignment,
  DutyRosterOverride,
  Flight,
  FlightTemplate,
  HistoryRecord,
  LatePriorityFrequencyAdjustment,
  OrdinaryPriorityFrequencyAdjustment,
  PositionRule,
  ScheduleSettings,
  Staff,
} from "../../model";
import {
  flightIdentities,
  type FlightIdentityFacts,
} from "../flights/flight-identities";

/**
 * Domain-facing state projection. It deliberately excludes application
 * lifecycle, weekly-plan metadata, versioning and persistence timestamps.
 */
export interface SchedulingFacts extends FlightIdentityFacts {
  flightSeasonOverrides?: Record<string, boolean>;
  staff: Staff[];
  flights: Flight[];
  templates: FlightTemplate[];
  positionRules: PositionRule[];
  history: HistoryRecord[];
  dutyRosterOverrides: DutyRosterOverride[];
  latePriorityFrequencyAdjustments: LatePriorityFrequencyAdjustment[];
  ordinaryPriorityFrequencyAdjustments?: OrdinaryPriorityFrequencyAdjustment[];
  assignments: Assignment[];
  settings: ScheduleSettings;
  activeScheduleDate: string | null;
}

export type ScheduleGenerationFacts = Pick<
  SchedulingFacts,
  | "staff"
  | "flightIdentities"
  | "flightSeasonOverrides"
  | "flights"
  | "templates"
  | "positionRules"
  | "history"
  | "dutyRosterOverrides"
  | "latePriorityFrequencyAdjustments"
  | "ordinaryPriorityFrequencyAdjustments"
  | "assignments"
  | "settings"
> &
  FlightIdentityFacts;

export type AssignmentEligibilityFacts = Pick<
  ScheduleGenerationFacts,
  "staff" | "flights" | "positionRules" | "assignments" | "settings"
> &
  FlightIdentityFacts;

export type AssignmentTimingFacts = Pick<
  ScheduleGenerationFacts,
  "flights" | "positionRules" | "assignments" | "settings"
> &
  FlightIdentityFacts;

export type FlightRuleFacts = Pick<
  ScheduleGenerationFacts,
  "flights" | "positionRules" | "settings"
> &
  FlightIdentityFacts;

export type HistoryRuleFacts = Pick<
  ScheduleGenerationFacts,
  "history" | "settings" | "ordinaryPriorityFrequencyAdjustments"
> &
  FlightIdentityFacts;

export type PositionFrequencyFacts = Pick<
  ScheduleGenerationFacts,
  | "history"
  | "positionRules"
  | "settings"
  | "ordinaryPriorityFrequencyAdjustments"
> &
  FlightIdentityFacts;

export type ScheduleSettingsFacts = Pick<ScheduleGenerationFacts, "settings"> &
  FlightIdentityFacts;

export type WorkloadFacts = Pick<
  ScheduleGenerationFacts,
  | "staff"
  | "flights"
  | "positionRules"
  | "history"
  | "assignments"
  | "dutyRosterOverrides"
  | "settings"
> &
  FlightIdentityFacts;

export type DutyRosterFacts = Pick<
  ScheduleGenerationFacts,
  "staff" | "history" | "dutyRosterOverrides" | "settings"
> &
  FlightIdentityFacts;

export type WorkloadAccountingFacts = Pick<
  ScheduleGenerationFacts,
  "staff" | "positionRules" | "assignments"
> &
  FlightIdentityFacts;

export type StaffAssignmentFacts = Pick<
  ScheduleGenerationFacts,
  "staff" | "positionRules" | "assignments"
> &
  FlightIdentityFacts;

export function createScheduleGenerationFacts(
  state: Pick<
    AppState,
    | "staff"
    | "flightSeasonOverrides"
    | "flights"
    | "templates"
    | "positionRules"
    | "history"
    | "dutyRosterOverrides"
    | "latePriorityFrequencyAdjustments"
    | "ordinaryPriorityFrequencyAdjustments"
    | "assignments"
    | "settings"
  > &
    FlightIdentityFacts
): ScheduleGenerationFacts {
  return {
    flightIdentities: [...flightIdentities(state)],
    flightSeasonOverrides: state.flightSeasonOverrides,
    staff: state.staff,
    flights: state.flights,
    templates: state.templates,
    positionRules: state.positionRules,
    history: state.history,
    dutyRosterOverrides: state.dutyRosterOverrides,
    latePriorityFrequencyAdjustments: state.latePriorityFrequencyAdjustments,
    ordinaryPriorityFrequencyAdjustments:
      state.ordinaryPriorityFrequencyAdjustments,
    assignments: state.assignments,
    settings: state.settings,
  };
}

export function createSchedulingFacts(
  state: Pick<
    AppState,
    | "staff"
    | "flightSeasonOverrides"
    | "flights"
    | "templates"
    | "positionRules"
    | "history"
    | "dutyRosterOverrides"
    | "latePriorityFrequencyAdjustments"
    | "ordinaryPriorityFrequencyAdjustments"
    | "assignments"
    | "settings"
    | "activeScheduleDate"
  > &
    FlightIdentityFacts
): SchedulingFacts {
  return {
    ...createScheduleGenerationFacts(state),
    activeScheduleDate: state.activeScheduleDate,
  };
}
