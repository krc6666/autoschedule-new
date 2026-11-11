import type * as XLSX from "xlsx-js-style";
import { normalizeWeeklyFlightNo as normalize } from "../domain/flights/weekly-flight-plan";
import { normalizeFlightSeasonOverrides } from "../domain/flights/configured-flight-positions";
import { append, rows } from "./excel-worksheet";

const sheetName = "本季航班状态";
const header = ["航班号", "本季启用"];

export function appendFlightSeasonOverrides(
  book: XLSX.WorkBook,
  values: Record<string, boolean> = {}
) {
  append(
    book,
    sheetName,
    [
      header,
      ...Object.entries(normalizeFlightSeasonOverrides(values)).map(
        ([no, enabled]) => [no, enabled ? "是" : "否"]
      ),
    ],
    [24, 24]
  );
}

export function parseFlightSeasonOverrides(book: XLSX.WorkBook): {
  value?: Record<string, boolean>;
  warnings: string[];
} {
  if (!book.Sheets[sheetName]) return { warnings: [] };
  const data = rows(book, sheetName);
  const invalid = (detail: string) => ({
    warnings: [`本季航班状态${detail}，未应用本季启用设置`],
  });
  if (header.some((v, i) => data[0]?.[i] !== v)) return invalid("表头无效");
  const result = new Map<string, boolean>();
  for (const [index, row] of data.slice(1).entries()) {
    if (!row.some((v) => String(v).trim())) continue;
    const no = normalize(String(row[0] ?? ""));
    if (!no || result.has(no) || !["是", "否"].includes(String(row[1])))
      return invalid(`第${index + 2}行无效或重复`);
    result.set(no, row[1] === "是");
  }
  return { value: Object.fromEntries(result), warnings: [] };
}
