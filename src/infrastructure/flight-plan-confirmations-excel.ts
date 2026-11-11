import type * as XLSX from "xlsx-js-style";
import type { FlightPlanConfirmation } from "../model";
import { normalizeFlightPlanConfirmations } from "../domain/flights/flight-plan-review";
import { append, rows } from "./excel-worksheet";

const sheetName = "航班换季确认";
const header = [
  "确认类型",
  "航班号",
  "已核对模板开始",
  "已核对模板结束",
  "保留当天开始",
  "保留当天结束",
];

export function appendFlightPlanConfirmations(
  book: XLSX.WorkBook,
  values: readonly FlightPlanConfirmation[]
) {
  append(
    book,
    sheetName,
    [
      header,
      ...values.map((r) => [
        r.kind,
        r.flightNo,
        r.templateStartTime,
        r.templateEndTime,
        r.currentStartTime,
        r.currentEndTime,
      ]),
    ],
    [24, 18, 20, 20, 20, 20]
  );
}

export function parseFlightPlanConfirmations(book: XLSX.WorkBook): {
  value?: FlightPlanConfirmation[];
  warnings: string[];
} {
  if (!book.Sheets[sheetName]) return { warnings: [] };
  const data = rows(book, sheetName);
  const invalid = () => ({
    warnings: ["航班换季确认表无效，未应用确认记录；请重新核对航班。"],
  });
  if (header.some((value, index) => data[0]?.[index] !== value))
    return invalid();
  const result: FlightPlanConfirmation[] = [];
  for (const row of data.slice(1)) {
    if (!row.some((v) => String(v).trim())) continue;
    const valid = normalizeFlightPlanConfirmations([
      {
        kind: row[0],
        flightNo: row[1],
        templateStartTime: row[2],
        templateEndTime: row[3],
        currentStartTime: row[4],
        currentEndTime: row[5],
      },
    ]);
    if (
      valid.length !== 1 ||
      result.some(
        (r) => r.kind === valid[0]!.kind && r.flightNo === valid[0]!.flightNo
      )
    )
      return invalid();
    result.push(valid[0]!);
  }
  return { value: result, warnings: [] };
}
