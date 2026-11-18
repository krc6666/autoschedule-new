import type {
  AuditChange,
  AuditStaffLabels,
} from "../../app/operation-audit-contract";
import { SCHEDULE_SETTING_DEFINITIONS } from "../../domain/rules/schedule-settings";
import { LATE_PRIORITY_KIND_DEFINITIONS } from "../../domain/reviews/late-priority-policy";

const AREAS: Record<string, string> = {
  staff: "人员",
  flights: "当天航班",
  templates: "航班模板",
  weeklyFlightPlans: "每周航班计划",
  positionRules: "岗位及资质",
  settings: "排班规则",
  history: "班表历史",
  assignments: "当前班表",
  dutyRosterOverrides: "轮值安排",
  latePriorityFrequencyAdjustments: "末班重点次数修正",
  ordinaryPriorityFrequencyAdjustments: "普通重点次数修正",
  halfRestSelections: "半休选择",
  leaveTypes: "休假类别",
  flightSeasonOverrides: "本季航班",
  flightPlanConfirmations: "航班核对",
  activeScheduleDate: "班表日期",
};
const FIELDS: Record<string, string> = {
  ...Object.fromEntries(
    SCHEDULE_SETTING_DEFINITIONS.map((field) => [field.key, field.label])
  ),
  id: "编号",
  name: "名称",
  staffId: "人员",
  staffName: "人员姓名",
  staffType: "人员类型",
  teamLeader: "分队长",
  cxPreflightQualified: "CX航前资质",
  dutyQualified: "值班资质",
  standbyQualified: "备勤资质",
  nightShift: "夜班能力",
  status: "状态",
  leaveTypeId: "休假类别编号",
  remark: "备注",
  manualRemark: "人工备注",
  flightNo: "航班",
  startTime: "开始时间",
  endTime: "结束时间",
  bookedPassengers: "预定人数",
  position: "岗位",
  category: "岗位分类",
  qualifiedStaffIds: "资质人员",
  manual: "手动补位",
  fatiguePoints: "疲劳点数",
  minPassengers: "启用旅客人数",
  earlyReleaseMinutes: "提前撤岗分钟",
  workHours: "工时",
  date: "工作日期",
  month: "月份",
  weekday: "星期",
  flightNos: "航班名单",
  enabled: "启用",
  delta: "修正次数",
  resetBaseline: "清零基准",
  kind: "类别",
  airlineCode: "航司",
  airlineCodes: "航司组合",
  cxPreflightStaffId: "CX航前人员",
  dutyStaffId: "值班人员",
  standbyStaffIds: "备勤人员",
  modes: "半休人员",
  adminSupportEnabled: "行政支援模式",
  airlineMixPolicies: "航司搭配偏好",
  sameFlightStaffExclusions: "同航班人员互斥",
  positionTransitionPolicies: "岗位衔接规则",
  dutyPositionPriorities: "值班岗位优先项",
  latePriorityFlightNumbers: "末班重点航班",
  relaxedShiftFlightNumbers: "轻松班次统计航班",
  ordinaryPriorityPositions: "普通重点岗位",
  lateShiftRecoveryPositionRules: "晚班恢复岗位",
  nextWorkdayRecoveryTargets: "下一班恢复目标",
  mobileSupervisorCoverageRules: "督导兼任范围",
  mobileSupervisorFillRules: "督导补位关系",
  crossWorkdayQualificationReservations: "跨班资质预留",
  crossFlightPriorityPolicies: "跨航班人员优先",
  teamLeaderGapFillPositionPolicies: "分队长补差保护",
  systemNotes: "系统说明",
  guideMode: "引导安排",
  sourceFlightNo: "来源航班",
  targetFlightNo: "目标航班",
  sourcePositionKeyword: "来源岗位",
  targetPositionKeyword: "目标岗位",
  staffIds: "人员名单",
  staffAId: "人员一",
  staffBId: "人员二",
  confirmed: "已确认",
  allowAutomatic: "允许自动",
  allowManual: "允许人工",
  layoutIndex: "显示顺序",
  layoutGroup: "显示区域",
  teamLeaderGapFill: "分队长补差",
  historyCoverage: "历史完整性",
  flightCutoffTime: "航班截载时间",
  flightStartTime: "航班开始时间",
  attendanceIntervals: "实际出勤时段",
  movable: "允许调动",
  minimumGapMinutes: "最少间隔分钟",
  minimumStaffCount: "最少人数",
  sourcePositions: "来源岗位",
  targetPosition: "目标岗位",
  positionKeyword: "岗位",
  keyword: "匹配内容",
  matchField: "匹配方式",
  mode: "执行方式",
  nextWorkdayCutoffTime: "下一班最早上岗时间",
  countBaseline: "次数原人员",
  assignmentRemarks: "岗位备注",
  manualOverrideWarnings: "人工调整提醒",
};
const VALUES: Record<string, string> = {
  ...Object.fromEntries(
    LATE_PRIORITY_KIND_DEFINITIONS.map((item) => [item.kind, item.label])
  ),
  assigned: "已安排",
  unfilled: "空岗",
  manual: "手动岗位",
  independent: "独立引导",
  "early-finish": "下午半休",
  "late-start": "上午半休",
  complete: "完整班表",
  "late-priority-only": "仅末班重点",
  prefer: "优先避开",
  forbid: "严格限制",
};
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function auditFieldLabel(key: string): string {
  return FIELDS[key] ?? key;
}

export function auditValue(
  value: unknown,
  names: Record<string, string> = {},
  depth = 0
): string {
  if (value === undefined) return "（未设置）";
  if (value === null || value === "") return "（空）";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") return String(value);
  if (typeof value === "string")
    return Object.hasOwn(names, value)
      ? names[value]!
      : (VALUES[value] ?? value);
  if (depth > 8) return JSON.stringify(value);
  if (Array.isArray(value))
    return value.length
      ? value.map((item) => auditValue(item, names, depth + 1)).join("；\n")
      : "（空列表）";
  if (record(value))
    return Object.keys(value).length
      ? Object.entries(value)
          .map(
            ([key, item]) =>
              `${auditFieldLabel(key)}：${auditValue(item, names, depth + 1)}`
          )
          .join("\n")
      : "（空内容）";
  return String(value);
}

// Only formats server snapshots; never consults today's configuration or rewrites audit data.
function equal(before: unknown, after: unknown): boolean {
  if (before === after) return true;
  if (Array.isArray(before) && Array.isArray(after))
    return (
      before.length === after.length &&
      before.every((v, i) => equal(v, after[i]))
    );
  if (record(before) && record(after)) {
    const keys = Object.keys(before);
    return (
      keys.length === Object.keys(after).length &&
      keys.every(
        (key) => Object.hasOwn(after, key) && equal(before[key], after[key])
      )
    );
  }
  return false;
}

function itemKey(value: unknown): string | undefined {
  if (!record(value)) return undefined;
  if (typeof value.id === "string" && value.id) return value.id;
  if (typeof value.flightNo === "string") {
    const position = value.position ?? value.positionKeyword;
    if (typeof position === "string")
      return `${value.flightNo}\u0000${position}`;
  }
  return undefined;
}

function itemLabel(value: unknown, fallback: string): string {
  if (!record(value)) return fallback;
  return (
    [
      value.name,
      value.flightNo ?? value.sourceFlightNo,
      value.position ?? value.positionKeyword ?? value.sourcePositionKeyword,
    ]
      .filter((v) => typeof v === "string" && v)
      .join(" / ") || fallback
  );
}

function changeLines(
  before: unknown,
  after: unknown,
  path: string,
  beforeNames: Record<string, string>,
  afterNames: Record<string, string>
): string[] {
  if (equal(before, after)) return [];
  if (record(before) || record(after)) {
    const old = record(before) ? before : {};
    const next = record(after) ? after : {};
    // Replacing an object with a scalar must still show both sides.
    if (
      (before != null && !record(before)) ||
      (after != null && !record(after))
    )
      return [
        `${path}：${auditValue(before, beforeNames)} → ${auditValue(after, afterNames)}`,
      ];
    const keys = [...new Set([...Object.keys(old), ...Object.keys(next)])];
    return keys
      .filter((key) => {
        if (["id", "flightId", "positionRuleId"].includes(key)) return false;
        // A saved assignment contains both identity and display name for the same occupant.
        if (
          key === "staffId" &&
          typeof old.staffName === "string" &&
          typeof next.staffName === "string" &&
          old.staffName !== next.staffName
        )
          return false;
        return true;
      })
      .flatMap((key) =>
        changeLines(
          old[key],
          next[key],
          [path, afterNames[key] ?? beforeNames[key] ?? auditFieldLabel(key)]
            .filter(Boolean)
            .join(" / "),
          beforeNames,
          afterNames
        )
      );
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const oldKeys = before.map(itemKey);
    const nextKeys = after.map(itemKey);
    const keyed =
      [...oldKeys, ...nextKeys].every((key) => key !== undefined) &&
      new Set(oldKeys).size === oldKeys.length &&
      new Set(nextKeys).size === nextKeys.length;
    if (keyed) {
      const old = new Map(before.map((item, i) => [oldKeys[i]!, item]));
      const next = new Map(after.map((item, i) => [nextKeys[i]!, item]));
      const lines = [...new Set([...old.keys(), ...next.keys()])].flatMap(
        (key) => {
          const prior = old.get(key),
            current = next.get(key);
          const label = [path, itemLabel(current ?? prior, key)]
            .filter(Boolean)
            .join(" / ");
          if (!old.has(key))
            return [`${label}：新增；${auditValue(current, afterNames)}`];
          if (!next.has(key))
            return [`${label}：删除；${auditValue(prior, beforeNames)}`];
          return changeLines(prior, current, label, beforeNames, afterNames);
        }
      );
      const retainedBefore = oldKeys.filter((key) => next.has(key!));
      const retainedAfter = nextKeys.filter((key) => old.has(key!));
      if (!equal(retainedBefore, retainedAfter))
        lines.push(
          `${path} / 顺序：${retainedBefore.map((key) => itemLabel(old.get(key!), key!)).join("、")} → ${retainedAfter.map((key) => itemLabel(next.get(key!), key!)).join("、")}`
        );
      return lines;
    }
    // Without stable IDs, equal-length object lists can only be identified by position.
    if (before.length === after.length && [...before, ...after].every(record))
      return before.flatMap((value, i) =>
        changeLines(
          value,
          after[i],
          `${path} / 第${i + 1}项`,
          beforeNames,
          afterNames
        )
      );
    const remaining = [...before];
    const added: unknown[] = [];
    for (const value of after) {
      const index = remaining.findIndex((old) => equal(old, value));
      if (index < 0) added.push(value);
      else remaining.splice(index, 1);
    }
    const parts = [
      added.length
        ? `新增${added.map((v) => auditValue(v, afterNames)).join("、")}`
        : "",
      remaining.length
        ? `移除${remaining.map((v) => auditValue(v, beforeNames)).join("、")}`
        : "",
    ].filter(Boolean);
    if (parts.length) return [`${path}：${parts.join("；")}`];
    return [
      `${path} / 顺序：${before.map((v) => auditValue(v, beforeNames)).join("、")} → ${after.map((v) => auditValue(v, afterNames)).join("、")}`,
    ];
  }
  if (before === undefined)
    return [`${path}：新增${auditValue(after, afterNames)}`];
  if (after === undefined)
    return [`${path}：删除${auditValue(before, beforeNames)}`];
  return [
    `${path}：${auditValue(before, beforeNames)} → ${auditValue(after, afterNames)}`,
  ];
}

export function projectAuditChange(
  change: AuditChange,
  labels: AuditStaffLabels
) {
  const beforeNames =
    change.scope === "shared" ? {} : (labels.before?.[change.scope] ?? {});
  const afterNames =
    change.scope === "shared" ? {} : (labels.after?.[change.scope] ?? {});
  const before = record(change.before) ? change.before : {};
  const after = record(change.after) ? change.after : {};
  const context = { ...before, ...after };
  const area = AREAS[change.area] ?? change.area;
  const target =
    change.key === "$order"
      ? "显示顺序"
      : [
          context.date ?? context.month,
          context.flightNo,
          context.position ?? context.name ?? context.staffName,
        ]
          .filter((value) => typeof value === "string" && value)
          .join(" / ") ||
        (change.area === "settings"
          ? auditFieldLabel(change.key)
          : change.key === "$value"
            ? ""
            : change.key);
  const label =
    change.key === "$order"
      ? "显示顺序"
      : change.area === "settings"
        ? auditFieldLabel(change.key)
        : area;
  const lines = changeLines(
    change.before,
    change.after,
    record(change.before) || record(change.after) ? "" : label,
    beforeNames,
    afterNames
  );
  return {
    title: `${change.scope === "shared" ? "共用资料" : `${change.scope}组`} · ${area}${target ? ` · ${target}` : ""}`,
    action: { add: "新增", update: "修改", delete: "删除" }[change.operation],
    lines,
  };
}
