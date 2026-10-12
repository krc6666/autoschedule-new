import type { MobileSupervisorCoverageRule } from "../rules/structured-policy-contract";
import type { ScheduleSettingsFacts } from "../shared/scheduling-facts";

export interface MobileSupervisorCoverageTarget {
  flightNo: string;
  position: string;
  remark: string;
}

export interface MobileSupervisorCoverageEvaluation {
  allowed: boolean;
  reason: string | null;
  rule: MobileSupervisorCoverageRule | null;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN");
}

function appliesToFlight(
  rule: MobileSupervisorCoverageRule,
  flightNo: string
): boolean {
  return (
    !normalize(rule.flightNo) ||
    normalize(rule.flightNo) === normalize(flightNo)
  );
}

function matchesTarget(
  rule: MobileSupervisorCoverageRule,
  target: MobileSupervisorCoverageTarget
): boolean {
  const keyword = normalize(rule.keyword);
  if (!keyword) return false;
  const value = rule.matchField === "remark" ? target.remark : target.position;
  return normalize(value).includes(keyword);
}

export function mobileSupervisorCoverageRuleMatchesTarget(
  rule: MobileSupervisorCoverageRule,
  target: MobileSupervisorCoverageTarget
): boolean {
  return (
    rule.enabled &&
    appliesToFlight(rule, target.flightNo) &&
    matchesTarget(rule, target)
  );
}

export function evaluateMobileSupervisorCoverage(
  state: ScheduleSettingsFacts,
  target: MobileSupervisorCoverageTarget
): MobileSupervisorCoverageEvaluation {
  const applicable = state.settings.mobileSupervisorCoverageRules.filter(
    (rule) =>
      rule.enabled &&
      appliesToFlight(rule, target.flightNo) &&
      normalize(rule.keyword)
  );
  const forbidden = applicable.find(
    (rule) =>
      rule.mode === "forbid" &&
      mobileSupervisorCoverageRuleMatchesTarget(rule, target)
  );
  if (forbidden) {
    const field = forbidden.matchField === "remark" ? "岗位备注" : "岗位名称";
    return {
      allowed: false,
      reason: `命中禁止规则：${field}包含“${forbidden.keyword}”`,
      rule: forbidden,
    };
  }
  const allowedRules = applicable.filter((rule) => rule.mode === "allow");
  if (
    allowedRules.length &&
    !allowedRules.some((rule) =>
      mobileSupervisorCoverageRuleMatchesTarget(rule, target)
    )
  ) {
    return {
      allowed: false,
      reason: "该岗位不在当前航班的允许兼任范围内",
      rule: null,
    };
  }
  return { allowed: true, reason: null, rule: null };
}

export function canMobileSupervisorCoverPosition(
  state: ScheduleSettingsFacts,
  target: MobileSupervisorCoverageTarget
): boolean {
  return evaluateMobileSupervisorCoverage(state, target).allowed;
}
