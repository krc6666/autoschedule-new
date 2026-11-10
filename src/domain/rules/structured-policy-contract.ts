export interface PositionTransitionPolicy {
  id: string;
  name: string;
  enabled: boolean;
  sourceFlightNo: string;
  sourcePositions: string[];
  targetFlightNo: string;
  targetPosition: string;
  minimumGapMinutes: number;
  mode: "prefer" | "forbid";
}

export interface DutyPositionPriority {
  id: string;
  flightNo: string;
  positionKeyword: string;
  enabled: boolean;
}

export interface NextWorkdayRecoveryTarget {
  id: string;
  flightNo: string;
  positionKeyword: string;
  enabled: boolean;
}

export interface LateShiftRecoveryPositionRule {
  id: string;
  enabled: boolean;
  flightNo: string;
  matchField: "position" | "remark";
  keyword: string;
  nextWorkdayCutoffTime: string;
}

export interface MobileSupervisorCoverageRule {
  id: string;
  enabled: boolean;
  flightNo: string;
  matchField: "position" | "remark";
  keyword: string;
  mode: "allow" | "forbid";
}

export interface MobileSupervisorFillRule {
  id: string;
  enabled: boolean;
  sourceFlightNo: string;
  sourcePositionKeyword: string;
  targetFlightNo: string;
  targetPositionKeyword: string;
  allowAutomatic: boolean;
  allowManual: boolean;
  /** Unresolved legacy configuration cannot grant runtime fill permission. */
  requiresConfirmation?: boolean;
}

export interface CrossWorkdayQualificationReservation {
  id: string;
  enabled: boolean;
  flightNo: string;
  matchField: "position" | "remark";
  keyword: string;
  minimumStaffCount: number;
}

export interface CrossFlightPriorityPolicy {
  id: string;
  enabled: boolean;
  flightNo: string;
  staffIds: string[];
}

export interface SameFlightStaffExclusion {
  id: string;
  enabled: boolean;
  firstStaffId: string;
  secondStaffId: string;
  /** Empty means every flight. */
  flightNo: string;
}

export interface TeamLeaderGapFillPositionPolicy {
  flightNo: string;
  position: string;
  movable: boolean;
}

export interface StructuredSchedulePolicies {
  sameFlightStaffExclusions: SameFlightStaffExclusion[];
  positionTransitionPolicies: PositionTransitionPolicy[];
  dutyPositionPriorities: DutyPositionPriority[];
  nextWorkdayRecoveryTargets: NextWorkdayRecoveryTarget[];
  lateShiftRecoveryPositionRules: LateShiftRecoveryPositionRule[];
  mobileSupervisorCoverageRules: MobileSupervisorCoverageRule[];
  mobileSupervisorFillRules: MobileSupervisorFillRule[];
  crossWorkdayQualificationReservations: CrossWorkdayQualificationReservation[];
  crossFlightPriorityPolicies: CrossFlightPriorityPolicy[];
  teamLeaderGapFillPositionPolicies: TeamLeaderGapFillPositionPolicy[];
}

export type StructuredPolicyKey = keyof StructuredSchedulePolicies;
