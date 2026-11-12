import { describe, expect, it } from "vitest";
import { createDefaultState } from "../../src/defaults";
import type { Assignment, HistoryRecord } from "../../src/model";
import { balanceRelaxedShifts } from "../../src/domain/reviews/relaxed-shift-balance";
import { buildMonthlyRelaxedShiftStatistics } from "../../src/domain/statistics/relaxed-shift-statistics";
import { ScheduleGuardError } from "../../src/domain/kernel/schedule-guard";
import { generateSchedule } from "../helpers/generate-schedule";
import * as XLSX from "xlsx-js-style";
import {
  buildConfigWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";
import { applyWorkbookImport } from "../../src/app/workbook-actions";
import { saveState, loadState } from "../../src/infrastructure/storage";
import {
  BUILT_IN_RULE_REGISTRY,
  builtInRulePreferences,
} from "../../src/domain/rules/built-in-rule-registry";
import { USER_SCHEDULING_RULES } from "../../src/ui/projections/policy-rule-presentation";

function fixture() {
  const state = createDefaultState();
  const sample = state.staff.find(
    (p) => p.status === "正常" && p.staffType === "常规"
  )!;
  state.staff = ["甲", "乙"].map((name, i) => ({
    ...structuredClone(sample),
    id: `p${i}`,
    name,
    dutyQualified: false,
    teamLeader: false,
  }));
  state.positionRules = [];
  state.dutyRosterOverrides = [];
  state.activeScheduleDate = "2026-11-06";
  state.flights = [
    {
      id: "am",
      flightNo: "AM100",
      startTime: "09:00",
      endTime: "10:00",
      bookedPassengers: 0,
      positions: ["P1"],
      remark: "",
    },
    {
      id: "pm",
      flightNo: "PM100",
      startTime: "14:00",
      endTime: "15:00",
      bookedPassengers: 0,
      positions: ["P1"],
      remark: "",
    },
  ];
  const make = (id: string, flightId: string, staff: number): Assignment => {
    const flight = state.flights.find((f) => f.id === flightId)!;
    return {
      id,
      flightId,
      flightNo: flight.flightNo,
      positionRuleId: id,
      position: "P1",
      staffId: `p${staff}`,
      staffName: state.staff[staff]!.name,
      startTime: flight.startTime,
      endTime: flight.endTime,
      workHours: 1,
      fatiguePoints: 1,
      remark: "",
      manualRemark: "",
      status: "assigned",
    };
  };
  state.assignments = [
    make("a0", "am", 0),
    make("a1", "am", 1),
    make("p1", "pm", 1),
  ];
  state.history = ["2026-11-02", "2026-11-04"].flatMap((date) =>
    state.assignments.map((a): HistoryRecord => ({
      ...a,
      date,
      staffId: a.staffId!,
      flightCutoffTime: a.endTime,
    }))
  );
  return state;
}

describe("monthly relaxed shift balance", () => {
  it("does not hide the recipient from the comparison by swapping in an originally idle person", () => {
    const state = fixture();
    state.staff.push({
      ...structuredClone(state.staff[0]!),
      id: "p2",
      name: "丙",
    });
    state.staff = [state.staff[0]!, state.staff[2]!, state.staff[1]!];
    state.history.push(
      ...state.history
        .filter((row) => row.staffId === "p0")
        .map((row) => ({ ...row, staffId: "p2", staffName: "丙" }))
    );
    const result = balanceRelaxedShifts({
      state,
      date: state.activeScheduleDate!,
      assignments: state.assignments,
      lockedAssignmentIds: new Set(),
      assertSafe: () => undefined,
    });
    expect(
      buildMonthlyRelaxedShiftStatistics(
        { ...state, assignments: result },
        state.activeScheduleDate!
      ).currentAfternoonRest.map((p) => p.staffName)
    ).toEqual(["乙"]);
  });
  it("catches up across archived workdays without losing daily rest opportunities", async () => {
    const state = fixture();
    state.settings.dailyPrimaryPositionUniqueEnabled = false;
    state.settings.positionRotationEnabled = false;
    state.settings.workloadBalanceEnabled = false;
    state.settings.minimumRegularTransitionMinutes = 0;
    state.positionRules = state.assignments.map((a) => ({
      id: a.positionRuleId!,
      flightNo: a.flightNo,
      name: a.id,
      category: "常规",
      remark: "",
      qualifiedStaffIds: ["p0", "p1"],
      manual: false,
      fatiguePoints: 1,
      minPassengers: 0,
      earlyReleaseMinutes: 0,
    }));
    const recipients: string[] = [];
    for (const date of [
      "2026-11-06",
      "2026-11-08",
      "2026-11-10",
      "2026-11-12",
    ]) {
      state.assignments = [];
      state.activeScheduleDate = date;
      const result = await generateSchedule(state, date);
      expect(result.unfilledCount).toBe(0);
      // Independently classify actual intervals rather than using the balance score.
      const resting = state.staff.filter(
        (person) =>
          result.assignments.some((a) => a.staffId === person.id) &&
          !result.assignments.some(
            (a) =>
              a.staffId === person.id &&
              a.startTime < "18:00" &&
              a.endTime > "12:00"
          )
      );
      expect(resting).toHaveLength(1);
      recipients.push(resting[0]!.name);
      state.history.push(
        ...result.assignments.map((a) => ({
          ...a,
          date,
          staffId: a.staffId!,
          flightCutoffTime: a.endTime,
        }))
      );
    }
    expect(recipients.slice(0, 2)).toEqual(["乙", "乙"]);
    expect(recipients.slice(2).sort()).toEqual(["乙", "甲"]);
    const report = buildMonthlyRelaxedShiftStatistics(state, "2026-11-12");
    expect(report.rows.map((row) => row.afternoonRestDates.length)).toEqual([
      3, 3,
    ]);
  });
  it("registers the final review and exposes independent switches in the actual rule ledger", () => {
    const state = fixture();
    const definition = BUILT_IN_RULE_REGISTRY.definition(
      "relaxed-shift-balance"
    );
    expect(definition?.execute.map((item) => item.kind)).toEqual([
      "final-review",
    ]);
    expect(
      USER_SCHEDULING_RULES.find((rule) => rule.id === "relaxed-shift-balance")
        ?.description
    ).toContain("本月");
    state.settings.earlyDepartureBalanceEnabled = false;
    expect(
      builtInRulePreferences(state.settings).find(
        (rule) => rule.id === "relaxed-shift-balance"
      )?.enabled
    ).toBe(true);
    state.settings.afternoonRestBalanceEnabled = false;
    expect(
      builtInRulePreferences(state.settings).find(
        (rule) => rule.id === "relaxed-shift-balance"
      )?.enabled
    ).toBe(false);
  });
  it("keeps explicit switches and zero targets through Excel, empty import, restart and actual scheduling", async () => {
    const source = fixture();
    source.settings.earlyDepartureBalanceEnabled = false;
    source.settings.earlyDepartureMaxDifference = 3;
    source.settings.afternoonRestMaxDifference = 0;
    source.settings.dailyPrimaryPositionUniqueEnabled = false;
    source.settings.positionRotationEnabled = false;
    source.settings.workloadBalanceEnabled = false;
    source.settings.minimumRegularTransitionMinutes = 0;
    source.positionRules = source.assignments.map((a) => ({
      id: a.positionRuleId!,
      flightNo: a.flightNo,
      name: a.id,
      category: "常规",
      remark: "",
      qualifiedStaffIds: ["p0", "p1"],
      manual: false,
      fatiguePoints: 1,
      minPassengers: 0,
      earlyReleaseMinutes: 0,
    }));
    const bytes = XLSX.write(buildConfigWorkbook(source), {
      type: "array",
      bookType: "xlsx",
    });
    const imported = parseWorkbook(XLSX.read(bytes, { type: "array" }), []);
    const target = createDefaultState();
    const applied = applyWorkbookImport(target, imported, "all");
    expect(applied.errors).toBeUndefined();
    let persisted = "";
    saveState(target, {
      setItem: (_k, value) => {
        persisted = value;
      },
    });
    const restarted = loadState({ getItem: () => persisted });
    for (const key of [
      "earlyDepartureBalanceEnabled",
      "earlyDepartureMaxDifference",
      "afternoonRestBalanceEnabled",
      "afternoonRestMaxDifference",
    ] as const)
      expect(restarted.settings[key]).toBe(source.settings[key]);
    const result = await generateSchedule(restarted, "2026-11-06");
    expect(result.unfilledCount).toBe(0);
    expect(
      buildMonthlyRelaxedShiftStatistics(
        {
          ...restarted,
          assignments: result.assignments,
          activeScheduleDate: "2026-11-06",
        },
        "2026-11-06"
      ).currentAfternoonRest.map((p) => p.staffName)
    ).toEqual(["乙"]);
  });
  it("runs the same balance after the complete automatic pipeline and final safety", async () => {
    const state = fixture();
    state.settings.dailyPrimaryPositionUniqueEnabled = false;
    state.settings.positionRotationEnabled = false;
    state.settings.workloadBalanceEnabled = false;
    state.settings.minimumRegularTransitionMinutes = 0;
    state.positionRules = state.assignments.map((a) => ({
      id: a.positionRuleId!,
      flightNo: a.flightNo,
      name: a.id,
      category: "常规",
      remark: "",
      qualifiedStaffIds: ["p0", "p1"],
      manual: false,
      fatiguePoints: 1,
      minPassengers: 0,
      earlyReleaseMinutes: 0,
    }));
    const result = await generateSchedule(state, state.activeScheduleDate!);
    expect(result.unfilledCount).toBe(0);
    const report = buildMonthlyRelaxedShiftStatistics(
      { ...state, assignments: result.assignments },
      state.activeScheduleDate!
    );
    expect(report.currentEarlyDepartures.map((p) => p.staffName)).toEqual([
      "乙",
    ]);
    expect(report.currentAfternoonRest.map((p) => p.staffName)).toEqual(["乙"]);
    expect(result.safetyCredential).toBeDefined();
  });
  it("preserves the original when disabled, locked or rejected by final safety", () => {
    for (const mode of ["disabled", "locked", "unsafe"] as const) {
      const state = fixture();
      if (mode === "disabled") {
        state.settings.earlyDepartureBalanceEnabled = false;
        state.settings.afternoonRestBalanceEnabled = false;
      }
      let checked = 0;
      const result = balanceRelaxedShifts({
        state,
        date: state.activeScheduleDate!,
        assignments: state.assignments,
        lockedAssignmentIds: new Set(
          mode === "locked" ? state.assignments.map((a) => a.id) : []
        ),
        assertSafe: () => {
          checked++;
          throw new ScheduleGuardError([
            { ruleId: "staff-unavailable", message: "final safety rejects" },
          ]);
        },
      });
      expect(result).toEqual(state.assignments);
      if (mode === "unsafe") expect(checked).toBeGreaterThan(0);
    }
  });

  it("ignores target/future/other-month and partial history; keeps each setting independent", () => {
    const state = fixture();
    state.settings.earlyDepartureBalanceEnabled = false;
    state.history.push(
      ...state.history.map((row) => ({ ...row, date: "2026-12-02" })),
      ...state.history.map((row) => ({ ...row, date: "2026-11-08" })),
      ...state.history.map((row) => ({ ...row, date: "2026-11-06" })),
      ...state.history.map((row) => ({
        ...row,
        date: "2026-11-01",
        historyCoverage: "late-priority-only" as const,
      }))
    );
    const result = balanceRelaxedShifts({
      state,
      date: state.activeScheduleDate!,
      assignments: state.assignments,
      lockedAssignmentIds: new Set(),
      assertSafe: () => undefined,
    });
    const report = buildMonthlyRelaxedShiftStatistics(
      {
        ...state,
        history: state.history.filter(
          (r) =>
            r.date < state.activeScheduleDate! && r.date.startsWith("2026-11")
        ),
        assignments: result,
      },
      state.activeScheduleDate!
    );
    expect(report.currentAfternoonRest.map((p) => p.staffName)).toEqual(["乙"]);
    expect(
      report.rows.find((r) => r.staff.name === "甲")!.afternoonRestDates
    ).toHaveLength(2);
  });

  it("gives the next rest opportunity to the person at zero rather than two", () => {
    const state = fixture();
    const before = structuredClone(state);
    const result = balanceRelaxedShifts({
      state,
      date: state.activeScheduleDate!,
      assignments: state.assignments,
      lockedAssignmentIds: new Set(),
      assertSafe: () => undefined,
    });
    const report = buildMonthlyRelaxedShiftStatistics(
      { ...state, assignments: result },
      state.activeScheduleDate!
    );
    expect(report.currentEarlyDepartures.map((p) => p.staffName)).toEqual([
      "乙",
    ]);
    expect(report.currentAfternoonRest.map((p) => p.staffName)).toEqual(["乙"]);
    expect(state).toEqual(before);
    expect(result.filter((a) => a.status === "assigned")).toHaveLength(3);
  });
});
