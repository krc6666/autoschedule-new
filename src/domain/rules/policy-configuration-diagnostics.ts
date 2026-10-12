import type { PositionRule, ScheduleGroupId, Staff } from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import { diagnoseSupervisorFillRuleConfiguration } from "../coverage/supervisor-fill-facts";
import {
  evaluateMobileSupervisorCoverage,
  mobileSupervisorCoverageRuleMatchesTarget,
} from "../coverage/mobile-supervisor-coverage";
import {
  matchesDutyPositionPriority,
  normalizeDutyPriorityFlightNo,
} from "../assignments/duty-assignment";
import { matchingPositionRules } from "../reviews/cross-workday-qualification-reservation";
import {
  matchingLateShiftRecoveryPositionRules,
  matchesNextWorkdayRecoveryTarget,
} from "../reviews/cross-day-recovery";
import { normalizedPolicyValue } from "../reviews/schedule-protection";
import { isOrdinaryPriorityPosition } from "../reviews/position-rotation-policy";
import {
  latePriorityFlightInScope,
  latePriorityFlightScopeCandidates,
} from "../statistics/late-priority-flight-scope";
import { teamLeaderGapFillPositionKey } from "../coverage/team-leader-gap-fill-protection";
import { STRUCTURED_POLICY_DEFINITIONS } from "./structured-policy-settings";
import { SCHEDULE_SETTING_DEFINITIONS } from "./schedule-settings";
import type { StructuredPolicyKey } from "./structured-policy-contract";
import { policyDiagnostic, type PolicyDiagnostic } from "./policy-diagnostic";

type DiagnosedKey = Exclude<
  StructuredPolicyKey,
  "teamLeaderGapFillPositionPolicies"
>;
export interface PolicyConfigurationFacts extends Pick<
  ScheduleGenerationFacts,
  "staff" | "flights" | "templates" | "positionRules" | "settings" | "history"
> {
  activeGroupId: ScheduleGroupId;
  groups: Record<ScheduleGroupId, { staff: Staff[] }>;
}
const normalized = (value: string) => value.trim().toUpperCase();
const target = (rule: PositionRule) => ({
  flightNo: rule.flightNo,
  position: rule.name,
  remark: rule.remark,
});

function flightIssue(
  state: PolicyConfigurationFacts,
  flightNo: string,
  field: string,
  optional = false,
  normalize = normalized
): PolicyDiagnostic | null {
  if (optional && !flightNo.trim()) return null;
  if (
    flightNo.trim() &&
    [...state.templates, ...state.flights].some(
      (flight) => normalize(flight.flightNo) === normalize(flightNo)
    )
  )
    return null;
  return policyDiagnostic(
    "flight-missing",
    `${field} ${flightNo || "（空）"} 没有对应航班配置`,
    "模板和当前计划中没有这个航班号；不同名称不会自动转换，可能仍引用改名前的名称。",
    [
      "在配置 → 航班计划模板核对准确航班号。",
      `回到本条规则，将“${field}”改成模板中的名称；如需要新增航班，先建立模板与岗位配置。`,
    ]
  );
}

function unmatchedPosition(
  field: string,
  keyword: string,
  matchField: "keyword" | "position" | "remark" | "exact"
): PolicyDiagnostic {
  return policyDiagnostic(
    "position-missing",
    `${field}“${keyword || "（空）"}”没有匹配岗位`,
    "规则已保存，但没有对应的岗位，所以无法执行。",
    [
      "在配置 → 岗位配置核对对应航班的岗位名称和备注。",
      matchField === "exact"
        ? `回到本条规则，将“${field}”填写为完整岗位名，不能只填写部分关键词。`
        : `回到本条规则修改“${field}”关键词，使它包含在对应${matchField === "position" ? "岗位名称" : matchField === "remark" ? "岗位备注" : "岗位名称或备注"}中。${matchField === "position" || matchField === "remark" ? "如关键词在另一个字段中，应修改本条“匹配位置”。" : ""}`,
    ]
  );
}

function notInPlan(
  state: PolicyConfigurationFacts,
  flightNo: string,
  normalize = normalized
): PolicyDiagnostic[] {
  if (
    !flightNo.trim() ||
    state.flights.some(
      (flight) => normalize(flight.flightNo) === normalize(flightNo)
    )
  )
    return [];
  return [
    policyDiagnostic(
      "current-plan-not-applicable",
      `当前航班计划未包含 ${flightNo}，本次不适用`,
      "长期配置存在，这次没有安排该航班，不属于配置丢失。",
      [
        "本次需要该航班时，在排班页的生成或重新排班准备确认窗口勾选它。",
        "模板改名后，当前班旧航班仍会保留；取消旧名称，再勾选正确模板。",
        "本次不需要该航班时，无需修改这条规则。",
      ],
      "info"
    ),
  ];
}

/** Configuration references only. Runtime candidate/safety decisions remain with their existing owners. */
export function diagnosePolicyConfiguration(
  state: PolicyConfigurationFacts,
  key: DiagnosedKey,
  id: string
): PolicyDiagnostic[] {
  const configured = state.settings[key].find((item) => item.id === id);
  if (!configured) return [];
  if (!configured.enabled)
    return [
      policyDiagnostic(
        "disabled",
        "已停用，保留配置",
        "本条规则的启用开关已关闭。",
        ["需要执行时，打开本条规则的“启用”。"],
        "info"
      ),
    ];
  if (key === "mobileSupervisorFillRules") {
    const rule = state.settings.mobileSupervisorFillRules.find(
      (item) => item.id === id
    )!;
    const issue = diagnoseSupervisorFillRuleConfiguration(state, rule);
    return issue ? [issue] : [];
  }
  const issues: PolicyDiagnostic[] = [];
  const currentStaffIds = new Set(state.staff.map((person) => person.id));
  const otherGroupId = state.activeGroupId === "A" ? "B" : "A";
  const knownStaffIds = new Set([
    ...currentStaffIds,
    ...state.groups[otherGroupId].staff.map((person) => person.id),
  ]);
  const otherGroupIssue = () =>
    policyDiagnostic(
      "other-group",
      "本条人员不在当前组，本次不适用",
      "其他组的人员配置仍保留，不能因为当前组名单没有他就当作已删除。",
      [
        "需要使用这条人员规则时，先切换到对应组；需要本组执行时，在本条规则选择本组人员。",
      ],
      "info"
    );
  const checkFlight = (
    flightNo: string,
    field: string,
    optional = false,
    normalize = normalized
  ) => {
    const issue = flightIssue(state, flightNo, field, optional, normalize);
    if (issue) issues.push(issue);
  };
  const checkPositions = (
    matches: readonly PositionRule[],
    field: string,
    keyword: string,
    matchField: "keyword" | "position" | "remark" | "exact" = "keyword"
  ) => {
    if (!matches.length)
      issues.push(unmatchedPosition(field, keyword, matchField));
  };
  switch (key) {
    case "sameFlightStaffExclusions": {
      const rule = state.settings.sameFlightStaffExclusions.find(
        (item) => item.id === id
      )!;
      checkFlight(rule.flightNo, "适用航班", true);
      if (
        !rule.firstStaffId ||
        !rule.secondStaffId ||
        rule.firstStaffId === rule.secondStaffId ||
        [rule.firstStaffId, rule.secondStaffId].some(
          (staffId) => !knownStaffIds.has(staffId)
        )
      )
        issues.push(
          policyDiagnostic(
            "staff-reference-invalid",
            "互斥人员未选齐、已删除或重复",
            "互斥需要两名不同的现有人员；人员当前休假不会使这条长期规则失效。",
            [
              "在本条规则重新选择“人员 A”和“人员 B”，确保是两名不同人员。",
              "人员列表中没有所需人员时，先在配置 → 人员配置中建立人员。",
            ]
          )
        );
      if (
        !issues.length &&
        (!currentStaffIds.has(rule.firstStaffId) ||
          !currentStaffIds.has(rule.secondStaffId))
      )
        return [otherGroupIssue()];
      return issues.length ? issues : notInPlan(state, rule.flightNo);
    }
    case "crossFlightPriorityPolicies": {
      const rule = state.settings.crossFlightPriorityPolicies.find(
        (item) => item.id === id
      )!;
      checkFlight(rule.flightNo, "优先航班");
      if (
        !rule.staffIds.length ||
        rule.staffIds.some((staffId) => !knownStaffIds.has(staffId))
      )
        issues.push(
          policyDiagnostic(
            "staff-reference-invalid",
            "优先人员未选择或含已删除人员",
            "没有有效的人员关联就不能使用优先配置；优先人员仍需满足当天安全条件。",
            ["在本条规则的“优先人员”重新勾选现有人员；人员删除后应清理旧关联。"]
          )
        );
      if (
        !issues.length &&
        !rule.staffIds.some((staffId) => currentStaffIds.has(staffId))
      )
        return [otherGroupIssue()];
      return issues.length ? issues : notInPlan(state, rule.flightNo);
    }
    case "dutyPositionPriorities": {
      const rule = state.settings.dutyPositionPriorities.find(
        (item) => item.id === id
      )!;
      checkFlight(
        rule.flightNo,
        "航班号",
        false,
        normalizeDutyPriorityFlightNo
      );
      checkPositions(
        state.positionRules.filter((position) =>
          matchesDutyPositionPriority(rule, target(position))
        ),
        "岗位或备注关键词",
        rule.positionKeyword
      );
      return issues.length
        ? issues
        : notInPlan(state, rule.flightNo, normalizeDutyPriorityFlightNo);
    }
    case "crossWorkdayQualificationReservations": {
      const rule = state.settings.crossWorkdayQualificationReservations.find(
        (item) => item.id === id
      )!;
      checkFlight(rule.flightNo, "下一工作班航班");
      checkPositions(
        matchingPositionRules(state, rule),
        "岗位关键词",
        rule.keyword,
        rule.matchField
      );
      return issues;
    }
    case "lateShiftRecoveryPositionRules": {
      const rule = state.settings.lateShiftRecoveryPositionRules.find(
        (item) => item.id === id
      )!;
      const ruleFacts = {
        ...state,
        settings: { ...state.settings, lateShiftRecoveryPositionRules: [rule] },
      };
      const historicalMatch = state.history.some(
        (record) =>
          matchingLateShiftRecoveryPositionRules(ruleFacts, record).length
      );
      const missingFlight = flightIssue(state, rule.flightNo, "适用航班", true);
      if (missingFlight) {
        if (historicalMatch)
          issues.push(
            policyDiagnostic(
              "historical-source",
              "当前没有同号航班配置，历史末班来源仍可匹配",
              "这条规则检查已发生的末班记录。删除或改名当前模板不会让旧历史记录消失，历史恢复保护仍可按原名称检查。",
              [
                "仍需保护这类历史岗位时保留本条规则，不要只为消除提示改成新航班号。",
                "新航班还需要同样保护时，可另外建立匹配新名称的末班重点岗位规则。",
              ],
              "info"
            )
          );
        else issues.push(missingFlight);
      }
      if (
        !state.positionRules.some(
          (position) =>
            matchingLateShiftRecoveryPositionRules(ruleFacts, target(position))
              .length
        )
      )
        issues.push(
          policyDiagnostic(
            "late-position-missing",
            `关键词“${rule.keyword || "（空）"}”没有匹配当前末班岗位配置`,
            "当前岗位配置没有匹配项；历史班表仍按本条规则检查，不能据此断言历史恢复保护已失效。",
            [
              "在配置 → 岗位配置核对岗位名称和备注，再在本条规则核对“匹配位置”与“关键词”。",
              "历史上的岗位仍需保护时保留这条规则；只是不再使用的新配置，可停用。",
            ],
            "info"
          )
        );
      break;
    }
    case "nextWorkdayRecoveryTargets": {
      const rule = state.settings.nextWorkdayRecoveryTargets.find(
        (item) => item.id === id
      )!;
      checkFlight(rule.flightNo, "目标航班");
      checkPositions(
        state.positionRules.filter((position) =>
          matchesNextWorkdayRecoveryTarget(
            {
              ...state,
              settings: {
                ...state.settings,
                nextWorkdayRecoveryTargets: [rule],
              },
            },
            target(position)
          )
        ),
        "岗位或备注关键词",
        rule.positionKeyword
      );
      break;
    }
    case "mobileSupervisorCoverageRules": {
      const rule = state.settings.mobileSupervisorCoverageRules.find(
        (item) => item.id === id
      )!;
      checkFlight(rule.flightNo, "适用航班", true);
      const candidates = state.positionRules.filter((position) =>
        mobileSupervisorCoverageRuleMatchesTarget(rule, target(position))
      );
      checkPositions(candidates, "关键词", rule.keyword, rule.matchField);
      if (
        rule.mode === "allow" &&
        candidates.length &&
        candidates.every(
          (position) =>
            !evaluateMobileSupervisorCoverage(state, target(position)).allowed
        )
      )
        issues.push(
          policyDiagnostic(
            "forbid-precedes-allow",
            "匹配岗位均被禁止兼任规则拦住",
            "同一岗位同时命中允许与禁止时，禁止规则优先。",
            [
              "在规则 → 机动督导兼任范围查看命中同一岗位的禁止条目。",
              "仅当业务确实允许兼任时才修改禁止范围；不要靠增加允许条目绕过禁止。",
            ]
          )
        );
      return issues.length ? issues : notInPlan(state, rule.flightNo);
    }
    case "positionTransitionPolicies": {
      const rule = state.settings.positionTransitionPolicies.find(
        (item) => item.id === id
      )!;
      checkFlight(rule.sourceFlightNo, "前序航班", true);
      checkFlight(rule.targetFlightNo, "目标航班");
      const source = state.positionRules.filter(
        (position) =>
          !rule.sourceFlightNo.trim() ||
          normalizedPolicyValue(position.flightNo) ===
            normalizedPolicyValue(rule.sourceFlightNo)
      );
      if (!rule.sourcePositions.length)
        checkPositions(source, "前序晚撤岗位", "全部岗位", "exact");
      for (const position of rule.sourcePositions)
        checkPositions(
          source.filter(
            (candidate) =>
              normalizedPolicyValue(candidate.name) ===
              normalizedPolicyValue(position)
          ),
          "前序晚撤岗位",
          position,
          "exact"
        );
      checkPositions(
        state.positionRules.filter(
          (position) =>
            normalizedPolicyValue(position.flightNo) ===
              normalizedPolicyValue(rule.targetFlightNo) &&
            normalizedPolicyValue(position.name) ===
              normalizedPolicyValue(rule.targetPosition)
        ),
        "目标岗位",
        rule.targetPosition,
        "exact"
      );
      if (rule.minimumGapMinutes === 0)
        issues.push(
          policyDiagnostic(
            "zero-gap",
            "衔接间隔为 0，本条不产生限制或避让",
            "本条规则只在间隔小于设定分钟数时触发，0 分钟不会触发。全局最小衔接仍照常执行。",
            ["需要本条生效时，在“最小间隔”填写大于 0 的分钟数。"],
            "info"
          )
        );
      return issues.length
        ? issues
        : [
            ...notInPlan(state, rule.sourceFlightNo),
            ...notInPlan(state, rule.targetFlightNo),
          ];
    }
  }
  if (!state.settings.lateShiftRecoveryEnabled)
    issues.push(
      policyDiagnostic(
        "parent-disabled",
        "跨工作日恢复保护已关闭，本条暂不执行",
        "条目启用，但它所属的总开关关闭；配置仍保留。",
        ["在规则 → 核心保护与公平参数打开“跨工作日恢复保护”，点击“保存规则”。"],
        "info"
      )
    );
  return issues;
}

export function diagnoseLatePriorityScope(
  state: PolicyConfigurationFacts,
  selected: readonly string[]
): PolicyDiagnostic[] {
  if (!selected.length)
    return [
      policyDiagnostic(
        "empty-scope",
        "未选择航班，末班重点轮换及对应统计已停用",
        "清空范围是允许的操作，其他排班安全规则仍执行。",
        ["需要恢复时，在本区域勾选航班，并点击“保存规则”。"],
        "info"
      ),
    ];
  const candidates = latePriorityFlightScopeCandidates(state.positionRules);
  return selected
    .filter((flightNo) => !latePriorityFlightInScope(candidates, flightNo))
    .map((flightNo) =>
      policyDiagnostic(
        "scope-position-missing",
        `${flightNo} 没有符合范围的常规重点岗位`,
        "已保存的航班范围还在，但当前岗位配置中没有对应的常规督导、一号、申报或送资料岗位。",
        [
          `在配置 → 岗位配置检查 ${flightNo} 的岗位性质、名称和备注。`,
          "如已改名或不再使用，可在本区域取消这个航班并点击“保存规则”；不要清空其他仍需使用的航班。",
        ]
      )
    );
}

export function diagnoseOrdinaryPriorityPosition(
  state: PolicyConfigurationFacts,
  index: number
): PolicyDiagnostic[] {
  const item = state.settings.ordinaryPriorityPositions[index];
  if (!item) return [];
  if (
    state.positionRules.some((rule) => isOrdinaryPriorityPosition(rule, [item]))
  )
    return [];
  return [
    policyDiagnostic(
      "ordinary-position-missing",
      `${item.airlineCode} / ${item.position} 没有匹配常规岗位`,
      "普通重点集合使用航司和完整规范岗位名，不使用岗位备注关键词匹配。",
      [
        "在配置 → 岗位配置核对常规岗位的航司和完整岗位名称。",
        "在本条普通重点岗位集合修改“航司”或“规范岗位”；不再需要的条目可删除。",
      ]
    ),
  ];
}

export function diagnoseGapFillReferences(
  state: PolicyConfigurationFacts
): PolicyDiagnostic[] {
  return state.settings.teamLeaderGapFillPositionPolicies
    .filter(
      (policy) =>
        !state.positionRules.some(
          (rule) =>
            teamLeaderGapFillPositionKey(rule.flightNo, rule.name) ===
            teamLeaderGapFillPositionKey(policy.flightNo, policy.position)
        )
    )
    .map((policy) =>
      policyDiagnostic(
        "gap-fill-position-missing",
        `${policy.flightNo} / ${policy.position} 的补差保护配置没有对应岗位`,
        "该条保护仍保存，但岗位已删除或名称改变，因此无法应用到现有岗位。",
        [
          "在配置 → 岗位配置核对航班号和岗位名。",
          `如来自 Excel，在配置文件的“${STRUCTURED_POLICY_DEFINITIONS.teamLeaderGapFillPositionPolicies.excelSheet}”表修正或删除旧条目，再导入；现有岗位的保护可在本区域重新设置。`,
        ]
      )
    );
}

export function diagnoseScalarPolicySetting(
  field: string,
  value: unknown,
  label: string
): PolicyDiagnostic[] {
  const definition = SCHEDULE_SETTING_DEFINITIONS.find(
    (item) => item.key === field
  );
  if (!definition) return [];
  if (
    definition.type === "boolean" &&
    field.endsWith("Enabled") &&
    value === false
  )
    return [
      policyDiagnostic(
        "disabled-setting",
        `${label}已关闭`,
        `当前设置不执行这项规则（${definition.description}），它的参数仍保留。`,
        [
          `需要执行时打开“${label}”，再点击“保存规则”；只修改下方参数不会打开该开关。`,
        ],
        "info"
      ),
    ];
  if (
    definition.type === "number" &&
    (typeof value !== "number" ||
      !Number.isFinite(value) ||
      (definition.min !== undefined && value < definition.min) ||
      (definition.max !== undefined && value > definition.max) ||
      (definition.integer && !Number.isInteger(value)))
  )
    return [
      policyDiagnostic(
        "invalid-number",
        `${label}超出允许范围或格式无效`,
        "保存时会按统一配置合同修正无效值，可能与刚输入的值不同。",
        [
          `将“${label}”改为${definition.integer ? "整数" : "数字"}，允许范围 ${definition.min ?? "不限"} 至 ${definition.max ?? "不限"}，再点击“保存规则”。`,
        ]
      ),
    ];
  if (
    definition.type === "time" &&
    (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))
  )
    return [
      policyDiagnostic(
        "invalid-time",
        `${label}没有有效时间`,
        "空时间或格式错误不会作为有效规则时间保存。",
        [`在“${label}”填写 00:00 至 23:59 的时间，再点击“保存规则”。`]
      ),
    ];
  if (
    (field === "minimumRegularTransitionMinutes" ||
      field === "tr121H02CooldownWorkdays") &&
    value === 0
  )
    return [
      policyDiagnostic(
        "zero-disabled",
        `${label}为 0，这项限制已关闭`,
        "0 是允许的设置，表示关闭这项间隔或冷却限制；其他安全规则仍然执行。",
        [`需要恢复时将“${label}”设为大于 0 的值，再点击“保存规则”。`],
        "info"
      ),
    ];
  return [];
}
