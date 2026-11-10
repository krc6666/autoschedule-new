// Local diagnostic probe: mirrors the reported qualification warning without changing product behavior.
import { describe, expect, it } from "vitest";
import { createDefaultState } from "../../src/defaults";
import { makeUnfilled } from "../../src/domain/flights/schedule-position-rules";
import { assignStaff } from "../../src/app/schedule-actions";
import {
  currentScheduleHistory,
  buildHistoricalScheduleDraft,
} from "../../src/app/history-actions";
import { buildOrdinaryPriorityStatistics } from "../../src/domain/statistics/ordinary-priority-statistics";
import { buildMonthlyLatePriorityStatistics } from "../../src/domain/statistics/monthly-late-priority-statistics";
import { buildMonthlyRelaxedShiftStatistics } from "../../src/domain/statistics/relaxed-shift-statistics";
import { buildDailyStaffFlightStatistics } from "../../src/domain/statistics/daily-staff-flight-statistics";

const DATE = "2026-10-29";

describe("qualification warning statistics diagnostic", () => {
  it.each(["current", "history", "history-edit"])(
    "counts actual unqualified H05 work in %s",
    (source) => {
      const state = createDefaultState();
      const person = {
        ...state.staff[0]!,
        id: "probe-person",
        name: "测试人员",
        status: "正常" as const,
        staffType: "常规" as const,
        dutyQualified: false,
        nightShift: true,
      };
      state.staff = [person];
      const rule = state.positionRules.find(
        (r) => r.flightNo === "TR121" && r.name === "H05"
      )!;
      rule.qualifiedStaffIds = [];
      state.positionRules = [rule];
      const flight = state.flights.find((f) => f.flightNo === "TR121")!;
      flight.positions = ["H05"];
      state.flights = [flight];
      state.templates = [{ ...flight }];
      state.settings.ordinaryPriorityPositions = [
        { airlineCode: "TR", position: "H05" },
      ];
      state.settings.latePriorityFlightNumbers = ["TR121"];
      state.settings.dutyFatiguePoints = 0;
      state.activeScheduleDate = DATE;
      state.history = [];
      state.assignments = [makeUnfilled(flight, rule.name, rule)];
      const assignment = state.assignments[0]!;
      const result = assignStaff(state, assignment.id, person.id);
      expect(result.changed).toBe(true);
      expect(
        assignment.manualOverrideWarnings?.some(
          (w) => w.code === "position-qualification"
        )
      ).toBe(true);
      const date = DATE;
      if (source !== "current") {
        state.history = currentScheduleHistory(state, date);
        state.assignments = [];
        state.activeScheduleDate = null;
      }
      if (source === "history-edit") {
        const draft = buildHistoricalScheduleDraft(state, date);
        expect(draft.warnings).toEqual([]);
        state.flights = draft.flights;
        state.assignments = draft.assignments;
        state.activeScheduleDate = date;
      }
      const ordinary = buildOrdinaryPriorityStatistics(state, date).find(
        (r) => r.staff.id === person.id
      )!;
      const late = buildMonthlyLatePriorityStatistics(state, date).rows.find(
        (r) => r.staff.id === person.id
      )!;
      const relaxed = buildMonthlyRelaxedShiftStatistics(state, date).rows.find(
        (r) => r.staff.id === person.id
      )!;
      const flights = buildDailyStaffFlightStatistics(state, date).rows.find(
        (r) => r.staffId === person.id
      )!;
      expect(ordinary.qualified).toBe(false);
      expect(ordinary.effectiveCount).toBe(1);
      expect(late.categories.送资料.qualified).toBe(false);
      expect(late.categories.送资料.effectiveCount).toBe(1);
      expect(relaxed.afternoonRestDates).toEqual([]); // Only a late flight exists that day.
      expect(relaxed.earlyDepartures).toHaveLength(0); // TR121 ends after 23:00.
      expect(flights.flightCount).toBe(1);
      expect(
        buildOrdinaryPriorityStatistics(state, "2026-11-03")[0]!.effectiveCount
      ).toBe(0);
      expect(
        buildMonthlyLatePriorityStatistics(state, "2026-11-03").rows
      ).toEqual([]);
      console.log(
        JSON.stringify({
          source,
          qualificationWarning: true,
          ordinary: ordinary.effectiveCount,
          delivery: late.categories.送资料.effectiveCount,
          afternoonRest: relaxed.afternoonRestDates.length,
          earlyDeparture: relaxed.earlyDepartures.length,
          flightCount: flights.flightCount,
        })
      );
      // A morning-only day counts early departure, without inventing an afternoon flight.
      flight.startTime = "08:00";
      flight.endTime = "10:00";
      state.flights.forEach((f) => {
        f.startTime = "08:00";
        f.endTime = "10:00";
      });
      state.assignments.forEach((a) => {
        a.startTime = "08:00";
        a.endTime = "10:00";
      });
      state.history.forEach((r) => {
        r.startTime = "08:00";
        r.endTime = "10:00";
        r.flightCutoffTime = "10:00";
      });
      const morning = buildMonthlyRelaxedShiftStatistics(state, date).rows.find(
        (r) => r.staff.id === person.id
      )!;
      expect(morning.earlyDepartures).toHaveLength(1);
      expect(morning.afternoonRestDates).toEqual([]);
      console.log(
        JSON.stringify({
          source,
          morningUnqualified: true,
          earlyDeparture: morning.earlyDepartures.length,
          afternoonRest: morning.afternoonRestDates.length,
        })
      );
    }
  );
});
