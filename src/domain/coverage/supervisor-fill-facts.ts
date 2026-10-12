import type { Assignment, Flight, PositionRule, Staff } from "../../model";
import {
  policyDiagnostic,
  type PolicyDiagnostic,
} from "../rules/policy-diagnostic";
import type { MobileSupervisorFillRule } from "../rules/structured-policy-contract";
import type {
  AssignmentEligibilityFacts,
  ScheduleGenerationFacts,
} from "../shared/scheduling-facts";
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

export interface SupervisorFillConfigurationIssue extends PolicyDiagnostic {
  code:
    | "source-flight-missing"
    | "source-position-missing"
    | "source-position-not-supervisor"
    | "target-flight-missing"
    | "target-position-missing"
    | "target-position-not-fill"
    | "no-operation-enabled"
    | "disabled"
    | "automatic-disabled"
    | "current-plan-not-applicable";
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

function positionsForKeyword(
  state: Pick<AssignmentEligibilityFacts, "positionRules">,
  flightNo: string,
  keyword: string
): PositionRule[] {
  return state.positionRules.filter(
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
  state: Pick<
    ScheduleGenerationFacts,
    "positionRules" | "flights" | "templates"
  >,
  rule: MobileSupervisorFillRule
): SupervisorFillConfigurationIssue | null {
  const issue = (
    code: SupervisorFillConfigurationIssue["code"],
    message: string,
    explanation: string,
    steps: string[],
    severity: PolicyDiagnostic["severity"] = "warning"
  ): SupervisorFillConfigurationIssue => ({
    ...policyDiagnostic(code, message, explanation, steps, severity),
    code,
  });
  if (!rule.enabled)
    return issue(
      "disabled",
      "已停用，保留配置",
      "这条关系的启用开关已关闭，不参与补位。",
      ["如需使用，在本条督导补位关系中打开“启用”。"],
      "info"
    );
  const configuredFlights = [...state.templates, ...state.flights];
  const sourceFlight = configuredFlights.find(
    (flight) => normalize(flight.flightNo) === normalize(rule.sourceFlightNo)
  );
  if (!sourceFlight)
    return issue(
      "source-flight-missing",
      `来源航班 ${rule.sourceFlightNo || "（空）"} 不存在，督导补位关系不会生效`,
      "航班模板和当前航班计划中都没有这个名称；不同航班号不会自动当作同一个航班。",
      [
        "在配置 → 航班计划模板核对准确航班号。",
        "回到规则 → 督导补位关系，将“来源航班”填成相同名称；若改过名，检查这里是否仍是旧名称。",
      ]
    );
  const sourceRules = positionsForKeyword(
    state,
    sourceFlight.flightNo,
    rule.sourcePositionKeyword
  );
  if (!sourceRules.length)
    return issue(
      "source-position-missing",
      `来源航班 ${sourceFlight.flightNo} 没有匹配“${rule.sourcePositionKeyword}”的岗位，督导补位关系不会生效`,
      "来源岗位关键词没有命中该航班的岗位名称。",
      [
        `在配置 → 岗位配置查看 ${sourceFlight.flightNo} 的岗位名称。`,
        "回到本条关系，修改“来源岗位”关键词，使它包含在正确的机动督导岗位名称中；关键词不能为空。",
      ]
    );
  if (!sourceRules.some((position) => position.category === "机动督导"))
    return issue(
      "source-position-not-supervisor",
      `来源岗位“${sourceRules[0]!.name}”不是机动督导，督导补位关系不会生效`,
      "匹配到的来源岗位均未设置为机动督导，不能充当补位来源。",
      [
        `在配置 → 岗位配置找到 ${sourceFlight.flightNo} 对应来源岗位，将“分类”设为“机动督导”；或改用已配置的机动督导岗位。`,
      ]
    );
  const targetFlight = configuredFlights.find(
    (flight) => normalize(flight.flightNo) === normalize(rule.targetFlightNo)
  );
  if (!targetFlight)
    return issue(
      "target-flight-missing",
      `目标航班 ${rule.targetFlightNo || "（空）"} 不存在，督导补位关系不会生效`,
      "航班模板和当前航班计划中都没有目标航班的名称。",
      [
        "在配置 → 航班计划模板核对航班号。",
        "回到本条关系，将“目标航班”填成准确名称，不要混用不同航班号。",
      ]
    );
  const targetRules = positionsForKeyword(
    state,
    targetFlight.flightNo,
    rule.targetPositionKeyword
  );
  if (!targetRules.length)
    return issue(
      "target-position-missing",
      `目标航班 ${targetFlight.flightNo} 没有匹配“${rule.targetPositionKeyword}”的岗位，督导补位关系不会生效`,
      "目标岗位关键词没有命中该航班的岗位名称。",
      [
        `在配置 → 岗位配置核对 ${targetFlight.flightNo} 的柜台名称。`,
        "在本条关系修改“目标岗位”关键词；关键词不能为空，并应包含在指定柜台名称中。",
      ]
    );
  if (
    !targetRules.some((position) => position.coverageRole === "supervisor-fill")
  )
    return issue(
      "target-position-not-fill",
      `目标岗位未标记为督导补位（${targetRules[0]!.name}），当前关系不会生效`,
      "只填来源与目标关系还不够；目标柜台也必须允许督导补位。",
      [
        `在配置 → 岗位配置找到 ${targetFlight.flightNo} / ${targetRules[0]!.name}。`,
        "将该岗位“补位性质”设为“督导补位”，再核对本条关系的目标岗位关键词。",
        "完整配置仍只在柜台缺人且没有安全普通候选时补位，不会强制替换已安排的普通人员。",
      ]
    );
  if (!rule.allowAutomatic && !rule.allowManual)
    return issue(
      "no-operation-enabled",
      "自动补位和人工补位均未开启，督导补位关系不会生效",
      "关系保留，但两个补位入口都已关闭。",
      [
        "需要生成时自动补位，打开本条关系的“自动补位”；需要手工补位，打开“人工补位”。",
      ],
      "info"
    );
  if (!rule.allowAutomatic)
    return issue(
      "automatic-disabled",
      "自动补位已关闭，仅允许人工补位",
      "自动生成排班不会使用这条关系，人工补位仍需通过安全检查。",
      ["如果希望生成排班时自动使用，在本条关系打开“自动补位”。"],
      "info"
    );
  const missingFromPlan = [rule.sourceFlightNo, rule.targetFlightNo].filter(
    (flightNo) =>
      !state.flights.some(
        (flight) => normalize(flight.flightNo) === normalize(flightNo)
      )
  );
  if (missingFromPlan.length)
    return issue(
      "current-plan-not-applicable",
      `当前航班计划未包含 ${[...new Set(missingFromPlan)].join("、")}，本次不适用`,
      "长期配置已能匹配，但当前班没有对应航班，因此这次不会执行这条补位关系。",
      [
        "在排班页点击“生成排班”或“重新排班”，在准备确认窗口勾选对应航班。",
        "如模板已经改名、当前班仍有旧名称，在配置页“航班计划模板”下展开“检查当前航班名称”，为旧航班选择正确模板并确认修正；也可在准备窗口取消旧航班并勾选正确模板。",
        "本次不需要该航班时可以保留此配置，无需修改；是否能实际补位仍取决于人员和安全条件。",
      ],
      "info"
    );
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
