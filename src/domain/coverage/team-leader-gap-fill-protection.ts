import type { Assignment, PositionRule } from "../../model";
import type { TeamLeaderGapFillPositionPolicy } from "../rules/structured-policy-contract";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import {
  assignmentRule,
  isGapFillGuidePosition,
} from "../flights/schedule-position-rules";
import { isOrdinaryPriorityPosition } from "../reviews/position-rotation-policy";

export interface TeamLeaderGapFillPositionDisposition {
  movable: boolean;
  fixed: boolean;
  reason: string;
}

export function teamLeaderGapFillPositionKey(
  flightNo: string,
  position: string
): string {
  return `${flightNo.trim().toUpperCase()}\u0000${position.trim().toUpperCase()}`;
}

export function replaceTeamLeaderGapFillPositionReference(
  policies: readonly TeamLeaderGapFillPositionPolicy[],
  previous: Pick<PositionRule, "flightNo" | "name">,
  next: Pick<PositionRule, "flightNo" | "name">
): TeamLeaderGapFillPositionPolicy[] {
  const previousKey = teamLeaderGapFillPositionKey(
    previous.flightNo,
    previous.name
  );
  const unique = new Map<string, TeamLeaderGapFillPositionPolicy>();
  for (const policy of policies) {
    const matched =
      teamLeaderGapFillPositionKey(policy.flightNo, policy.position) ===
      previousKey;
    const updated = matched
      ? {
          ...policy,
          flightNo: next.flightNo.trim().toUpperCase(),
          position: next.name.trim(),
        }
      : policy;
    unique.set(
      teamLeaderGapFillPositionKey(updated.flightNo, updated.position),
      updated
    );
  }
  return [...unique.values()];
}

export function removeTeamLeaderGapFillPositionReference(
  policies: readonly TeamLeaderGapFillPositionPolicy[],
  rule: Pick<PositionRule, "flightNo" | "name">
): TeamLeaderGapFillPositionPolicy[] {
  const key = teamLeaderGapFillPositionKey(rule.flightNo, rule.name);
  return policies.filter(
    (policy) =>
      teamLeaderGapFillPositionKey(policy.flightNo, policy.position) !== key
  );
}

export function fixedTeamLeaderGapFillPositionReason(
  rule: Pick<PositionRule, "flightNo" | "category" | "manual">
): string | null {
  if (/^KE\s*166$/i.test(rule.flightNo.trim())) return "KE166岗位";
  if (rule.manual) return "人工岗位";
  if (rule.category === "行政支援") return "行政支援岗位";
  return null;
}

/** Filling an empty target does not grant permission to move an occupied source. */
export function isTeamLeaderGapFillVacancy(
  state: Pick<ScheduleGenerationFacts, "positionRules">,
  assignment: Assignment
): boolean {
  const rule = assignmentRule(state, assignment);
  return Boolean(
    assignment.status === "unfilled" &&
    !assignment.staffId &&
    rule &&
    (rule.category === "常规" || rule.category === "机动督导") &&
    !fixedTeamLeaderGapFillPositionReason({
      ...rule,
      flightNo: assignment.flightNo,
    })
  );
}

export function teamLeaderGapFillPositionDisposition(
  state: Pick<ScheduleGenerationFacts, "settings">,
  rule: PositionRule
): TeamLeaderGapFillPositionDisposition {
  const fixedReason = fixedTeamLeaderGapFillPositionReason(rule);
  if (fixedReason) return { movable: false, fixed: true, reason: fixedReason };

  const override = state.settings.teamLeaderGapFillPositionPolicies.find(
    (policy) =>
      teamLeaderGapFillPositionKey(policy.flightNo, policy.position) ===
      teamLeaderGapFillPositionKey(rule.flightNo, rule.name)
  );
  if (override)
    return {
      movable: override.movable,
      fixed: false,
      reason: override.movable ? "规则页已允许移动" : "规则页设为保护",
    };

  if (
    isOrdinaryPriorityPosition(rule, state.settings.ordinaryPriorityPositions)
  )
    return { movable: false, fixed: false, reason: "普通重点岗位默认保护" };
  if (rule.category === "常规" || isGapFillGuidePosition(rule))
    return { movable: true, fixed: false, reason: "默认允许移动" };
  return {
    movable: false,
    fixed: false,
    reason: `${rule.category}岗位默认保护`,
  };
}

export function teamLeaderGapFillAssignmentProtectionReasons(
  state: ScheduleGenerationFacts,
  assignment: Assignment,
  dutyStaffId: string | null
): string[] {
  const rule = assignmentRule(state, assignment);
  const person = assignment.staffId
    ? state.staff.find((item) => item.id === assignment.staffId)
    : undefined;
  const reasons: string[] = [];
  if (assignment.status !== "assigned" || !assignment.staffId)
    reasons.push("不是有效已排岗位");
  if (!rule) reasons.push("岗位规则不存在");
  if (/^KE\s*166$/i.test(assignment.flightNo.trim())) reasons.push("KE166岗位");
  if (assignment.staffId === dutyStaffId) reasons.push("值班人员当前岗位");
  if (assignment.layoutGroup !== undefined) reasons.push("特殊布局岗位");
  if (assignment.supervisorSourceAssignmentId !== undefined)
    reasons.push("督导兼任关联岗位");
  if (assignment.teamLeaderGapFill === true) reasons.push("已补差落地岗位");
  if (person?.staffType === "行政支援") reasons.push("行政支援人员岗位");
  if (rule) {
    const disposition = teamLeaderGapFillPositionDisposition(state, rule);
    if (!disposition.movable) reasons.push(disposition.reason);
  }
  return [...new Set(reasons)];
}
