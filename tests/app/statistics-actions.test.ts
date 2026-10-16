import { describe, expect, it } from "vitest";

import {
  applyLatePriorityCountsImport,
  resetMonthlyLatePriorityFrequencyCounts,
  updateLatePriorityFrequencyAdjustment,
} from "../../src/app/statistics-actions";
import { updateOrdinaryPriorityFrequencyAdjustment } from "../../src/app/statistics-actions";
import { createDefaultState } from "../../src/defaults";
import {
  buildMonthlyLatePriorityStatistics,
  type LatePriorityStatisticsCategory,
} from "../../src/domain/statistics/monthly-late-priority-statistics";

describe("statistics actions", () => {
  it("writes ordinary重点 manual counts and marks the active schedule stale", () => {
    const state = createDefaultState();
    state.activeScheduleDate = "2026-09-20";
    state.assignments = [
      {
        id: "existing",
        flightId: "f",
        flightNo: "CA123",
        positionRuleId: null,
        position: "柜台 A",
        staffId: "1",
        staffName: "张三",
        startTime: "08:00",
        endTime: "09:00",
        workHours: 1,
        fatiguePoints: 1,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
    ];
    state.settings.ordinaryPriorityPositions = [
      { airlineCode: "CA", position: "柜台 A" },
    ];
    state.schedulePolicyStale = false;
    expect(
      updateOrdinaryPriorityFrequencyAdjustment(
        state,
        "2026-09",
        "1",
        "CA",
        "柜台 A",
        1
      )
    ).toBe(true);
    expect(state.ordinaryPriorityFrequencyAdjustments).toHaveLength(1);
    expect(state.schedulePolicyStale).toBe(true);
  });
  it("imports final counts by replacing existing corrections instead of accumulating", () => {
    const state = createDefaultState();
    state.settings.latePriorityFlightNumbers = ["TR121"];
    const rule = state.positionRules.find(
      (item) => item.flightNo === "TR121" && item.remark === "一号"
    )!;
    const staff = state.staff.find(
      (person) => person.id === rule.qualifiedStaffIds[0]
    )!;
    state.latePriorityFrequencyAdjustments = [
      {
        month: "2026-08",
        staffId: staff.id,
        flightNo: "TR121",
        kind: "number-one",
        delta: 8,
      },
      {
        month: "2026-07",
        staffId: staff.id,
        flightNo: "TR121",
        kind: "number-one",
        delta: 4,
      },
    ];
    const current = buildMonthlyLatePriorityStatistics(state, "2026-08-20");
    const targets = current.rows.flatMap((row) =>
      current.flightNumbers.flatMap((flightNo) =>
        Object.entries(row.flights[flightNo]!.categories).map(
          ([category, value]) => ({
            month: "2026-08",
            staffId: row.staff.id,
            staffName: row.staff.name,
            flightNo,
            category: category as LatePriorityStatisticsCategory,
            finalCount:
              row.staff.id === staff.id && category === "一号"
                ? 3
                : value.effectiveCount,
          })
        )
      )
    );

    expect(
      applyLatePriorityCountsImport(state, {
        month: "2026-08",
        referenceDate: "2026-08-20",
        flightNumbers: ["TR121"],
        targets,
        errors: [],
        canApply: true,
      })
    ).toBe(true);

    expect(
      buildMonthlyLatePriorityStatistics(state, "2026-08-20").rows.find(
        (row) => row.staff.id === staff.id
      )!.flights.TR121!.categories.一号.effectiveCount
    ).toBe(3);
    expect(state.latePriorityFrequencyAdjustments).toContainEqual({
      month: "2026-07",
      staffId: staff.id,
      flightNo: "TR121",
      kind: "number-one",
      delta: 4,
    });
  });

  it("rejects a count preview after the current flight scope changes", () => {
    const state = createDefaultState();
    state.settings.latePriorityFlightNumbers = ["TR121"];
    const row = buildMonthlyLatePriorityStatistics(state, "2026-08-20")
      .rows[0]!;
    const targets = Object.entries(row.flights.TR121!.categories).map(
      ([category, value]) => ({
        month: "2026-08",
        staffId: row.staff.id,
        staffName: row.staff.name,
        flightNo: "TR121",
        category: category as LatePriorityStatisticsCategory,
        finalCount: value.effectiveCount,
      })
    );

    expect(
      applyLatePriorityCountsImport(state, {
        month: "2026-08",
        referenceDate: "2026-08-20",
        flightNumbers: ["TR121", "TW616"],
        targets,
        errors: [],
        canApply: true,
      })
    ).toBe(false);
    expect(state.latePriorityFrequencyAdjustments).toEqual([]);
  });

  it.each(["常规", "机动督导", "分流", "引导", "行政支援"] as const)(
    "updates corrections with a zero floor in category %s",
    (category) => {
      const state = createDefaultState();
      const rule = state.positionRules.find(
        (item) => item.flightNo === "TR121" && item.remark === "一号"
      )!;
      const staffId = rule.qualifiedStaffIds[0]!;
      rule.category = category;

      expect(
        updateLatePriorityFrequencyAdjustment(
          state,
          "2026-08",
          staffId,
          "TR121",
          "number-one",
          -1
        )
      ).toBe(false);
      expect(state.latePriorityFrequencyAdjustments).toEqual([]);

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
      expect(state.latePriorityFrequencyAdjustments).toEqual([
        {
          month: "2026-08",
          staffId,
          flightNo: "TR121",
          kind: "number-one",
          delta: 1,
        },
      ]);
    }
  );

  it("rejects a declaration correction for a combined-only flight", () => {
    const state = createDefaultState();
    const combinedRule = state.positionRules.find(
      (item) => item.flightNo === "TR121" && item.remark === "申报"
    )!;
    combinedRule.remark = "申报/送资料";
    state.positionRules = [combinedRule];
    state.settings.latePriorityFlightNumbers = ["TR121"];
    const staffId = combinedRule.qualifiedStaffIds[0]!;

    expect(
      updateLatePriorityFrequencyAdjustment(
        state,
        "2026-08",
        staffId,
        "TR121",
        "declaration",
        1
      )
    ).toBe(false);
    expect(
      updateLatePriorityFrequencyAdjustment(
        state,
        "2026-08",
        staffId,
        "TR121",
        "delivery",
        1
      )
    ).toBe(true);
    expect(state.latePriorityFrequencyAdjustments).toEqual([
      {
        month: "2026-08",
        staffId,
        flightNo: "TR121",
        kind: "delivery",
        delta: 1,
      },
    ]);
  });

  it.each(["常规", "机动督导", "分流", "引导", "行政支援"] as const)(
    "resets selected-month counts and keeps other months in category %s",
    (positionCategory) => {
      const state = createDefaultState();
      const rule = state.positionRules.find(
        (item) => item.flightNo === "TR121" && item.remark === "一号"
      )!;
      const staffId = rule.qualifiedStaffIds[0]!;
      rule.category = positionCategory;
      state.settings.latePriorityFlightNumbers = ["TR121"];
      state.history = [
        {
          id: "history-tr121-number-one",
          date: "2026-08-10",
          flightNo: "TR121",
          position: rule.name,
          staffId,
          staffName: state.staff.find((person) => person.id === staffId)!.name,
          startTime: "21:55",
          endTime: "23:55",
          workHours: 2,
          fatiguePoints: 5,
          remark: rule.remark,
        },
      ];
      state.latePriorityFrequencyAdjustments = [
        {
          month: "2026-08",
          staffId,
          flightNo: "TR121",
          kind: "number-one",
          delta: 2,
        },
        {
          month: "2026-07",
          staffId,
          flightNo: "TR121",
          kind: "number-one",
          delta: 4,
        },
      ];

      expect(resetMonthlyLatePriorityFrequencyCounts(state, "2026-08-18")).toBe(
        true
      );
      expect(state.latePriorityFrequencyAdjustments).toEqual([
        {
          month: "2026-07",
          staffId,
          flightNo: "TR121",
          kind: "number-one",
          delta: 4,
        },
        {
          month: "2026-08",
          staffId,
          flightNo: "TR121",
          kind: "number-one",
          delta: -1,
          resetBaseline: 1,
        },
      ]);
      const category = buildMonthlyLatePriorityStatistics(
        state,
        "2026-08-18"
      ).rows.find((row) => row.staff.id === staffId)?.categories.一号;
      expect(category).toMatchObject({
        effectiveCount: 0,
        manualCorrection: 0,
        visibleDetails: [],
      });
    }
  );
});
