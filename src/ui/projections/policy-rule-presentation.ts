import {
  ACTIVE_SCHEDULING_RULES,
  SCHEDULING_STAGE_ORDER,
  schedulingRuleDefinition,
  type SchedulingRuleId,
  type SchedulingRuleStage,
} from "../../domain/rules/schedule-rule-contract";

export interface UserRuleStagePresentation {
  label: string;
  summary: string;
}

const USER_RULE_STAGES: Readonly<
  Record<SchedulingRuleStage, UserRuleStagePresentation>
> = {
  "hard-constraint": {
    label: "必须遵守",
    summary: "先排除状态、资质、夜班、时间和工时不符合的安排",
  },
  "reserved-assignment": {
    label: "优先安排",
    summary: "先落实 KE166 督导和值班等指定任务",
  },
  coverage: {
    label: "补齐岗位",
    summary: "优先保护稀缺岗位并补齐能够安全安排的空缺",
  },
  protection: {
    label: "保护与均衡",
    summary: "在岗位完整的前提下兼顾恢复、负荷和公平",
  },
  "stable-order": {
    label: "最后比较",
    summary: "前面条件相同时，最后比较人员的历史疲劳",
  },
  "post-schedule-review": {
    label: "结果检查",
    summary: "对完整班表再次检查重点岗位频率和连续轮岗",
  },
};

const USER_RULE_DESCRIPTIONS: Readonly<Record<SchedulingRuleId, string>> = {
  "staff-eligibility":
    "人员状态、岗位资质、夜班能力、时间冲突和每日工时都必须符合要求。",
  "same-flight-staff-exclusion":
    "规则页配置的两个人不得被自动安排在同一航班；指定航班时只限制该航班，留空时限制所有航班。人工调整可以突破，但会持续标红提醒。",
  "daily-primary-position-unique":
    "同一张生成班表内，每个人最多承担一次非督导首个岗位；没有可用人选时该岗位保留空缺。",
  "minimum-flight-transition":
    "常规跨航班连续工作必须留足准备时间；符合条件的下午分流按提前撤岗配置接续。",
  "strict-next-workday-recovery":
    "选择严格限制时，上一班末班重点岗位人员不得承担配置的次班恢复目标；唯一例外是为补齐半休造成的后续岗位空缺。没有半休补位例外且无完整方案时，本次排班失败。",
  "mobile-supervisor":
    "所有明确分类为机动督导的顶部岗位都先找独立人选；人手不足时才在规则允许的同航班柜台兼任或安全重排。",
  "ke166-supervisor":
    "仅为 KE166 保留第二真人容量、跨航班重点人员及专属轮岗保护。",
  "duty-position": "按值班优先项安排晚撤岗位，并只锁定实际安排的岗位。",
  "scarce-qualification":
    "12 点前先安排可胜任人数更少的岗位，避免稀缺人员被提前占用。",
  "position-compaction":
    "发现中间空缺时把后序岗位安全前移，不减少已经填好的岗位。",
  "team-leader-concurrent-supervision":
    "常规岗位仍有空缺时，才允许符合条件的分队长短时并行督导。",
  "cross-workday-qualification-reservation":
    "当天岗位填满后，优先保留下一工作班稀缺岗位所需的合格人员。",
  "cross-flight-priority":
    "同一时段航班发生人员冲突时，优先把规则页选中的重点人员留在配置航班；不会突破硬约束，一般情况下也不制造空缺。",
  "position-transition":
    "严格衔接不符合要求时阻止安排；12 点前无人替代时保留原因供复核。",
  "tr121-h02-cooldown":
    "TR121/H02 一号承担后优先避开随后设定数量的已归档工作班；没有完整替代方案时保留岗位并选择最久未承担者。",
  "late-priority-aggregate-rotation":
    "先避开上一班承担过末班重岗位的人，再平衡本月和最近 8 班的四类合计次数。",
  "late-shift-recovery":
    "上一工作班承担晚间重点岗位的人，本班优先通过整体换位获得恢复。",
  "late-shift-cutoff":
    "需要恢复的人若能退出截止后岗位，优先按设定时间下班；若整体缺员使晚班不可避免，则保留晚班并优先安全撤掉其截止前岗位。",
  "half-rest-morning":
    "下午半休优先落实至少一个12点前岗位；上午半休优先落实一个午后岗位，并以结束时间最晚的航班作为晚到班锚点。",
  "half-rest-early-finish":
    "下午半休在完成前序规则和早班参与后尽量提前最终下班；上午半休优先选择结束时间最晚的合法航班，并尽量减少该航班之前的安排。",
  "priority-position-consecutive": "重点岗位连续由同一人承担时优先换人。",
  "high-fatigue-position-consecutive":
    "高疲劳普通岗位连续由同一人承担时优先换人。",
  "same-day-late-obligation":
    "整体判断受保护人员是否必须承担后续晚班；晚班不可避免时，在不制造岗位空缺的前提下优先安全撤掉其截止前岗位，多人冲突时先保护截止更早的人。",
  "same-day-cross-flight-priority":
    "同一人员同日承担同航司控制与一号时优先安排其他安全人选；没有安全替代或人工落位时允许保留，并显示琥珀色警告。",
  "late-shift-position-relief":
    "上一班做过已勾选末班重点岗位、这班又必须上晚班时，优先选择该人员可胜任的最低疲劳晚班岗位。",
  "preferred-position-transition":
    "多人都能胜任时，优先选择岗位衔接更顺畅的人。",
  "staff-coverage":
    "条件允许时优先让当天还没有实际工时的普通人员参与；分队长不要求每天上班。",
  "daily-flight-count-balance":
    "常规在岗人员按最终承担的不同航班数比较，差值必须不超过 1；无法安全做到时保留岗位空缺并说明阻塞原因。",
  "rolling-load": "优先避开短时间内已经接近疲劳上限的人。",
  "high-load-recovery": "刚完成高负荷岗位的人优先获得恢复时间。",
  "late-priority-frequency":
    "合计负担相同时，再分别平衡督导、一号、申报和送资料。",
  "cross-workday-load":
    "上一工作班较累的人本班尽量轻一些，较轻松的人适当多承担。",
  "position-frequency": "先比较本月重点岗位次数，再比较最近几个工作班的次数。",
  "position-frequency-review":
    "班表完成后整体检查重点岗位频率，存在安全方案时进行连续换位。",
  "workload-balance": "航班密集时比较安排后的工时和疲劳差，避免负荷过度集中。",
  "historical-fatigue": "前面条件相同时，优先选择历史疲劳较低的人。",
  "position-rotation": "最后按重点、高疲劳普通、低疲劳普通的顺序检查连续轮岗。",
};

export const USER_RULE_FLOW = SCHEDULING_STAGE_ORDER.map(
  (stage) => USER_RULE_STAGES[stage]
);

export function userRuleStagePresentation(
  stage: SchedulingRuleStage
): UserRuleStagePresentation {
  return USER_RULE_STAGES[stage];
}

export function userRulePresentation(id: SchedulingRuleId) {
  const definition = schedulingRuleDefinition(id);
  return {
    id,
    label: definition.label,
    stage: userRuleStagePresentation(definition.stage),
    description: USER_RULE_DESCRIPTIONS[id],
  };
}

export const USER_SCHEDULING_RULES = ACTIVE_SCHEDULING_RULES.map((rule) =>
  userRulePresentation(rule.id)
);
