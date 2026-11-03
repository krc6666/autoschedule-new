import * as XLSX from "xlsx-js-style";
import { describe, expect, it } from "vitest";
import { createDefaultState } from "../../src/defaults";
import { updateConfigurationField } from "../../src/app/configuration-actions";
import {
  buildHistoricalScheduleDraft,
  currentScheduleHistory,
  replaceHistoryForDate,
} from "../../src/app/history-actions";
import { makeUnfilled } from "../../src/domain/flights/schedule-position-rules";
import { buildMonthlyLatePriorityStatistics } from "../../src/domain/statistics/monthly-late-priority-statistics";
import { buildOrdinaryPriorityStatistics } from "../../src/domain/statistics/ordinary-priority-statistics";
import { latePriorityFrequencyProfileForRule } from "../../src/domain/statistics/late-priority-frequency";
import { createScheduleFrequencyFacts } from "../../src/domain/statistics/schedule-frequency";
import {
  buildConfigWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";
import { applyWorkbookImport } from "../../src/app/workbook-actions";
import { loadState, saveState } from "../../src/infrastructure/storage";
import {
  buildLatePriorityCountsWorkbook,
  parseLatePriorityCountsWorkbook,
} from "../../src/infrastructure/late-priority-counts-excel";
import type { AppState } from "../../src/model";

const DATE = "2026-11-03";

function fixture(remark = "申报") {
  const state = createDefaultState();
  const rule = state.positionRules.find(
    (r) => r.flightNo === "TR121" && r.name === "H04"
  )!;
  state.staff = state.staff.slice(0, 2).map((p, i) => ({
    ...p,
    id: `test-${i}`,
    name: `测试人员${i}`,
    status: "正常" as const,
    staffType: "常规" as const,
  }));
  rule.qualifiedStaffIds = state.staff.map((p) => p.id);
  rule.remark = remark;
  state.positionRules = [rule];
  state.flights = state.flights.filter((f) => f.flightNo === "TR121");
  state.flights[0]!.positions = ["H04"];
  state.templates = state.templates.filter((f) => f.flightNo === "TR121");
  state.templates[0]!.positions = ["H04"];
  state.settings.ordinaryPriorityPositions = [
    { airlineCode: "TR", position: "H04" },
  ];
  state.settings.latePriorityFlightNumbers = ["TR121"];
  state.history = [
    {
      id: "old-h04",
      date: DATE,
      flightNo: "TR121",
      position: "H04",
      staffId: state.staff[0]!.id,
      staffName: state.staff[0]!.name,
      startTime: "21:55",
      endTime: "23:55",
      workHours: 2,
      fatiguePoints: 7,
      remark,
      assignmentRemarks: { remark, manualRemark: "保留原文" },
    },
  ];
  state.assignments = [];
  return { state, rule };
}

function counts(state: AppState, date = DATE) {
  return buildMonthlyLatePriorityStatistics(state, date).rows.find(
    (r) => r.staff.id === state.staff[0]!.id
  )!.flights.TR121!.categories;
}

describe("position remark count linkage", () => {
  it.each(["申报", "送资料", "", "申报/送资料"])(
    "reclassifies saved H04 from %j using the current rule without changing history",
    (oldRemark) => {
      const { state, rule } = fixture(oldRemark);
      const original = structuredClone(state.history);
      updateConfigurationField(
        state,
        "position",
        rule.id,
        "remark",
        "申报/送资料"
      );
      expect(counts(state).送资料.effectiveCount).toBe(1);
      expect(counts(state).申报.effectiveCount).toBe(0);
      const ordinary = buildOrdinaryPriorityStatistics(state, DATE)[0]!;
      expect(ordinary).toMatchObject({ position: "H04", effectiveCount: 1 });
      expect(state.history).toEqual(original);
    }
  );

  it("uses current semantics for stale draft remarks and manual baseline deductions", () => {
    const { state, rule } = fixture();
    const old = makeUnfilled(state.flights[0]!, rule.name, rule);
    updateConfigurationField(
      state,
      "position",
      rule.id,
      "remark",
      "申报/送资料"
    );
    state.activeScheduleDate = DATE;
    state.assignments = [
      {
        ...old,
        staffId: state.staff[1]!.id,
        staffName: state.staff[1]!.name,
        status: "assigned",
        manualRemark: "督导（手工备注不决定类别）",
        countBaseline: {
          staffId: state.staff[0]!.id,
          staffName: state.staff[0]!.name,
        },
      },
    ];
    const rows = buildMonthlyLatePriorityStatistics(state, DATE).rows;
    const before = rows.find((r) => r.staff.id === state.staff[0]!.id)!;
    const after = rows.find((r) => r.staff.id === state.staff[1]!.id)!;
    expect(before.categories.送资料).toMatchObject({
      baseCount: 1,
      manualCorrection: -1,
      effectiveCount: 0,
    });
    expect(after.categories.送资料).toMatchObject({
      baseCount: 0,
      manualCorrection: 1,
      effectiveCount: 1,
    });
    expect(after.categories.申报.effectiveCount).toBe(0);
    expect(after.categories.督导.effectiveCount).toBe(0);
    expect(
      buildOrdinaryPriorityStatistics(state, DATE).map((r) => r.effectiveCount)
    ).toEqual([0, 1]);
    state.assignments[0]!.staffId = null;
    state.assignments[0]!.staffName = "";
    state.assignments[0]!.status = "unfilled";
    expect(counts(state).送资料).toMatchObject({
      baseCount: 1,
      manualCorrection: -1,
      effectiveCount: 0,
    });
  });

  it("keeps old remarks through historical editing and rearchive while counting delivery", () => {
    const { state, rule } = fixture();
    updateConfigurationField(
      state,
      "position",
      rule.id,
      "remark",
      "申报/送资料"
    );
    const draft = buildHistoricalScheduleDraft(state, DATE);
    expect(draft.warnings).toEqual([]);
    state.flights = draft.flights;
    state.assignments = draft.assignments;
    state.activeScheduleDate = DATE;
    expect(state.assignments[0]!.remark).toBe("申报");
    expect(counts(state).送资料.effectiveCount).toBe(1);
    replaceHistoryForDate(state, DATE, currentScheduleHistory(state, DATE));
    state.assignments = [];
    expect(state.history[0]!.assignmentRemarks).toEqual({
      remark: "申报",
      manualRemark: "保留原文",
    });
    expect(counts(state).送资料.effectiveCount).toBe(1);
  });

  it("updates monthly, recent and previous-workday auto facts even when reusing the frequency snapshot", () => {
    const { state, rule } = fixture();
    const date = "2026-11-05";
    const facts = createScheduleFrequencyFacts(state, date);
    const profile = () =>
      latePriorityFrequencyProfileForRule(
        state,
        state.staff[0]!.id,
        state.flights[0]!,
        rule,
        date,
        facts
      );
    expect(profile().counts.declaration.currentMonthCount).toBe(1);
    updateConfigurationField(
      state,
      "position",
      rule.id,
      "remark",
      "申报/送资料"
    );
    expect(profile().counts.delivery).toEqual({
      currentMonthCount: 1,
      recentWorkdayCount: 1,
    });
    expect(profile().counts.declaration).toEqual({
      currentMonthCount: 0,
      recentWorkdayCount: 0,
    });
    expect(profile().previousWorkdayAssigned).toBe(true);
    expect(profile().totalCurrentMonthCount).toBe(1);
    updateConfigurationField(state, "position", rule.id, "remark", "申报");
    expect(profile().counts.declaration.currentMonthCount).toBe(1);
    expect(profile().counts.delivery.currentMonthCount).toBe(0);
    rule.category = "分流";
    expect(profile().applies).toBe(false);
  });

  it("keeps scope, end-time and unmatched-position boundaries after changing remarks", () => {
    const { state, rule } = fixture();
    updateConfigurationField(
      state,
      "position",
      rule.id,
      "remark",
      "申报/送资料"
    );
    state.history.push({ ...state.history[0]!, id: "duplicate" });
    expect(counts(state).送资料.effectiveCount).toBe(1);
    state.history.forEach((r) => {
      r.endTime = "23:00";
    });
    expect(counts(state).送资料.effectiveCount).toBe(0);
    state.history.forEach((r) => {
      r.endTime = "23:55";
      r.position = "H040";
    });
    expect(counts(state).送资料.effectiveCount).toBe(0);
    state.history.forEach((r) => {
      r.position = "H04";
    });
    state.settings.latePriorityFlightNumbers = [];
    expect(
      buildMonthlyLatePriorityStatistics(state, DATE).flightNumbers
    ).toEqual([]);
  });

  it("preserves source remarks and linked counts through config Excel, storage and counts Excel", () => {
    const { state, rule } = fixture();
    updateConfigurationField(
      state,
      "position",
      rule.id,
      "remark",
      "申报/送资料"
    );
    const restored = createDefaultState();
    const binary = XLSX.write(buildConfigWorkbook(state), {
      type: "array",
      bookType: "xlsx",
    });
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
    expect(loaded.history[0]!.assignmentRemarks?.remark).toBe("申报");
    expect(
      loaded.positionRules.find(
        (r) => r.flightNo === "TR121" && r.name === "H04"
      )!.remark
    ).toBe("申报/送资料");
    expect(counts(loaded).送资料.effectiveCount).toBe(1);
    expect(
      buildOrdinaryPriorityStatistics(loaded, DATE)[0]!.effectiveCount
    ).toBe(1);
    const book = buildLatePriorityCountsWorkbook(loaded, DATE);
    const preview = parseLatePriorityCountsWorkbook(book, loaded, DATE);
    expect(preview).toMatchObject({ errors: [] });
    expect(
      XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]!]!, { header: 1 })
    ).toContainEqual(expect.arrayContaining(["送资料"]));
  });
});
