export const SCHEDULING_STAGE_ORDER = [
  "hard-constraint",
  "reserved-assignment",
  "coverage",
  "protection",
  "stable-order",
  "post-schedule-review",
] as const;

export type SchedulingRuleStage = (typeof SCHEDULING_STAGE_ORDER)[number];
export type SchedulingRuleFeedbackMode =
  "dedicated" | "aggregated" | "decision-only";
export type SchedulingRuleOptimization = "required" | "best-effort";

type SchedulingRuleMetadata = {
  optimization?: SchedulingRuleOptimization;
  deferCandidateAfterCoverage?: boolean;
  feedbackOrder?: number;
};

export const SCHEDULING_STAGE_LABELS: Readonly<
  Record<SchedulingRuleStage, string>
> = {
  "hard-constraint": "硬约束",
  "reserved-assignment": "特殊岗位锁定",
  coverage: "岗位完整性",
  protection: "人员保护与公平",
  "stable-order": "最后比较",
  "post-schedule-review": "排班后轮岗复核",
};

export const SCHEDULING_RULES = [
  {
    id: "staff-eligibility",
    stage: "hard-constraint",
    label: "人员与岗位硬约束",
    feedbackMode: "aggregated",
  },
  {
    id: "same-flight-staff-exclusion",
    stage: "hard-constraint",
    label: "同航班人员互斥",
    feedbackMode: "aggregated",
  },
  {
    id: "daily-primary-position-unique",
    stage: "hard-constraint",
    label: "同一班表一号岗位单人限一次",
    feedbackMode: "aggregated",
  },
  {
    id: "minimum-flight-transition",
    stage: "hard-constraint",
    label: "普通岗位最小航班衔接间隔",
    feedbackMode: "aggregated",
  },
  {
    id: "strict-next-workday-recovery",
    stage: "hard-constraint",
    label: "严格跨工作日恢复目标（半休补位可突破）",
    feedbackMode: "aggregated",
  },
  {
    id: "mobile-supervisor",
    stage: "reserved-assignment",
    label: "机动督导独立优先、缺员兼任与配置补位",
    feedbackMode: "aggregated",
  },
  {
    id: "ke166-supervisor",
    stage: "reserved-assignment",
    label: "KE166第二真人容量与专项保护",
    feedbackMode: "aggregated",
  },
  {
    id: "duty-position",
    stage: "reserved-assignment",
    label: "值班岗位锁定",
    feedbackMode: "dedicated",
    feedbackKey: "duty-roster",
    feedbackOrder: 8,
  },
  {
    id: "scarce-qualification",
    stage: "coverage",
    label: "稀缺资质预留",
    feedbackMode: "decision-only",
    deferCandidateAfterCoverage: true,
  },
  {
    id: "position-compaction",
    stage: "coverage",
    label: "岗位空缺下沉",
    feedbackMode: "dedicated",
    feedbackKey: "morning-priority",
    feedbackOrder: 0,
  },
  {
    id: "team-leader-concurrent-supervision",
    stage: "coverage",
    label: "分队长并行督导补缺",
    feedbackMode: "aggregated",
  },
  {
    id: "same-day-cross-flight-priority",
    stage: "protection",
    label: "同日同航司控制与一号岗位优先避免（无替代可接受）",
    feedbackMode: "aggregated",
    optimization: "required",
  },
  {
    id: "cross-workday-qualification-reservation",
    stage: "protection",
    label: "跨工作日资质预留",
    feedbackMode: "dedicated",
    feedbackKey: "cross-workday-qualification-reservation",
    feedbackOrder: 1,
  },
  {
    id: "position-transition",
    stage: "protection",
    label: "严格岗位衔接",
    feedbackMode: "aggregated",
  },
  {
    id: "cross-flight-priority",
    stage: "protection",
    label: "跨航班重点人员优先",
    feedbackMode: "aggregated",
  },
  {
    id: "tr121-h02-cooldown",
    stage: "protection",
    label: "TR121/H02 工作班冷却",
    feedbackMode: "decision-only",
  },
  {
    id: "late-priority-aggregate-rotation",
    stage: "protection",
    label: "末班重点岗位合计轮换保护",
    feedbackMode: "aggregated",
  },
  {
    id: "late-priority-frequency",
    stage: "protection",
    label: "末班重点岗位分类公平",
    feedbackMode: "aggregated",
  },
  {
    id: "position-frequency",
    stage: "protection",
    label: "重点岗位频率均衡",
    feedbackMode: "aggregated",
  },
  {
    id: "position-frequency-review",
    stage: "protection",
    label: "重点岗位频率安全重排",
    feedbackMode: "dedicated",
    feedbackKey: "position-frequency-review",
    feedbackOrder: 4,
  },
  {
    id: "priority-position-consecutive",
    stage: "protection",
    label: "重点岗位连续承担保护",
    feedbackMode: "aggregated",
  },
  {
    id: "late-shift-recovery",
    stage: "protection",
    label: "跨工作日恢复保护",
    feedbackMode: "dedicated",
    feedbackKey: "previous-late",
    optimization: "best-effort",
    feedbackOrder: 6,
  },
  {
    id: "late-shift-cutoff",
    stage: "protection",
    label: "末班重点岗位次班截止保护",
    feedbackMode: "dedicated",
    feedbackKey: "current-late",
    optimization: "best-effort",
    feedbackOrder: 7,
  },
  {
    id: "half-rest-morning",
    stage: "protection",
    label: "半休时段参与目标",
    feedbackMode: "aggregated",
  },
  {
    id: "half-rest-early-finish",
    stage: "protection",
    label: "下午半休尽早下班与上午半休最晚结束",
    feedbackMode: "aggregated",
    optimization: "best-effort",
  },
  {
    id: "high-fatigue-position-consecutive",
    stage: "protection",
    label: "高疲劳普通岗位连续承担保护",
    feedbackMode: "aggregated",
    optimization: "best-effort",
  },
  {
    id: "same-day-late-obligation",
    stage: "protection",
    label: "当天早晚负荷分散",
    feedbackMode: "aggregated",
    optimization: "best-effort",
  },
  {
    id: "late-shift-position-relief",
    stage: "protection",
    label: "上一班末班重点人员晚班轻岗优先",
    feedbackMode: "aggregated",
    optimization: "best-effort",
  },
  {
    id: "preferred-position-transition",
    stage: "protection",
    label: "优先岗位衔接",
    feedbackMode: "aggregated",
    optimization: "best-effort",
  },
  {
    id: "staff-coverage",
    stage: "protection",
    label: "当日在岗覆盖",
    feedbackMode: "aggregated",
    optimization: "best-effort",
  },
  {
    id: "daily-flight-count-balance",
    stage: "protection",
    label: "同一工作班航班数均衡",
    feedbackMode: "dedicated",
    feedbackKey: "daily-flight-count-balance",
    optimization: "best-effort",
    feedbackOrder: 9,
  },
  {
    id: "rolling-load",
    stage: "protection",
    label: "滚动负荷保护",
    feedbackMode: "aggregated",
    optimization: "best-effort",
  },
  {
    id: "high-load-recovery",
    stage: "protection",
    label: "连续高负荷保护",
    feedbackMode: "dedicated",
    feedbackKey: "high-load",
    optimization: "best-effort",
    feedbackOrder: 2,
  },
  {
    id: "cross-workday-load",
    stage: "protection",
    label: "跨工作班负荷互补",
    feedbackMode: "dedicated",
    feedbackKey: "cross-workday-load",
    optimization: "best-effort",
    feedbackOrder: 3,
  },
  {
    id: "workload-balance",
    stage: "protection",
    label: "工时与疲劳均衡",
    feedbackMode: "aggregated",
    optimization: "best-effort",
  },
  {
    id: "historical-fatigue",
    stage: "stable-order",
    label: "历史疲劳",
    feedbackMode: "aggregated",
    optimization: "best-effort",
  },
  {
    id: "position-rotation",
    stage: "post-schedule-review",
    label: "连续轮岗复核",
    feedbackMode: "dedicated",
    feedbackKey: "position-rotation",
    feedbackOrder: 5,
  },
] as const satisfies readonly (
  | ({
      id: string;
      stage: SchedulingRuleStage;
      label: string;
      feedbackMode: Exclude<SchedulingRuleFeedbackMode, "dedicated">;
    } & SchedulingRuleMetadata)
  | ({
      id: string;
      stage: SchedulingRuleStage;
      label: string;
      feedbackMode: "dedicated";
      feedbackKey: string;
    } & SchedulingRuleMetadata)
)[];

export type SchedulingRuleId = (typeof SCHEDULING_RULES)[number]["id"];
export type ActiveSchedulingRuleId = Exclude<
  SchedulingRuleId,
  "team-leader-concurrent-supervision"
>;

export const ACTIVE_SCHEDULING_RULES = SCHEDULING_RULES.filter(
  (
    rule
  ): rule is Extract<
    (typeof SCHEDULING_RULES)[number],
    { id: ActiveSchedulingRuleId }
  > => rule.id !== "team-leader-concurrent-supervision"
);
export type RuleFeedbackKey = Extract<
  (typeof SCHEDULING_RULES)[number],
  { feedbackMode: "dedicated" }
>["feedbackKey"];

export type SchedulingDecisionOutcome =
  "selected" | "blocked" | "fallback" | "preserved";

export interface SchedulingDecision {
  ruleId: SchedulingRuleId;
  stage: SchedulingRuleStage;
  outcome: SchedulingDecisionOutcome;
  message: string;
}

const RULE_DEFINITION_BY_ID = Object.fromEntries(
  SCHEDULING_RULES.map((definition) => [definition.id, definition])
) as Readonly<Record<SchedulingRuleId, (typeof SCHEDULING_RULES)[number]>>;

export function schedulingRuleDefinition(
  ruleId: SchedulingRuleId
): (typeof SCHEDULING_RULES)[number] {
  return RULE_DEFINITION_BY_ID[ruleId];
}

export function schedulingDecision(
  ruleId: SchedulingRuleId,
  outcome: SchedulingDecisionOutcome,
  message: string
): SchedulingDecision {
  return {
    ruleId,
    stage: schedulingRuleDefinition(ruleId).stage,
    outcome,
    message,
  };
}

export function schedulingRuleLabel(ruleId: SchedulingRuleId): string {
  return schedulingRuleDefinition(ruleId).label;
}
