import * as XLSX from "xlsx-js-style";
import { describe, expect, it } from "vitest";

import type { PositionRule, Staff } from "../../src/model";
import {
  parseLegacyScheduleWorkbook,
  type LegacyScheduleImportPreview,
} from "../../src/infrastructure/legacy-schedule-excel";
import { applyLegacyScheduleImport } from "../../src/app/workbook-actions";
import { createDefaultState } from "../../src/defaults";
import { parseWorkbook } from "../../src/infrastructure/excel";
import { buildMonthlyLatePriorityStatistics } from "../../src/domain/statistics/monthly-late-priority-statistics";

const staff: Staff[] = [
  {
    id: "a",
    name: "人员A",
    staffType: "常规",
    teamLeader: false,
    cxPreflightQualified: false,
    dutyQualified: true,
    standbyQualified: true,
    nightShift: true,
    status: "正常",
    remark: "",
  },
  {
    id: "b",
    name: "人员B",
    staffType: "常规",
    teamLeader: false,
    cxPreflightQualified: false,
    dutyQualified: true,
    standbyQualified: true,
    nightShift: true,
    status: "正常",
    remark: "",
  },
];

function workbook(rows: unknown[][], sheetName = "7.29周三"): XLSX.WorkBook {
  const result = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    result,
    XLSX.utils.aoa_to_sheet(rows),
    sheetName
  );
  return result;
}

describe("legacy horizontal schedule workbook adapter", () => {
  it("recognizes date, flight, position and cleans a person remark", () => {
    const preview = parseLegacyScheduleWorkbook(
      workbook([
        ["岗位", "AB123\\n（0845-1045）\\n到岗0820"],
        ["G18（控制）", "人员A（收插排）"],
      ]),
      staff,
      { year: 2026 }
    );

    expect(preview.records).toHaveLength(1);
    expect(preview.records[0]).toMatchObject({
      date: "2026-07-29",
      flightNo: "AB123",
      position: "G18",
      staffId: "a",
      staffName: "人员A",
      startTime: "08:45",
      endTime: "10:45",
      status: "ready",
    });
    expect(preview.records[0]?.remark).toContain("人员A（收插排）");
  });

  it("does not import numbers, status text, or ambiguous multi-person cells", () => {
    const preview = parseLegacyScheduleWorkbook(
      workbook([
        ["岗位", "AB123（0845-1045）"],
        ["G18", "人员A200"],
        ["G17", "人员A/人员B"],
        ["G16", "人员A（病假）"],
        ["G15", "取消"],
      ]),
      staff,
      { year: 2026 }
    );

    expect(preview.records).toHaveLength(3);
    expect(
      preview.records.find((item) => item.position === "G18")
    ).toMatchObject({
      staffName: "人员A",
      status: "ready",
    });
    expect(
      preview.records.find((item) => item.position === "G17")
    ).toMatchObject({
      staffName: "",
      status: "review",
    });
    expect(
      preview.records.find((item) => item.position === "G16")
    ).toMatchObject({
      staffName: "人员A",
      status: "review",
    });
    expect(preview.records.some((item) => item.position === "G15")).toBe(false);
    expect(preview.warnings.join("\n")).toContain("多人");
  });

  it("keeps unknown people for review instead of guessing a staff id", () => {
    const preview = parseLegacyScheduleWorkbook(
      workbook([
        ["岗位", "AB123（0845-1045）"],
        ["G18", "未知人员"],
      ]),
      staff,
      { year: 2026 }
    );

    expect(preview.records[0]).toMatchObject({
      staffId: "",
      staffName: "",
      status: "review",
    });
    expect(preview.records[0]?.rawText).toBe("未知人员");
  });

  it("writes only ready records and deduplicates against existing history", () => {
    const preview = parseLegacyScheduleWorkbook(
      workbook([
        ["岗位", "AB123（0845-1045）"],
        ["G18", "人员A"],
        ["G17", "未知人员"],
      ]),
      staff,
      { year: 2026 }
    );
    const state = createDefaultState();
    state.history = [{ ...preview.records[0]!, date: "2026-08-19" }];
    const result = applyLegacyScheduleImport(state, preview, "2026-08-19");
    expect(result.imported).toBe(0);
    expect(state.history).toHaveLength(1);
    expect(result.skipped).toBe(2);
  });

  it("routes a legacy workbook through the normal workbook boundary", () => {
    const imported = parseWorkbook(
      workbook([
        ["岗位", "AB123（0845-1045）"],
        ["G18", "人员A"],
      ]),
      staff
    );

    expect(imported.legacySchedule?.recognizedSheets).toBe(1);
    expect(imported.history).toBeUndefined();
    expect(imported.warnings.join("\n")).toContain("旧版横向排班");
  });

  it("reads the date from the first header cell when the sheet keeps its default name", () => {
    const preview = parseLegacyScheduleWorkbook(
      workbook(
        [
          ["7.1岗位", "AB123（0845-1045）"],
          ["G18", "人员A"],
        ],
        "Sheet1"
      ),
      staff,
      { year: 2026 }
    );

    expect(preview.recognizedSheets).toBe(1);
    expect(preview.records[0]?.date).toBe("2026-07-01");
  });

  it("uses the selected date and keeps only configured late-priority positions", () => {
    const positionRules: PositionRule[] = [
      {
        id: "late",
        flightNo: "AB123",
        name: "H02",
        category: "常规",
        remark: "一号",
        qualifiedStaffIds: ["a"],
        manual: false,
        fatiguePoints: 3,
        minPassengers: 0,
        earlyReleaseMinutes: 0,
      },
      {
        id: "regular",
        flightNo: "AB123",
        name: "G20",
        category: "常规",
        remark: "",
        qualifiedStaffIds: ["a"],
        manual: false,
        fatiguePoints: 1,
        minPassengers: 0,
        earlyReleaseMinutes: 0,
      },
    ];
    const preview = parseLegacyScheduleWorkbook(
      workbook([
        ["1.2岗位", "AB123（2115-2330）"],
        ["H02", "人员A"],
        ["G20", "人员B"],
      ]),
      staff,
      {
        year: 2026,
        targetDate: "2026-08-19",
        latePriorityOnly: true,
        latePriorityFlightNumbers: ["AB123"],
        positionRules,
        lateShiftEndTime: "23:00",
      }
    );

    expect(preview.records).toHaveLength(1);
    expect(preview.records[0]).toMatchObject({
      date: "2026-08-19",
      position: "H02",
      remark: "一号",
      fatiguePoints: 3,
      staffName: "人员A",
    });
    expect(preview.ignoredRecords).toBe(1);
  });

  it("does not count a late-priority-looking position from an afternoon flight", () => {
    const positionRules: PositionRule[] = [
      {
        id: "afternoon-number-one",
        flightNo: "PM123",
        name: "G20",
        category: "常规",
        remark: "一号",
        qualifiedStaffIds: ["a"],
        manual: false,
        fatiguePoints: 3,
        minPassengers: 0,
        earlyReleaseMinutes: 0,
      },
    ];
    const preview = parseLegacyScheduleWorkbook(
      workbook([
        ["1.2岗位", "PM123（1340-1540）"],
        ["G20", "人员A"],
      ]),
      staff,
      {
        targetDate: "2026-08-19",
        latePriorityOnly: true,
        latePriorityFlightNumbers: ["PM123"],
        positionRules,
        lateShiftEndTime: "23:00",
      }
    );

    expect(preview.records).toEqual([]);
    expect(preview.readyRecords).toBe(0);
    expect(preview.ignoredRecords).toBe(1);
  });

  it("marks applied legacy records as late-priority-only history", () => {
    const preview = {
      records: [
        {
          id: "legacy-history",
          date: "2026-08-19",
          flightNo: "AB123",
          position: "H02",
          staffId: "a",
          staffName: "人员A",
          startTime: "21:15",
          endTime: "23:30",
          workHours: 2.25,
          fatiguePoints: 3,
          remark: "",
          rawText: "人员A",
          sourceSheet: "Sheet1",
          sourceCell: "B2",
          status: "ready" as const,
        },
      ],
      sheets: 1,
      recognizedSheets: 1,
      readyRecords: 1,
      reviewRecords: 0,
      ignoredRecords: 0,
      warnings: [],
    } satisfies LegacyScheduleImportPreview;
    const state = createDefaultState();

    expect(
      applyLegacyScheduleImport(state, preview, "2026-08-19").imported
    ).toBe(1);
    expect(state.history[0]).toMatchObject({
      flightNo: "AB123",
      position: "H02",
      historyCoverage: "late-priority-only",
    });
  });

  it("imports old schedule conflicts as historical facts without current safety guards", () => {
    const state = createDefaultState();
    const worker = state.staff.find((person) => person.id === "2")!;
    const preview = {
      records: [
        {
          id: "legacy-cx937-g20",
          date: "2026-08-19",
          flightNo: "CX937",
          position: "G20",
          staffId: worker.id,
          staffName: worker.name,
          startTime: "08:30",
          endTime: "10:30",
          workHours: 2,
          fatiguePoints: 4,
          remark: "涓€鍙?",
          rawText: worker.name,
          sourceSheet: "Sheet1",
          sourceCell: "B2",
          status: "ready" as const,
        },
        {
          id: "legacy-cx931-g20",
          date: "2026-08-19",
          flightNo: "CX931",
          position: "G20",
          staffId: worker.id,
          staffName: worker.name,
          startTime: "17:50",
          endTime: "19:50",
          workHours: 2,
          fatiguePoints: 4,
          remark: "涓€鍙?",
          rawText: worker.name,
          sourceSheet: "Sheet1",
          sourceCell: "B3",
          status: "ready" as const,
        },
      ],
      sheets: 1,
      recognizedSheets: 1,
      readyRecords: 2,
      reviewRecords: 0,
      ignoredRecords: 0,
      warnings: [],
    } satisfies LegacyScheduleImportPreview;

    const result = applyLegacyScheduleImport(state, preview, "2026-08-19");

    expect(result.imported).toBe(2);
    expect(state.history).toHaveLength(2);
  });

  it("upgrades an existing legacy record instead of leaving old metadata behind", () => {
    const preview = {
      records: [
        {
          id: "legacy-history-new",
          date: "2026-08-19",
          flightNo: "AB123",
          position: "H02",
          staffId: "a",
          staffName: "人员A",
          startTime: "21:15",
          endTime: "23:30",
          workHours: 2.25,
          fatiguePoints: 3,
          remark: "一号",
          rawText: "人员A",
          sourceSheet: "Sheet1",
          sourceCell: "B2",
          status: "ready" as const,
        },
      ],
      sheets: 1,
      recognizedSheets: 1,
      readyRecords: 1,
      reviewRecords: 0,
      ignoredRecords: 0,
      warnings: [],
    } satisfies LegacyScheduleImportPreview;
    const state = createDefaultState();
    state.history = [
      {
        ...preview.records[0]!,
        id: "legacy-history-old",
        remark: "人员A",
        historyCoverage: undefined,
      },
    ];

    expect(
      applyLegacyScheduleImport(state, preview, "2026-08-19").imported
    ).toBe(0);
    expect(state.history[0]).toMatchObject({
      remark: "一号",
      fatiguePoints: 3,
      historyCoverage: "late-priority-only",
    });
  });

  it.each(["常规", "机动督导", "分流", "引导", "行政支援"] as const)(
    "feeds imported H02 into existing statistics independently of category %s",
    (category) => {
      const state = createDefaultState();
      state.staff = staff;
      const rule = state.positionRules.find(
        (item) => item.flightNo === "TR121" && item.name === "H02"
      )!;
      rule.qualifiedStaffIds = ["a"];
      rule.category = category;
      state.settings.latePriorityFlightNumbers = ["TR121"];
      const preview = parseLegacyScheduleWorkbook(
        workbook([
          ["宀椾綅", "TR121\n2155-2355"],
          ["H02", "人员A"],
        ]),
        staff,
        {
          targetDate: "2026-08-19",
          latePriorityOnly: true,
          latePriorityFlightNumbers: state.settings.latePriorityFlightNumbers,
          positionRules: state.positionRules,
          lateShiftEndTime: state.settings.lateShiftEndTime,
        }
      );

      expect(preview.records[0]).toMatchObject({
        flightNo: "TR121",
        position: "H02",
        remark: "一号",
        fatiguePoints: 10,
      });
      applyLegacyScheduleImport(state, preview, "2026-08-19");
      expect(state.history[0]).toMatchObject({
        staffId: "a",
        remark: "一号",
        historyCoverage: "late-priority-only",
      });

      const row = buildMonthlyLatePriorityStatistics(
        state,
        "2026-08-20"
      ).rows.find((item) => item.staff.id === "a")!;
      expect(row.totalCount).toBe(1);
    }
  );
});
