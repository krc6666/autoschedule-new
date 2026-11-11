import type { RotationReview } from "../reviews/reassignment-safety-policy";

export type CrossWorkdayReservationDisposition =
  "preserve" | "yield-to-selected-vacancy";

export type ReassignmentIntent =
  | { kind: "mobile-supervisor-counter-coverage" }
  | { kind: "configured-supervisor-fill-under-shortage" }
  | { kind: "team-leader-concurrent-gap-fill" }
  | { kind: "late-priority-frequency-review" }
  | { kind: "ke166-rotation-review" }
  | { kind: "consecutive-rotation-review" }
  | { kind: "late-shift-recovery-review" }
  | { kind: "position-frequency-review" }
  | { kind: "manual-swap-analysis" }
  | { kind: "next-workday-cutoff-recovery" }
  | {
      kind: "team-leader-gap-fill";
      crossWorkdayReservation: CrossWorkdayReservationDisposition;
    };

export interface ReassignmentIntentPolicy {
  allowWorkloadBalanceRegression: boolean;
  allowCutoffProtectionRegression: boolean;
  allowCrossWorkdayRecoveryRegression: boolean;
  allowCrossWorkdayReservationRegression: boolean;
  allowCrossFlightPriorityRegression: boolean;
  allowLoadProtectionRegression: boolean;
  allowPositionTransitionRegression: boolean;
  allowTr121CooldownRegression: boolean;
  allowDirectGuideReassignment: boolean;
  allowDutyFlightCountRegression: boolean;
}

export function reassignmentIntentReview(
  intent: ReassignmentIntent
): RotationReview {
  switch (intent.kind) {
    case "mobile-supervisor-counter-coverage":
    case "configured-supervisor-fill-under-shortage":
      return "mobile-supervisor";
    case "team-leader-concurrent-gap-fill":
    case "team-leader-gap-fill":
      return "coverage";
    case "late-priority-frequency-review":
      return "late-frequency";
    case "ke166-rotation-review":
    case "consecutive-rotation-review":
      return "consecutive";
    case "position-frequency-review":
      return "frequency";
    case "late-shift-recovery-review":
    case "manual-swap-analysis":
    case "next-workday-cutoff-recovery":
      return "recovery";
  }
}

const STRICT_REASSIGNMENT_POLICY: ReassignmentIntentPolicy = {
  allowWorkloadBalanceRegression: false,
  allowCutoffProtectionRegression: false,
  allowCrossWorkdayRecoveryRegression: false,
  allowCrossWorkdayReservationRegression: false,
  allowCrossFlightPriorityRegression: false,
  allowLoadProtectionRegression: false,
  allowPositionTransitionRegression: false,
  allowTr121CooldownRegression: false,
  allowDirectGuideReassignment: false,
  allowDutyFlightCountRegression: false,
};

export function reassignmentIntentPolicy(
  intent: ReassignmentIntent
): ReassignmentIntentPolicy {
  switch (intent.kind) {
    case "manual-swap-analysis":
      return {
        ...STRICT_REASSIGNMENT_POLICY,
        allowDutyFlightCountRegression: true,
      };
    case "next-workday-cutoff-recovery":
      return {
        ...STRICT_REASSIGNMENT_POLICY,
        allowWorkloadBalanceRegression: true,
        allowCutoffProtectionRegression: true,
      };
    case "team-leader-gap-fill":
      return {
        ...STRICT_REASSIGNMENT_POLICY,
        allowCrossWorkdayRecoveryRegression: true,
        allowCrossWorkdayReservationRegression:
          intent.crossWorkdayReservation === "yield-to-selected-vacancy",
        allowLoadProtectionRegression: true,
        allowDirectGuideReassignment: true,
      };
    case "configured-supervisor-fill-under-shortage":
      return {
        ...STRICT_REASSIGNMENT_POLICY,
        allowWorkloadBalanceRegression: true,
        allowCutoffProtectionRegression: true,
        allowCrossWorkdayRecoveryRegression: true,
        allowCrossWorkdayReservationRegression: true,
        allowCrossFlightPriorityRegression: true,
        allowLoadProtectionRegression: true,
        allowPositionTransitionRegression: true,
        allowTr121CooldownRegression: true,
      };
    case "mobile-supervisor-counter-coverage":
    case "team-leader-concurrent-gap-fill":
    case "late-priority-frequency-review":
    case "ke166-rotation-review":
    case "consecutive-rotation-review":
    case "late-shift-recovery-review":
    case "position-frequency-review":
      return STRICT_REASSIGNMENT_POLICY;
  }
}
