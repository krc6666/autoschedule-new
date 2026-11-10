import * as XLSX from "xlsx-js-style";
import type { AppState, Assignment } from "../model";
import { staffStatusLabel } from "../domain/staff-status";
import { halfRestSelectionForDate } from "../domain/records/half-rest-selections";
import { getDutyRosterForDate } from "../domain/duty-roster/roster";
import { buildMonthlyRelaxedShiftStatistics } from "../domain/statistics/relaxed-shift-statistics";
import {
  isFixedBottomPosition,
  isGuideAssignment,
} from "../domain/flights/schedule-position-rules";
import { addIsoDays } from "../domain/shared/time";
import { combinedAssignmentRemark } from "../utils";

// Excel does not reliably auto-fit wrapped/merged cells on opening a workbook.
// Use conservative character widths and explicit row heights in the file itself.
function textWidth(text: string): number {
  return [...text].reduce(
    (width, char) => width + (char.codePointAt(0)! > 255 ? 2 : 1),
    0
  );
}

function wrappedLines(text: string, width: number): number {
  const available = Math.max(1, width - 3);
  return text
    .split(/\r?\n/)
    .reduce(
      (lines, line) =>
        lines + Math.max(1, Math.ceil(textWidth(line) / available)),
      0
    );
}

export function buildSchedulePrintSheet(
  state: AppState,
  date: string
): XLSX.WorkSheet {
  const groups = [...new Set(state.assignments.map((a) => a.flightNo))].map(
    (flightNo) => ({
      flightNo,
      items: state.assignments.filter((a) => a.flightNo === flightNo),
    })
  );
  const guide = (a: Assignment) =>
    isGuideAssignment(state, a) || isFixedBottomPosition(a.position);
  const normal = groups.map((g) => g.items.filter((a) => !guide(a)));
  const normalRows = Math.max(0, ...normal.map((g) => g.length));
  const flightColumns = Math.max(4, groups.length * 2);
  const rosterStart = flightColumns + 1;
  const totalColumns = rosterStart + 2;
  const staff = state.staff.filter((p) => p.staffType === "常规");
  const rosterRows = Math.ceil(staff.length / 2);
  const halfRestIds = new Set(
    halfRestSelectionForDate(state, date).halfRestStaffIds
  );
  const greenCells = new Set<string>();
  const guideRow = normalRows + 3;
  const summaryStart = Math.max(guideRow, rosterRows + 1) + 2;
  const matrix: string[][] = Array.from({ length: summaryStart + 3 }, () =>
    Array(totalColumns).fill("")
  );
  const merges: XLSX.Range[] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: flightColumns - 1 } },
    { s: { r: 0, c: rosterStart }, e: { r: 0, c: rosterStart + 1 } },
    {
      s: { r: summaryStart + 2, c: 1 },
      e: { r: summaryStart + 2, c: flightColumns - 1 },
    },
  ];
  if (flightColumns > 4)
    for (const r of [summaryStart, summaryStart + 1])
      merges.push({ s: { r, c: 3 }, e: { r, c: flightColumns - 1 } });
  matrix[0]![0] = `${date} 航班保障排班`;
  matrix[0]![rosterStart] = "人员名单";
  matrix[1]![rosterStart] = "人员";
  matrix[1]![rosterStart + 1] = "人员";
  if (!groups.length) matrix[1]![0] = "暂无航班";
  groups.forEach((g, index) => {
    const flight = state.flights.find((f) => f.flightNo === g.flightNo);
    const first = g.items[0]!;
    matrix[1]![index * 2] = "岗位";
    matrix[1]![index * 2 + 1] = [
      g.flightNo,
      flight?.remark.trim(),
      `${flight?.startTime ?? first.startTime}-${flight?.endTime ?? first.endTime}`,
    ]
      .filter(Boolean)
      .join("\n");
    normal[index]!.forEach((a, row) => {
      matrix[row + 2]![index * 2] = a.position;
      matrix[row + 2]![index * 2 + 1] = [
        a.staffName || (a.status === "manual" ? "" : "待补位"),
        combinedAssignmentRemark(a.remark, a.manualRemark),
      ]
        .filter(Boolean)
        .join("\n");
    });
    const names = [
      ...new Set(
        g.items
          .filter(guide)
          .map((a) => a.staffName || (a.status === "manual" ? "" : "待补位"))
          .filter(Boolean)
      ),
    ];
    matrix[guideRow]![index * 2] = "引导人员";
    matrix[guideRow]![index * 2 + 1] = names.join("、") || "未安排";
  });
  staff.forEach((p, index) => {
    const c = rosterStart + Math.floor(index / rosterRows);
    const r = 2 + (index % rosterRows);
    matrix[r]![c] =
      p.status === "正常"
        ? p.name
        : `${p.name}（${staffStatusLabel(p, state.leaveTypes)}）`;
    if (halfRestIds.has(p.id)) greenCells.add(XLSX.utils.encode_cell({ r, c }));
  });
  const duty = getDutyRosterForDate(state, date);
  const name = (id: string | null) =>
    state.staff.find((p) => p.id === id)?.name ?? "未安排";
  matrix[summaryStart]![0] = "CX航前人员";
  matrix[summaryStart]![1] = name(duty.cxPreflightStaffId);
  matrix[summaryStart]![2] = "24小时值班人员";
  matrix[summaryStart]![3] = name(duty.dutyStaffId);
  const standbyDate = addIsoDays(date, 1);
  matrix[summaryStart + 1]![0] = `次日备勤一（${standbyDate}）`;
  matrix[summaryStart + 1]![1] = name(duty.standbyStaffIds[0]);
  matrix[summaryStart + 1]![2] = `次日备勤二（${standbyDate}）`;
  matrix[summaryStart + 1]![3] = name(duty.standbyStaffIds[1]);
  const early = new Map<string, string[]>();
  for (const item of buildMonthlyRelaxedShiftStatistics(state, date)
    .currentEarlyDepartures) {
    const airline =
      /^[A-Za-z]{2}/.exec(item.flightNo)?.[0].toUpperCase() ?? "其他";
    const names = early.get(airline) ?? [];
    if (!names.includes(item.staffName)) names.push(item.staffName);
    early.set(airline, names);
  }
  matrix[summaryStart + 2]![0] = "提前下班";
  matrix[summaryStart + 2]![1] =
    [...early]
      .map(([code, names]) => `${code}：${names.join("、")}`)
      .join("\n") || "无";

  const widths = Array.from({ length: totalColumns }, (_, c) => {
    if (c === flightColumns) return 2;
    const min = c >= rosterStart ? 14 : c % 2 === 0 ? 10 : 16;
    const max = c >= rosterStart ? 28 : c % 2 === 0 ? 20 : 32;
    const texts = matrix.slice(1, summaryStart).map((row) => row[c]!);
    return Math.min(
      max,
      Math.max(
        min,
        ...texts.flatMap((t) =>
          t.split("\n").map((line) => textWidth(line) + 4)
        )
      )
    );
  });
  const worksheet = XLSX.utils.aoa_to_sheet(matrix);
  worksheet["!cols"] = widths.map((wch) => ({ wch }));
  worksheet["!merges"] = merges;
  const border = { style: "thin", color: { rgb: "808080" } };
  const heights = matrix.map((row, r) => {
    if (!row.some(Boolean)) return { hpt: 10 };
    let height = r === 0 ? 30 : 26;
    row.forEach((text, c) => {
      const merge = merges.find((m) => m.s.r === r && m.s.c === c);
      const width = merge
        ? widths.slice(c, merge.e.c + 1).reduce((a, b) => a + b, 0)
        : widths[c]!;
      height = Math.max(
        height,
        wrappedLines(text, width) * (r === 0 ? 19 : 16) + 10
      );
      const address = XLSX.utils.encode_cell({ r, c });
      const cell = worksheet[address];
      if (!cell) return;
      const flightCell =
        c < flightColumns &&
        (r <= normalRows + 1 || r === guideRow || r >= summaryStart);
      const rosterCell = c >= rosterStart && r <= rosterRows + 1;
      if (!flightCell && !rosterCell) return;
      const heading = r < 2;
      cell.s = {
        font: {
          name: "Microsoft YaHei",
          sz: r === 0 ? 14 : 10,
          bold: heading || (c < flightColumns && c % 2 === 0),
          color: { rgb: heading && c < flightColumns ? "FFFFFF" : "202020" },
        },
        fill: {
          patternType: "solid",
          fgColor: {
            rgb: greenCells.has(address)
              ? "C6EFCE"
              : c >= rosterStart
                ? "D9E2F3"
                : heading
                  ? "B4232D"
                  : r >= summaryStart
                    ? "FCE4D6"
                    : "FFFFFF",
          },
        },
        alignment: { horizontal: "center", vertical: "center", wrapText: true },
        border: { top: border, bottom: border, left: border, right: border },
      };
    });
    return { hpt: height };
  });
  worksheet["!rows"] = heights;
  worksheet["!margins"] = {
    left: 0.25,
    right: 0.25,
    top: 0.35,
    bottom: 0.35,
    header: 0.15,
    footer: 0.15,
  };
  return worksheet;
}
