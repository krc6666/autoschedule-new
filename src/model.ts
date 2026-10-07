import type { SchedulingDecision } from "./domain/rules/schedule-rule-contract";
import type {
  CrossWorkdayQualificationReservation,
  CrossFlightPriorityPolicy,
  DutyPositionPriority,
  LateShiftRecoveryPositionRule,
  MobileSupervisorCoverageRule,
  MobileSupervisorFillRule,
  NextWorkdayRecoveryTarget,
  PositionTransitionPolicy,
  SameFlightStaffExclusion,
  TeamLeaderGapFillPositionPolicy,
} from "./domain/rules/structured-policy-contract";
import type { LatePriorityFrequencyKind } from "./domain/reviews/late-priority-policy";

export type StaffStatus = "正常" | "病假" | "休假";
export type StaffType = "常规" | "行政支援";

export interface Staff {
  id: string;
  name: string;
  staffType: StaffType;
  teamLeader: boolean;
  cxPreflightQualified: boolean;
  dutyQualified: boolean;
  standbyQualified: boolean;
  nightShift: boolean;
  status: StaffStatus;
  remark: string;
}

export interface Flight {
  id: string;
  flightNo: string;
  startTime: string;
  endTime: string;
  bookedPassengers: number;
  positions: string[];
  remark: string;
}

export interface FlightTemplate extends Omit<
  Flight,
  "id" | "bookedPassengers"
> {
  id: string;
}

export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface WeeklyFlightPlanEntry {
  weekday: IsoWeekday;
  flightNos: string[];
}

export interface PositionRule {
  id: string;
  flightNo: string;
  name: string;
  category: "常规" | "引导" | "机动督导" | "分流" | "行政支援";
  /** Orthogonal coverage behavior; it does not replace the position category. */
  coverageRole?: "none" | "supervisor-fill";
  remark: string;
  qualifiedStaffIds: string[];
  manual: boolean;
  fatiguePoints: number;
  minPassengers: number;
  earlyReleaseMinutes: number;
}

export interface HistoryRecord {
  id: string;
  date: string;
  flightNo: string;
  position: string;
  staffId: string;
  staffName: string;
  startTime: string;
  endTime: string;
  /** Original scheduled end of the source flight, before an early release. */
  flightCutoffTime?: string;
  workHours: number;
  fatiguePoints: number;
  remark: string;
  /** Whether this record represents a complete day or a scoped legacy import. */
  historyCoverage?: "complete" | "late-priority-only";
  /** True only for a team leader assignment confirmed through gap fill. */
  teamLeaderGapFill?: true;
}

export interface Assignment {
  id: string;
  flightId: string;
  flightNo: string;
  positionRuleId: string | null;
  position: string;
  staffId: string | null;
  staffName: string;
  startTime: string;
  endTime: string;
  workHours: number;
  fatiguePoints: number;
  remark: string;
  manualRemark: string;
  status: "assigned" | "unfilled" | "manual";
  systemNotes?: string[];
  vacancyEvidence?: {
    reason: "daily-flight-count-balance" | "no-qualified-candidate";
    blockers: string[];
  };
  decisionTrace?: SchedulingDecision[];
  /** Identifies the schedule run and rule snapshot behind decisionTrace. */
  decisionEvidence?: {
    scheduleRunId: string;
    ruleFingerprint: string;
  };
  manualOverrideWarnings?: Array<{ code: string; message: string }>;
  supervisorSourceAssignmentId?: string;
  /** Structured relation used when a supervisor fills a configured target. */
  supervisorFillRuleId?: string;
  /** True only for a team leader assignment confirmed through gap fill. */
  teamLeaderGapFill?: true;
  layoutGroup?: "primary" | "bottom";
  layoutIndex?: number;
}

export interface DutyRosterOverride {
  date: string;
  cxPreflightStaffId: string | null;
  dutyStaffId: string | null;
  standbyStaffIds: [string | null, string | null];
}

export interface LatePriorityFrequencyAdjustment {
  month: string;
  staffId: string;
  flightNo: string;
  kind: LatePriorityFrequencyKind;
  delta: number;
  resetBaseline?: number;
}

export interface OrdinaryPriorityPosition {
  airlineCode: string;
  position: string;
}

export interface OrdinaryPriorityFrequencyAdjustment {
  month: string;
  staffId: string;
  airlineCode: string;
  position: string;
  delta: number;
  resetBaseline?: number;
}

export interface ScheduleSettings {
  sameFlightStaffExclusions: SameFlightStaffExclusion[];
  maxDailyHours: number;
  historyWindowDays: number;
  nightStart: string;
  nightEnd: string;
  consecutiveDayPenalty: number;
  adminSupportEnabled: boolean;
  highLoadProtectionEnabled: boolean;
  highLoadFatigueThreshold: number;
  highLoadRecoveryMinutes: number;
  remarkedPositionHighLoad: boolean;
  minimumRegularTransitionMinutes: number;
  positionTransitionPolicies: PositionTransitionPolicy[];
  rollingLoadProtectionEnabled: boolean;
  rollingLoadWindowMinutes: number;
  rollingLoadMaxFatigue: number;
  positionRotationEnabled: boolean;
  sameDayCrossFlightPriorityEnabled: boolean;
  dailyPrimaryPositionUniqueEnabled: boolean;
  ordinaryPriorityPositions: OrdinaryPriorityPosition[];
  tr121H02CooldownWorkdays: number;
  latePriorityFlightNumbers: string[];
  lateShiftRecoveryEnabled: boolean;
  nextWorkdayRecoveryMode: "prefer" | "forbid";
  lateShiftEndTime: string;
  teamLeaderConcurrentSupervisionMaxOverlapMinutes: number;
  lateShiftRecoveryPositionRules: LateShiftRecoveryPositionRule[];
  nextWorkdayRecoveryTargets: NextWorkdayRecoveryTarget[];
  dutyFatiguePoints: number;
  dutyPositionPriorities: DutyPositionPriority[];
  mobileSupervisorCoverageRules: MobileSupervisorCoverageRule[];
  mobileSupervisorFillRules: MobileSupervisorFillRule[];
  crossWorkdayQualificationReservations: CrossWorkdayQualificationReservation[];
  crossFlightPriorityPolicies: CrossFlightPriorityPolicy[];
  teamLeaderGapFillPositionPolicies: TeamLeaderGapFillPositionPolicy[];
  earlyDepartureCutoffTime: string;
  afternoonRestStartTime: string;
  afternoonRestEndTime: string;
  workloadBalanceEnabled: boolean;
  dailyFlightCountBalanceExemptHalfRest: boolean;
  dailyFlightCountBalanceExemptTeamLeaders: boolean;
  maxWorkHoursDifference: number;
  maxTodayFatigueDifference: number;
}

export type ScheduleGroupId = "A" | "B";

/** Facts shared by both groups. Group workspaces must not copy these values. */
export interface SharedScheduleData {
  templates: FlightTemplate[];
  weeklyFlightPlans: WeeklyFlightPlanEntry[];
  positionRules: PositionRule[];
  settings: ScheduleSettings;
}

/** Facts that belong exclusively to one personnel group. */
export interface GroupWorkspace {
  flights: Flight[];
  staff: Staff[];
  history: HistoryRecord[];
  dutyRosterOverrides: DutyRosterOverride[];
  latePriorityFrequencyAdjustments: LatePriorityFrequencyAdjustment[];
  ordinaryPriorityFrequencyAdjustments: OrdinaryPriorityFrequencyAdjustment[];
  assignments: Assignment[];
  activeScheduleDate: string | null;
  schedulePolicyStale: boolean;
  scheduleRuleFingerprint?: string;
}

export type GroupWorkspaces = Record<ScheduleGroupId, GroupWorkspace>;

export interface AppState {
  version: 8;
  /** Shared configuration and the two isolated group workspaces. */
  shared: SharedScheduleData;
  groups: GroupWorkspaces;
  activeGroupId: ScheduleGroupId;
  /**
   * Legacy current-workspace projection kept during the staged migration.
   * Consumers move to `shared`/`groups` in the following phase.
   */
  staff: Staff[];
  flights: Flight[];
  templates: FlightTemplate[];
  weeklyFlightPlans: WeeklyFlightPlanEntry[];
  positionRules: PositionRule[];
  history: HistoryRecord[];
  dutyRosterOverrides: DutyRosterOverride[];
  latePriorityFrequencyAdjustments: LatePriorityFrequencyAdjustment[];
  ordinaryPriorityFrequencyAdjustments: OrdinaryPriorityFrequencyAdjustment[];
  assignments: Assignment[];
  activeScheduleDate: string | null;
  schedulePolicyStale: boolean;
  /** Fingerprint of the rule context used for the active generated schedule. */
  scheduleRuleFingerprint?: string;
  settings: ScheduleSettings;
  updatedAt: string;
}

export interface ScheduleResult {
  assignments: Assignment[];
  unfilledCount: number;
  warnings: string[];
  safetyCredential?: import("./domain/kernel/schedule-safety-credential").ScheduleSafetyCredential;
}

export type AppSection =
  | "overview"
  | "config"
  | "flights"
  | "schedule"
  | "policy"
  | "statistics"
  | "history";
