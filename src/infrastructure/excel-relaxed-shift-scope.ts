import type * as XLSX from "xlsx-js-style";
import { normalizeRelaxedShiftFlights } from "../domain/statistics/relaxed-shift-flight-scope";
import { append, rows } from "./excel-worksheet";
import { normalizeText } from "../utils";

const SHEET = "轻松班次航班范围";

export function parseRelaxedShiftScope(workbook: XLSX.WorkBook): {
  present: boolean;
  value?: string[] | null;
  warnings: string[];
} {
  if (!workbook.SheetNames.includes(SHEET))
    return { present: false, warnings: [] };
  const [header = [], ...data] = rows(workbook, SHEET);
  const modeIndex = header.findIndex((c) => normalizeText(c) === "选择方式");
  const flightIndex = header.findIndex((c) => normalizeText(c) === "航班号");
  const invalid = (reason: string) => ({
    present: true,
    warnings: [`${SHEET}：${reason}，未覆盖原范围`],
  });
  if (modeIndex < 0 || flightIndex < 0)
    return invalid("缺少选择方式或航班号表头");
  const entries = data
    .map((row, index) => ({
      row: index + 2,
      mode: normalizeText(row[modeIndex]),
      flight: normalizeText(row[flightIndex]),
    }))
    .filter((entry) => entry.mode || entry.flight);
  if (
    entries.length === 1 &&
    entries[0]!.mode === "默认MF/CX" &&
    !entries[0]!.flight
  )
    return { present: true, value: null, warnings: [] };
  const bad = entries.find(
    (entry) =>
      entry.mode !== "指定" ||
      !normalizeRelaxedShiftFlights([entry.flight]).length
  );
  if (bad)
    return invalid(
      `第${bad.row}行选择方式或航班号无效；默认MF/CX不能与指定航班混用`
    );
  const selected = normalizeRelaxedShiftFlights(
    entries.map((entry) => entry.flight)
  );
  if (selected.length !== entries.length) return invalid("航班号重复");
  return { present: true, value: selected, warnings: [] };
}

export function appendRelaxedShiftScope(
  workbook: XLSX.WorkBook,
  value: string[] | null
): void {
  append(
    workbook,
    SHEET,
    [
      ["选择方式", "航班号"],
      ...(value === null
        ? [["默认MF/CX", ""]]
        : value.map((no) => ["指定", no])),
    ],
    [20, 20]
  );
}
