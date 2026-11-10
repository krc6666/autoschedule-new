import type * as XLSX from "xlsx-js-style";
import type { LeaveType } from "../model";
import { leaveTypeNameError } from "../domain/staff-status";
import { append, findSheet, rows } from "./excel-worksheet";
import { normalizeText } from "../utils";

export function parseLeaveTypes(workbook: XLSX.WorkBook): {
  types?: LeaveType[];
  warnings: string[];
} {
  const name = findSheet(workbook, ["休假类别"]);
  if (!name) return { warnings: [] };
  const data = rows(workbook, name);
  const header = data[0] ?? [];
  const idIndex = header.findIndex(
    (cell) => normalizeText(cell) === "类别编号"
  );
  const nameIndex = header.findIndex((cell) => normalizeText(cell) === "名称");
  const enabledIndex = header.findIndex(
    (cell) => normalizeText(cell) === "启用"
  );
  if ([idIndex, nameIndex, enabledIndex].some((index) => index < 0))
    return {
      warnings: ["休假类别工作表缺少类别编号、名称或启用表头，未应用该表"],
    };
  const types: LeaveType[] = [];
  const warnings: string[] = [];
  data.slice(1).forEach((row, index) => {
    if (row.every((cell) => !normalizeText(cell))) return;
    const id = normalizeText(row[idIndex]);
    const typeName = normalizeText(row[nameIndex]);
    const enabled = normalizeText(row[enabledIndex]);
    const error = leaveTypeNameError(typeName, types);
    if (
      !id ||
      types.some((item) => item.id === id) ||
      error ||
      !["是", "否"].includes(enabled)
    ) {
      warnings.push(
        `休假类别第${index + 2}行：${error ?? "类别编号为空、重复或启用值不是是/否"}，未应用该表`
      );
      return;
    }
    types.push({ id, name: typeName, enabled: enabled === "是" });
  });
  return warnings.length ? { warnings } : { types, warnings };
}

export function appendLeaveTypes(
  workbook: XLSX.WorkBook,
  types: readonly LeaveType[]
): void {
  append(
    workbook,
    "休假类别",
    [
      ["类别编号", "名称", "启用"],
      ...types.map((type) => [type.id, type.name, type.enabled ? "是" : "否"]),
    ],
    [30, 20, 10]
  );
}
