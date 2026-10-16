import * as XLSX from "xlsx-js-style";
import { describe, expect, it } from "vitest";

import { createDefaultState } from "../../src/defaults";
import {
  applyLatePriorityCountsImport,
  updateLatePriorityFrequencyAdjustment,
} from "../../src/app/statistics-actions";
import { buildMonthlyLatePriorityStatistics } from "../../src/domain/statistics/monthly-late-priority-statistics";
import { saveState, loadState } from "../../src/infrastructure/storage";
import { buildOrdinaryPriorityStatistics } from "../../src/domain/statistics/ordinary-priority-statistics";
import {
  buildConfigWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";
import { applyWorkbookImport } from "../../src/app/workbook-actions";
import {
  buildLatePriorityCountsWorkbook,
  parseLatePriorityCountsWorkbook,
} from "../../src/infrastructure/late-priority-counts-excel";

describe("late-priority counts workbook", () => {
  it("preserves non-regular statistics through config Excel and storage without rewriting facts", () => {
    const state = createDefaultState();
    const rule = state.positionRules.find(
      (r) => r.flightNo === "TR121" && r.name === "督导"
    )!;
    const staff = state.staff.find((p) => p.id === rule.qualifiedStaffIds[0])!;
    rule.category = "分流";
    state.positionRules = [rule];
    state.staff = [staff];
    state.settings.ordinaryPriorityPositions = [
      { airlineCode: "TR", position: "督导" },
    ];
    state.settings.latePriorityFlightNumbers = ["TR121"];
    state.history = [
      {
        id: "category-persist",
        date: "2026-08-13",
        flightNo: "TR121",
        position: "督导",
        staffId: staff.id,
        staffName: staff.name,
        startTime: "22:00",
        endTime: "23:55",
        workHours: 1.92,
        fatiguePoints: 5,
        remark: "",
      },
    ];
    const source = JSON.stringify([state.history, state.positionRules]);
    const binary = XLSX.write(buildConfigWorkbook(state), {
      type: "array",
      bookType: "xlsx",
    });
    const restored = createDefaultState();
    applyWorkbookImport(
      restored,
      parseWorkbook(XLSX.read(binary, { type: "array" }), []),
      "config"
    );
    let serialized = "";
    saveState(restored, {
      setItem: (_key, value) => {
        serialized = value;
      },
    });
    const loaded = loadState({ getItem: () => serialized });
    expect(loaded.positionRules[0]!.category).toBe("分流");
    expect(
      buildOrdinaryPriorityStatistics(loaded, "2026-08-20")[0]
    ).toMatchObject({ qualified: true, actualCount: 1, effectiveCount: 1 });
    expect(
      buildMonthlyLatePriorityStatistics(loaded, "2026-08-20").rows[0]!
        .categories.督导.effectiveCount
    ).toBe(1);
    expect(
      JSON.stringify([state.history, state.positionRules]) === source
    ).toBe(true);
  });
  it.each(["常规", "机动督导", "分流", "引导", "行政支援"] as const)(
    "round-trips selected final counts independently of category %s",
    (category) => {
      const state = createDefaultState();
      state.settings.latePriorityFlightNumbers = ["TR121", "TW616"];
      for (const rule of state.positionRules) rule.category = category;
      const staffId = state.positionRules.find(
        (rule) => rule.flightNo === "TR121" && rule.remark === "一号"
      )!.qualifiedStaffIds[0]!;
      state.latePriorityFrequencyAdjustments = [
        {
          month: "2026-08",
          staffId,
          flightNo: "TR121",
          kind: "number-one",
          delta: 3,
        },
      ];

      const workbook = buildLatePriorityCountsWorkbook(state, "2026-08-20");
      const preview = parseLatePriorityCountsWorkbook(
        XLSX.read(XLSX.write(workbook, { type: "array", bookType: "xlsx" }), {
          type: "array",
        }),
        state,
        "2026-08-20"
      );

      expect(workbook.SheetNames).toEqual(["末班重点岗位次数"]);
      expect(preview.canApply).toBe(true);
      expect(preview.month).toBe("2026-08");
      expect(preview.flightNumbers).toEqual(["TR121", "TW616"]);
      expect(
        preview.targets.find(
          (target) =>
            target.staffId === staffId &&
            target.flightNo === "TR121" &&
            target.category === "一号"
        )?.finalCount
      ).toBe(3);
      expect(
        updateLatePriorityFrequencyAdjustment(
          state,
          "2026-08",
          staffId,
          "TR121",
          "number-one",
          1
        )
      ).toBe(true);
      expect(applyLatePriorityCountsImport(state, preview)).toBe(true);
      expect(
        buildMonthlyLatePriorityStatistics(state, "2026-08-20").rows.find(
          (row) => row.staff.id === staffId
        )!.flights.TR121!.categories.一号.effectiveCount
      ).toBe(3);
      expect(applyLatePriorityCountsImport(state, preview)).toBe(false);
    }
  );

  it("exports a combined-only flight as delivery without a declaration row", () => {
    const state = createDefaultState();
    const combinedRule = state.positionRules.find(
      (rule) => rule.flightNo === "TR121" && rule.remark === "申报"
    )!;
    combinedRule.remark = "申报/送资料";
    state.positionRules = [combinedRule];
    state.settings.latePriorityFlightNumbers = ["TR121"];

    const workbook = buildLatePriorityCountsWorkbook(state, "2026-08-20");
    const preview = parseLatePriorityCountsWorkbook(
      workbook,
      state,
      "2026-08-20"
    );

    expect(preview.canApply).toBe(true);
    expect(new Set(preview.targets.map((target) => target.category))).toEqual(
      new Set(["送资料"])
    );
  });

  it("rejects an old declaration row for a combined-only flight", () => {
    const state = createDefaultState();
    const combinedRule = state.positionRules.find(
      (rule) => rule.flightNo === "TR121" && rule.remark === "申报"
    )!;
    combinedRule.remark = "申报/送资料";
    const staff = state.staff.find(
      (person) => person.id === combinedRule.qualifiedStaffIds[0]
    )!;
    combinedRule.qualifiedStaffIds = [staff.id];
    state.staff = [staff];
    state.positionRules = [combinedRule];
    state.settings.latePriorityFlightNumbers = ["TR121"];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["月份", "人员编号", "人员姓名", "航班号", "岗位类别", "最终次数"],
        ["2026-08", staff.id, staff.name, "TR121", "送资料", 0],
        ["2026-08", staff.id, staff.name, "TR121", "申报", 0],
      ]),
      "末班重点岗位次数"
    );

    const preview = parseLatePriorityCountsWorkbook(
      workbook,
      state,
      "2026-08-20"
    );

    expect(preview.canApply).toBe(false);
    expect(preview.errors.join("\n")).toContain(
      "岗位类别不适用于当前航班：申报"
    );
  });

  it("blocks invalid, duplicate, unknown, and wrong-month rows", () => {
    const state = createDefaultState();
    state.settings.latePriorityFlightNumbers = ["TR121"];
    const staff = state.staff[0]!;
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["月份", "人员编号", "人员姓名", "航班号", "岗位类别", "最终次数"],
        ["2026-07", staff.id, staff.name, "TR121", "一号", 1],
        ["2026-08", "unknown", "未知", "TR121", "一号", 1],
        ["2026-08", staff.id, staff.name, "UNKNOWN", "一号", 1],
        ["2026-08", staff.id, staff.name, "TR121", "未知类别", 1],
        ["2026-08", staff.id, staff.name, "TR121", "督导", -1],
        ["2026-08", staff.id, staff.name, "TR121", "申报", 1.5],
        ["2026-08", staff.id, staff.name, "TR121", "送资料", 1],
        ["2026-08", staff.id, staff.name, "TR121", "送资料", 2],
      ]),
      "末班重点岗位次数"
    );

    const preview = parseLatePriorityCountsWorkbook(
      workbook,
      state,
      "2026-08-20"
    );

    expect(preview.canApply).toBe(false);
    expect(preview.errors.join("\n")).toMatch(
      /月份|人员|航班|类别|非负整数|重复/
    );
  });

  it("blocks partial files so missing rows cannot silently clear counts", () => {
    const state = createDefaultState();
    state.settings.latePriorityFlightNumbers = ["TR121"];
    const staff = state.staff[0]!;
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["月份", "人员编号", "人员姓名", "航班号", "岗位类别", "最终次数"],
        ["2026-08", staff.id, staff.name, "TR121", "督导", 0],
      ]),
      "末班重点岗位次数"
    );

    const preview = parseLatePriorityCountsWorkbook(
      workbook,
      state,
      "2026-08-20"
    );

    expect(preview.canApply).toBe(false);
    expect(preview.errors.join("\n")).toContain("缺少");
  });
});
