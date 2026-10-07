import type { ScheduleSettings } from "../../model";
import {
  createDefaultStructuredPolicies,
  normalizeStructuredPolicies,
} from "./structured-policy-settings";
import { normalizeLatePriorityFlightNumbers } from "../statistics/late-priority-flight-scope";

export type ScalarScheduleSettingKey = Exclude<
  keyof ScheduleSettings,
  | "adminSupportEnabled"
  | "positionTransitionPolicies"
  | "dutyPositionPriorities"
  | "nextWorkdayRecoveryTargets"
  | "lateShiftRecoveryPositionRules"
  | "mobileSupervisorCoverageRules"
  | "mobileSupervisorFillRules"
  | "crossWorkdayQualificationReservations"
  | "crossFlightPriorityPolicies"
  | "latePriorityFlightNumbers"
  | "ordinaryPriorityPositions"
  | "sameFlightStaffExclusions"
  | "teamLeaderGapFillPositionPolicies"
>;

export interface ScheduleSettingDefinition {
  key: ScalarScheduleSettingKey;
  label: string;
  type: "boolean" | "number" | "time" | "mode";
  description: string;
  defaultValue: boolean | number | string;
  min?: number;
  max?: number;
  integer?: boolean;
}

export const SCHEDULE_SETTING_DEFINITIONS: readonly ScheduleSettingDefinition[] =
  [
    {
      key: "maxDailyHours",
      label: "每日工时上限",
      type: "number",
      description: "单人当日累计工时硬上限",
      defaultValue: 12,
      min: 1,
      max: 24,
    },
    {
      key: "historyWindowDays",
      label: "历史统计天数",
      type: "number",
      description: "历史疲劳统计窗口",
      defaultValue: 7,
      min: 1,
      max: 90,
      integer: true,
    },
    {
      key: "nightStart",
      label: "夜班开始时间",
      type: "time",
      description: "夜班能力检查起点",
      defaultValue: "22:00",
    },
    {
      key: "nightEnd",
      label: "夜班结束时间",
      type: "time",
      description: "夜班能力检查终点",
      defaultValue: "06:00",
    },
    {
      key: "consecutiveDayPenalty",
      label: "连续工作惩罚",
      type: "number",
      description: "连续工作日的历史疲劳增量",
      defaultValue: 5,
      min: 0,
      max: 100,
    },
    {
      key: "highLoadProtectionEnabled",
      label: "启用高负荷衔接保护",
      type: "boolean",
      description: "是否执行同日高负荷恢复保护",
      defaultValue: true,
    },
    {
      key: "highLoadFatigueThreshold",
      label: "高负荷疲劳阈值",
      type: "number",
      description: "达到该点数视为高负荷",
      defaultValue: 4,
      min: 0.5,
      max: 50,
    },
    {
      key: "highLoadRecoveryMinutes",
      label: "高负荷恢复分钟",
      type: "number",
      description: "高负荷岗位后的优先恢复时间",
      defaultValue: 360,
      min: 0,
      max: 1440,
      integer: true,
    },
    {
      key: "remarkedPositionHighLoad",
      label: "备注岗位视为高负荷",
      type: "boolean",
      description: "有岗位备注时纳入高负荷保护",
      defaultValue: true,
    },
    {
      key: "minimumRegularTransitionMinutes",
      label: "普通岗位最小衔接间隔",
      type: "number",
      description: "同一人员跨航班连续工作的最小准备时间",
      defaultValue: 90,
      min: 0,
      max: 1440,
      integer: true,
    },
    {
      key: "rollingLoadProtectionEnabled",
      label: "启用滚动负荷保护",
      type: "boolean",
      description: "是否限制短时间内累计疲劳",
      defaultValue: true,
    },
    {
      key: "rollingLoadWindowMinutes",
      label: "滚动负荷窗口分钟",
      type: "number",
      description: "累计疲劳的时间窗口",
      defaultValue: 360,
      min: 0,
      max: 1440,
      integer: true,
    },
    {
      key: "rollingLoadMaxFatigue",
      label: "滚动负荷疲劳上限",
      type: "number",
      description: "滚动窗口内的累计疲劳目标",
      defaultValue: 8,
      min: 0.5,
      max: 100,
    },
    {
      key: "positionRotationEnabled",
      label: "启用岗位轮换",
      type: "boolean",
      description: "是否执行重点岗位频率均衡与连续轮岗",
      defaultValue: true,
    },
    {
      key: "sameDayCrossFlightPriorityEnabled",
      label: "同日同航司控制/一号优先避免",
      type: "boolean",
      description: "有安全替代时优先分开，无替代时允许安排并报警",
      defaultValue: true,
    },
    {
      key: "dailyPrimaryPositionUniqueEnabled",
      label: "同一班表一号岗位单人限一次",
      type: "boolean",
      description:
        "同一张生成班表内，每个人最多承担一次非督导首个岗位；无法安排时保留空岗",
      defaultValue: true,
    },
    {
      key: "tr121H02CooldownWorkdays",
      label: "TR121/H02 冷却工作班数",
      type: "number",
      description: "承担 TR121/H02 后优先避开的后续已归档工作班数，0 表示关闭",
      defaultValue: 3,
      min: 0,
      max: 30,
      integer: true,
    },
    {
      key: "lateShiftRecoveryEnabled",
      label: "启用跨工作日恢复",
      type: "boolean",
      description: "是否保护上一班末班重点岗位人员",
      defaultValue: true,
    },
    {
      key: "nextWorkdayRecoveryMode",
      label: "跨工作日恢复目标强度",
      type: "mode",
      description: "优先避开或严格限制次班恢复目标",
      defaultValue: "prefer",
    },
    {
      key: "lateShiftEndTime",
      label: "末班结束界线",
      type: "time",
      description: "实际结束时间晚于该时刻的重点岗位纳入末班统计",
      defaultValue: "23:00",
    },
    {
      key: "teamLeaderConcurrentSupervisionMaxOverlapMinutes",
      label: "分队长并行督导最大重叠分钟",
      type: "number",
      description: "只在补齐常规岗位空缺时允许两个督导原始保障时段重叠的上限",
      defaultValue: 30,
      min: 0,
      max: 720,
      integer: true,
    },
    {
      key: "dutyFatiguePoints",
      label: "值班疲劳点数",
      type: "number",
      description: "值班任务计入的疲劳点",
      defaultValue: 12,
      min: 0,
      max: 50,
    },
    {
      key: "earlyDepartureCutoffTime",
      label: "提前下班截载节点",
      type: "time",
      description: "严格早于该时间计提前下班",
      defaultValue: "12:00",
    },
    {
      key: "afternoonRestStartTime",
      label: "下午无航班开始",
      type: "time",
      description: "下午无航班统计起点",
      defaultValue: "12:00",
    },
    {
      key: "afternoonRestEndTime",
      label: "下午无航班结束",
      type: "time",
      description: "下午无航班统计终点",
      defaultValue: "18:00",
    },
    {
      key: "workloadBalanceEnabled",
      label: "启用工时疲劳均衡",
      type: "boolean",
      description: "是否执行人员负荷均衡",
      defaultValue: true,
    },
    {
      key: "dailyFlightCountBalanceExemptHalfRest",
      label: "航班数均衡豁免半休人员",
      type: "boolean",
      description: "勾选后半休人员不参与同一工作班航班数比较",
      defaultValue: true,
    },
    {
      key: "dailyFlightCountBalanceExemptTeamLeaders",
      label: "航班数均衡豁免分队长",
      type: "boolean",
      description: "勾选后分队长不参与同一工作班航班数比较",
      defaultValue: true,
    },
    {
      key: "maxWorkHoursDifference",
      label: "最大工时差",
      type: "number",
      description: "常规人员当日工时差目标",
      defaultValue: 2,
      min: 0,
      max: 24,
    },
    {
      key: "maxTodayFatigueDifference",
      label: "最大当日疲劳差",
      type: "number",
      description: "常规人员当日疲劳差目标",
      defaultValue: 4,
      min: 0,
      max: 100,
    },
  ] as const;

const CLOCK_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function scalarDefaults(): Omit<
  ScheduleSettings,
  | "adminSupportEnabled"
  | "positionTransitionPolicies"
  | "dutyPositionPriorities"
  | "nextWorkdayRecoveryTargets"
  | "lateShiftRecoveryPositionRules"
  | "mobileSupervisorCoverageRules"
  | "mobileSupervisorFillRules"
  | "crossWorkdayQualificationReservations"
  | "crossFlightPriorityPolicies"
  | "latePriorityFlightNumbers"
  | "ordinaryPriorityPositions"
  | "sameFlightStaffExclusions"
  | "teamLeaderGapFillPositionPolicies"
> {
  return Object.fromEntries(
    SCHEDULE_SETTING_DEFINITIONS.map((definition) => [
      definition.key,
      definition.defaultValue,
    ])
  ) as ReturnType<typeof scalarDefaults>;
}

export function createDefaultScheduleSettings(): ScheduleSettings {
  return structuredClone({
    ...scalarDefaults(),
    adminSupportEnabled: false,
    latePriorityFlightNumbers: [],
    ordinaryPriorityPositions: [],
    ...createDefaultStructuredPolicies(),
  });
}

function normalizeScalar(
  definition: ScheduleSettingDefinition,
  value: unknown,
  fallback: unknown
): boolean | number | string {
  if (definition.type === "boolean")
    return typeof value === "boolean" ? value : Boolean(fallback);
  if (definition.type === "mode")
    return value === "forbid" || value === "prefer" ? value : String(fallback);
  if (definition.type === "time")
    return CLOCK_PATTERN.test(String(value ?? ""))
      ? String(value)
      : String(fallback);
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Number(fallback);
  const bounded = Math.min(
    definition.max ?? numeric,
    Math.max(definition.min ?? numeric, numeric)
  );
  return definition.integer ? Math.round(bounded) : bounded;
}

export function normalizeScheduleSettings(
  input: Partial<ScheduleSettings>,
  fallback = createDefaultScheduleSettings()
): ScheduleSettings {
  const result = {} as ScheduleSettings;
  for (const definition of SCHEDULE_SETTING_DEFINITIONS) {
    (result as unknown as Record<string, unknown>)[definition.key] =
      normalizeScalar(
        definition,
        input[definition.key],
        fallback[definition.key]
      );
  }
  result.adminSupportEnabled =
    typeof input.adminSupportEnabled === "boolean"
      ? input.adminSupportEnabled
      : fallback.adminSupportEnabled;
  result.latePriorityFlightNumbers = normalizeLatePriorityFlightNumbers(
    Array.isArray(input.latePriorityFlightNumbers)
      ? input.latePriorityFlightNumbers
      : fallback.latePriorityFlightNumbers
  );
  result.ordinaryPriorityPositions = Array.isArray(
    input.ordinaryPriorityPositions
  )
    ? input.ordinaryPriorityPositions
        .filter((item) => item && typeof item === "object")
        .map((item) => ({
          airlineCode: String(item.airlineCode ?? "")
            .trim()
            .toUpperCase(),
          position: String(item.position ?? "").trim(),
        }))
        .filter((item) => item.airlineCode && item.position)
    : structuredClone(fallback.ordinaryPriorityPositions);
  Object.assign(result, normalizeStructuredPolicies(input, fallback));
  return result;
}

export function applyScheduleSettingsPatch(
  current: ScheduleSettings,
  patch: Partial<ScheduleSettings>
): ScheduleSettings {
  return normalizeScheduleSettings({ ...current, ...patch }, current);
}
