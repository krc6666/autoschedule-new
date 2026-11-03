import * as XLSX from "xlsx-js-style";
import { describe, expect, it } from "vitest";
import { createDefaultState } from "../../src/defaults";
import { makeUnfilled } from "../../src/domain/flights/schedule-position-rules";
import { buildMonthlyLatePriorityStatistics } from "../../src/domain/statistics/monthly-late-priority-statistics";
import { latePriorityFrequencyProfileForRule } from "../../src/domain/statistics/late-priority-frequency";
import { createScheduleFrequencyFacts } from "../../src/domain/statistics/schedule-frequency";
import {
  buildHistoricalScheduleDraft,
  currentScheduleHistory,
  replaceHistoryForDate,
} from "../../src/app/history-actions";
import {
  assignStaff,
  clearScheduleStaff,
} from "../../src/app/schedule-actions";
import {
  buildConfigWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";
import { applyWorkbookImport } from "../../src/app/workbook-actions";
import {
  buildLatePriorityCountsWorkbook,
  parseLatePriorityCountsWorkbook,
} from "../../src/infrastructure/late-priority-counts-excel";
import {
  applyLatePriorityCountsImport,
  resetMonthlyLatePriorityFrequencyCounts,
} from "../../src/app/statistics-actions";
import { saveState, loadState } from "../../src/infrastructure/storage";
import type { AppState } from "../../src/model";

const PAST = "2026-10-29";
const TODAY = "2026-10-31";
const roles = ["督导", "一号", "申报", "送资料"] as const;

function fixture(remark: string = "送资料") {
  const state = createDefaultState();
  state.staff = state.staff.slice(0, 2).map((p, i) => ({
    ...p,
    id: `role-test-${i}`,
    name: `测试人员${i}`,
    status: "正常" as const,
    staffType: "常规" as const,
    nightShift: true,
    dutyQualified: false,
  }));
  const oldRule = state.positionRules.find(
    (r) => r.flightNo === "TR121" && r.name === "H05"
  )!;
  const newRule = state.positionRules.find(
    (r) => r.flightNo === "TR121" && r.name === "H04"
  )!;
  oldRule.remark = "";
  newRule.remark = remark;
  oldRule.qualifiedStaffIds = [];
  newRule.qualifiedStaffIds = [];
  state.positionRules = [newRule, oldRule];
  const flight = state.flights.find((f) => f.flightNo === "TR121")!;
  flight.positions = ["H04", "H05"];
  state.flights = [flight];
  state.templates = [{ ...flight }];
  state.settings.latePriorityFlightNumbers = ["TR121"];
  state.settings.dutyFatiguePoints = 0;
  state.history = [
    {
      id: "old-role",
      date: PAST,
      flightNo: "TR121",
      position: "H05",
      staffId: state.staff[0]!.id,
      staffName: state.staff[0]!.name,
      startTime: "21:55",
      endTime: "23:55",
      flightCutoffTime: "23:55",
      workHours: 2,
      fatiguePoints: 8,
      remark: `${remark}；人工调整提醒：测试人员不在资质名单`,
      assignmentRemarks: { remark, manualRemark: "" },
      countBaseline: {
        staffId: state.staff[1]!.id,
        staffName: state.staff[1]!.name,
      },
      manualOverrideWarnings: [
        { code: "position-qualification", message: "测试人员不在资质名单" },
      ],
    },
  ];
  state.assignments = [
    {
      ...makeUnfilled(flight, newRule.name, newRule),
      staffId: state.staff[1]!.id,
      staffName: state.staff[1]!.name,
      status: "assigned",
    },
  ];
  state.activeScheduleDate = TODAY;
  return { state, oldRule, newRule, flight };
}

function cell(
  state: AppState,
  staffIndex: number,
  role = "送资料" as (typeof roles)[number],
  date = TODAY
) {
  return (
    buildMonthlyLatePriorityStatistics(state, date).rows.find(
      (r) => r.staff.id === state.staff[staffIndex]!.id
    )?.categories[role] ?? {
      qualified: false,
      baseCount: 0,
      manualCorrection: 0,
      effectiveCount: 0,
      details: [],
      visibleDetails: [],
    }
  );
}

describe("role remarks across moved positions", () => {
  it.each(roles)(
    "counts historical H05 and current H04 %s despite missing qualifications",
    (role) => {
      const { state } = fixture(role);
      const original = structuredClone(state.history);
      expect(cell(state, 0, role)).toMatchObject({
        qualified: false,
        baseCount: 0,
        manualCorrection: 1,
        effectiveCount: 1,
      });
      expect(cell(state, 0, role).details).toEqual([
        { date: PAST, flightNo: "TR121", position: "H05" },
      ]);
      expect(cell(state, 1, role).effectiveCount).toBe(1);
      expect(state.history).toEqual(original);
    }
  );

  it.each(roles)(
    "keeps recorded %s when all current role remarks are removed",
    (role) => {
      const { state, newRule } = fixture(role);
      newRule.remark = "";
      state.assignments = [];
      expect(cell(state, 0, role).effectiveCount).toBe(1);
      const row = buildMonthlyLatePriorityStatistics(state, TODAY).rows.find(
        (r) => r.staff.id === state.staff[0]!.id
      )!;
      expect(row.flights.TR121!.applicableCategories).toEqual([role]);
      const preview = parseLatePriorityCountsWorkbook(
        buildLatePriorityCountsWorkbook(state, TODAY),
        state,
        TODAY
      );
      expect(preview.canApply).toBe(true);
      expect(
        preview.targets.find(
          (t) => t.staffId === state.staff[0]!.id && t.category === role
        )?.finalCount
      ).toBe(1);
    }
  );

  it("retains recorded roles when a position is removed or reassigned another role", () => {
    const { state, oldRule } = fixture();
    oldRule.remark = "一号";
    expect(cell(state, 0).effectiveCount).toBe(1);
    expect(cell(state, 0, "一号").effectiveCount).toBe(1);
    state.positionRules = state.positionRules.filter((r) => r !== oldRule);
    expect(cell(state, 0).effectiveCount).toBe(1);
    expect(cell(state, 0, "一号").effectiveCount).toBe(0);
  });

  it("ignores separated manual remarks and warnings while preserving combined-role counting", () => {
    const { state, oldRule } = fixture();
    const record = state.history[0]!;
    record.remark = "送资料；督导；人工调整提醒：一号人员替换";
    record.assignmentRemarks!.manualRemark = "督导";
    oldRule.remark = "申报";
    expect(cell(state, 0).effectiveCount).toBe(1);
    expect(cell(state, 0, "申报").effectiveCount).toBe(0);
    expect(cell(state, 0, "督导").effectiveCount).toBe(0);
    expect(cell(state, 0, "一号").effectiveCount).toBe(0);
    delete record.assignmentRemarks;
    record.remark = "送资料；人工调整提醒：督导、一号人员替换";
    expect(cell(state, 0).effectiveCount).toBe(1);
    expect(cell(state, 0, "督导").effectiveCount).toBe(0);
    expect(cell(state, 0, "一号").effectiveCount).toBe(0);
  });

  it("shares the historical role projection with monthly/recent/previous-shift auto counts", () => {
    const { state, oldRule, newRule, flight } = fixture();
    const facts = createScheduleFrequencyFacts(state, TODAY);
    const profile = () =>
      latePriorityFrequencyProfileForRule(
        state,
        state.staff[0]!.id,
        flight,
        newRule,
        TODAY,
        facts
      );
    expect(profile().counts.delivery).toEqual({
      currentMonthCount: 1,
      recentWorkdayCount: 1,
    });
    expect(profile().previousWorkdayAssigned).toBe(true);
    oldRule.remark = "一号";
    expect(profile().counts.delivery.currentMonthCount).toBe(1);
    expect(profile().counts["number-one"].currentMonthCount).toBe(1);
    oldRule.category = "分流";
    expect(profile().counts.delivery.currentMonthCount).toBe(0); // Existing auto category contract.
  });

  it("counts a historical edit, qualification override, rearchive, and clear from final people", () => {
    const { state } = fixture();
    const draft = buildHistoricalScheduleDraft(state, PAST);
    expect(draft.warnings).toEqual([]);
    state.flights = draft.flights;
    state.assignments = draft.assignments;
    state.activeScheduleDate = PAST;
    expect(cell(state, 0, "送资料", PAST).effectiveCount).toBe(1);
    const assignment = state.assignments.find((a) => a.position === "H05")!;
    expect(assignStaff(state, assignment.id, state.staff[1]!.id).changed).toBe(
      true
    );
    expect(
      assignment.manualOverrideWarnings?.some(
        (w) => w.code === "position-qualification"
      )
    ).toBe(true);
    expect(cell(state, 0, "送资料", PAST).effectiveCount).toBe(0);
    expect(cell(state, 1, "送资料", PAST).effectiveCount).toBe(1);
    replaceHistoryForDate(state, PAST, currentScheduleHistory(state, PAST));
    expect(cell(state, 1, "送资料", PAST).effectiveCount).toBe(1);
    clearScheduleStaff(state);
    expect(cell(state, 1, "送资料", PAST).effectiveCount).toBe(0);
  });

  it("applies historical-only category corrections to automatic frequency too", () => {
    const { state, newRule, flight } = fixture();
    state.assignments = [];
    newRule.remark = "";
    const target = { ...newRule, flightNo: "AK151", remark: "送资料" };
    state.positionRules.push(target);
    state.settings.latePriorityFlightNumbers.push("AK151");
    resetMonthlyLatePriorityFrequencyCounts(state, TODAY);
    expect(cell(state, 0).effectiveCount).toBe(0);
    const profile = latePriorityFrequencyProfileForRule(
      state,
      state.staff[0]!.id,
      flight,
      target,
      TODAY
    );
    expect(profile.counts.delivery.currentMonthCount).toBe(0);
    expect(profile.counts.delivery.recentWorkdayCount).toBe(1);
    expect(profile.previousWorkdayAssigned).toBe(true);
  });

  it("preserves source and counts through Excel/storage and counts import/reset", () => {
    const { state, newRule } = fixture();
    state.assignments = [];
    newRule.remark = "";
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
    let data = "";
    saveState(restored, {
      setItem: (_k, v) => {
        data = v;
      },
    });
    const loaded = loadState({ getItem: () => data });
    expect(cell(loaded, 0).effectiveCount).toBe(1);
    expect(loaded.history[0]!.assignmentRemarks?.remark).toBe("送资料");
    const book = buildLatePriorityCountsWorkbook(loaded, TODAY);
    const preview = parseLatePriorityCountsWorkbook(book, loaded, TODAY);
    expect(preview.canApply).toBe(true);
    expect(applyLatePriorityCountsImport(loaded, preview)).toBe(false); // Same final counts need no correction.
    resetMonthlyLatePriorityFrequencyCounts(loaded, TODAY);
    expect(cell(loaded, 0).effectiveCount).toBe(0);
    expect(loaded.history).toEqual(restored.history);
  });

  it("keeps scope/month/time/dedup and does not treat keywords in free notes as positions", () => {
    const { state } = fixture();
    state.history.push({ ...state.history[0]!, id: "duplicate" });
    expect(cell(state, 0).effectiveCount).toBe(1);
    state.history.forEach((r) => {
      r.endTime = "23:00";
    });
    expect(cell(state, 0).effectiveCount).toBe(0);
    state.history.forEach((r) => {
      r.endTime = "23:55";
      r.date = "2026-09-29";
    });
    expect(
      buildMonthlyLatePriorityStatistics(state, TODAY).rows.some(
        (r) => r.staff.id === state.staff[0]!.id
      )
    ).toBe(false);
    state.settings.latePriorityFlightNumbers = [];
    expect(buildMonthlyLatePriorityStatistics(state, TODAY).rows).toEqual([]);
  });
});
