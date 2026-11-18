import { expect, it } from "vitest";
import { buildMonthlyRelaxedShiftStatistics } from "../../src/domain/statistics/relaxed-shift-statistics";
import {
  relaxedMatrixFixture,
  matrixHistory,
} from "../helpers/relaxed-flight-matrix";
import { relaxedShiftFlightScope } from "../../src/domain/statistics/relaxed-shift-flight-scope";

it("adds mutually exclusive afternoon free/off dates without changing the original rest statistic", () => {
  const state = relaxedMatrixFixture();
  const report = buildMonthlyRelaxedShiftStatistics(state, "2026-11-18");
  expect(report.rows.map((r) => r.afternoonRestDates)).toEqual([
    ["2026-11-18"],
    ["2026-11-18"],
    [],
    [],
    [],
  ]);
  expect(report.rows[0]).toMatchObject({
    afternoonFreeDates: [],
    afternoonOffDates: ["2026-11-18"],
    earlyDepartureDatesByFlight: { MF8001: ["2026-11-18"] },
  });
  expect(report.rows[1]).toMatchObject({
    afternoonFreeDates: ["2026-11-18"],
    afternoonOffDates: [],
  });
  expect(report.rows[2]).toMatchObject({
    afternoonFreeDates: [],
    afternoonOffDates: [],
  });
  for (const index of [3, 4])
    expect(report.rows[index]).toMatchObject({
      afternoonOffDates: ["2026-11-18"],
      afternoonFreeDates: [],
    });
});

it("uses complete saved facts, keeps current-over-history replacement and does not invent missing attendance", () => {
  const state = relaxedMatrixFixture();
  state.history = [
    matrixHistory(state.assignments[0]!, "2026-11-18"),
    matrixHistory(state.assignments[1]!, "2026-11-16"),
    {
      ...matrixHistory(state.assignments[1]!, "2026-11-14"),
      historyCoverage: "late-priority-only",
    },
    matrixHistory(state.assignments[0]!, "2026-10-31"),
    {
      ...matrixHistory(state.assignments[0]!, "2026-11-12"),
      attendanceIntervals: [{ startTime: "19:00", endTime: "20:00" }],
    },
  ];
  const report = buildMonthlyRelaxedShiftStatistics(state, "2026-11-18");
  expect(report.rows[0]).toMatchObject({
    afternoonOffDates: ["2026-11-18"],
    afternoonFreeDates: ["2026-11-12"],
  });
  expect(report.rows[1]).toMatchObject({
    afternoonFreeDates: ["2026-11-16", "2026-11-18"],
  });
  // A same-day manual reassignment must replace both dates and flight counts.
  state.assignments[1]!.staffId = state.staff[0]!.id;
  state.assignments[1]!.staffName = state.staff[0]!.name;
  expect(
    buildMonthlyRelaxedShiftStatistics(state, "2026-11-18").rows[0]
  ).toMatchObject({
    afternoonOffDates: [],
    afternoonFreeDates: ["2026-11-12", "2026-11-18"],
    earlyDepartureDatesByFlight: {
      CX937: ["2026-11-18"],
      MF8001: ["2026-11-12"],
    },
  });
});

it("counts one event per person/day and preserves duty, strict cutoff and 23:00 exclusions", () => {
  const state = relaxedMatrixFixture();
  state.assignments.push({
    ...state.assignments[0]!,
    id: "guide",
    position: "引导",
    workHours: 0,
  });
  expect(
    buildMonthlyRelaxedShiftStatistics(state, "2026-11-18").rows[0]
  ).toMatchObject({ earlyDepartureDatesByFlight: { MF8001: ["2026-11-18"] } });
  state.flights[0]!.endTime = "23:01";
  expect(
    buildMonthlyRelaxedShiftStatistics(state, "2026-11-18").rows[0]
  ).toMatchObject({ earlyDepartures: [], earlyDepartureDatesByFlight: {} });
});

it.each([
  ["12:00", "13:00", false, true],
  ["12:01", "13:00", false, false],
  ["17:59", "19:00", false, false],
  ["18:00", "20:00", true, false],
  ["23:00", "01:00", true, false],
  ["11:50", "19:00", false, true],
] as const)(
  "classifies start %s/end %s at the exact afternoon/noon boundaries",
  (startTime, endTime, free, off) => {
    const state = relaxedMatrixFixture();
    state.assignments = [
      { ...state.assignments[0]!, startTime, endTime, workHours: 0 },
    ];
    state.flights = [];
    const row = buildMonthlyRelaxedShiftStatistics(state, "2026-11-18")
      .rows[0]!;
    expect(row.afternoonFreeDates.length).toBe(Number(free));
    expect(row.afternoonOffDates.length).toBe(Number(off));
  }
);

it("keeps default scope, explicit empty scope and 200 staff facts independent of display selection", () => {
  const state = relaxedMatrixFixture();
  state.settings.relaxedShiftFlightNumbers = null;
  expect(relaxedShiftFlightScope(state).selected).toEqual([
    "MF8001",
    "CX937",
    "CX931",
  ]);
  const before = buildMonthlyRelaxedShiftStatistics(state, "2026-11-18");
  state.settings.relaxedShiftFlightNumbers = [];
  expect(relaxedShiftFlightScope(state).selected).toEqual([]);
  expect(buildMonthlyRelaxedShiftStatistics(state, "2026-11-18")).toEqual(
    before
  );
  state.staff = Array.from({ length: 200 }, (_, i) => ({
    ...state.staff[0]!,
    id: `large-${i}`,
    name: `人员${i}`,
  }));
  state.assignments = state.staff.map((p, i) => ({
    ...state.assignments[i % 2]!,
    id: p.id,
    staffId: p.id,
    staffName: p.name,
  }));
  const rows = buildMonthlyRelaxedShiftStatistics(state, "2026-11-18").rows;
  expect(rows).toHaveLength(200);
  expect(rows.reduce((sum, r) => sum + r.afternoonFreeDates.length, 0)).toBe(
    100
  );
  expect(rows.reduce((sum, r) => sum + r.afternoonOffDates.length, 0)).toBe(
    100
  );
});
