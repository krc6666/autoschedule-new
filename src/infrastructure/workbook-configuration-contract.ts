import {
  SCHEDULE_SETTING_DEFINITIONS,
  STATISTICS_TIME_WINDOWS,
} from "../domain/rules/schedule-settings";
import { STRUCTURED_POLICY_DEFINITIONS } from "../domain/rules/structured-policy-settings";
import type { WorkbookImport } from "./excel";

/** Added after existing workbooks; absent values have a defined initial meaning. */
export const OPTIONAL_CONFIGURATION_SCALARS = new Set([
  "morningStatsStartTime",
  "morningStatsEndTime",
  "eveningStatsStartTime",
  "eveningStatsEndTime",
]);

const CONFIGURATION_SECTIONS = {
  staff: "人员信息",
  flights: "航班计划",
  templates: "航班配置",
  weeklyFlightPlans: "每周航班计划",
  positionRules: "岗位配置",
  leaveTypes: "休假类别",
  halfRestSelections: "半休选择",
  dutyRosterOverrides: "值班轮值",
  latePriorityFrequencyAdjustments: "末班重点次数修正",
  ordinaryPriorityFrequencyAdjustments: "普通重点次数修正",
} as const satisfies Partial<Record<keyof WorkbookImport, string>>;

/** One decision for import preview and commit; no target-device fallback. */
function workbookConfigurationRestoreErrors(
  imported: WorkbookImport
): string[] {
  const errors = [
    ...(imported.configurationRestoreErrors ?? []),
    ...(imported.flightConfigurationErrors ?? []),
    ...imported.warnings,
  ];
  for (const [field, sheet] of Object.entries(CONFIGURATION_SECTIONS)) {
    if (imported[field as keyof typeof CONFIGURATION_SECTIONS] === undefined)
      errors.push(`完整恢复缺少有效的“${sheet}”工作表`);
  }
  for (const definition of SCHEDULE_SETTING_DEFINITIONS) {
    if (imported.settings?.[definition.key] === undefined)
      errors.push(`完整恢复缺少规则参数：${definition.label}`);
  }
  for (const [key, definition] of Object.entries(
    STRUCTURED_POLICY_DEFINITIONS
  )) {
    if (
      imported.settings?.[key as keyof typeof STRUCTURED_POLICY_DEFINITIONS] ===
      undefined
    )
      errors.push(`完整恢复缺少有效的“${definition.excelSheet}”工作表`);
  }
  if (imported.settings?.ordinaryPriorityPositions === undefined)
    errors.push("完整恢复缺少有效的“普通重点岗位集合”工作表");
  if (imported.settings?.latePriorityFlightNumbers === undefined)
    errors.push("完整恢复缺少有效的“末班重点航班范围”工作表");
  for (const { label, start, end } of STATISTICS_TIME_WINDOWS) {
    if (
      imported.settings?.[start] !== undefined &&
      imported.settings[start] === imported.settings[end]
    )
      errors.push(`完整恢复的${label}统计时段开始与结束不能相同`);
  }
  return [...new Set(errors)];
}

/** Compile missing new-feature values once for both preview and actual restore. */
export function compileWorkbookConfigurationRestore(input: WorkbookImport): {
  imported: WorkbookImport;
  errors: string[];
  restoreDefaults: string[];
} {
  const imported = { ...input, settings: { ...input.settings } };
  const restoreDefaults: string[] = [];
  if (imported.flightPlanConfirmations === undefined) {
    imported.flightPlanConfirmations = [];
    restoreDefaults.push("航班换季确认：未确认，按实际差异重新核对");
  }
  for (const definition of SCHEDULE_SETTING_DEFINITIONS) {
    if (
      !OPTIONAL_CONFIGURATION_SCALARS.has(definition.key) ||
      imported.settings[definition.key] !== undefined
    )
      continue;
    (imported.settings as Record<string, unknown>)[definition.key] =
      definition.defaultValue;
    restoreDefaults.push(`${definition.label}：${definition.defaultValue}`);
  }
  if (imported.leaveTypes === undefined) {
    imported.leaveTypes = [];
    restoreDefaults.push("休假类别：无自建类别");
  }
  if (imported.halfRestSelections === undefined) {
    imported.halfRestSelections = [];
    restoreDefaults.push("半休选择：无半休人员");
  }
  return {
    imported,
    errors: workbookConfigurationRestoreErrors(imported),
    restoreDefaults,
  };
}
