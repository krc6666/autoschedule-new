import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx-js-style";
import { createDefaultState } from "../../src/defaults";
import type { Assignment } from "../../src/model";
import { buildMonthlyRelaxedShiftStatistics as statistics } from "../../src/domain/statistics/relaxed-shift-statistics";
import {
  applyScheduleSettingsPatch,
  normalizeScheduleSettings,
} from "../../src/domain/rules/schedule-settings";
import { currentScheduleHistory } from "../../src/app/history-actions";
import {
  buildConfigWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";
import { saveState, loadState } from "../../src/infrastructure/storage";

const date = "2026-11-10";
function scenario() {
  const state = createDefaultState();
  state.staff = state.staff.slice(0, 4).map((person, i) => ({
    ...person,
    id: `p${i}`,
    name: `人员${i}`,
    staffType: "常规" as const,
    status: "正常" as const,
    dutyQualified: false,
    teamLeader: false,
  }));
  state.flights = [];
  state.assignments = [];
  state.history = [];
  state.activeScheduleDate = date;
  state.settings.dutyFatiguePoints = 0;
  const add = (
    id: string,
    person: number,
    startTime: string,
    endTime: string
  ): Assignment => {
    state.flights.push({
      id,
      flightNo: id,
      startTime,
      endTime,
      positions: ["柜台"],
      bookedPassengers: 0,
      remark: "",
    });
    const task: Assignment = {
      id,
      flightId: id,
      flightNo: id,
      positionRuleId: null,
      position: "柜台",
      staffId: state.staff[person]!.id,
      staffName: state.staff[person]!.name,
      startTime,
      endTime,
      workHours: 2,
      fatiguePoints: 1,
      remark: "",
      manualRemark: "",
      status: "assigned",
    };
    state.assignments.push(task);
    return task;
  };
  const counts = () =>
    statistics(state, date).rows.map((row) => row.afternoonRestDates.length);
  return { state, add, counts };
}

describe("afternoon attendance contract", () => {
  it("does not count anyone when the whole afternoon has no flights, in current and complete history", () => {
    const { state, add, counts } = scenario();
    add("AM", 0, "08:00", "10:00");
    add("PM", 1, "19:00", "21:00");
    expect(counts()).toEqual([0, 0, 0, 0]);
    state.history = currentScheduleHistory(state, date);
    state.assignments = [];
    state.activeScheduleDate = null;
    expect(counts()).toEqual([0, 0, 0, 0]);
  });

  it.each([
    ["11:00", "14:00", 0],
    ["17:30", "19:00", 0],
    ["12:00", "12:01", 0],
    ["17:59", "18:00", 0],
    ["10:00", "12:00", 1],
    ["18:00", "20:00", 1],
  ])(
    "counts only absence of positive overlap: %s—%s",
    (start, end, expected) => {
      const { add, counts } = scenario();
      add("AFTERNOON", 0, "13:00", "15:00");
      add("PERSON", 1, start, end);
      expect(counts()).toEqual([0, expected, 0, 0]);
    }
  );

  it("uses an unfilled afternoon flight as a flight, without counting the empty position as work", () => {
    const { add, counts } = scenario();
    add("AM", 0, "08:00", "10:00");
    const task = add("AFTERNOON", 1, "13:00", "15:00");
    task.staffId = null;
    task.staffName = "";
    task.status = "unfilled";
    expect(counts()).toEqual([1, 0, 0, 0]);
  });

  it("does not let a guide appearing before its source change early departure", () => {
    const { state, add } = scenario();
    const source = add("AM", 0, "08:00", "10:00");
    state.positionRules.push({
      ...state.positionRules[0]!,
      id: "guide",
      category: "引导",
    });
    state.assignments.unshift({
      ...source,
      id: "guide",
      positionRuleId: "guide",
      workHours: 0,
    });
    expect(statistics(state, date).rows[0]!.earlyDepartures).toHaveLength(1);
  });

  it("recomputes from final people after manual clearing and deduplicates repeated roles", () => {
    const { state, add, counts } = scenario();
    add("AM", 1, "08:00", "10:00");
    const afternoon = add("AFTERNOON", 1, "13:00", "15:00");
    add("OTHER", 0, "13:00", "15:00");
    expect(counts()).toEqual([0, 0, 0, 0]);
    afternoon.staffId = null;
    afternoon.staffName = "";
    afternoon.status = "unfilled";
    state.assignments.push({ ...state.assignments[0]!, id: "duplicate" });
    expect(counts()).toEqual([0, 1, 0, 0]);
    expect(statistics(state, date).currentAfternoonRest).toHaveLength(1);
  });

  it("counts guide presence without adding load history, preserving it through archive, storage and XLSX", () => {
    const { state, add, counts } = scenario();
    const source = add("SOURCE", 0, "10:00", "12:00");
    state.flights[0]!.endTime = "14:00";
    add("OTHER", 1, "13:00", "15:00");
    state.positionRules.push({
      ...state.positionRules[0]!,
      id: "guide-rule",
      flightNo: source.flightNo,
      name: "引导",
      category: "引导",
      qualifiedStaffIds: [source.staffId!],
    });
    state.assignments.push({
      ...source,
      id: "guide",
      positionRuleId: "guide-rule",
      position: "引导",
      endTime: "14:00",
      workHours: 0,
      fatiguePoints: 0,
    });
    expect(counts()).toEqual([0, 0, 0, 0]);
    const earlyBefore = statistics(state, date).rows[0]!.earlyDepartures;
    state.history = currentScheduleHistory(state, date);
    expect(state.history.filter((r) => r.position === "引导")).toEqual([]);
    expect(
      state.history.find((r) => r.staffId === source.staffId)?.workHours
    ).toBe(2);
    state.assignments = [];
    state.activeScheduleDate = null;
    expect(counts()).toEqual([0, 0, 0, 0]);
    expect(statistics(state, date).rows[0]!.earlyDepartures).toEqual(
      earlyBefore
    );
    let saved = "";
    saveState(state, {
      setItem: (_key, value) => {
        saved = value;
      },
    });
    const restored = loadState({ getItem: () => saved });
    expect(
      statistics(restored, date).rows.map((r) => r.afternoonRestDates.length)
    ).toEqual([0, 0, 0, 0]);
    const book = XLSX.read(
      XLSX.write(buildConfigWorkbook(state), {
        type: "buffer",
        bookType: "xlsx",
      }),
      { type: "buffer" }
    );
    const imported = parseWorkbook(book, state.staff);
    state.history = imported.history!;
    expect(counts()).toEqual([0, 0, 0, 0]);
    expect(
      state.history.find((r) => r.staffId === source.staffId)?.workHours
    ).toBe(2);
  });

  it("uses saved history intervals rather than today's templates and ignores partial history", () => {
    const { state, add, counts } = scenario();
    add("AM", 0, "08:00", "10:00");
    add("AFTERNOON", 1, "13:00", "15:00");
    state.history = currentScheduleHistory(state, date);
    state.assignments = [];
    state.activeScheduleDate = null;
    state.flights = [];
    expect(counts()).toEqual([1, 0, 0, 0]);
    state.history = state.history.map((r) => ({
      ...r,
      historyCoverage: "late-priority-only",
    }));
    expect(counts()).toEqual([0, 0, 0, 0]);
  });

  it("changes the afternoon window without changing early departures", () => {
    const { state, add, counts } = scenario();
    add("MIDDAY", 0, "12:00", "13:00");
    add("LATE", 1, "16:00", "17:00");
    expect(counts()).toEqual([0, 0, 0, 0]);
    const before = statistics(state, date).rows.map((r) => r.earlyDepartures);
    state.settings.afternoonRestStartTime = "14:00";
    state.settings.afternoonRestEndTime = "18:00";
    expect(counts()).toEqual([1, 0, 0, 0]);
    expect(statistics(state, date).rows.map((r) => r.earlyDepartures)).toEqual(
      before
    );
  });

  it("handles an edited window across midnight in the same operational day", () => {
    const { state, add, counts } = scenario();
    state.settings.afternoonRestStartTime = "22:00";
    state.settings.afternoonRestEndTime = "02:00";
    add("AFTER-MIDNIGHT", 0, "01:00", "03:00");
    add("AM", 1, "08:00", "10:00");
    expect(counts()).toEqual([0, 1, 0, 0]);
  });

  it("falls back to saved task times when optional attendance metadata is damaged", () => {
    const { state, add, counts } = scenario();
    add("AM", 0, "08:00", "10:00");
    add("AFTERNOON", 1, "13:00", "15:00");
    state.history = currentScheduleHistory(state, date);
    state.assignments = [];
    state.activeScheduleDate = null;
    state.history[0]!.attendanceIntervals = [
      { startTime: "invalid", endTime: "14:00" },
    ];
    let saved = "";
    saveState(state, {
      setItem: (_key, value) => {
        saved = value;
      },
    });
    const restored = loadState({ getItem: () => saved });
    expect(restored.history[0]!.attendanceIntervals).toBeUndefined();
    expect(restored.history).toHaveLength(2);
    expect(counts()).toEqual([1, 0, 0, 0]);
  });

  it("owns all six editable times and preserves invalid intervals and older defaults", () => {
    const defaults = normalizeScheduleSettings({});
    expect(defaults).toMatchObject({
      morningStatsStartTime: "06:00",
      morningStatsEndTime: "12:00",
      eveningStatsStartTime: "18:00",
      eveningStatsEndTime: "06:00",
    });
    const settings = applyScheduleSettingsPatch(defaults, {
      morningStatsStartTime: "07:00",
      morningStatsEndTime: "11:00",
      afternoonRestStartTime: "13:00",
      afternoonRestEndTime: "17:00",
      eveningStatsStartTime: "19:00",
      eveningStatsEndTime: "05:00",
    });
    expect(
      applyScheduleSettingsPatch(settings, { afternoonRestStartTime: "17:00" })
    ).toMatchObject({
      afternoonRestStartTime: "13:00",
      afternoonRestEndTime: "17:00",
    });
    expect(
      applyScheduleSettingsPatch(settings, { afternoonRestStartTime: "25:00" })
    ).toMatchObject({ afternoonRestStartTime: "13:00" });
    const { state } = scenario();
    state.settings = settings;
    let saved = "";
    saveState(state, {
      setItem: (_key, value) => {
        saved = value;
      },
    });
    expect(loadState({ getItem: () => saved }).settings).toMatchObject(
      settings
    );
    const imported = parseWorkbook(
      XLSX.read(
        XLSX.write(buildConfigWorkbook(state), {
          type: "buffer",
          bookType: "xlsx",
        }),
        { type: "buffer" }
      ),
      state.staff
    );
    expect(imported.settings).toMatchObject({
      morningStatsStartTime: "07:00",
      morningStatsEndTime: "11:00",
      afternoonRestStartTime: "13:00",
      afternoonRestEndTime: "17:00",
      eveningStatsStartTime: "19:00",
      eveningStatsEndTime: "05:00",
    });
  });
});
