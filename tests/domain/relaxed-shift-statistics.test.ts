import { describe, expect, it } from "vitest";

import { createDefaultState } from "../../src/defaults";
import type { Assignment, HistoryRecord } from "../../src/model";
import { buildMonthlyRelaxedShiftStatistics } from "../../src/domain/statistics/relaxed-shift-statistics";

function assignment(
  id: string,
  flightNo: string,
  staffId: string,
  staffName: string,
  startTime: string,
  endTime: string
): Assignment {
  return {
    id,
    flightId: `flight-${flightNo}`,
    flightNo,
    positionRuleId: id,
    position: "柜台",
    staffId,
    staffName,
    startTime,
    endTime,
    workHours: 2,
    fatiguePoints: 1,
    remark: "",
    manualRemark: "",
    status: "assigned",
  };
}

describe("monthly relaxed shift statistics", () => {
  it("excludes the whole date when any flight's planned cutoff is after 23:00 despite early release", () => {
    const state = createDefaultState();
    const person = state.staff.find((item) => item.status === "正常")!;
    person.dutyQualified = false;
    state.staff = [person];
    state.activeScheduleDate = "2026-10-01";
    state.settings.earlyDepartureCutoffTime = "23:30";
    state.flights = [
      {
        id: "flight-AK151",
        flightNo: "AK151",
        startTime: "21:05",
        endTime: "23:05",
        bookedPassengers: 0,
        positions: ["G09"],
        remark: "",
      },
      {
        id: "flight-TGT123",
        flightNo: "TGT123",
        startTime: "22:10",
        endTime: "22:50",
        bookedPassengers: 0,
        positions: ["G01"],
        remark: "",
      },
    ];
    state.assignments = [
      {
        ...assignment(
          "ak151-g09",
          "AK151",
          person.id,
          person.name,
          "21:05",
          "22:10"
        ),
        workHours: 1.08,
      },
      assignment(
        "target-g01",
        "TGT123",
        person.id,
        person.name,
        "22:10",
        "22:50"
      ),
    ];

    const row = buildMonthlyRelaxedShiftStatistics(state, "2026-10-01")
      .rows[0]!;

    expect(row.earlyDepartures).toEqual([]);
  });

  it("does not suppress early departure when a flight cutoff is exactly 23:00", () => {
    const state = createDefaultState();
    const person = state.staff.find((item) => item.status === "正常")!;
    person.dutyQualified = false;
    state.staff = [person];
    state.activeScheduleDate = "2026-10-01";
    state.settings.earlyDepartureCutoffTime = "23:30";
    state.flights = [
      {
        id: "flight-AK151",
        flightNo: "AK151",
        startTime: "21:05",
        endTime: "23:00",
        bookedPassengers: 0,
        positions: ["G09"],
        remark: "",
      },
    ];
    state.assignments = [
      {
        ...assignment(
          "ak151-g09",
          "AK151",
          person.id,
          person.name,
          "21:05",
          "22:10"
        ),
        workHours: 1.08,
      },
    ];

    const row = buildMonthlyRelaxedShiftStatistics(state, "2026-10-01")
      .rows[0]!;

    expect(row.earlyDepartures).toHaveLength(1);
  });

  it("uses the saved end time for archived rows without a flight cutoff snapshot", () => {
    const state = createDefaultState();
    const person = state.staff.find((item) => item.status === "正常")!;
    person.dutyQualified = false;
    state.staff = [person];
    state.settings.earlyDepartureCutoffTime = "23:30";
    state.history = [
      {
        id: "legacy-ak151",
        date: "2026-10-01",
        flightNo: "AK151",
        position: "G09",
        staffId: person.id,
        staffName: person.name,
        startTime: "21:05",
        endTime: "23:05",
        workHours: 1.08,
        fatiguePoints: 3.5,
        remark: "",
      },
    ];

    const row = buildMonthlyRelaxedShiftStatistics(state, "2026-10-02")
      .rows[0]!;

    expect(row.earlyDepartures).toEqual([]);
  });

  it("uses a strict cutoff, excludes duty from early departure, and keeps duty and standby in afternoon rest", () => {
    const state = createDefaultState();
    const [duty, standby, afternoon, exactCutoff] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 4);
    state.staff = [duty!, standby!, afternoon!, exactCutoff!];
    state.activeScheduleDate = "2026-07-18";
    state.dutyRosterOverrides = [
      {
        date: "2026-07-18",
        cxPreflightStaffId: null,
        dutyStaffId: duty!.id,
        standbyStaffIds: [standby!.id, afternoon!.id],
      },
    ];
    state.assignments = [
      assignment("duty-early", "EARLY", duty!.id, duty!.name, "08:00", "10:00"),
      assignment(
        "standby-early",
        "EARLY",
        standby!.id,
        standby!.name,
        "08:00",
        "10:00"
      ),
      {
        ...assignment(
          "standby-guide",
          "EARLY",
          standby!.id,
          standby!.name,
          "08:00",
          "10:00"
        ),
        workHours: 0,
      },
      assignment(
        "exact-cutoff",
        "NOON",
        exactCutoff!.id,
        exactCutoff!.name,
        "10:00",
        "12:00"
      ),
      assignment(
        "afternoon-exact",
        "NOON",
        afternoon!.id,
        afternoon!.name,
        "10:00",
        "12:00"
      ),
      assignment(
        "afternoon-flight",
        "LATE",
        afternoon!.id,
        afternoon!.name,
        "15:00",
        "17:00"
      ),
    ];

    const result = buildMonthlyRelaxedShiftStatistics(state, "2026-07-18");
    const dutyRow = result.rows.find((row) => row.staff.id === duty!.id)!;
    const standbyRow = result.rows.find((row) => row.staff.id === standby!.id)!;
    const afternoonRow = result.rows.find(
      (row) => row.staff.id === afternoon!.id
    )!;
    const exactCutoffRow = result.rows.find(
      (row) => row.staff.id === exactCutoff!.id
    )!;

    expect(dutyRow.earlyDepartures).toHaveLength(0);
    expect(dutyRow.afternoonRestDates).toEqual(["2026-07-18"]);
    expect(standbyRow.earlyDepartures).toEqual([
      { date: "2026-07-18", flightNo: "EARLY", cutoffTime: "10:00" },
    ]);
    expect(standbyRow.afternoonRestDates).toEqual(["2026-07-18"]);
    expect(afternoonRow.earlyDepartures).toHaveLength(0);
    expect(afternoonRow.afternoonRestDates).toHaveLength(0);
    expect(exactCutoffRow.earlyDepartures).toHaveLength(0);
    expect(exactCutoffRow.afternoonRestDates).toEqual(["2026-07-18"]);
  });

  it("combines archived days with the current schedule and replaces same-day history", () => {
    const state = createDefaultState();
    const person = state.staff.find((item) => item.status === "正常")!;
    person.dutyQualified = false;
    state.staff = [person];
    const archived: HistoryRecord = {
      id: "archived",
      date: "2026-07-16",
      flightNo: "EARLY",
      position: "柜台",
      staffId: person.id,
      staffName: person.name,
      startTime: "08:00",
      endTime: "10:00",
      workHours: 2,
      fatiguePoints: 1,
      remark: "",
    };
    state.history = [
      archived,
      { ...archived, id: "stale", date: "2026-07-18", endTime: "09:00" },
    ];
    state.activeScheduleDate = "2026-07-18";
    state.assignments = [
      assignment("current", "NOON", person.id, person.name, "10:00", "12:00"),
    ];

    const row = buildMonthlyRelaxedShiftStatistics(state, "2026-07-18")
      .rows[0]!;
    expect(row.earlyDepartures).toEqual([
      { date: "2026-07-16", flightNo: "EARLY", cutoffTime: "10:00" },
    ]);
    // No afternoon flight is recorded on the archived date; the active day has planned flights.
    expect(row.afternoonRestDates).toEqual(["2026-07-18"]);
  });

  it("does not treat a late-priority-only history import as a complete afternoon record", () => {
    const state = createDefaultState();
    const person = state.staff[0]!;
    state.staff = [person];
    state.history = [
      {
        id: "partial-late-history",
        date: "2026-07-17",
        flightNo: "TR121",
        position: "H02",
        staffId: person.id,
        staffName: person.name,
        startTime: "20:00",
        endTime: "23:30",
        workHours: 3.5,
        fatiguePoints: 3,
        remark: "",
        historyCoverage: "late-priority-only",
      } as HistoryRecord & { historyCoverage: "late-priority-only" },
    ];

    const row = buildMonthlyRelaxedShiftStatistics(state, "2026-07-18")
      .rows[0]!;

    expect(row.afternoonRestDates).toEqual([]);
    expect(row.earlyDepartures).toEqual([]);
  });

  it("keeps complete morning history eligible for early departure without inventing afternoon flights", () => {
    const state = createDefaultState();
    const person = state.staff[0]!;
    person.dutyQualified = false;
    state.staff = [person];
    state.history = [
      {
        id: "complete-history",
        date: "2026-07-17",
        flightNo: "AM123",
        position: "G01",
        staffId: person.id,
        staffName: person.name,
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 1,
        remark: "",
        historyCoverage: "complete",
      },
    ];

    const row = buildMonthlyRelaxedShiftStatistics(state, "2026-07-18")
      .rows[0]!;

    expect(row.afternoonRestDates).toEqual([]);
    expect(row.earlyDepartures).toHaveLength(1);
  });
});
