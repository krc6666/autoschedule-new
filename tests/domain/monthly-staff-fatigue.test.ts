import { describe, expect, it } from "vitest";
import { createDefaultState } from "../../src/defaults";
import type { Assignment, HistoryRecord } from "../../src/model";
import { buildMonthlyStaffFatigue } from "../../src/domain/statistics/monthly-staff-fatigue";
import { historyFatigue } from "../../src/domain/statistics/fatigue";

function fixture() {
  const state = createDefaultState();
  state.staff = state.staff.filter((p) => p.staffType === "常规").slice(0, 3);
  state.staff.forEach((p, i) => {
    p.id = `p${i}`;
    p.name = `P${i}`;
    p.status = "正常";
  });
  state.history = [];
  state.assignments = [];
  state.activeScheduleDate = null;
  state.settings.dutyFatiguePoints = 0;
  return state;
}
function record(
  date: string,
  fatiguePoints: number,
  staffId = "p0"
): HistoryRecord {
  return {
    id: `${date}-${staffId}`,
    date,
    staffId,
    staffName: staffId,
    flightNo: "TEST001",
    position: "G01",
    startTime: "08:00",
    endTime: "10:00",
    workHours: 2,
    fatiguePoints,
    remark: "",
  };
}
function assignment(
  state: ReturnType<typeof fixture>,
  fatiguePoints = 4
): Assignment {
  return {
    ...record("2026-10-22", fatiguePoints),
    id: "active",
    flightId: state.flights[0]!.id,
    positionRuleId: null,
    status: "assigned",
    manualRemark: "",
  };
}

describe("monthly staff fatigue", () => {
  it("sums the entire selected month through its latest roster, independently of today's selected date", () => {
    const state = fixture();
    state.history = [
      record("2026-09-30", 30),
      record("2026-10-01", 2),
      record("2026-10-21", 6),
      record("2026-10-31", 7),
      record("2026-11-01", 50),
    ];
    const result = buildMonthlyStaffFatigue(state, "2026-10", "2026-10-21");
    expect(result.latestDate).toBe("2026-10-31");
    expect(result.rows[0]).toMatchObject({ todayFatigue: 6, monthFatigue: 15 });
    expect(
      buildMonthlyStaffFatigue(state, "2026-09", "2026-10-21").rows[0]
        ?.monthFatigue
    ).toBe(30);
    expect(
      buildMonthlyStaffFatigue(state, "2026-12", "2026-10-21")
    ).toMatchObject({
      latestDate: null,
      rows: expect.arrayContaining([
        expect.objectContaining({ monthFatigue: 0, todayFatigue: 6 }),
      ]),
    });
  });
  it("replaces the entire archived active date and keeps zero rather than substituting work hours", () => {
    const state = fixture();
    state.activeScheduleDate = "2026-10-22";
    state.assignments = [assignment(state, 0)];
    state.history = [
      record("2026-10-01", 3),
      record("2026-10-22", 99),
      record("2026-10-22", 99, "p1"),
    ];
    expect(
      buildMonthlyStaffFatigue(state, "2026-10", "2026-10-22").rows.map((r) => [
        r.todayFatigue,
        r.monthFatigue,
      ])
    ).toEqual([
      [0, 3],
      [0, 0],
      [0, 0],
    ]);
    state.assignments[0]!.staffId = null;
    state.assignments[0]!.status = "unfilled";
    state.assignments[0]!.fatiguePoints = 100;
    state.assignments[0]!.countBaseline = { staffId: "p0", staffName: "P0" };
    expect(
      buildMonthlyStaffFatigue(state, "2026-10", "2026-10-22").rows[0]
        ?.monthFatigue
    ).toBe(3);
  });
  it("uses only the valid active date and leaves actual history visible during leave", () => {
    const state = fixture();
    state.assignments = [assignment(state, 40)];
    state.history = [record("2026-10-22", 3)];
    state.staff[0]!.status = "休假";
    expect(
      buildMonthlyStaffFatigue(state, "2026-10", "2026-10-22").rows[0]
    ).toMatchObject({ todayFatigue: 3, monthFatigue: 3 });
    state.activeScheduleDate = "2026-11-22";
    expect(
      buildMonthlyStaffFatigue(state, "2026-10", "2026-10-22").rows[0]
    ).toMatchObject({ todayFatigue: 3, monthFatigue: 3 });
    expect(
      buildMonthlyStaffFatigue(state, "2026-10", "2026-10-23").rows[0]
        ?.todayFatigue
    ).toBe(0);
  });
  it("preserves counted workload, duty extra points, leaders, and excludes reused guides and administrative staff", () => {
    const state = fixture();
    state.activeScheduleDate = "2026-10-22";
    state.staff[0]!.teamLeader = true;
    state.staff[1]!.staffType = "行政支援";
    state.settings.dutyFatiguePoints = 6;
    state.dutyRosterOverrides = [
      {
        date: state.activeScheduleDate,
        dutyStaffId: "p0",
        cxPreflightStaffId: null,
        standbyStaffIds: [null, null],
      },
    ];
    state.positionRules = [
      { ...state.positionRules[0]!, id: "guide", category: "引导" },
    ];
    state.assignments = [
      assignment(state, 4),
      { ...assignment(state, 50), id: "guide", positionRuleId: "guide" },
      { ...assignment(state, 90), id: "admin", staffId: "p1" },
    ];
    expect(
      buildMonthlyStaffFatigue(state, "2026-10", "2026-10-22").rows.map((r) => [
        r.staff.id,
        r.todayFatigue,
        r.monthFatigue,
      ])
    ).toEqual([
      ["p0", 10, 10],
      ["p2", 0, 0],
    ]);
    state.assignments = [];
    expect(
      buildMonthlyStaffFatigue(state, "2026-10", "2026-10-22").rows[0]
        ?.monthFatigue
    ).toBe(0);
  });
  it("keeps exact stored fatigue including scoped records without changing history-window rules or source data", () => {
    const state = fixture();
    state.history = [
      record("2026-10-01", 0),
      record("2026-10-19", 2),
      record("2026-10-20", 2),
      { ...record("2026-10-21", 3), historyCoverage: "late-priority-only" },
    ];
    const before = structuredClone(state);
    const old = historyFatigue(
      state.history,
      "p0",
      "2026-10-22",
      state.settings
    );
    expect(
      buildMonthlyStaffFatigue(state, "2026-10", "2026-10-22").rows[0]
        ?.monthFatigue
    ).toBe(7);
    expect(
      historyFatigue(state.history, "p0", "2026-10-22", state.settings)
    ).toBe(old);
    expect(state).toEqual(before);
  });
  it("separates years and sums a large month without losing fractional points", () => {
    const state = fixture();
    state.history = Array.from({ length: 3000 }, (_, i) => ({
      ...record(`2026-12-${String((i % 30) + 1).padStart(2, "0")}`, 0.5),
      id: `r${i}`,
    }));
    state.history.push(record("2027-01-01", 2));
    expect(
      buildMonthlyStaffFatigue(state, "2026-12", "2027-01-01").rows[0]
    ).toMatchObject({ monthFatigue: 1500, todayFatigue: 2 });
    expect(
      buildMonthlyStaffFatigue(state, "2027-01", "2027-01-01").rows[0]
        ?.monthFatigue
    ).toBe(2);
  });
});
