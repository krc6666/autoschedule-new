import type { Assignment } from "../../model";
import type { AssignmentEligibilityFacts } from "../shared/scheduling-facts";
import {
  diagnoseManualAssignmentEligibility,
  type AssignmentEligibilityViolation,
  type AssignmentEligibilityViolationCode,
} from "./assignment-eligibility";

const WARNING_CODES: ReadonlySet<AssignmentEligibilityViolationCode> = new Set([
  "position-qualification",
  "time-conflict",
  "daily-hours",
  "minimum-flight-transition",
  "position-transition",
  "same-flight-staff-exclusion",
  "same-airline-priority",
]);

export interface ManualAssignmentEvaluation {
  allowed: boolean;
  blockers: AssignmentEligibilityViolation[];
  warnings: AssignmentEligibilityViolation[];
}

export function evaluateManualAssignment(
  state: AssignmentEligibilityFacts,
  assignmentId: string,
  staffId: string,
  ignoreAssignmentId?: string
): ManualAssignmentEvaluation {
  const diagnostic = diagnoseManualAssignmentEligibility(
    state,
    assignmentId,
    staffId,
    ignoreAssignmentId
  );
  const warnings = diagnostic.violations.filter((item) =>
    WARNING_CODES.has(item.code)
  );
  const blockers = diagnostic.violations.filter(
    (item) => !WARNING_CODES.has(item.code)
  );
  return { allowed: blockers.length === 0, blockers, warnings };
}

export function replaceManualOverrideWarnings(
  assignment: Assignment,
  warnings: readonly AssignmentEligibilityViolation[]
): void {
  if (warnings.length) {
    assignment.manualOverrideWarnings = warnings.map(({ code, message }) => ({
      code,
      message,
    }));
  } else {
    delete assignment.manualOverrideWarnings;
  }
}

export function manualOverrideWarningMessage(
  assignments: readonly Assignment[]
): string | undefined {
  const messages = [
    ...new Set(
      assignments.flatMap((item) =>
        (item.manualOverrideWarnings ?? []).map((warning) => warning.message)
      )
    ),
  ];
  return messages.length
    ? `人工调整已保留，突破以下限制：\n${messages.join("\n")}`
    : undefined;
}

export function isManualOverrideSafetyReason(reason: string): boolean {
  return [
    "没有具备双向岗位资质的人员",
    "交换后会产生时间冲突",
    "交换后超过每日工时上限",
    "交换后违反严格岗位衔接保护",
    "少于要求的",
  ].some((marker) => reason.includes(marker));
}
