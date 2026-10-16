import * as XLSX from "xlsx-js-style";

import type { HistoryRecord, PositionRule, Staff } from "../model";
import { durationHours, normalizeTime } from "../domain/shared/time";
import { createId, normalizeText } from "../utils";
import { rows, normalizePosition } from "./excel-worksheet";
import {
  endsAfterLateShiftThreshold,
  latePriorityFrequencyKinds,
  normalizeLatePriorityFlightNumber,
  normalizeLatePriorityPositionReference,
} from "../domain/reviews/late-priority-policy";
import { latePriorityFlightInScope } from "../domain/statistics/late-priority-flight-scope";

export type LegacyRecordStatus = "ready" | "review";

export interface LegacyScheduleRecord extends HistoryRecord {
  rawText: string;
  sourceSheet: string;
  sourceCell: string;
  status: LegacyRecordStatus;
  issue?: string;
}

export interface LegacyScheduleImportPreview {
  records: LegacyScheduleRecord[];
  sheets: number;
  recognizedSheets: number;
  readyRecords: number;
  reviewRecords: number;
  ignoredRecords: number;
  warnings: string[];
}

export interface LegacyScheduleParseOptions {
  year?: number;
  targetDate?: string;
  latePriorityOnly?: boolean;
  latePriorityFlightNumbers?: readonly string[];
  positionRules?: readonly PositionRule[];
  lateShiftEndTime?: string;
}

const FLIGHT_PATTERN = /\b([A-Z]{2}\d{3,4})\b/i;
const TIME_RANGE_PATTERN = /(\d{3,4})\s*[-~至]\s*(\d{3,4})/;
const STATUS_PATTERN = /病假|年休假|产假|飞行假|休假/;

function normalizedCell(value: unknown): string {
  return normalizeText(value).replace(/\\n/g, "\n");
}

function compactTime(value: string): string {
  const digits = value.replace(/\D/g, "").padStart(4, "0");
  return normalizeTime(`${digits.slice(0, -2)}:${digits.slice(-2)}`);
}

function parseFlightHeader(
  value: unknown
): { flightNo: string; startTime: string; endTime: string } | undefined {
  const text = normalizedCell(value);
  const flightNo = text.match(FLIGHT_PATTERN)?.[1]?.toUpperCase();
  const range = text.match(TIME_RANGE_PATTERN);
  if (!flightNo || !range) return undefined;
  const startTime = compactTime(range[1]!);
  const endTime = compactTime(range[2]!);
  if (!startTime || !endTime) return undefined;
  return { flightNo, startTime, endTime };
}

function parseSheetDate(sheetName: string, year: number): string | undefined {
  const match = /(?:^|\D)(\d{1,2})[./-](\d{1,2})(?:\D|$)/.exec(sheetName);
  if (!match) return undefined;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const value = new Date(Date.UTC(year, month - 1, day));
  if (
    value.getUTCFullYear() !== year ||
    value.getUTCMonth() !== month - 1 ||
    value.getUTCDate() !== day
  )
    return undefined;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function cleanPosition(value: unknown): string {
  return normalizePosition(normalizedCell(value).replace(/[（(].*?[）)]/g, ""));
}

function cellName(
  value: unknown,
  staff: readonly Staff[]
): {
  staffId: string;
  staffName: string;
  status: LegacyRecordStatus;
  issue?: string;
} {
  const raw = normalizedCell(value).trim();
  if (!raw || raw === "/" || raw === "取消")
    return {
      staffId: "",
      staffName: "",
      status: "review",
      issue: "空白或取消",
    };
  const matches = staff
    .map((person) => person)
    .filter((person) => raw.includes(person.name))
    .sort((a, b) => b.name.length - a.name.length);
  const unique = [
    ...new Map(matches.map((person) => [person.id, person])).values(),
  ];
  if (unique.length > 1)
    return {
      staffId: "",
      staffName: "",
      status: "review",
      issue: "多人单元格，需确认",
    };
  if (unique.length === 1) {
    const person = unique[0]!;
    return {
      staffId: person.id,
      staffName: person.name,
      status: STATUS_PATTERN.test(raw) ? "review" : "ready",
      issue: STATUS_PATTERN.test(raw) ? "包含休假状态，需确认" : undefined,
    };
  }
  return {
    staffId: "",
    staffName: "",
    status: "review",
    issue: "未匹配到系统人员",
  };
}

function cellAddress(column: number, row: number): string {
  let value = "";
  let current = column + 1;
  while (current > 0) {
    const remainder = (current - 1) % 26;
    value = String.fromCharCode(65 + remainder) + value;
    current = Math.floor((current - 1) / 26);
  }
  return `${value}${row + 1}`;
}

function latePriorityRuleFor(
  record: Pick<
    LegacyScheduleRecord,
    "flightNo" | "position" | "startTime" | "endTime"
  >,
  options: LegacyScheduleParseOptions
): PositionRule | undefined {
  if (!options.latePriorityOnly) return undefined;
  if (
    !options.positionRules ||
    !options.latePriorityFlightNumbers ||
    !options.lateShiftEndTime ||
    !latePriorityFlightInScope(
      options.latePriorityFlightNumbers,
      record.flightNo
    )
  )
    return undefined;
  const normalizedFlight = normalizeLatePriorityFlightNumber(record.flightNo);
  const normalizedPosition = normalizeLatePriorityPositionReference(
    record.position
  );
  return options.positionRules.find(
    (rule) =>
      normalizeLatePriorityFlightNumber(rule.flightNo) === normalizedFlight &&
      normalizeLatePriorityPositionReference(rule.name) ===
        normalizedPosition &&
      latePriorityFrequencyKinds(rule).length > 0 &&
      endsAfterLateShiftThreshold(record, options.lateShiftEndTime!)
  );
}

export function parseLegacyScheduleWorkbook(
  workbook: XLSX.WorkBook,
  staff: readonly Staff[],
  options: LegacyScheduleParseOptions = {}
): LegacyScheduleImportPreview {
  const year = options.year ?? new Date().getFullYear();
  const records: LegacyScheduleRecord[] = [];
  const warnings: string[] = [];
  let ignoredRecords = 0;
  let recognizedSheets = 0;
  for (const sheetName of workbook.SheetNames) {
    const data = rows(workbook, sheetName);
    const detectedDate =
      parseSheetDate(sheetName, year) ??
      parseSheetDate(normalizedCell(data[0]?.[0]), year);
    const date = options.targetDate ?? detectedDate;
    if (!date) continue;
    const headers = data[0] ?? [];
    const flights = new Map<
      number,
      { flightNo: string; startTime: string; endTime: string }
    >();
    for (let column = 1; column < headers.length; column += 2) {
      const flight = parseFlightHeader(headers[column]);
      if (flight) flights.set(column, flight);
    }
    if (!flights.size) continue;
    recognizedSheets += 1;
    for (const [personColumn, flight] of flights) {
      const positionColumn = personColumn - 1;
      for (let rowIndex = 1; rowIndex < data.length; rowIndex += 1) {
        const position = cleanPosition(data[rowIndex]?.[positionColumn]);
        const rawText = normalizedCell(data[rowIndex]?.[personColumn]);
        if (!position || !rawText || rawText === "取消" || rawText === "/")
          continue;
        const person = cellName(rawText, staff);
        const candidate = {
          flightNo: flight.flightNo,
          position,
          startTime: flight.startTime,
          endTime: flight.endTime,
        };
        const latePriorityRule = latePriorityRuleFor(candidate, options);
        if (options.latePriorityOnly && !latePriorityRule) {
          ignoredRecords += 1;
          continue;
        }
        const issue = person.issue;
        records.push({
          id: createId("legacy-history"),
          date,
          flightNo: flight.flightNo,
          position,
          staffId: person.staffId,
          staffName: person.staffName,
          startTime: flight.startTime,
          endTime: flight.endTime,
          workHours: durationHours(flight.startTime, flight.endTime),
          fatiguePoints:
            latePriorityRule?.fatiguePoints ??
            durationHours(flight.startTime, flight.endTime),
          remark: options.latePriorityOnly
            ? (latePriorityRule?.remark ?? "")
            : rawText,
          rawText,
          sourceSheet: sheetName,
          sourceCell: cellAddress(personColumn, rowIndex),
          status: person.status,
          issue,
        });
        if (issue)
          warnings.push(
            `${sheetName} ${cellAddress(personColumn, rowIndex)}：${issue}`
          );
      }
    }
  }
  const uniqueWarnings = [...new Set(warnings)];
  return {
    records,
    sheets: workbook.SheetNames.length,
    recognizedSheets,
    readyRecords: records.filter((record) => record.status === "ready").length,
    reviewRecords: records.filter((record) => record.status === "review")
      .length,
    ignoredRecords,
    warnings: uniqueWarnings,
  };
}
