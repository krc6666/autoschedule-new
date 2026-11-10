import * as XLSX from "xlsx-js-style";
import { describe, expect, it } from "vitest";
import { createDefaultState } from "../../src/defaults";
import {
  buildScheduleWorkbook,
  buildConfigWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";
import { applyWorkbookImport } from "../../src/app/workbook-actions";

function fixture(count = 5, flightCount = 4) {
  const state = createDefaultState();
  const base = state.staff[0]!;
  state.staff = Array.from({ length: count }, (_, i) => ({
    ...base,
    id: `p${i}`,
    name: `人员${i}`,
    staffType: "常规" as const,
    status: i === 2 ? ("休假" as const) : ("正常" as const),
    ...(i === 2 ? { leaveTypeId: "flight" } : {}),
  }));
  state.leaveTypes = [{ id: "flight", name: "飞行假", enabled: true }];
  state.flights = Array.from({ length: flightCount }, (_, i) => ({
    id: `f${i}`,
    flightNo: `FL${100 + i}`,
    startTime: "08:00",
    endTime: "11:00",
    remark: "到岗07:20",
    positions: ["G01"],
    bookedPassengers: 0,
  }));
  state.assignments = state.flights.map((f, i) => ({
    id: `a${i}`,
    flightId: f.id,
    flightNo: f.flightNo,
    positionRuleId: null,
    position: "G01",
    staffId: count ? "p0" : null,
    staffName: count ? "人员0" : "",
    startTime: f.startTime,
    endTime: f.endTime,
    workHours: 3,
    fatiguePoints: 1,
    status: "assigned" as const,
    remark: "",
    manualRemark: i ? "" : "很长的交接备注，必须完整显示。".repeat(12),
  }));
  state.activeScheduleDate = "2026-11-10";
  state.halfRestSelections = [
    { date: "2026-11-10", modes: { p1: "early-finish", p3: "late-start" } },
  ];
  return state;
}

const cellEntries = (sheet: XLSX.WorkSheet) =>
  Object.entries(sheet).filter(([address]) => !address.startsWith("!"));
const find = (sheet: XLSX.WorkSheet, value: string) =>
  cellEntries(sheet).find(([, cell]) => cell.v === value)!;

describe("schedule print layout", () => {
  it("ends at the two name columns without a roster numbering column", () => {
    const ws = buildScheduleWorkbook(fixture(18, 5), "2026-11-10").Sheets[
      "保障明细"
    ]!;
    expect(cellEntries(ws).some(([, cell]) => cell.v === "序号")).toBe(false);
    expect(XLSX.utils.decode_range(ws["!ref"]!).e.c).toBe(12);
    const title = ws["!merges"]!.find((m) => m.s.c === 11 && m.s.r === 0)!;
    expect(title.e.c).toBe(12);
  });
  it("updates only the exported projection after manual edits and keeps half-rest tied to identity", () => {
    const state = fixture();
    state.staff[1]!.name = "更改后的姓名";
    state.leaveTypes[0]!.name = "维护后的飞行假";
    state.assignments[0]!.staffId = "p1";
    state.assignments[0]!.staffName = state.staff[1]!.name;
    state.assignments[0]!.manualRemark = "人工调整后的完整说明";
    const wb = buildScheduleWorkbook(state, "2026-11-10");
    const ws = wb.Sheets["保障明细"]!;
    expect(find(ws, "人员2（维护后的飞行假）")).toBeDefined();
    const rosterName = cellEntries(ws).find(
      ([a, c]) => XLSX.utils.decode_cell(a).c >= 9 && c.v === "更改后的姓名"
    )!;
    expect(rosterName[1].s.fill.fgColor.rgb).toBe("C6EFCE");
    expect(
      cellEntries(ws).some(([, c]) =>
        String(c.v).includes("人工调整后的完整说明")
      )
    ).toBe(true);
    expect(
      buildScheduleWorkbook(state, "2026-11-12").Sheets["保障明细"]![
        rosterName[0]
      ].s.fill.fgColor.rgb
    ).not.toBe("C6EFCE");
  });
  it("puts flights first, a complete two-column roster on the right and summaries below", () => {
    const state = fixture();
    const before = structuredClone(state);
    const ws = buildScheduleWorkbook(state, "2026-11-10").Sheets["保障明细"]!;
    const flightHeader = cellEntries(ws).find(([, c]) =>
      String(c.v).startsWith("FL100\n")
    )!;
    expect(XLSX.utils.decode_cell(flightHeader[0]).r).toBeLessThan(2);
    const roster = ["人员0", "人员1", "人员2（飞行假）", "人员3", "人员4"].map(
      (name) =>
        cellEntries(ws).find(
          ([a, c]) => c.v === name && XLSX.utils.decode_cell(a).c > 7
        )!
    );
    expect(roster.every(Boolean)).toBe(true);
    expect(roster.map(([a]) => XLSX.utils.decode_cell(a).c)).toEqual([
      9, 9, 9, 10, 10,
    ]);
    const summaryRow = XLSX.utils.decode_cell(find(ws, "CX航前人员")[0]).r;
    expect(summaryRow).toBeGreaterThan(
      Math.max(...roster.map(([a]) => XLSX.utils.decode_cell(a).r))
    );
    expect(summaryRow).toBeGreaterThan(
      XLSX.utils.decode_cell(find(ws, "G01")[0]).r
    );
    expect(state).toEqual(before);
  });

  it("keeps green fills and full remarks in the actual XLSX bytes without half-rest labels", () => {
    const state = fixture();
    const wb = buildScheduleWorkbook(state, "2026-11-10");
    const read = XLSX.read(
      XLSX.write(wb, { type: "array", bookType: "xlsx" }),
      { type: "array", cellStyles: true }
    );
    const ws = read.Sheets["保障明细"]!;
    for (const name of ["人员1", "人员3"])
      expect(find(ws, name)[1].s.fgColor.rgb).toBe("C6EFCE");
    expect(find(ws, "人员2（飞行假）")[1].s.fgColor.rgb).not.toBe("C6EFCE");
    expect(cellEntries(ws).some(([, c]) => String(c.v).includes("半休"))).toBe(
      false
    );
    const remark = state.assignments[0]!.manualRemark;
    const [address] = cellEntries(ws).find(([, c]) =>
      String(c.v).includes(remark)
    )!;
    const row = XLSX.utils.decode_cell(address).r;
    expect(ws["!rows"]![row]!.hpt).toBeGreaterThan(100);
    expect(wb.Sheets["保障明细"]![address].s.alignment.wrapText).toBe(true);
    expect(read.SheetNames).toContain("半休选择");
    expect(parseWorkbook(read, state.staff).halfRestSelections).toEqual(
      state.halfRestSelections
    );
  });

  it.each([
    [0, 0],
    [1, 1],
    [18, 8],
    [31, 6],
  ])(
    "keeps every roster member exactly once with %i people and %i flights",
    (count, flights) => {
      const state = fixture(count, flights);
      const ws = buildScheduleWorkbook(state, "2026-11-10").Sheets["保障明细"]!;
      const rosterStart = Math.max(4, flights * 2) + 1;
      const names = cellEntries(ws)
        .filter(([a]) => {
          const c = XLSX.utils.decode_cell(a).c;
          return c === rosterStart || c === rosterStart + 1;
        })
        .map(([, c]) => c.v);
      for (const person of state.staff)
        expect(
          names.filter(
            (v) =>
              String(v).startsWith(
                person.name + (person.status === "休假" ? "（" : "")
              ) &&
              (v === person.name || v === `${person.name}（飞行假）`)
          )
        ).toHaveLength(1);
    }
  );

  it("round-trips dated selections through config and preserves them when an old or broken table is imported", () => {
    const state = fixture();
    const workbook = buildConfigWorkbook(state);
    expect(parseWorkbook(workbook, state.staff).halfRestSelections).toEqual(
      state.halfRestSelections
    );
    const fresh = fixture();
    fresh.halfRestSelections = [];
    applyWorkbookImport(fresh, parseWorkbook(workbook, fresh.staff), "config");
    expect(fresh.halfRestSelections).toEqual(state.halfRestSelections);
    delete workbook.Sheets["半休选择"];
    workbook.SheetNames = workbook.SheetNames.filter(
      (name) => name !== "半休选择"
    );
    const old = parseWorkbook(workbook, state.staff);
    expect(old.halfRestSelections).toBeUndefined();
    applyWorkbookImport(state, old, "config");
    expect(state.halfRestSelections).toEqual(fresh.halfRestSelections);
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["日期", "半休人员(JSON)"],
        ["2026-11-10", '{"p0":"bad-mode"}'],
      ]),
      "半休选择"
    );
    const broken = parseWorkbook(workbook, state.staff);
    expect(broken.halfRestSelections).toBeUndefined();
    expect(broken.warnings.join(" ")).toContain("半休");
  });
});
