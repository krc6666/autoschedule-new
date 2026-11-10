import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx-js-style";
import { createDefaultState } from "../../src/defaults";
import {
  currentScheduleHistory,
  replaceHistoryForDate,
} from "../../src/app/history-actions";
import { assignStaff } from "../../src/app/schedule-actions";
import { buildMonthlyStaffFatigue } from "../../src/domain/statistics/monthly-staff-fatigue";
import { loadState, saveState } from "../../src/infrastructure/storage";
import {
  buildConfigWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";
import { applyWorkbookImport } from "../../src/app/workbook-actions";
import { createTestAutoscheduleStore } from "../helpers/application";

function fixture() {
  const state = createDefaultState();
  state.staff = state.staff
    .filter((p) => p.staffType === "常规" && p.status === "正常")
    .slice(0, 2);
  state.staff.forEach((p, i) => {
    p.name = `P${i}`;
    p.nightShift = true;
    p.teamLeader = false;
  });
  const flight = { ...state.flights[0]!, startTime: "13:00", endTime: "15:00" };
  const rule = {
    ...state.positionRules.find((r) => r.flightNo === flight.flightNo)!,
    category: "常规" as const,
    qualifiedStaffIds: state.staff.map((p) => p.id),
    fatiguePoints: 4,
  };
  state.flights = [flight];
  state.positionRules = [rule];
  state.activeScheduleDate = "2026-10-22";
  state.settings.dutyFatiguePoints = 6;
  state.dutyRosterOverrides = [
    {
      date: state.activeScheduleDate,
      dutyStaffId: state.staff[0]!.id,
      cxPreflightStaffId: null,
      standbyStaffIds: [null, null],
    },
  ];
  state.assignments = [
    {
      id: "slot",
      flightId: flight.id,
      flightNo: flight.flightNo,
      positionRuleId: rule.id,
      position: rule.name,
      staffId: state.staff[0]!.id,
      staffName: "P0",
      startTime: "13:00",
      endTime: "15:00",
      workHours: 2,
      fatiguePoints: 4,
      remark: "",
      manualRemark: "",
      status: "assigned",
    },
  ];
  state.history = [
    {
      id: "previous",
      date: "2026-10-01",
      flightNo: flight.flightNo,
      position: rule.name,
      staffId: state.staff[0]!.id,
      staffName: "P0",
      startTime: "13:00",
      endTime: "15:00",
      workHours: 2,
      fatiguePoints: 3,
      remark: "",
    },
  ];
  return state;
}
function totals(state: ReturnType<typeof fixture>) {
  return buildMonthlyStaffFatigue(state, "2026-10", "2026-10-22").rows.map(
    (r) => [r.todayFatigue, r.monthFatigue]
  );
}

describe("fatigue archive and persisted facts", () => {
  it("counts duty and role points once before/after repeated archive, manual replacement and clearing", () => {
    const state = fixture();
    expect(totals(state)).toEqual([
      [10, 13],
      [0, 0],
    ]);
    for (let i = 0; i < 2; i++) {
      replaceHistoryForDate(
        state,
        "2026-10-22",
        currentScheduleHistory(state, "2026-10-22")
      );
      expect(totals(state)).toEqual([
        [10, 13],
        [0, 0],
      ]);
    }
    expect(assignStaff(state, "slot", state.staff[1]!.id).changed).toBe(true);
    expect(totals(state)).toEqual([
      [6, 9],
      [4, 4],
    ]);
    replaceHistoryForDate(
      state,
      "2026-10-22",
      currentScheduleHistory(state, "2026-10-22")
    );
    expect(totals(state)).toEqual([
      [6, 9],
      [4, 4],
    ]);
    expect(assignStaff(state, "slot", "").changed).toBe(true);
    replaceHistoryForDate(
      state,
      "2026-10-22",
      currentScheduleHistory(state, "2026-10-22")
    );
    expect(totals(state)).toEqual([
      [6, 9],
      [0, 0],
    ]);
    state.assignments = [];
    state.activeScheduleDate = null;
    expect(totals(state)).toEqual([
      [6, 9],
      [0, 0],
    ]);
  });
  it("preserves totals across actual storage restoration and XLSX bytes without adding new fields", () => {
    const state = fixture();
    replaceHistoryForDate(
      state,
      "2026-10-22",
      currentScheduleHistory(state, "2026-10-22")
    );
    let serialized = "";
    saveState(state, {
      setItem: (_key, value) => {
        serialized = value;
      },
    });
    const restored = loadState({ getItem: () => serialized });
    expect(totals(restored)).toEqual([
      [10, 13],
      [0, 0],
    ]);
    const bytes = XLSX.write(buildConfigWorkbook(state), {
      type: "buffer",
      bookType: "xlsx",
    });
    const imported = parseWorkbook(
      XLSX.read(bytes, { type: "buffer" }),
      state.staff
    );
    const target = createDefaultState();
    const applied = applyWorkbookImport(target, imported, "all");
    expect(applied.errors ?? []).toEqual([]);
    expect(totals(target)).toEqual([
      [10, 13],
      [0, 0],
    ]);
    expect(target.activeScheduleDate).toBeNull();
  });
  it("keeps groups separate when switching the actual store projection", () => {
    const state = fixture();
    const store = createTestAutoscheduleStore(state);
    expect(totals(store.getState().model)).toEqual([
      [10, 13],
      [0, 0],
    ]);
    store.getState().switchGroup("B");
    expect(
      buildMonthlyStaffFatigue(
        store.getState().model,
        "2026-10",
        "2026-10-22"
      ).rows.every((r) => r.monthFatigue === 0)
    ).toBe(true);
    store.getState().switchGroup("A");
    expect(totals(store.getState().model)).toEqual([
      [10, 13],
      [0, 0],
    ]);
  });
});
