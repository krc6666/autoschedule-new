import type * as XLSX from "xlsx-js-style";
import type { HalfRestSelection } from "../model";
import { normalizeHalfRestSelections } from "../domain/records/half-rest-selections";
import { append, rows } from "./excel-worksheet";

export function appendHalfRestSelections(
  workbook: XLSX.WorkBook,
  selections: readonly HalfRestSelection[]
): void {
  append(
    workbook,
    "半休选择",
    [
      ["日期", "半休人员(JSON)"],
      ...selections.map((row) => [row.date, JSON.stringify(row.modes)]),
    ],
    [14, 60]
  );
}

export function parseHalfRestSelections(workbook: XLSX.WorkBook): {
  value?: HalfRestSelection[];
  warnings: string[];
} {
  if (!workbook.Sheets["半休选择"]) return { warnings: [] };
  const data = rows(workbook, "半休选择");
  const invalid = () => ({ warnings: ["半休选择表无效，保留已有半休标记。"] });
  if (data[0]?.[0] !== "日期" || data[0]?.[1] !== "半休人员(JSON)")
    return invalid();
  const result: HalfRestSelection[] = [];
  for (const row of data.slice(1)) {
    if (!row.some((v) => String(v).trim())) continue;
    try {
      const normalized = normalizeHalfRestSelections([
        { date: String(row[0]), modes: JSON.parse(String(row[1])) },
      ]);
      if (
        normalized.length !== 1 ||
        result.some((r) => r.date === normalized[0]!.date)
      )
        return invalid();
      result.push(normalized[0]!);
    } catch {
      return invalid();
    }
  }
  return { value: result, warnings: [] };
}
