import type * as XLSX from "xlsx-js-style";
import type { FlightLeaderCoverageHistory } from "../model";
import type { ScheduleSettings } from "../model";
import { normalizeFlightLeaderRequirements } from "../domain/rules/flight-leader-requirements";
import { normalizeFlightLeaderCoverageHistory } from "../domain/rules/flight-leader-coverage";
import { append, rows } from "./excel-worksheet";

const SHEET = "负责人保障记录";

const REQUIREMENTS = "航班负责人人数";
export function appendFlightLeaderRequirements(
  workbook: XLSX.WorkBook,
  requirements: ScheduleSettings["flightLeaderRequirements"]
): void {
  append(
    workbook,
    REQUIREMENTS,
    [
      ["航班号", "至少负责人人数"],
      ...requirements.map((row) => [row.flightNo, row.minimum]),
    ],
    [22, 22]
  );
}

export function parseFlightLeaderRequirements(workbook: XLSX.WorkBook): {
  value?: ScheduleSettings["flightLeaderRequirements"];
  warnings: string[];
} {
  if (!workbook.Sheets[REQUIREMENTS]) return { warnings: [] };
  const data = rows(workbook, REQUIREMENTS);
  const invalid = () => ({
    warnings: [
      "航班负责人人数表无效，须为不同航班及1至100整数；保留已有设置。",
    ],
  });
  if (data[0]?.[0] !== "航班号" || data[0]?.[1] !== "至少负责人人数")
    return invalid();
  const raw = data
    .slice(1)
    .filter((row) => row.some((value) => String(value).trim()))
    .map((row) => ({
      flightNo: String(row[0] ?? ""),
      minimum: Number(row[1]),
    }));
  const normalized = normalizeFlightLeaderRequirements(raw);
  return normalized.length === raw.length
    ? { value: normalized, warnings: [] }
    : invalid();
}

export function appendFlightLeaderCoverageHistory(
  workbook: XLSX.WorkBook,
  history: readonly FlightLeaderCoverageHistory[]
): void {
  append(
    workbook,
    SHEET,
    [
      ["日期", "航班负责人人数(JSON)"],
      ...history.map((day) => [day.date, JSON.stringify(day.flights)]),
    ],
    [14, 90]
  );
}

export function parseFlightLeaderCoverageHistory(workbook: XLSX.WorkBook): {
  value?: FlightLeaderCoverageHistory[];
  warnings: string[];
} {
  if (!workbook.Sheets[SHEET]) return { warnings: [] };
  const data = rows(workbook, SHEET);
  const invalid = () => ({
    warnings: ["负责人保障记录表无效，保留已有记录。"],
  });
  if (data[0]?.[0] !== "日期" || data[0]?.[1] !== "航班负责人人数(JSON)")
    return invalid();
  const result: FlightLeaderCoverageHistory[] = [];
  for (const row of data.slice(1)) {
    if (!row.some((value) => String(value).trim())) continue;
    try {
      const normalized = normalizeFlightLeaderCoverageHistory([
        { date: String(row[0]), flights: JSON.parse(String(row[1])) },
      ]);
      if (
        normalized.length !== 1 ||
        result.some((day) => day.date === normalized[0]!.date)
      )
        return invalid();
      result.push(normalized[0]!);
    } catch {
      return invalid();
    }
  }
  return { value: result, warnings: [] };
}
