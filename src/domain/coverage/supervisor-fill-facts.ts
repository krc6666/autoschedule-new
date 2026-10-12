import type { Assignment, Flight, PositionRule, Staff } from "../../model";
import type { MobileSupervisorFillRule } from "../rules/structured-policy-contract";
import type { AssignmentEligibilityFacts } from "../shared/scheduling-facts";
import { evaluateAutomaticHardConstraints } from "../rules/built-in-rule-registry";
import { assignmentRule } from "../flights/schedule-position-rules";
import { isDisplayOnlyGuideReuse } from "../candidates/assignment-eligibility-facts";

export type SupervisorFillMode = "automatic" | "manual";

export interface SupervisorFillEvaluation {
  allowed: boolean;
  reason: string | null;
  rule: MobileSupervisorFillRule | null;
  hasSafeRegularCandidate: boolean;
}

export interface SupervisorFillConfigurationIssue {
  code:
    | "source-flight-missing"
    | "source-position-missing"
    | "source-position-not-supervisor"
    | "target-flight-missing"
    | "target-position-missing"
    | "target-position-not-fill"
    | "no-operation-enabled";
  message: string;
}

export function clearSupervisorFillRule(
  target: Pick<Assignment, "supervisorFillRuleId">
): void {
  delete target.supervisorFillRuleId;
}

export function clearSupervisorFillLink(
  target: Pick<
    Assignment,
    "supervisorSourceAssignmentId" | "supervisorFillRuleId"
  >
): void {
  delete target.supervisorSourceAssignmentId;
  clearSupervisorFillRule(target);
}

export function setSupervisorFillLink(
  target: Pick<
    Assignment,
    "supervisorSourceAssignmentId" | "supervisorFillRuleId"
  >,
  sourceAssignmentId: string,
  fillRuleId?: string
): void {
  target.supervisorSourceAssignmentId = sourceAssignmentId;
  if (fillRuleId) target.supervisorFillRuleId = fillRuleId;
  else clearSupervisorFillRule(target);
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN");
}

function matches(value: string, keyword: string): boolean {
  const normalizedKeyword = normalize(keyword);
  return (
    Boolean(normalizedKeyword) && normalize(value).includes(normalizedKeyword)
  );
}

function positionForKeyword(
  state: Pick<AssignmentEligibilityFacts, "positionRules">,
  flightNo: string,
  keyword: string
): PositionRule | undefined {
  return state.positionRules.find(
    (rule) =>
      normalize(rule.flightNo) === normalize(flightNo) &&
      matches(rule.name, keyword)
  );
}

/**
 * Checks the configuration-only part of a supervisor-fill relationship.
 * Runtime assignment eligibility remains owned by evaluateSupervisorFillFacts.
 */
export function diagnoseSupervisorFillRuleConfiguration(
  state: Pick<AssignmentEligibilityFacts, "positionRules" | "flights">,
  rule: MobileSupervisorFillRule
): SupervisorFillConfigurationIssue | null {
  const sourceFlight = state.flights.find(
    (flight) => normalize(flight.flightNo) === normalize(rule.sourceFlightNo)
  );
  if (!sourceFlight)
    return {
      code: "source-flight-missing",
      message: `来源航班 ${rule.sourceFlightNo || "（空）"} 不存在，督导补位关系不会生效`,
    };
  const sourceRule = positionForKeyword(
    state,
    sourceFlight.flightNo,
    rule.sourcePositionKeyword
  );
  if (!sourceRule)
    return {
      code: "source-position-missing",
      message: `来源航班 ${sourceFlight.flightNo} 没有匹配“${rule.sourcePositionKeyword}”的岗位，督导补位关系不会生效`,
    };
  if (sourceRule.category !== "机动督导")
    return {
      code: "source-position-not-supervisor",
      message: `来源岗位“${sourceRule.name}”不是机动督导，督导补位关系不会生效`,
    };
  const targetFlight = state.flights.find(
    (flight) => normalize(flight.flightNo) === normalize(rule.targetFlightNo)
  );
  if (!targetFlight)
    return {
      code: "target-flight-missing",
      message: `目标航班 ${rule.targetFlightNo || "（空）"} 不存在，督导补位关系不会生效`,
    };
  const targetRule = positionForKeyword(
    state,
    targetFlight.flightNo,
    rule.targetPositionKeyword
  );
  if (!targetRule)
    return {
      code: "target-position-missing",
      message: `目标航班 ${targetFlight.flightNo} 没有匹配“${rule.targetPositionKeyword}”的岗位，督导补位关系不会生效`,
    };
  if (targetRule.coverageRole !== "supervisor-fill")
    return {
      code: "target-position-not-fill",
      message: `目标岗位未标记为督导补位（${targetRule.name}），当前关系不会生效`,
    };
  if (!rule.allowAutomatic && !rule.allowManual)
    return {
      code: "no-operation-enabled",
      message: "自动补位和人工补位均未开启，督导补位关系不会生效",
    };
  return null;
}

function matchingRule(
  state: AssignmentEligibilityFacts,
  sourceFlight: Flight,
  sourceRule: PositionRule,
  targetFlight: Flight,
  targetRule: PositionRule,
  mode: SupervisorFillMode
): MobileSupervisorFillRule | undefined {
  return state.settings.mobileSupervisorFillRules.find(
    (rule) =>
      rule.enabled &&
      (mode === "automatic" ? rule.allowAutomatic : rule.allowManual) &&
      normalize(rule.sourceFlightNo) === normalize(sourceFlight.flightNo) &&
      matches(sourceRule.name, rule.sourcePositionKeyword) &&
      normalize(rule.targetFlightNo) === normalize(targetFlight.flightNo) &&
      matches(targetRule.name, rule.targetPositionKeyword)
  );
}

function assignmentFlight(
  state: AssignmentEligibilityFacts,
  assignment: Assignment
): Flight | undefined {
  return state.flights.find((flight) => flight.id === assignment.flightId);
}

function safeRegularCandidate(
  state: AssignmentEligibilityFacts,
  assignments: readonly Assignment[],
  target: Assignment,
  targetFlight: Flight,
  targetRule: PositionRule,
  sourceStaffId: string
): Staff | undefined {
  const otherAssignments = assignments.filter(
    (assignment) => assignment.id !== target.id
  );
  return state.staff.find(
    (person) =>
      person.id !== sourceStaffId &&
      evaluateAutomaticHardConstraints({
        state,
        assignments: [...otherAssignments],
        flight: targetFlight,
        rule: targetRule,
        person,
        workHours: target.workHours,
        transitionMode: "forbid",
      }).eligible
  );
}

export interface SupervisorFillEvaluationOptions {
  /**
   * When true, skip the "safe regular still available" gate.
   * Use for validating recorded links and for shortage-prefer configured fill
   * after prepare has already committed to binding the supervisor onto the
   * configured fill counter.
   */
  ignoreSafeRegularCandidate?: boolean;
}

export function evaluateSupervisorFillFacts(
  state: AssignmentEligibilityFacts,
  assignments: readonly Assignment[],
  source: Assignment,
  target: Assignment,
  mode: SupervisorFillMode,
  options: SupervisorFillEvaluationOptions = {}
): SupervisorFillEvaluation {
  const sourceRule = assignmentRule(state, source);
  const targetRule = assignmentRule(state, target);
  const sourceFlight = assignmentFlight(state, source);
  const targetFlight = assignmentFlight(state, target);
  if (!sourceRule || !targetRule || !sourceFlight || !targetFlight)
    return {
      allowed: false,
      reason: "来源督导或目标岗位不存在",
      rule: null,
      hasSafeRegularCandidate: false,
    };
  if (sourceRule.category !== "机动督导")
    return {
      allowed: false,
      reason: "来源岗位不是机动督导",
      rule: null,
      hasSafeRegularCandidate: false,
    };
  if (targetRule.coverageRole !== "supervisor-fill")
    return {
      allowed: false,
      reason: "目标岗位未标记为督导补位",
      rule: null,
      hasSafeRegularCandidate: false,
    };
  const rule = matchingRule(
    state,
    sourceFlight,
    sourceRule,
    targetFlight,
    targetRule,
    mode
  );
  if (!rule)
    return {
      allowed: false,
      reason: "没有启用且允许当前操作的督导补位关系",
      rule: null,
      hasSafeRegularCandidate: false,
    };
  if (source.status !== "assigned" || !source.staffId || !source.staffName)
    return {
      allowed: false,
      reason: "来源机动督导尚未安排人员",
      rule,
      hasSafeRegularCandidate: false,
    };
  const person = state.staff.find(
    (candidate) => candidate.id === source.staffId
  );
  if (!person)
    return {
      allowed: false,
      reason: "来源机动督导人员不存在",
      rule,
      hasSafeRegularCandidate: false,
    };
  const regularCandidate = safeRegularCandidate(
    state,
    assignments,
    target,
    targetFlight,
    targetRule,
    person.id
  );
  if (regularCandidate && !options.ignoreSafeRegularCandidate)
    return {
      allowed: false,
      reason: `${regularCandidate.name}仍可安全承担${target.flightNo}/${target.position}`,
      rule,
      hasSafeRegularCandidate: true,
    };
  const fillRule: PositionRule = {
    ...targetRule,
    qualifiedStaffIds: [person.id],
  };
  const otherAssignments = assignments.filter((assignment) => {
    if (assignment.id === target.id) return false;
    if (isDisplayOnlyGuideReuse(state, assignments, assignment)) return false;
    return source.flightId === target.flightId
      ? assignment.id !== source.id
      : true;
  });
  const eligibility = evaluateAutomaticHardConstraints({
    state,
    assignments: [...otherAssignments],
    flight: targetFlight,
    rule: fillRule,
    person,
    workHours: 0,
    transitionMode: "forbid",
  });
  if (!eligibility.eligible)
    return {
      allowed: false,
      reason: eligibility.violations[0]?.message ?? "督导补位未通过安全检查",
      rule,
      hasSafeRegularCandidate: false,
    };
  return {
    allowed: true,
    reason: null,
    rule,
    hasSafeRegularCandidate: false,
  };
}

export function hasRecordedSupervisorFillLink(
  evaluation: SupervisorFillEvaluation,
  target: Pick<Assignment, "supervisorFillRuleId">
): boolean {
  return Boolean(
    evaluation.allowed &&
    evaluation.rule &&
    target.supervisorFillRuleId === evaluation.rule.id
  );
}
