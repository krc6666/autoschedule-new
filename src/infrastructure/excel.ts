import * as XLSX from "xlsx-js-style";

import type {
  AppState,
  Assignment,
  DutyRosterOverride,
  Flight,
  FlightTemplate,
  HistoryRecord,
  LatePriorityFrequencyAdjustment,
  OrdinaryPriorityFrequencyAdjustment,
  PositionRule,
  ScheduleSettings,
  Staff,
  WeeklyFlightPlanEntry,
} from "../model";
import {
  combinedAssignmentRemark,
  assignmentWarningRemark,
  createId,
  downloadBlob,
  normalizeText,
  orderPositionRules,
  splitList,
} from "../utils";
import {
  addIsoDays,
  durationHours,
  normalizeTime,
} from "../domain/shared/time";
import { getDutyRosterForDate } from "../domain/duty-roster/roster";
import { buildMonthlyRelaxedShiftStatistics } from "../domain/statistics/relaxed-shift-statistics";
import {
  isFixedBottomPosition,
  isGuideAssignment,
} from "../domain/flights/schedule-position-rules";
import { mergeLatePriorityFrequencyAdjustments } from "../domain/statistics/late-priority-frequency-adjustment";
import { mergeOrdinaryPriorityFrequencyAdjustments } from "../domain/statistics/ordinary-priority-frequency-adjustment";
import { normalizeOrdinaryPriorityPositions } from "../domain/reviews/position-rotation-policy";
import { sameAirlinePriorityWarningsByAssignment } from "../domain/rules/airline-rotation";
import {
  createEmptyWeeklyFlightPlans,
  replaceWeeklyFlightPlan,
} from "../domain/flights/weekly-flight-plan";
import {
  appendScheduleRuleSheets,
  parseScheduleRuleSettings,
} from "./excel-rule-settings";
import {
  parseLegacyScheduleWorkbook,
  type LegacyScheduleImportPreview,
  type LegacyScheduleParseOptions,
} from "./legacy-schedule-excel";
import {
  append,
  findSheet,
  headerIndex,
  normalizePosition,
  rows,
  sheet,
} from "./excel-worksheet";

export interface WorkbookImport {
  staff?: Staff[];
  flights?: Flight[];
  templates?: FlightTemplate[];
  weeklyFlightPlans?: WeeklyFlightPlanEntry[];
  positionRules?: PositionRule[];
  history?: HistoryRecord[];
  settings?: Partial<ScheduleSettings>;
  latePriorityFrequencyAdjustments?: LatePriorityFrequencyAdjustment[];
  ordinaryPriorityFrequencyAdjustments?: OrdinaryPriorityFrequencyAdjustment[];
  dutyRosterOverrides?: DutyRosterOverride[];
  dutyRosterInvalid?: boolean;
  legacySchedule?: LegacyScheduleImportPreview;
  warnings: string[];
}

function parseDutyRosterOverrides(
  workbook: XLSX.WorkBook,
  staff: Staff[]
): { value?: DutyRosterOverride[]; warnings: string[] } {
  const sheetName = findSheet(workbook, ["值班轮值"]);
  if (!sheetName) return { warnings: [] };
  const data = rows(workbook, sheetName);
  const header = data[0] ?? [];
  const dateIndex = headerIndex(header, ["日期", "工作班日期"], 0);
  const cxIndex = headerIndex(header, ["CX航前人员编号", "CX航前编号"], 1);
  const dutyIndex = headerIndex(header, ["值班人员编号", "值班编号"], 2);
  const standby0Index = headerIndex(header, ["备勤1编号", "备勤一编号"], 3);
  const standby1Index = headerIndex(header, ["备勤2编号", "备勤二编号"], 4);
  const staffIds = new Set(staff.map((person) => person.id));
  const staffById = new Map(staff.map((person) => [person.id, person]));
  const warnings: string[] = [];
  const result: DutyRosterOverride[] = [];
  const dates = new Set<string>();
  const isDate = (value: string): boolean => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  };
  data.slice(1).forEach((row, rowIndex) => {
    const excelRow = rowIndex + 2;
    const date = normalizeText(row[dateIndex]).slice(0, 10);
    const ids = [
      normalizeText(row[cxIndex]),
      normalizeText(row[dutyIndex]),
      normalizeText(row[standby0Index]),
      normalizeText(row[standby1Index]),
    ];
    if (!date && ids.every((id) => !id)) return;
    if (!isDate(date)) {
      warnings.push(`值班轮值第${excelRow}行：日期“${date}”无效`);
      return;
    }
    if (dates.has(date)) {
      warnings.push(`值班轮值第${excelRow}行：日期“${date}”重复`);
      return;
    }
    dates.add(date);
    const labels = ["CX航前人员编号", "值班人员编号", "备勤1编号", "备勤2编号"];
    let invalid = false;
    ids.forEach((id, index) => {
      if (id && !staffIds.has(id)) {
        warnings.push(`值班轮值第${excelRow}行：${labels[index]}“${id}”不存在`);
        invalid = true;
      }
    });
    if (
      ids[0] &&
      staffById.get(ids[0]) &&
      !staffById.get(ids[0])!.cxPreflightQualified
    ) {
      warnings.push(`值班轮值第${excelRow}行：CX航前人员不具备CX航前资质`);
      invalid = true;
    }
    if (
      ids[1] &&
      staffById.get(ids[1]) &&
      !staffById.get(ids[1])!.dutyQualified
    ) {
      warnings.push(`值班轮值第${excelRow}行：值班人员不具备值班资质`);
      invalid = true;
    }
    if (
      ids
        .slice(2)
        .some(
          (id) =>
            id && staffById.get(id) && !staffById.get(id)!.standbyQualified
        )
    ) {
      warnings.push(`值班轮值第${excelRow}行：备勤人员不具备备勤资质`);
      invalid = true;
    }
    const dutyAndOther = [ids[1], ids[2], ids[3]].filter(Boolean);
    if (
      new Set(dutyAndOther).size !== dutyAndOther.length ||
      (ids[1] && ids[0] === ids[1])
    ) {
      warnings.push(`值班轮值第${excelRow}行：值班和备勤人员不能重复`);
      invalid = true;
    }
    if (invalid) return;
    result.push({
      date,
      cxPreflightStaffId: ids[0] || null,
      dutyStaffId: ids[1] || null,
      standbyStaffIds: [ids[2] || null, ids[3] || null],
    });
  });
  return warnings.length
    ? { warnings, value: undefined }
    : { value: result, warnings };
}

function parseLatePriorityFrequencyAdjustments(
  workbook: XLSX.WorkBook
): LatePriorityFrequencyAdjustment[] | undefined {
  if (!workbook.SheetNames.includes("末班重点次数修正")) return undefined;
  const data = rows(workbook, "末班重点次数修正");
  const header = data[0] ?? [];
  const index = (names: string[], fallback: number) =>
    headerIndex(header, names, fallback);
  const kindIndex = index(["类别", "岗位类别"], 3);
  const kinds = new Set([
    "supervisor",
    "number-one",
    "declaration",
    "delivery",
  ]);
  return mergeLatePriorityFrequencyAdjustments(
    data.slice(1).flatMap((row): LatePriorityFrequencyAdjustment[] => {
      const month = normalizeText(row[index(["月份"], 0)]);
      const staffId = normalizeText(row[index(["人员编号", "编号"], 1)]);
      const flightNo = normalizeText(row[index(["航班号"], 2)]).toUpperCase();
      const kind = normalizeText(row[kindIndex]);
      const delta = Number(row[index(["修正次数", "修正值"], 4)]);
      const resetBaseline = Number(row[index(["清零基准次数"], 5)] ?? 0);
      if (
        !/^\d{4}-\d{2}$/.test(month) ||
        !staffId ||
        !flightNo ||
        !kinds.has(kind) ||
        !Number.isFinite(delta) ||
        !Number.isInteger(delta) ||
        (delta === 0 && resetBaseline <= 0) ||
        !Number.isFinite(resetBaseline) ||
        !Number.isInteger(resetBaseline) ||
        resetBaseline < 0
      )
        return [];
      return [
        {
          month,
          staffId,
          flightNo,
          kind: kind as LatePriorityFrequencyAdjustment["kind"],
          delta,
          resetBaseline: resetBaseline || undefined,
        },
      ];
    })
  );
}

function parseOrdinaryPriorityFrequencyAdjustments(
  workbook: XLSX.WorkBook
): OrdinaryPriorityFrequencyAdjustment[] | undefined {
  if (!workbook.SheetNames.includes("普通重点次数修正")) return undefined;
  const data = rows(workbook, "普通重点次数修正");
  return mergeOrdinaryPriorityFrequencyAdjustments(
    data.slice(1).flatMap((row): OrdinaryPriorityFrequencyAdjustment[] => {
      const month = normalizeText(row[0]);
      const staffId = normalizeText(row[1]);
      const airlineCode = normalizeText(row[2]);
      const position = normalizeText(row[3]);
      const delta = Number(row[4]);
      const resetBaseline = Number(row[5] ?? 0);
      if (
        !/^\d{4}-\d{2}$/.test(month) ||
        !staffId ||
        !airlineCode ||
        !position ||
        !Number.isInteger(delta) ||
        !Number.isInteger(resetBaseline) ||
        resetBaseline < 0 ||
        (delta === 0 && resetBaseline === 0)
      )
        return [];
      return [
        {
          month,
          staffId,
          airlineCode,
          position,
          delta,
          resetBaseline: resetBaseline || undefined,
        },
      ];
    })
  );
}

function parseOrdinaryPriorityPositions(workbook: XLSX.WorkBook): {
  present: boolean;
  value: ScheduleSettings["ordinaryPriorityPositions"];
} {
  if (!workbook.SheetNames.includes("普通重点岗位集合"))
    return { present: false, value: [] };
  const data = rows(workbook, "普通重点岗位集合");
  return {
    present: true,
    value: normalizeOrdinaryPriorityPositions(
      data.slice(1).map((row) => ({
        airlineCode: normalizeText(row[0]),
        position: normalizeText(row[1]),
      }))
    ),
  };
}

export interface WorkbookImportOptions {
  legacySchedule?: LegacyScheduleParseOptions;
}

function sheetHasDataRows(
  workbook: XLSX.WorkBook,
  candidates: string[]
): boolean {
  const sheetName = findSheet(workbook, candidates);
  if (!sheetName) return false;
  return rows(workbook, sheetName)
    .slice(1)
    .some((row) => row.some((value) => normalizeText(value)));
}

function parseStaff(workbook: XLSX.WorkBook): Staff[] | undefined {
  const sheetName = findSheet(workbook, ["人员信息", "员工信息"]);
  if (!sheetName) return undefined;
  const data = rows(workbook, sheetName);
  const header = data[0] ?? [];
  const idIndex = headerIndex(header, ["编号", "员工号"], 0);
  const nameIndex = headerIndex(header, ["姓名"], 1);
  const nightIndex = headerIndex(header, ["夜班"], 2);
  const statusIndex = headerIndex(header, ["状态"], 3);
  const remarkIndex = headerIndex(header, ["备注"], 4);
  const staffTypeIndex = headerIndex(
    header,
    ["人员类型", "人员分类", "类型"],
    5
  );
  const cxPreflightIndex = headerIndex(
    header,
    ["CX航前资质", "CX航前", "航前资质"],
    6
  );
  const dutyIndex = header.findIndex((cell) =>
    ["值班资质", "值班人员资质"].some((candidate) =>
      normalizeText(cell).includes(candidate)
    )
  );
  const standbyIndex = header.findIndex((cell) =>
    ["备勤资质", "备勤人员资质"].some((candidate) =>
      normalizeText(cell).includes(candidate)
    )
  );
  const teamLeaderIndex = header.findIndex((cell) =>
    ["是否为分队长", "分队长"].some((candidate) =>
      normalizeText(cell).includes(candidate)
    )
  );
  return data.slice(1).flatMap((row) => {
    const id = normalizeText(row[idIndex]);
    const name = normalizeText(row[nameIndex]);
    if (!id || !name) return [];
    const rawStatus = normalizeText(row[statusIndex]);
    const status: Staff["status"] =
      rawStatus === "病假" || rawStatus === "休假" ? rawStatus : "正常";
    const staffType: Staff["staffType"] = normalizeText(
      row[staffTypeIndex]
    ).includes("行政")
      ? "行政支援"
      : "常规";
    return [
      {
        id,
        name,
        staffType,
        teamLeader:
          staffType === "常规" &&
          teamLeaderIndex >= 0 &&
          ["是", "有", "true", "1"].includes(
            normalizeText(row[teamLeaderIndex]).toLowerCase()
          ),
        cxPreflightQualified:
          staffType === "常规" &&
          ["是", "有", "true", "1"].includes(
            normalizeText(row[cxPreflightIndex]).toLowerCase()
          ),
        dutyQualified:
          staffType === "常规" &&
          (dutyIndex < 0 ||
            !["否", "无", "false", "0"].includes(
              normalizeText(row[dutyIndex]).toLowerCase()
            )),
        standbyQualified:
          staffType === "常规" &&
          (standbyIndex < 0 ||
            !["否", "无", "false", "0"].includes(
              normalizeText(row[standbyIndex]).toLowerCase()
            )),
        nightShift: !["否", "不可以", "false", "0"].includes(
          normalizeText(row[nightIndex]).toLowerCase()
        ),
        status,
        remark: normalizeText(row[remarkIndex]),
      },
    ];
  });
}

function parseFlights(workbook: XLSX.WorkBook): Flight[] | undefined {
  const sheetName = findSheet(workbook, ["航班计划"]);
  if (!sheetName) return undefined;
  const data = rows(workbook, sheetName);
  const header = data[0] ?? [];
  const flightIndex = headerIndex(header, ["航班号"], 0);
  const startIndex = headerIndex(header, ["开始时间"], 1);
  const endIndex = headerIndex(header, ["结束时间"], 2);
  const passengerIndex = headerIndex(
    header,
    ["预定人数", "旅客人数", "运力人数"],
    3
  );
  const positionIndex = headerIndex(header, ["涉及岗位", "岗位"], 4);
  const remarkIndex = headerIndex(header, ["备注"], 5);
  return data.slice(1).flatMap((row) => {
    const flightNo = normalizeText(row[flightIndex]).toUpperCase();
    const startTime = normalizeTime(normalizeText(row[startIndex]));
    const endTime = normalizeTime(normalizeText(row[endIndex]));
    if (!flightNo || !startTime || !endTime) return [];
    return [
      {
        id: createId("flight"),
        flightNo,
        startTime,
        endTime,
        bookedPassengers: Number(row[passengerIndex]) || 0,
        positions: splitList(row[positionIndex]).map(normalizePosition),
        remark: normalizeText(row[remarkIndex]),
      },
    ];
  });
}

function parseTemplates(workbook: XLSX.WorkBook): FlightTemplate[] | undefined {
  const sheetName = findSheet(workbook, ["航班配置", "航班模板"]);
  if (!sheetName) return undefined;
  const data = rows(workbook, sheetName);
  const header = data[0] ?? [];
  const flightIndex = headerIndex(header, ["航班号"], 0);
  const startIndex = headerIndex(header, ["开始时间"], 1);
  const endIndex = headerIndex(header, ["结束时间"], 2);
  const positionIndex = headerIndex(header, ["涉及岗位", "岗位"], 3);
  const remarkIndex = headerIndex(header, ["备注"], 4);
  return data.slice(1).flatMap((row) => {
    const flightNo = normalizeText(row[flightIndex]).toUpperCase();
    const startTime = normalizeTime(normalizeText(row[startIndex]));
    const endTime = normalizeTime(normalizeText(row[endIndex]));
    if (!flightNo || !startTime || !endTime) return [];
    return [
      {
        id: createId("template"),
        flightNo,
        startTime,
        endTime,
        positions: splitList(row[positionIndex]).map(normalizePosition),
        remark: normalizeText(row[remarkIndex]),
      },
    ];
  });
}

function parseWeeklyFlightPlans(
  workbook: XLSX.WorkBook
): WeeklyFlightPlanEntry[] | undefined {
  const sheetName = findSheet(workbook, ["每周航班计划"]);
  if (!sheetName) return undefined;
  const data = rows(workbook, sheetName);
  let plans = createEmptyWeeklyFlightPlans();
  const weekdayByLabel = new Map<string, number>([
    ["星期一", 1],
    ["周一", 1],
    ["星期二", 2],
    ["周二", 2],
    ["星期三", 3],
    ["周三", 3],
    ["星期四", 4],
    ["周四", 4],
    ["星期五", 5],
    ["周五", 5],
    ["星期六", 6],
    ["周六", 6],
    ["星期日", 7],
    ["星期天", 7],
    ["周日", 7],
    ["周天", 7],
  ]);
  for (const row of data.slice(1)) {
    const rawWeekday = normalizeText(row[0]);
    const numericWeekday = Number(rawWeekday);
    const weekday =
      weekdayByLabel.get(rawWeekday) ??
      (Number.isInteger(numericWeekday) &&
      numericWeekday >= 1 &&
      numericWeekday <= 7
        ? numericWeekday
        : undefined);
    if (!weekday) continue;
    plans = replaceWeeklyFlightPlan(
      plans,
      weekday as WeeklyFlightPlanEntry["weekday"],
      splitList(row[1])
    );
  }
  return plans;
}

function parseFatigueMap(workbook: XLSX.WorkBook): Map<string, number> {
  const sheetName = findSheet(workbook, ["岗位疲劳度", "疲劳度计算"]);
  const result = new Map<string, number>();
  if (!sheetName) return result;
  const data = rows(workbook, sheetName);
  let currentFlight = "";
  for (const row of data.slice(1)) {
    currentFlight = normalizeText(row[1]).toUpperCase() || currentFlight;
    const position = normalizePosition(row[5]);
    const points = Number(row[7]);
    if (currentFlight && position && Number.isFinite(points))
      result.set(`${currentFlight}|${position}`, points);
  }
  return result;
}

function parsePositions(workbook: XLSX.WorkBook): PositionRule[] | undefined {
  const sheetName = findSheet(workbook, ["岗位配置"]);
  if (!sheetName) return undefined;
  const fatigueMap = parseFatigueMap(workbook);
  const data = rows(workbook, sheetName);
  const header = data[0] ?? [];
  const flightIndex = headerIndex(header, ["航班号"], 0);
  const categoryIndex = headerIndex(header, ["项目分类", "分类"], 1);
  const nameIndex = headerIndex(header, ["岗位名称"], 2);
  const remarkIndex = headerIndex(header, ["备注"], 3);
  const qualifiedIndex = headerIndex(header, ["可胜任人员"], 4);
  const fatiguePointsIndex = headerIndex(header, ["疲劳点数"], 5);
  const minPassengersIndex = headerIndex(
    header,
    ["启用旅客人数", "最少旅客人数", "运力阈值"],
    fatiguePointsIndex + 1
  );
  const earlyReleaseIndex = headerIndex(
    header,
    ["提前撤岗分钟", "提前撤岗", "分流分钟"],
    minPassengersIndex + 1
  );
  const result: PositionRule[] = [];
  let currentFlight = "";
  for (const row of data.slice(1)) {
    currentFlight =
      normalizeText(row[flightIndex]).toUpperCase() || currentFlight;
    const name = normalizePosition(row[nameIndex]);
    if (!currentFlight || !name) continue;
    const rawQualified = normalizeText(row[qualifiedIndex]);
    const categoryText = normalizeText(row[categoryIndex]);
    if (categoryText.includes("支援") && !categoryText.includes("行政支援"))
      continue;
    const supervisorFill = categoryText.includes("督导补位");
    const category: PositionRule["category"] = supervisorFill
      ? "常规"
      : categoryText.includes("机动督导")
        ? "机动督导"
        : categoryText.includes("行政支援")
          ? "行政支援"
          : categoryText.includes("引导")
            ? "引导"
            : categoryText.includes("分流")
              ? "分流"
              : "常规";
    result.push({
      id: createId("position"),
      flightNo: currentFlight,
      name,
      category,
      coverageRole: supervisorFill ? "supervisor-fill" : "none",
      remark: normalizeText(row[remarkIndex]),
      qualifiedStaffIds: splitList(rawQualified),
      manual: rawQualified.includes("手动输入"),
      fatiguePoints:
        fatigueMap.get(`${currentFlight}|${name}`) ??
        (Number(row[fatiguePointsIndex]) || 1),
      minPassengers: Number(row[minPassengersIndex]) || 0,
      earlyReleaseMinutes: Number(row[earlyReleaseIndex]) || 0,
    });
  }
  const unique = new Map(
    result.map((rule) => [
      `${rule.flightNo}|${rule.name}|${rule.category}`,
      rule,
    ])
  );
  return orderPositionRules([...unique.values()]);
}

function staffIdByName(staff: Staff[], name: string): string {
  return staff.find((person) => person.name === name)?.id ?? "";
}

function parseHistory(
  workbook: XLSX.WorkBook,
  staff: Staff[]
): HistoryRecord[] | undefined {
  const sheetName = findSheet(workbook, ["历史排班", "排班结果"]);
  if (!sheetName) return undefined;
  const data = rows(workbook, sheetName);
  const header = data[0] ?? [];
  const idIndex = headerIndex(header, ["记录ID", "历史记录ID"], -1);
  const dateIndex = headerIndex(header, ["日期"], 0);
  const flightIndex = headerIndex(header, ["航班号"], -1);
  const positionIndex = headerIndex(header, ["岗位"], 1);
  const staffIdIndex = headerIndex(header, ["人员编号", "编号"], -1);
  const nameIndex = headerIndex(header, ["姓名"], 2);
  const startIndex = headerIndex(header, ["开始时间"], -1);
  const endIndex = headerIndex(header, ["结束时间"], -1);
  const flightCutoffIndex = headerIndex(header, ["航班截载时间"], -1);
  const hoursIndex = headerIndex(header, ["工作时长"], 3);
  const fatigueIndex = headerIndex(header, ["疲劳点"], -1);
  const remarkIndex = headerIndex(header, ["备注"], 4);
  const coverageIndex = headerIndex(header, ["历史覆盖范围"], -1);
  const gapFillIndex = headerIndex(header, ["分队长补差"], -1);
  return data.slice(1).flatMap((row) => {
    const date = normalizeText(row[dateIndex]).slice(0, 10);
    const staffName = normalizeText(row[nameIndex]);
    const position = normalizePosition(row[positionIndex]);
    if (!date || !staffName || !position) return [];
    const importedStaffId =
      staffIdIndex >= 0 ? normalizeText(row[staffIdIndex]) : "";
    const startTime =
      startIndex >= 0 ? normalizeTime(normalizeText(row[startIndex])) : "";
    const endTime =
      endIndex >= 0 ? normalizeTime(normalizeText(row[endIndex])) : "";
    const flightCutoffTime =
      flightCutoffIndex >= 0
        ? normalizeTime(normalizeText(row[flightCutoffIndex]))
        : "";
    const rawHours = row[hoursIndex];
    const parsedHours = Number(rawHours);
    const hours =
      normalizeText(rawHours) !== "" && Number.isFinite(parsedHours)
        ? parsedHours
        : durationHours(startTime, endTime);
    const rawFatigue = fatigueIndex >= 0 ? row[fatigueIndex] : "";
    const parsedFatigue = Number(rawFatigue);
    const historyCoverage =
      coverageIndex >= 0 &&
      (normalizeText(row[coverageIndex]) === "complete" ||
        normalizeText(row[coverageIndex]) === "late-priority-only")
        ? (normalizeText(
            row[coverageIndex]
          ) as HistoryRecord["historyCoverage"])
        : undefined;
    const teamLeaderGapFill =
      gapFillIndex >= 0 &&
      ["是", "true", "1"].includes(
        normalizeText(row[gapFillIndex]).toLowerCase()
      )
        ? true
        : undefined;
    return [
      {
        id:
          (idIndex >= 0 && normalizeText(row[idIndex])) || createId("history"),
        date,
        flightNo:
          flightIndex >= 0 ? normalizeText(row[flightIndex]).toUpperCase() : "",
        position,
        staffId: importedStaffId || staffIdByName(staff, staffName),
        staffName,
        startTime,
        endTime,
        ...(flightCutoffTime ? { flightCutoffTime } : {}),
        workHours: hours,
        fatiguePoints:
          normalizeText(rawFatigue) !== "" && Number.isFinite(parsedFatigue)
            ? parsedFatigue
            : hours,
        remark: normalizeText(row[remarkIndex]),
        ...(historyCoverage ? { historyCoverage } : {}),
        ...(teamLeaderGapFill ? { teamLeaderGapFill } : {}),
      },
    ];
  });
}

export function parseWorkbook(
  workbook: XLSX.WorkBook,
  currentStaff: Staff[],
  options: WorkbookImportOptions = {}
): WorkbookImport {
  const staff = parseStaff(workbook);
  const effectiveStaff = staff !== undefined ? staff : currentStaff;
  const flights = parseFlights(workbook);
  const templates = parseTemplates(workbook);
  const weeklyFlightPlans = parseWeeklyFlightPlans(workbook);
  const positionRules = parsePositions(workbook);
  const history = parseHistory(workbook, effectiveStaff);
  const parsedRules = parseScheduleRuleSettings(workbook, effectiveStaff);
  const latePriorityFrequencyAdjustments =
    parseLatePriorityFrequencyAdjustments(workbook);
  const ordinaryPriorityFrequencyAdjustments =
    parseOrdinaryPriorityFrequencyAdjustments(workbook);
  const ordinaryPriorityPositions = parseOrdinaryPriorityPositions(workbook);
  const dutyRoster = parseDutyRosterOverrides(workbook, effectiveStaff);
  if (ordinaryPriorityPositions.present) {
    parsedRules.settings = {
      ...(parsedRules.settings ?? {}),
      ordinaryPriorityPositions: ordinaryPriorityPositions.value,
    };
  }
  const warnings = [...parsedRules.warnings, ...dutyRoster.warnings];
  const hasStandardSheet = Boolean(
    staff ||
    flights ||
    templates ||
    weeklyFlightPlans ||
    positionRules ||
    history ||
    parsedRules.recognized ||
    latePriorityFrequencyAdjustments !== undefined ||
    ordinaryPriorityFrequencyAdjustments !== undefined ||
    ordinaryPriorityPositions.present ||
    workbook.SheetNames.some((name) => name.includes("值班轮值"))
  );
  const legacySchedule = hasStandardSheet
    ? undefined
    : parseLegacyScheduleWorkbook(workbook, effectiveStaff, {
        year: new Date().getFullYear(),
        ...options.legacySchedule,
      });
  if (legacySchedule?.recognizedSheets)
    warnings.push(
      `识别到旧版横向排班：${legacySchedule.recognizedSheets} 个工作日、${legacySchedule.readyRecords} 条可导入、${legacySchedule.reviewRecords} 条待确认`
    );
  if (
    staff?.length === 0 &&
    sheetHasDataRows(workbook, ["人员信息", "员工信息"])
  )
    warnings.push("人员信息工作表没有有效数据");
  if (flights?.length === 0 && sheetHasDataRows(workbook, ["航班计划"]))
    warnings.push("航班计划工作表没有有效数据");
  if (
    templates?.length === 0 &&
    sheetHasDataRows(workbook, ["航班配置", "航班模板"])
  )
    warnings.push("航班配置工作表没有有效数据");
  if (positionRules?.length === 0 && sheetHasDataRows(workbook, ["岗位配置"]))
    warnings.push("岗位配置工作表没有有效数据");
  if (
    !staff &&
    !flights &&
    !templates &&
    !weeklyFlightPlans &&
    !positionRules &&
    !history &&
    !parsedRules.recognized &&
    latePriorityFrequencyAdjustments === undefined &&
    ordinaryPriorityFrequencyAdjustments === undefined &&
    !ordinaryPriorityPositions.present &&
    !workbook.SheetNames.some((name) => name.includes("值班轮值")) &&
    !legacySchedule?.recognizedSheets
  )
    warnings.push("未识别到受支持的工作表");
  return {
    staff,
    flights,
    templates,
    weeklyFlightPlans,
    positionRules,
    history,
    legacySchedule,
    settings: parsedRules.settings,
    latePriorityFrequencyAdjustments,
    ordinaryPriorityFrequencyAdjustments,
    dutyRosterOverrides: dutyRoster.value,
    dutyRosterInvalid: dutyRoster.warnings.length > 0,
    warnings,
  };
}

export async function importWorkbook(
  file: File,
  currentStaff: Staff[],
  options: WorkbookImportOptions = {}
): Promise<WorkbookImport> {
  const workbook = XLSX.read(await file.arrayBuffer(), {
    type: "array",
    cellDates: false,
  });
  return parseWorkbook(workbook, currentStaff, options);
}

export function buildConfigWorkbook(state: AppState): XLSX.WorkBook {
  const workbook = XLSX.utils.book_new();
  const activeStaffIds = new Set(state.staff.map((person) => person.id));
  append(
    workbook,
    "人员信息",
    [
      [
        "编号",
        "姓名",
        "是否可上夜班",
        "状态",
        "备注",
        "人员类型",
        "CX航前资质",
        "值班资质",
        "备勤资质",
        "是否为分队长",
      ],
      ...state.staff.map((person) => [
        person.id,
        person.name,
        person.nightShift ? "是" : "否",
        person.status,
        person.remark,
        person.staffType,
        person.cxPreflightQualified ? "是" : "否",
        person.dutyQualified ? "是" : "否",
        person.standbyQualified ? "是" : "否",
        person.teamLeader ? "是" : "否",
      ]),
    ],
    [10, 14, 16, 10, 24, 14, 14, 14, 14, 16]
  );
  append(
    workbook,
    "航班计划",
    [
      [
        "航班号",
        "开始时间",
        "结束时间",
        "预定人数（当天填写）",
        "涉及岗位（用逗号分隔）",
        "备注",
      ],
      ...state.flights.map((flight) => [
        flight.flightNo,
        flight.startTime,
        flight.endTime,
        flight.bookedPassengers,
        flight.positions.join(","),
        flight.remark,
      ]),
    ],
    [12, 12, 12, 12, 48, 24]
  );
  append(
    workbook,
    "航班配置",
    [
      ["航班号", "开始时间", "结束时间", "涉及岗位（用逗号分隔）", "备注"],
      ...state.templates.map((template) => [
        template.flightNo,
        template.startTime,
        template.endTime,
        template.positions.join(","),
        template.remark,
      ]),
    ],
    [12, 12, 12, 48, 24]
  );
  append(
    workbook,
    "每周航班计划",
    [
      ["星期", "航班号（用逗号分隔）"],
      ...state.weeklyFlightPlans.map((entry) => [
        `星期${["一", "二", "三", "四", "五", "六", "日"][entry.weekday - 1]}`,
        entry.flightNos.join(","),
      ]),
    ],
    [12, 48]
  );
  append(
    workbook,
    "岗位配置",
    [
      [
        "航班号",
        "项目分类",
        "岗位名称",
        "备注",
        "可胜任人员（用逗号分隔）",
        "疲劳点数",
        "启用旅客人数",
        "提前撤岗分钟",
      ],
      ...state.positionRules.map((rule) => [
        rule.flightNo,
        rule.coverageRole === "supervisor-fill" ? "督导补位" : rule.category,
        rule.name,
        rule.remark,
        rule.manual
          ? "手动输入项"
          : rule.qualifiedStaffIds
              .filter((staffId) => activeStaffIds.has(staffId))
              .join(","),
        rule.fatiguePoints,
        rule.minPassengers,
        rule.earlyReleaseMinutes,
      ]),
    ],
    [12, 18, 16, 24, 48, 12, 18, 18]
  );
  append(
    workbook,
    "普通重点岗位集合",
    [
      ["航司", "规范岗位"],
      ...state.settings.ordinaryPriorityPositions.map((item) => [
        item.airlineCode,
        item.position,
      ]),
    ],
    [12, 24]
  );
  appendScheduleRuleSheets(workbook, {
    ...state,
    settings: {
      ...state.settings,
      crossFlightPriorityPolicies:
        state.settings.crossFlightPriorityPolicies.map((rule) => ({
          ...rule,
          staffIds: rule.staffIds.filter((staffId) =>
            activeStaffIds.has(staffId)
          ),
        })),
      sameFlightStaffExclusions:
        state.settings.sameFlightStaffExclusions.filter(
          (rule) =>
            activeStaffIds.has(rule.firstStaffId) &&
            activeStaffIds.has(rule.secondStaffId)
        ),
    },
  });
  append(
    workbook,
    "末班重点次数修正",
    [
      ["月份", "人员编号", "航班号", "类别", "修正次数", "清零基准次数"],
      ...state.latePriorityFrequencyAdjustments.map((item) => [
        item.month,
        item.staffId,
        item.flightNo,
        item.kind,
        item.delta,
        item.resetBaseline ?? 0,
      ]),
    ],
    [12, 14, 14, 16, 12, 16]
  );
  append(
    workbook,
    "普通重点次数修正",
    [
      ["月份", "人员编号", "航司", "规范岗位", "修正次数", "清零基准次数"],
      ...state.ordinaryPriorityFrequencyAdjustments.map((item) => [
        item.month,
        item.staffId,
        item.airlineCode,
        item.position,
        item.delta,
        item.resetBaseline ?? 0,
      ]),
    ],
    [12, 14, 12, 18, 12, 16]
  );
  append(
    workbook,
    "值班轮值",
    [
      ["日期", "CX航前人员编号", "值班人员编号", "备勤1编号", "备勤2编号"],
      ...state.dutyRosterOverrides.map((item) => [
        item.date,
        item.cxPreflightStaffId ?? "",
        item.dutyStaffId ?? "",
        item.standbyStaffIds[0] ?? "",
        item.standbyStaffIds[1] ?? "",
      ]),
    ],
    [14, 20, 20, 16, 16]
  );
  append(
    workbook,
    "历史排班",
    [
      [
        "记录ID",
        "日期",
        "航班号",
        "岗位",
        "人员编号",
        "姓名",
        "开始时间",
        "结束时间",
        "工作时长(小时)",
        "疲劳点数",
        "备注",
        "历史覆盖范围",
        "分队长补差",
        "航班截载时间",
      ],
      ...state.history.map((record) => [
        record.id,
        record.date,
        record.flightNo,
        record.position,
        record.staffId,
        record.staffName,
        record.startTime,
        record.endTime,
        record.workHours,
        record.fatiguePoints,
        record.remark,
        record.historyCoverage ?? "",
        record.teamLeaderGapFill ? "是" : "否",
        record.flightCutoffTime ?? record.endTime,
      ]),
    ],
    [18, 12, 12, 18, 16, 14, 12, 12, 16, 12, 32, 20, 14, 12]
  );
  return workbook;
}

export function buildScheduleWorkbook(
  state: AppState,
  date: string
): XLSX.WorkBook {
  const workbook = XLSX.utils.book_new();
  const assignments = state.assignments;
  const sameDayWarningsByAssignment =
    state.settings.sameDayCrossFlightPriorityEnabled === false
      ? new Map<string, readonly { code: string; message: string }[]>()
      : sameAirlinePriorityWarningsByAssignment(
          assignments,
          state.positionRules
        );
  const flights = [...new Set(assignments.map((item) => item.flightNo))];
  const grouped = flights.map((flightNo) =>
    assignments.filter((item) => item.flightNo === flightNo)
  );
  const isGuideExportAssignment = (item: Assignment): boolean =>
    isGuideAssignment(state, item) || isFixedBottomPosition(item.position);
  const normalGroups = grouped.map((items) =>
    items.filter((item) => !isGuideExportAssignment(item))
  );
  const guideGroups = grouped.map((items) =>
    items.filter(isGuideExportAssignment)
  );
  const maxPositions = Math.max(
    0,
    ...normalGroups.map((items) => items.length)
  );
  const totalColumns = Math.max(4, flights.length * 2);
  const roster = getDutyRosterForDate(state, date);
  const staffName = (staffId: string | null): string =>
    staffId
      ? (state.staff.find((person) => person.id === staffId)?.name ?? "未安排")
      : "未安排";
  const standbyDate = addIsoDays(date, 1);
  const relaxed = buildMonthlyRelaxedShiftStatistics(state, date);
  const airlineCode = (flightNo: string): string =>
    /^[A-Za-z]{2}/.exec(flightNo)?.[0].toUpperCase() ?? "其他";
  const earlyDepartureText = (() => {
    const byAirline = new Map<string, string[]>();
    for (const item of relaxed.currentEarlyDepartures) {
      const code = airlineCode(item.flightNo);
      const names = byAirline.get(code) ?? [];
      if (!names.includes(item.staffName)) names.push(item.staffName);
      byAirline.set(code, names);
    }
    return (
      [...byAirline.entries()]
        .map(([code, names]) => `${code}：${names.join("、")}`)
        .join("\n") || "无"
    );
  })();
  const earlyDepartureRowHeight = Math.max(
    34,
    18 * earlyDepartureText.split("\n").length
  );
  const summaryRows: unknown[][] = [
    [`${date} 航班保障排班`, ...Array(totalColumns - 1).fill("")],
    [
      "CX航前人员",
      staffName(roster.cxPreflightStaffId),
      "24小时值班人员",
      staffName(roster.dutyStaffId),
      ...Array(Math.max(0, totalColumns - 4)).fill(""),
    ],
    [
      `次日备勤一（${standbyDate}）`,
      staffName(roster.standbyStaffIds[0]),
      `次日备勤二（${standbyDate}）`,
      staffName(roster.standbyStaffIds[1]),
      ...Array(Math.max(0, totalColumns - 4)).fill(""),
    ],
    [
      "提前下班",
      earlyDepartureText,
      ...Array(Math.max(0, totalColumns - 2)).fill(""),
    ],
    Array(totalColumns).fill(""),
  ];
  const matrixHeader: unknown[] =
    [
      flights.flatMap((flightNo, index) => {
        const first = grouped[index]?.[0];
        const flightRemark = state.flights
          .find((flight) => flight.flightNo === flightNo)
          ?.remark.trim();
        return [
          `${date}\n岗位`,
          [
            flightNo,
            flightRemark,
            `${first?.startTime ?? ""}-${first?.endTime ?? ""}`,
          ]
            .filter(Boolean)
            .join("\n"),
        ];
      }),
    ][0] ?? [];
  const matrix: unknown[][] = [...summaryRows, matrixHeader];
  for (let row = 0; row < maxPositions; row += 1) {
    matrix.push(
      normalGroups.flatMap((items) => {
        const item = items[row];
        if (!item) return ["", ""];
        const remark = combinedAssignmentRemark(item.remark, item.manualRemark);
        const staff =
          item.staffName || (item.status === "manual" ? "" : "待补位");
        return [item.position, [staff, remark].filter(Boolean).join("\n")];
      })
    );
  }
  matrix.push(Array(totalColumns).fill(""));
  matrix.push(Array(totalColumns).fill(""));
  matrix.push(
    guideGroups.flatMap((items) => {
      const names = [
        ...new Set(
          items
            .map(
              (item) =>
                item.staffName || (item.status === "manual" ? "" : "待补位")
            )
            .filter(Boolean)
        ),
      ];
      return names.length
        ? ["引导人员", names.join("、")]
        : ["引导人员", "未安排"];
    })
  );
  const matrixSheet = sheet(
    matrix,
    Array.from({ length: totalColumns }, (_, index) =>
      index % 2 === 0 ? 20 : 22
    )
  );
  const range = XLSX.utils.decode_range(matrixSheet["!ref"] ?? "A1");
  for (let row = range.s.r; row <= range.e.r; row += 1) {
    for (let column = range.s.c; column <= range.e.c; column += 1) {
      const address = XLSX.utils.encode_cell({ r: row, c: column });
      const cell = matrixSheet[address];
      if (!cell) continue;
      const matrixHeaderRow = summaryRows.length;
      const isTitle = row === 0;
      const isSummary = row > 0 && row < summaryRows.length - 1;
      const isSummaryLabel = isSummary && (column === 0 || column === 2);
      const isGuideRow = row === matrixHeaderRow + maxPositions + 3;
      const isBlankGuideSpacer =
        row > matrixHeaderRow + maxPositions &&
        row < matrixHeaderRow + maxPositions + 3;
      cell.s = {
        font: {
          bold:
            isTitle ||
            row === matrixHeaderRow ||
            column % 2 === 0 ||
            isSummaryLabel ||
            isGuideRow,
          color: {
            rgb: isTitle || row === matrixHeaderRow ? "FFFFFF" : "1F2328",
          },
          sz: isTitle ? 14 : isGuideRow ? 11 : 10,
        },
        fill: {
          fgColor: {
            rgb:
              isTitle || row === matrixHeaderRow
                ? "B4232D"
                : isSummaryLabel
                  ? "F3F4F6"
                  : isGuideRow
                    ? "EAF4F1"
                    : isBlankGuideSpacer
                      ? "FFFFFF"
                      : column % 2 === 0
                        ? "F3F4F6"
                        : "FFFFFF",
          },
        },
        alignment: { vertical: "center", horizontal: "center", wrapText: true },
        border: {
          top: {
            style: isBlankGuideSpacer ? undefined : "thin",
            color: { rgb: "D8DEE4" },
          },
          bottom: {
            style: isBlankGuideSpacer ? undefined : "thin",
            color: { rgb: "D8DEE4" },
          },
          left: {
            style: isBlankGuideSpacer ? undefined : "thin",
            color: { rgb: "D8DEE4" },
          },
          right: {
            style: isBlankGuideSpacer ? undefined : "thin",
            color: { rgb: "D8DEE4" },
          },
        },
      };
    }
  }
  matrixSheet["!rows"] = [
    { hpt: 30 },
    { hpt: 22 },
    { hpt: 22 },
    { hpt: earlyDepartureRowHeight },
    { hpt: 10 },
    { hpt: 42 },
    ...Array.from({ length: maxPositions }, () => ({ hpt: 26 })),
    { hpt: 10 },
    { hpt: 10 },
    { hpt: 28 },
  ];
  matrixSheet["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: totalColumns - 1 } },
    { s: { r: 3, c: 1 }, e: { r: 3, c: totalColumns - 1 } },
  ];
  XLSX.utils.book_append_sheet(workbook, matrixSheet, "保障明细");
  append(
    workbook,
    "排班结果",
    [
      [
        "日期",
        "航班号",
        "岗位",
        "姓名",
        "开始时间",
        "结束时间",
        "工作时长(小时)",
        "疲劳点数",
        "备注",
        "状态",
        "航班截载时间",
        "系统说明",
      ],
      ...assignments.map((item) => [
        date,
        item.flightNo,
        item.position,
        item.staffName,
        item.startTime,
        item.endTime,
        item.workHours,
        item.fatiguePoints,
        assignmentWarningRemark(item.remark, item.manualRemark, [
          ...(item.manualOverrideWarnings ?? []),
          ...(sameDayWarningsByAssignment.get(item.id) ?? []),
        ]),
        item.status === "assigned"
          ? "已排"
          : item.status === "manual"
            ? "可留空"
            : "待补位",
        state.flights.find((flight) => flight.id === item.flightId)?.endTime ??
          item.endTime,
        (item.systemNotes ?? []).join("；"),
      ]),
    ],
    [12, 12, 16, 14, 12, 12, 16, 12, 24, 12, 12, 60]
  );
  const people = new Map<string, Assignment[]>();
  assignments
    .filter((item) => item.staffId)
    .forEach((item) =>
      people.set(item.staffName, [...(people.get(item.staffName) ?? []), item])
    );
  append(
    workbook,
    "人员排班",
    [
      [
        "日期",
        "姓名",
        "航班号",
        "岗位",
        "开始时间",
        "结束时间",
        "工作时长(小时)",
      ],
      ...[...people.entries()].flatMap(([name, items]) =>
        items.map((item) => [
          date,
          name,
          item.flightNo,
          item.position,
          item.startTime,
          item.endTime,
          item.workHours,
        ])
      ),
    ],
    [12, 14, 12, 18, 12, 12, 16]
  );
  return workbook;
}

export function writeWorkbook(workbook: XLSX.WorkBook, fileName: string): void {
  const bytes = XLSX.write(workbook, {
    bookType: "xlsx",
    type: "array",
    compression: true,
  });
  downloadBlob(
    new Blob([bytes], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    fileName
  );
}
