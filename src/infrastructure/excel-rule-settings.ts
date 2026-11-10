import type * as XLSX from "xlsx-js-style";

import {
  SCHEDULE_SETTING_DEFINITIONS,
  type ScalarScheduleSettingKey,
} from "../domain/rules/schedule-settings";
import { STRUCTURED_POLICY_DEFINITIONS } from "../domain/rules/structured-policy-settings";
import type { StructuredPolicyKey } from "../domain/rules/structured-policy-contract";
import { normalizeTime } from "../domain/shared/time";
import type { AppState, ScheduleSettings, Staff } from "../model";
import type {
  CrossWorkdayQualificationReservation,
  CrossFlightPriorityPolicy,
  DutyPositionPriority,
  LateShiftRecoveryPositionRule,
  MobileSupervisorCoverageRule,
  MobileSupervisorFillRule,
  NextWorkdayRecoveryTarget,
  PositionTransitionPolicy,
  SameFlightStaffExclusion,
  TeamLeaderGapFillPositionPolicy,
} from "../domain/rules/structured-policy-contract";
import { createId, normalizeText, splitList } from "../utils";
import { normalizeLatePriorityFlightNumber } from "../domain/reviews/late-priority-policy";
import {
  append,
  headerIndex,
  normalizePosition,
  rows,
  type Row,
} from "./excel-worksheet";

const SETTING_DESCRIPTORS = SCHEDULE_SETTING_DEFINITIONS;
const LATE_PRIORITY_FLIGHT_SCOPE_SHEET = "末班重点航班范围";

function structuredPolicySheet(key: StructuredPolicyKey): string {
  return STRUCTURED_POLICY_DEFINITIONS[key].excelSheet;
}

interface ParsedRuleSheet<T> {
  present: boolean;
  value?: T[];
  warnings: string[];
}

export interface ParsedScheduleRuleSettings {
  settings?: Partial<ScheduleSettings>;
  warnings: string[];
  recognized: boolean;
}

function parseBoolean(value: unknown): boolean | undefined {
  const normalized = normalizeText(value).toLowerCase();
  if (["是", "启用", "true", "1", "yes", "y"].includes(normalized)) return true;
  if (["否", "停用", "false", "0", "no", "n"].includes(normalized))
    return false;
  return undefined;
}

function parseScalarSettings(workbook: XLSX.WorkBook): {
  present: boolean;
  settings?: Partial<ScheduleSettings>;
  warnings: string[];
} {
  if (!workbook.SheetNames.includes("规则参数"))
    return { present: false, warnings: [] };
  const data = rows(workbook, "规则参数");
  const header = data[0] ?? [];
  const keyIndex = headerIndex(header, ["参数代码"], 0);
  const valueIndex = headerIndex(header, ["值"], 2);
  const descriptors = new Map(
    SETTING_DESCRIPTORS.map((descriptor) => [descriptor.key, descriptor])
  );
  const settings: Partial<ScheduleSettings> = {};
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const [rowOffset, row] of data.slice(1).entries()) {
    if (row.every((value) => !normalizeText(value))) continue;
    const excelRow = rowOffset + 2;
    const key = normalizeText(row[keyIndex]) as ScalarScheduleSettingKey;
    const descriptor = descriptors.get(key);
    if (!descriptor) {
      warnings.push(
        `规则参数第${excelRow}行：未知参数代码“${key || "空白"}”，该行未导入`
      );
      continue;
    }
    if (seen.has(key)) {
      delete (settings as Record<string, unknown>)[key];
      warnings.push(
        `规则参数第${excelRow}行：参数代码“${key}”重复，该参数未覆盖当前设置`
      );
      continue;
    }
    seen.add(key);
    const raw = row[valueIndex];
    let value: boolean | number | string | undefined;
    if (descriptor.type === "boolean") {
      value = parseBoolean(raw);
    } else if (descriptor.type === "mode") {
      const mode = normalizeText(raw).toLowerCase();
      value =
        mode === "forbid" || mode === "严格限制"
          ? "forbid"
          : mode === "prefer" || mode === "优先避开"
            ? "prefer"
            : undefined;
    } else if (descriptor.type === "time") {
      value = normalizeTime(normalizeText(raw)) || undefined;
    } else {
      const parsed = Number(raw);
      value = Number.isFinite(parsed) ? parsed : undefined;
      if (
        typeof value === "number" &&
        descriptor.integer &&
        !Number.isInteger(value)
      )
        value = undefined;
      if (
        typeof value === "number" &&
        descriptor.min !== undefined &&
        value < descriptor.min
      )
        value = undefined;
      if (
        typeof value === "number" &&
        descriptor.max !== undefined &&
        value > descriptor.max
      )
        value = undefined;
    }
    if (value === undefined) {
      warnings.push(
        `规则参数第${excelRow}行：${descriptor.label}的值无效，该参数未覆盖当前设置`
      );
      continue;
    }
    (settings as Record<string, unknown>)[key] = value;
  }
  for (const key of [
    "dailyFlightCountBalanceExemptHalfRest",
    "dailyFlightCountBalanceExemptTeamLeaders",
  ] as const) {
    if (seen.has(key)) continue;
    const descriptor = descriptors.get(key);
    if (descriptor)
      (settings as Record<string, unknown>)[key] = descriptor.defaultValue;
  }
  return { present: true, settings, warnings };
}

function parseRuleSheet<T>(
  workbook: XLSX.WorkBook,
  sheetName: string,
  parser: (
    row: Row,
    header: Row,
    excelRow: number
  ) => { value?: T; errors: string[] }
): ParsedRuleSheet<T> {
  if (!workbook.SheetNames.includes(sheetName))
    return { present: false, warnings: [] };
  const data = rows(workbook, sheetName);
  const header = data[0] ?? [];
  const value: T[] = [];
  const warnings: string[] = [];
  for (const [rowOffset, row] of data.slice(1).entries()) {
    if (row.every((item) => !normalizeText(item))) continue;
    const excelRow = rowOffset + 2;
    const parsed = parser(row, header, excelRow);
    if (parsed.errors.length)
      warnings.push(
        ...parsed.errors.map((error) => `${sheetName}第${excelRow}行：${error}`)
      );
    else if (parsed.value) value.push(parsed.value);
  }
  return warnings.length
    ? { present: true, warnings }
    : { present: true, value, warnings: [] };
}

function cell(
  row: Row,
  header: Row,
  candidates: string[],
  fallback: number
): string {
  return normalizeText(row[headerIndex(header, candidates, fallback)]);
}

function ruleId(value: string, prefix: string): string {
  return value || createId(prefix);
}

function parseTransitionPolicies(
  workbook: XLSX.WorkBook
): ParsedRuleSheet<PositionTransitionPolicy> {
  return parseRuleSheet(
    workbook,
    structuredPolicySheet("positionTransitionPolicies"),
    (row, header) => {
      const enabled = parseBoolean(cell(row, header, ["启用"], 2));
      const modeText = cell(row, header, ["模式"], 8).toLowerCase();
      const mode =
        modeText === "forbid" || modeText === "禁止" || modeText === "强保护"
          ? "forbid"
          : modeText === "prefer" ||
              modeText === "优先" ||
              modeText === "软保护"
            ? "prefer"
            : undefined;
      const minimumGapMinutes = Number(cell(row, header, ["最小间隔"], 7));
      const errors = [
        enabled === undefined ? "启用值必须填写是或否" : "",
        !mode ? "模式必须填写 prefer/优先 或 forbid/禁止" : "",
        !Number.isFinite(minimumGapMinutes) ||
        minimumGapMinutes < 0 ||
        minimumGapMinutes > 1440
          ? "最小间隔分钟必须是0至1440"
          : "",
      ].filter(Boolean);
      if (errors.length || enabled === undefined || !mode) return { errors };
      return {
        errors: [],
        value: {
          id: ruleId(
            cell(row, header, ["规则ID", "ID"], 0),
            "transition-policy"
          ),
          name: cell(row, header, ["规则名称", "名称"], 1),
          enabled,
          sourceFlightNo: cell(row, header, ["来源航班"], 3).toUpperCase(),
          sourcePositions: splitList(cell(row, header, ["来源岗位"], 4)).map(
            normalizePosition
          ),
          targetFlightNo: cell(row, header, ["目标航班"], 5).toUpperCase(),
          targetPosition: normalizePosition(cell(row, header, ["目标岗位"], 6)),
          minimumGapMinutes,
          mode,
        },
      };
    }
  );
}

function parseDutyPriorities(
  workbook: XLSX.WorkBook
): ParsedRuleSheet<DutyPositionPriority> {
  return parseRuleSheet(
    workbook,
    structuredPolicySheet("dutyPositionPriorities"),
    (row, header) => {
      const enabled = parseBoolean(cell(row, header, ["启用"], 3));
      if (enabled === undefined) return { errors: ["启用值必须填写是或否"] };
      return {
        errors: [],
        value: {
          id: ruleId(cell(row, header, ["规则ID", "ID"], 0), "duty-priority"),
          flightNo: cell(row, header, ["航班号"], 1).toUpperCase(),
          positionKeyword: cell(row, header, ["岗位关键词"], 2),
          enabled,
        },
      };
    }
  );
}

function parseRecoveryTargets(
  workbook: XLSX.WorkBook
): ParsedRuleSheet<NextWorkdayRecoveryTarget> {
  return parseRuleSheet(
    workbook,
    structuredPolicySheet("nextWorkdayRecoveryTargets"),
    (row, header) => {
      const enabled = parseBoolean(cell(row, header, ["启用"], 3));
      if (enabled === undefined) return { errors: ["启用值必须填写是或否"] };
      return {
        errors: [],
        value: {
          id: ruleId(cell(row, header, ["规则ID", "ID"], 0), "recovery-target"),
          flightNo: cell(row, header, ["航班号"], 1).toUpperCase(),
          positionKeyword: cell(row, header, ["岗位关键词"], 2),
          enabled,
        },
      };
    }
  );
}

function parseLateShiftPositions(
  workbook: XLSX.WorkBook
): ParsedRuleSheet<LateShiftRecoveryPositionRule> {
  return parseRuleSheet(
    workbook,
    structuredPolicySheet("lateShiftRecoveryPositionRules"),
    (row, header) => {
      const enabled = parseBoolean(cell(row, header, ["启用"], 1));
      const fieldText = cell(row, header, ["匹配字段"], 3).toLowerCase();
      const matchField =
        fieldText === "position" ||
        fieldText === "岗位名称" ||
        fieldText === "岗位"
          ? "position"
          : fieldText === "remark" ||
              fieldText === "岗位备注" ||
              fieldText === "备注"
            ? "remark"
            : undefined;
      const cutoff = cell(row, header, ["次班截止时间", "截止时间"], 5);
      const errors = [
        enabled === undefined ? "启用值必须填写是或否" : "",
        !matchField
          ? "匹配字段必须填写 position/岗位名称 或 remark/岗位备注"
          : "",
        cutoff && !normalizeTime(cutoff)
          ? "次班截止时间必须是有效时间或留空"
          : "",
      ].filter(Boolean);
      if (errors.length || enabled === undefined || !matchField)
        return { errors };
      return {
        errors: [],
        value: {
          id: ruleId(
            cell(row, header, ["规则ID", "ID"], 0),
            "late-recovery-position"
          ),
          enabled,
          flightNo: cell(row, header, ["航班号"], 2).toUpperCase(),
          matchField,
          keyword: cell(row, header, ["关键词"], 4),
          nextWorkdayCutoffTime: cutoff ? normalizeTime(cutoff) : "",
        },
      };
    }
  );
}

function parseSupervisorCoverage(
  workbook: XLSX.WorkBook
): ParsedRuleSheet<MobileSupervisorCoverageRule> {
  return parseRuleSheet(
    workbook,
    structuredPolicySheet("mobileSupervisorCoverageRules"),
    (row, header) => {
      const enabled = parseBoolean(cell(row, header, ["启用"], 1));
      const fieldText = cell(row, header, ["匹配字段"], 3).toLowerCase();
      const matchField =
        fieldText === "position" ||
        fieldText === "岗位名称" ||
        fieldText === "岗位"
          ? "position"
          : fieldText === "remark" ||
              fieldText === "岗位备注" ||
              fieldText === "备注"
            ? "remark"
            : undefined;
      const modeText = cell(row, header, ["模式"], 5).toLowerCase();
      const mode =
        modeText === "allow" || modeText === "允许"
          ? "allow"
          : modeText === "forbid" || modeText === "禁止"
            ? "forbid"
            : undefined;
      const errors = [
        enabled === undefined ? "启用值必须填写是或否" : "",
        !matchField
          ? "匹配字段必须填写 position/岗位名称 或 remark/岗位备注"
          : "",
        !mode ? "模式必须填写 allow/允许 或 forbid/禁止" : "",
      ].filter(Boolean);
      if (errors.length || enabled === undefined || !matchField || !mode)
        return { errors };
      return {
        errors: [],
        value: {
          id: ruleId(
            cell(row, header, ["规则ID", "ID"], 0),
            "supervisor-coverage"
          ),
          enabled,
          flightNo: cell(row, header, ["航班号"], 2).toUpperCase(),
          matchField,
          keyword: cell(row, header, ["关键词"], 4),
          mode,
        },
      };
    }
  );
}

function parseSupervisorFillRules(
  workbook: XLSX.WorkBook
): ParsedRuleSheet<MobileSupervisorFillRule> {
  return parseRuleSheet(
    workbook,
    structuredPolicySheet("mobileSupervisorFillRules"),
    (row, header) => {
      const enabled = parseBoolean(cell(row, header, ["启用"], 1));
      const allowAutomatic = parseBoolean(
        cell(row, header, ["允许自动补位"], 6)
      );
      const allowManual = parseBoolean(cell(row, header, ["允许人工补位"], 7));
      const sourceFlightNo = cell(row, header, ["来源航班"], 2).toUpperCase();
      const sourcePositionKeyword = cell(row, header, ["来源岗位关键词"], 3);
      const targetFlightNo = cell(row, header, ["目标航班"], 4).toUpperCase();
      const targetPositionKeyword = cell(row, header, ["目标岗位关键词"], 5);
      const confirmationColumn = headerIndex(header, ["待确认"], -1);
      const requiresConfirmation =
        confirmationColumn < 0
          ? undefined
          : parseBoolean(row[confirmationColumn]);
      const errors = [
        enabled === undefined ? "启用值必须填写是或否" : "",
        !sourceFlightNo && !requiresConfirmation ? "来源航班不能为空" : "",
        !sourcePositionKeyword && !requiresConfirmation
          ? "来源岗位关键词不能为空"
          : "",
        !targetFlightNo ? "目标航班不能为空" : "",
        !targetPositionKeyword ? "目标岗位关键词不能为空" : "",
        allowAutomatic === undefined ? "允许自动补位必须填写是或否" : "",
        allowManual === undefined ? "允许人工补位必须填写是或否" : "",
        confirmationColumn >= 0 && requiresConfirmation === undefined
          ? "待确认必须填写是或否"
          : "",
      ].filter(Boolean);
      if (
        errors.length ||
        enabled === undefined ||
        allowAutomatic === undefined ||
        allowManual === undefined
      )
        return { errors };
      return {
        errors: [],
        value: {
          id: ruleId(cell(row, header, ["规则ID", "ID"], 0), "supervisor-fill"),
          enabled,
          sourceFlightNo,
          sourcePositionKeyword,
          targetFlightNo,
          targetPositionKeyword,
          allowAutomatic,
          allowManual,
          ...(requiresConfirmation !== undefined
            ? { requiresConfirmation }
            : {}),
        },
      };
    }
  );
}

function parseCrossWorkdayReservations(
  workbook: XLSX.WorkBook
): ParsedRuleSheet<CrossWorkdayQualificationReservation> {
  return parseRuleSheet(
    workbook,
    structuredPolicySheet("crossWorkdayQualificationReservations"),
    (row, header) => {
      const enabled = parseBoolean(cell(row, header, ["启用"], 1));
      const fieldText = cell(row, header, ["匹配字段"], 3).toLowerCase();
      const matchField =
        fieldText === "position" ||
        fieldText === "岗位名称" ||
        fieldText === "岗位"
          ? "position"
          : fieldText === "remark" ||
              fieldText === "岗位备注" ||
              fieldText === "备注"
            ? "remark"
            : undefined;
      const minimumStaffCount = Number(
        cell(row, header, ["至少保留人数", "最低人数"], 5)
      );
      const errors = [
        enabled === undefined ? "启用值必须填写是或否" : "",
        !matchField
          ? "匹配字段必须填写 position/岗位名称 或 remark/岗位备注"
          : "",
        !Number.isInteger(minimumStaffCount) ||
        minimumStaffCount < 1 ||
        minimumStaffCount > 50
          ? "至少保留人数必须是1至50的整数"
          : "",
      ].filter(Boolean);
      if (errors.length || enabled === undefined || !matchField)
        return { errors };
      return {
        errors: [],
        value: {
          id: ruleId(
            cell(row, header, ["规则ID", "ID"], 0),
            "cross-workday-reservation"
          ),
          enabled,
          flightNo: cell(
            row,
            header,
            ["下一工作班航班号", "航班号"],
            2
          ).toUpperCase(),
          matchField,
          keyword: cell(row, header, ["岗位关键词", "关键词"], 4),
          minimumStaffCount,
        },
      };
    }
  );
}

function parseLatePriorityFlightScope(
  workbook: XLSX.WorkBook
): ParsedRuleSheet<string> {
  return parseRuleSheet(
    workbook,
    LATE_PRIORITY_FLIGHT_SCOPE_SHEET,
    (row, header) => {
      const flightNo = normalizeLatePriorityFlightNumber(
        cell(row, header, ["航班号"], 0)
      );
      return flightNo
        ? { value: flightNo, errors: [] }
        : { errors: ["航班号不能为空"] };
    }
  );
}

function parseCrossFlightPriorityPolicies(
  workbook: XLSX.WorkBook,
  staff: readonly Staff[] = []
): ParsedRuleSheet<CrossFlightPriorityPolicy> {
  const staffIdsSet = new Set(staff.map((person) => person.id));
  return parseRuleSheet(
    workbook,
    structuredPolicySheet("crossFlightPriorityPolicies"),
    (row, header) => {
      const enabled = parseBoolean(cell(row, header, ["启用"], 1));
      const flightNo = cell(
        row,
        header,
        ["优先航班号", "航班号"],
        2
      ).toUpperCase();
      const staffIds = splitList(
        cell(
          row,
          header,
          ["优先人员编号（逗号分隔）", "优先人员编号", "人员编号"],
          3
        )
      );
      const errors = [
        enabled === undefined ? "启用值必须填写是或否" : "",
        !flightNo ? "优先航班号不能为空" : "",
        !staffIds.length ? "优先人员编号不能为空" : "",
        ...staffIds
          .filter((staffId) => staff.length > 0 && !staffIdsSet.has(staffId))
          .map((staffId) => `优先人员编号“${staffId}”不存在`),
      ].filter(Boolean);
      if (errors.length || enabled === undefined) return { errors };
      return {
        errors: [],
        value: {
          id: ruleId(
            cell(row, header, ["规则ID", "ID"], 0),
            "cross-flight-priority"
          ),
          enabled,
          flightNo,
          staffIds,
        },
      };
    }
  );
}

function parseSameFlightStaffExclusions(
  workbook: XLSX.WorkBook,
  staff: readonly Staff[]
): ParsedRuleSheet<SameFlightStaffExclusion> {
  const staffIds = new Set(staff.map((person) => person.id));
  return parseRuleSheet(
    workbook,
    structuredPolicySheet("sameFlightStaffExclusions"),
    (row, header) => {
      const enabledIndex = headerIndex(header, ["启用"], -1);
      const enabled = enabledIndex < 0 ? true : parseBoolean(row[enabledIndex]);
      const firstStaffId = cell(row, header, ["人员A编号", "人员A"], 2);
      const secondStaffId = cell(row, header, ["人员B编号", "人员B"], 4);
      const errors = [
        enabled === undefined ? "启用必须填写是或否" : "",
        !firstStaffId ? "人员A编号不能为空" : "",
        !secondStaffId ? "人员B编号不能为空" : "",
        firstStaffId && !staffIds.has(firstStaffId)
          ? `人员A编号“${firstStaffId}”不存在`
          : "",
        secondStaffId && !staffIds.has(secondStaffId)
          ? `人员B编号“${secondStaffId}”不存在`
          : "",
        firstStaffId && firstStaffId === secondStaffId
          ? "两个人员不能相同"
          : "",
      ].filter(Boolean);
      if (errors.length) return { errors };
      return {
        errors: [],
        value: {
          id: ruleId(
            cell(row, header, ["规则ID", "ID"], 0),
            "same-flight-staff-exclusion"
          ),
          enabled: enabled ?? true,
          flightNo: cell(row, header, ["适用航班", "航班号"], 1).toUpperCase(),
          firstStaffId,
          secondStaffId,
        },
      };
    }
  );
}

function parseTeamLeaderGapFillPositionPolicies(
  workbook: XLSX.WorkBook
): ParsedRuleSheet<TeamLeaderGapFillPositionPolicy> {
  return parseRuleSheet(
    workbook,
    structuredPolicySheet("teamLeaderGapFillPositionPolicies"),
    (row, header) => {
      const flightNo = cell(row, header, ["航班号"], 0).toUpperCase();
      const position = cell(row, header, ["岗位名称", "岗位"], 1);
      const movable = parseBoolean(
        cell(row, header, ["允许参与补差换人", "允许移动"], 2)
      );
      const errors = [
        !flightNo ? "航班号不能为空" : "",
        !position ? "岗位名称不能为空" : "",
        movable === undefined ? "允许参与补差换人必须填写是或否" : "",
      ].filter(Boolean);
      if (errors.length || movable === undefined) return { errors };
      return {
        errors: [],
        value: { flightNo, position, movable },
      };
    }
  );
}

export function parseScheduleRuleSettings(
  workbook: XLSX.WorkBook,
  staff: readonly Staff[] = []
): ParsedScheduleRuleSettings {
  const scalar = parseScalarSettings(workbook);
  const transitions = parseTransitionPolicies(workbook);
  const dutyPriorities = parseDutyPriorities(workbook);
  const recoveryTargets = parseRecoveryTargets(workbook);
  const lateShiftPositions = parseLateShiftPositions(workbook);
  const supervisorCoverage = parseSupervisorCoverage(workbook);
  const supervisorFill = parseSupervisorFillRules(workbook);
  const crossWorkdayReservations = parseCrossWorkdayReservations(workbook);
  const latePriorityFlightScope = parseLatePriorityFlightScope(workbook);
  const crossFlightPriority = parseCrossFlightPriorityPolicies(workbook, staff);
  const sameFlightStaffExclusions = parseSameFlightStaffExclusions(
    workbook,
    staff
  );
  const teamLeaderGapFillPositionPolicies =
    parseTeamLeaderGapFillPositionPolicies(workbook);
  const recognized =
    scalar.present ||
    transitions.present ||
    dutyPriorities.present ||
    recoveryTargets.present ||
    lateShiftPositions.present ||
    supervisorCoverage.present ||
    supervisorFill.present ||
    crossWorkdayReservations.present ||
    latePriorityFlightScope.present ||
    crossFlightPriority.present ||
    sameFlightStaffExclusions.present ||
    teamLeaderGapFillPositionPolicies.present;
  const hasImportableSettings =
    Boolean(scalar.settings && Object.keys(scalar.settings).length) ||
    transitions.value !== undefined ||
    dutyPriorities.value !== undefined ||
    recoveryTargets.value !== undefined ||
    lateShiftPositions.value !== undefined ||
    supervisorCoverage.value !== undefined ||
    supervisorFill.value !== undefined ||
    crossWorkdayReservations.value !== undefined ||
    latePriorityFlightScope.value !== undefined ||
    crossFlightPriority.value !== undefined ||
    sameFlightStaffExclusions.value !== undefined ||
    teamLeaderGapFillPositionPolicies.value !== undefined;
  const settings: Partial<ScheduleSettings> | undefined = hasImportableSettings
    ? { ...(scalar.settings ?? {}) }
    : undefined;
  if (settings && !scalar.present) {
    for (const key of [
      "dailyFlightCountBalanceExemptHalfRest",
      "dailyFlightCountBalanceExemptTeamLeaders",
    ] as const) {
      const descriptor = SETTING_DESCRIPTORS.find((item) => item.key === key);
      if (descriptor)
        (settings as Record<string, unknown>)[key] = descriptor.defaultValue;
    }
  }
  if (settings && transitions.value)
    settings.positionTransitionPolicies = transitions.value;
  if (settings && dutyPriorities.value)
    settings.dutyPositionPriorities = dutyPriorities.value;
  if (settings && recoveryTargets.value)
    settings.nextWorkdayRecoveryTargets = recoveryTargets.value;
  if (settings && lateShiftPositions.value)
    settings.lateShiftRecoveryPositionRules = lateShiftPositions.value;
  if (settings && supervisorCoverage.value)
    settings.mobileSupervisorCoverageRules = supervisorCoverage.value;
  if (settings && supervisorFill.value)
    settings.mobileSupervisorFillRules = supervisorFill.value;
  if (settings && crossWorkdayReservations.value)
    settings.crossWorkdayQualificationReservations =
      crossWorkdayReservations.value;
  if (settings && latePriorityFlightScope.value !== undefined)
    settings.latePriorityFlightNumbers = latePriorityFlightScope.value;
  if (settings && crossFlightPriority.value !== undefined)
    settings.crossFlightPriorityPolicies = crossFlightPriority.value;
  if (settings && sameFlightStaffExclusions.value !== undefined)
    settings.sameFlightStaffExclusions = sameFlightStaffExclusions.value;
  if (settings && teamLeaderGapFillPositionPolicies.value !== undefined)
    settings.teamLeaderGapFillPositionPolicies =
      teamLeaderGapFillPositionPolicies.value;
  return {
    settings,
    recognized,
    warnings: [
      ...scalar.warnings,
      ...transitions.warnings,
      ...dutyPriorities.warnings,
      ...recoveryTargets.warnings,
      ...lateShiftPositions.warnings,
      ...supervisorCoverage.warnings,
      ...supervisorFill.warnings,
      ...crossWorkdayReservations.warnings,
      ...latePriorityFlightScope.warnings,
      ...crossFlightPriority.warnings,
      ...sameFlightStaffExclusions.warnings,
      ...teamLeaderGapFillPositionPolicies.warnings,
    ],
  };
}

export function appendScheduleRuleSheets(
  workbook: XLSX.WorkBook,
  state: AppState
): void {
  append(
    workbook,
    "规则参数",
    [
      ["参数代码", "参数名称", "值", "说明"],
      ...SETTING_DESCRIPTORS.map((descriptor) => [
        descriptor.key,
        descriptor.label,
        descriptor.type === "boolean"
          ? state.settings[descriptor.key]
            ? "是"
            : "否"
          : state.settings[descriptor.key],
        descriptor.description,
      ]),
    ],
    [34, 24, 18, 48]
  );
  append(
    workbook,
    structuredPolicySheet("positionTransitionPolicies"),
    [
      [
        "规则ID",
        "规则名称",
        "启用",
        "来源航班",
        "来源岗位（逗号分隔）",
        "目标航班",
        "目标岗位",
        "最小间隔分钟",
        "模式",
      ],
      ...state.settings.positionTransitionPolicies.map((rule) => [
        rule.id,
        rule.name,
        rule.enabled ? "是" : "否",
        rule.sourceFlightNo,
        rule.sourcePositions.join(","),
        rule.targetFlightNo,
        rule.targetPosition,
        rule.minimumGapMinutes,
        rule.mode,
      ]),
    ],
    [30, 24, 10, 14, 36, 14, 18, 18, 14]
  );
  append(
    workbook,
    structuredPolicySheet("dutyPositionPriorities"),
    [
      ["规则ID", "航班号", "岗位关键词", "启用"],
      ...state.settings.dutyPositionPriorities.map((rule) => [
        rule.id,
        rule.flightNo,
        rule.positionKeyword,
        rule.enabled ? "是" : "否",
      ]),
    ],
    [30, 14, 24, 10]
  );
  append(
    workbook,
    structuredPolicySheet("nextWorkdayRecoveryTargets"),
    [
      ["规则ID", "航班号", "岗位关键词", "启用"],
      ...state.settings.nextWorkdayRecoveryTargets.map((rule) => [
        rule.id,
        rule.flightNo,
        rule.positionKeyword,
        rule.enabled ? "是" : "否",
      ]),
    ],
    [30, 14, 24, 10]
  );
  append(
    workbook,
    structuredPolicySheet("lateShiftRecoveryPositionRules"),
    [
      [
        "规则ID",
        "启用",
        "航班号（空白表示全部）",
        "匹配字段",
        "关键词",
        "次班截止时间（可留空）",
      ],
      ...state.settings.lateShiftRecoveryPositionRules.map((rule) => [
        rule.id,
        rule.enabled ? "是" : "否",
        rule.flightNo,
        rule.matchField,
        rule.keyword,
        rule.nextWorkdayCutoffTime,
      ]),
    ],
    [32, 10, 24, 16, 24, 24]
  );
  append(
    workbook,
    structuredPolicySheet("mobileSupervisorCoverageRules"),
    [
      [
        "规则ID",
        "启用",
        "航班号（空白表示全部）",
        "匹配字段",
        "关键词",
        "模式",
      ],
      ...state.settings.mobileSupervisorCoverageRules.map((rule) => [
        rule.id,
        rule.enabled ? "是" : "否",
        rule.flightNo,
        rule.matchField,
        rule.keyword,
        rule.mode,
      ]),
    ],
    [32, 10, 24, 16, 24, 14]
  );
  append(
    workbook,
    structuredPolicySheet("mobileSupervisorFillRules"),
    [
      [
        "规则ID",
        "启用",
        "来源航班",
        "来源岗位关键词",
        "目标航班",
        "目标岗位关键词",
        "允许自动补位",
        "允许人工补位",
        "待确认",
      ],
      ...state.settings.mobileSupervisorFillRules.map((rule) => [
        rule.id,
        rule.enabled ? "是" : "否",
        rule.sourceFlightNo,
        rule.sourcePositionKeyword,
        rule.targetFlightNo,
        rule.targetPositionKeyword,
        rule.allowAutomatic ? "是" : "否",
        rule.allowManual ? "是" : "否",
        rule.requiresConfirmation ? "是" : "否",
      ]),
    ],
    [32, 10, 16, 24, 16, 24, 16, 16, 12]
  );
  append(
    workbook,
    structuredPolicySheet("crossWorkdayQualificationReservations"),
    [
      [
        "规则ID",
        "启用",
        "下一工作班航班号",
        "匹配字段",
        "岗位关键词",
        "至少保留人数",
      ],
      ...state.settings.crossWorkdayQualificationReservations.map(
        (reservation) => [
          reservation.id,
          reservation.enabled ? "是" : "否",
          reservation.flightNo,
          reservation.matchField,
          reservation.keyword,
          reservation.minimumStaffCount,
        ]
      ),
    ],
    [32, 10, 24, 16, 24, 18]
  );
  append(
    workbook,
    LATE_PRIORITY_FLIGHT_SCOPE_SHEET,
    [
      ["航班号"],
      ...state.settings.latePriorityFlightNumbers.map((flightNo) => [flightNo]),
    ],
    [20]
  );
  append(
    workbook,
    structuredPolicySheet("crossFlightPriorityPolicies"),
    [
      [
        "规则ID",
        "启用",
        "优先航班号",
        "优先人员编号（逗号分隔）",
        "优先人员姓名（仅供核对）",
      ],
      ...state.settings.crossFlightPriorityPolicies.map((policy) => [
        policy.id,
        policy.enabled ? "是" : "否",
        policy.flightNo,
        policy.staffIds.join(","),
        policy.staffIds
          .map(
            (staffId) =>
              state.staff.find((person) => person.id === staffId)?.name ?? ""
          )
          .filter(Boolean)
          .join(","),
      ]),
    ],
    [32, 10, 18, 40, 40]
  );
  append(
    workbook,
    structuredPolicySheet("sameFlightStaffExclusions"),
    [
      [
        "规则ID",
        "适用航班（空白表示全部）",
        "人员A编号",
        "人员A姓名",
        "人员B编号",
        "人员B姓名",
        "启用",
      ],
      ...state.settings.sameFlightStaffExclusions.map((exclusion) => [
        exclusion.id,
        exclusion.flightNo,
        exclusion.firstStaffId,
        state.staff.find((person) => person.id === exclusion.firstStaffId)
          ?.name ?? "",
        exclusion.secondStaffId,
        state.staff.find((person) => person.id === exclusion.secondStaffId)
          ?.name ?? "",
        exclusion.enabled ? "是" : "否",
      ]),
    ],
    [32, 24, 16, 16, 16, 16, 10]
  );
  append(
    workbook,
    structuredPolicySheet("teamLeaderGapFillPositionPolicies"),
    [
      ["航班号", "岗位名称", "允许参与补差换人"],
      ...state.settings.teamLeaderGapFillPositionPolicies.map((policy) => [
        policy.flightNo,
        policy.position,
        policy.movable ? "是" : "否",
      ]),
    ],
    [16, 24, 22]
  );
}
