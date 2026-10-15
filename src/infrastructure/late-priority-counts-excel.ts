import * as XLSX from "xlsx-js-style";

import {
  LATE_PRIORITY_STATISTICS_CATEGORIES,
  buildMonthlyLatePriorityStatistics,
  canAdjustLatePriorityCategory,
  type LatePriorityStatisticsCategory,
} from "../domain/statistics/monthly-late-priority-statistics";
import { normalizeLatePriorityFlightNumber } from "../domain/reviews/late-priority-policy";
import type { AppState } from "../model";
import { normalizeText } from "../utils";
import { append, headerIndex, rows } from "./excel-worksheet";

const SHEET_NAME = "末班重点岗位次数";

export interface LatePriorityCountTarget {
  month: string;
  staffId: string;
  staffName: string;
  flightNo: string;
  category: LatePriorityStatisticsCategory;
  finalCount: number;
}

export interface LatePriorityCountsImportPreview {
  month: string;
  referenceDate: string;
  flightNumbers: string[];
  targets: LatePriorityCountTarget[];
  errors: string[];
  canApply: boolean;
}

export function buildLatePriorityCountsWorkbook(
  state: AppState,
  date: string
): XLSX.WorkBook {
  const statistics = buildMonthlyLatePriorityStatistics(state, date);
  const workbook = XLSX.utils.book_new();
  append(
    workbook,
    SHEET_NAME,
    [
      ["月份", "人员编号", "人员姓名", "航班号", "岗位类别", "最终次数"],
      ...statistics.rows.flatMap((row) =>
        statistics.flightNumbers.flatMap((flightNo) =>
          row.flights[flightNo]!.applicableCategories.map((category) => [
            statistics.month,
            row.staff.id,
            row.staff.name,
            flightNo,
            category,
            row.flights[flightNo]!.categories[category].effectiveCount,
          ])
        )
      ),
    ],
    [12, 14, 14, 14, 14, 12]
  );
  return workbook;
}

export function parseLatePriorityCountsWorkbook(
  workbook: XLSX.WorkBook,
  state: AppState,
  expectedDate: string
): LatePriorityCountsImportPreview {
  const month = expectedDate.slice(0, 7);
  const errors: string[] = [];
  const data = rows(workbook, SHEET_NAME);
  if (!data.length) {
    return {
      month,
      referenceDate: expectedDate,
      flightNumbers: [],
      targets: [],
      errors: [`缺少“${SHEET_NAME}”工作表或工作表为空`],
      canApply: false,
    };
  }
  const header = data[0] ?? [];
  const monthIndex = headerIndex(header, ["月份"], 0);
  const staffIdIndex = headerIndex(header, ["人员编号"], 1);
  const staffNameIndex = headerIndex(header, ["人员姓名"], 2);
  const flightIndex = headerIndex(header, ["航班号"], 3);
  const categoryIndex = headerIndex(header, ["岗位类别"], 4);
  const countIndex = headerIndex(header, ["最终次数"], 5);
  const staffById = new Map(state.staff.map((person) => [person.id, person]));
  const statistics = buildMonthlyLatePriorityStatistics(state, expectedDate);
  const rowByStaffId = new Map(
    statistics.rows.map((row) => [row.staff.id, row])
  );
  const allowedFlights = new Set(statistics.flightNumbers);
  const allowedCategories = new Set<string>(
    LATE_PRIORITY_STATISTICS_CATEGORIES
  );
  const expectedKeys = statistics.rows.flatMap((row) =>
    statistics.flightNumbers.flatMap((flightNo) =>
      row.flights[flightNo]!.applicableCategories.map((category) =>
        [row.staff.id, flightNo, category].join("\u0000")
      )
    )
  );
  const expectedKeySet = new Set(expectedKeys);
  const seen = new Set<string>();
  const targets: LatePriorityCountTarget[] = [];

  data.slice(1).forEach((row, offset) => {
    const excelRow = offset + 2;
    if (!row.some((value) => normalizeText(value))) return;
    const rowMonth = normalizeText(row[monthIndex]);
    const staffId = normalizeText(row[staffIdIndex]);
    const staffName = normalizeText(row[staffNameIndex]);
    const flightNo = normalizeLatePriorityFlightNumber(
      normalizeText(row[flightIndex])
    );
    const category = normalizeText(row[categoryIndex]);
    const rawCount = normalizeText(row[countIndex]);
    const finalCount = Number(rawCount);
    const key = [staffId, flightNo, category].join("\u0000");
    let valid = true;
    if (rowMonth !== month) {
      errors.push(`第${excelRow}行月份应为 ${month}`);
      valid = false;
    }
    const staff = staffById.get(staffId);
    if (!staff) {
      errors.push(`第${excelRow}行人员编号不存在：${staffId || "空"}`);
      valid = false;
    } else if (staffName && staffName !== staff.name) {
      errors.push(`第${excelRow}行人员姓名与编号不一致`);
      valid = false;
    }
    if (!allowedFlights.has(flightNo)) {
      errors.push(
        `第${excelRow}行航班不在当前末班重点范围：${flightNo || "空"}`
      );
      valid = false;
    }
    if (!allowedCategories.has(category)) {
      errors.push(`第${excelRow}行岗位类别无效：${category || "空"}`);
      valid = false;
    } else if (!expectedKeySet.has(key)) {
      errors.push(`第${excelRow}行岗位类别不适用于当前航班：${category}`);
      valid = false;
    }
    if (!rawCount || !Number.isInteger(finalCount) || finalCount < 0) {
      errors.push(`第${excelRow}行最终次数必须是非负整数`);
      valid = false;
    }
    if (seen.has(key)) {
      errors.push(`第${excelRow}行与前面记录重复`);
      valid = false;
    }
    seen.add(key);
    const categoryStatistics =
      rowByStaffId.get(staffId)?.flights[flightNo]?.categories[
        category as LatePriorityStatisticsCategory
      ];
    if (
      valid &&
      staff &&
      allowedCategories.has(category) &&
      (!categoryStatistics ||
        !canAdjustLatePriorityCategory(categoryStatistics)) &&
      finalCount !== 0
    ) {
      errors.push(
        `第${excelRow}行人员没有该航班岗位类别资质或已记录次数，次数只能为 0`
      );
      valid = false;
    }
    if (valid && staff) {
      targets.push({
        month,
        staffId,
        staffName: staff.name,
        flightNo,
        category: category as LatePriorityStatisticsCategory,
        finalCount,
      });
    }
  });

  const missingCount = expectedKeys.filter((key) => !seen.has(key)).length;
  if (missingCount)
    errors.push(
      `文件缺少 ${missingCount} 项人员、航班或岗位类别记录，请使用本页面导出的完整次数文件`
    );

  const flightNumbers = statistics.flightNumbers;
  if (!targets.length) errors.push("工作表中没有可导入的次数记录");
  return {
    month,
    referenceDate: expectedDate,
    flightNumbers,
    targets,
    errors,
    canApply: errors.length === 0 && targets.length > 0,
  };
}

export async function importLatePriorityCountsWorkbook(
  file: File,
  state: AppState,
  expectedDate: string
): Promise<LatePriorityCountsImportPreview> {
  const workbook = XLSX.read(await file.arrayBuffer(), {
    type: "array",
    cellDates: false,
  });
  return parseLatePriorityCountsWorkbook(workbook, state, expectedDate);
}
