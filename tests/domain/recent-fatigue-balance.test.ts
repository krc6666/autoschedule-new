import { describe, expect, it } from "vitest";
import {
  recentFatigueScenario,
  denseRecentFatigueScenario,
  fatigueAssignments,
  RECENT_FATIGUE_DATE as date,
} from "../helpers/recent-fatigue-scenario";
import {
  workloadBalanceLoadSnapshots,
  evaluateWorkloadBalance,
  preservesWorkloadBalance,
  workloadBalancePriority,
  analyzeWorkloadPressure,
} from "../../src/domain/reviews/workload-balance";
import { buildDailyScheduleModel } from "../../src/domain/kernel/daily-schedule-model";
import { prepareSchedule } from "../../src/domain/kernel/schedule-preparation";
import { evaluateAutomaticHardConstraints } from "../../src/domain/rules/built-in-rule-registry";
import { reassignmentSafetyReasons } from "../../src/domain/reviews/rotation-review-safety";
import { generateSchedule } from "../helpers/generate-schedule";
import { buildScheduleFeedback } from "../../src/domain/feedback/schedule-feedback";
import {
  currentScheduleHistory,
  replaceHistoryForDate,
} from "../../src/app/history-actions";
import { analyzeManualSwap } from "../../src/domain/reviews/manual-swap-analysis";

describe("supplemental recent fatigue balance", () => {
  it("retains the daily target in small-day candidate selection while catching up", () => {
    const state = recentFatigueScenario();
    const priority = workloadBalancePriority(
      state.staff[1]!,
      fatigueAssignments(state, [6, 10]),
      state,
      1,
      4,
      null,
      date,
      analyzeWorkloadPressure(state)
    );
    expect(priority.todayFatigueExcess).toBe(4);
  });
  it("uses actual saved points, retaining zero and excluding current/future/out-of-window records", () => {
    const state = recentFatigueScenario();
    const base = state.history[0]!;
    state.history.push(
      {
        ...base,
        id: "zero",
        date: "2026-11-06",
        fatiguePoints: 0,
        workHours: 9,
      },
      { ...base, id: "boundary", date: "2026-10-31", fatiguePoints: 2 },
      { ...base, id: "old", date: "2026-10-30", fatiguePoints: 99 },
      { ...base, id: "same", date, fatiguePoints: 99 },
      { ...base, id: "future", date: "2026-11-08", fatiguePoints: 99 }
    );
    state.settings.consecutiveDayPenalty = 100;
    const loads = workloadBalanceLoadSnapshots(
      state,
      fatigueAssignments(state, [6, 10]),
      date,
      null
    );
    expect(loads.map((p) => p.recentFatigue)).toEqual([12, 6]);
    expect(
      evaluateWorkloadBalance(
        state,
        date,
        fatigueAssignments(state, [6, 10]),
        null
      ).recentFatigueDifference
    ).toBe(2);
  });

  it("adds a real cumulative points objective even for fewer than four flights", () => {
    const state = recentFatigueScenario();
    const preparation = prepareSchedule(
      state,
      date,
      evaluateAutomaticHardConstraints
    );
    const model = buildDailyScheduleModel({
      state,
      date,
      preparation,
      timeoutMs: 10000,
    })!;
    expect(
      model.problem.objectives.find(
        (o) => o.id === "candidate:workload-balance:recent-fatigue-spread"
      )
    ).toBeDefined();
    state.settings.workloadBalanceEnabled = false;
    const disabled = buildDailyScheduleModel({
      state,
      date,
      preparation: prepareSchedule(
        state,
        date,
        evaluateAutomaticHardConstraints
      ),
      timeoutMs: 10000,
    })!;
    expect(
      disabled.problem.objectives.some((o) => o.id.includes("recent-fatigue"))
    ).toBe(false);
  });

  it("rejects a later comfort review that reverses a balanced pair", () => {
    const state = recentFatigueScenario();
    const before = fatigueAssignments(state, [6, 10]);
    const after = fatigueAssignments(state, [10, 6]);
    const reasons = reassignmentSafetyReasons({
      kind: "plan",
      state,
      date,
      assignments: before,
      changes: after.map((a) => ({ assignmentId: a.id, staffId: a.staffId! })),
      primaryAssignmentId: before[0]!.id,
      intent: { kind: "staff-work-continuity-review" },
    });
    expect(reasons).toContain("调整会扩大工时或疲劳差");
  });

  it("balances final actual points across consecutive archived workdays", async () => {
    const state = recentFatigueScenario();
    const actual: number[][] = [];
    for (const day of [date, "2026-11-09", "2026-11-11"]) {
      state.activeScheduleDate = day;
      const result = await generateSchedule(state, day);
      expect(result.unfilledCount).toBe(0);
      expect(result.safetyCredential).toBeDefined();
      state.assignments = result.assignments;
      const totals = state.staff.map((p) =>
        result.assignments
          .filter((a) => a.staffId === p.id)
          .reduce((sum, a) => sum + a.fatiguePoints, 0)
      );
      actual.push(totals);
      expect([...totals].sort((a, b) => a - b)).toEqual([6, 10]);
      replaceHistoryForDate(state, day, currentScheduleHistory(state, day));
    }
    expect(actual[0]).toEqual([6, 10]);
    expect(actual[2]).toEqual(actual[1]!.map((n) => (n === 6 ? 10 : 6)));
  });

  it("uses the daily target budget for catch-up instead of forcing today's exact equality", async () => {
    const state = denseRecentFatigueScenario();
    const result = await generateSchedule(state, date);
    expect(
      result.unfilledCount,
      JSON.stringify(result.assignments.filter((a) => a.status === "unfilled"))
    ).toBe(0);
    const points = state.staff.map((p) =>
      result.assignments
        .filter((a) => a.staffId === p.id)
        .reduce((sum, a) => sum + a.fatiguePoints, 0)
    );
    expect(points).toEqual([4, 8]);
    const model = buildDailyScheduleModel({
      state,
      date,
      preparation: prepareSchedule(
        state,
        date,
        evaluateAutomaticHardConstraints
      ),
      timeoutMs: 10000,
    })!;
    const ids = model.problem.objectives.map((o) => o.id);
    expect(
      ids.indexOf("candidate:workload-balance:today-fatigue-excess")
    ).toBeLessThan(
      ids.indexOf("candidate:workload-balance:recent-fatigue-spread")
    );
    expect(
      ids.indexOf("candidate:workload-balance:recent-fatigue-spread")
    ).toBeLessThan(
      ids.indexOf("candidate:workload-balance:today-fatigue-spread")
    );
    // Real same-flight swap improves the recent ledger, spending only the daily budget.
    const balanced = structuredClone(result.assignments);
    const firstFlight = balanced.filter((a) => a.flightId === "f0");
    for (const a of firstFlight) {
      a.staffId = a.staffId === "p0" ? "p1" : "p0";
      a.staffName = state.staff.find((p) => p.id === a.staffId)!.name;
    }
    expect(
      preservesWorkloadBalance(state, date, balanced, result.assignments, null)
    ).toBe(true);
    expect(
      preservesWorkloadBalance(state, date, result.assignments, balanced, null)
    ).toBe(false);
  });

  it("keeps daily overload protection when catching up on a small day", async () => {
    const state = denseRecentFatigueScenario();
    state.flights = state.flights.slice(0, 2);
    state.positionRules = state.positionRules.slice(0, 4);
    state.history[0]!.fatiguePoints = 30;
    state.history[1]!.fatiguePoints = 0;
    state.positionRules.forEach((rule, index) => {
      rule.fatiguePoints = index % 2 ? 5 : 1;
    });
    const result = await generateSchedule(state, date);
    expect(
      result.unfilledCount,
      JSON.stringify(result.assignments.filter((a) => a.status === "unfilled"))
    ).toBe(0);
    const points = state.staff.map((p) =>
      result.assignments
        .filter((a) => a.staffId === p.id)
        .reduce((sum, a) => sum + a.fatiguePoints, 0)
    );
    expect(points).toEqual([6, 6]);
  });

  it("shows the actual window and final cumulative difference after manual changes", () => {
    const state = recentFatigueScenario();
    state.assignments = fatigueAssignments(state, [6, 10]);
    const feedback = () =>
      buildScheduleFeedback(state, date).find((f) => f.key === "fatigue");
    expect(JSON.stringify(feedback())).toContain("近期累计疲劳差 0.0 点");
    state.assignments = fatigueAssignments(state, [10, 6]);
    expect(JSON.stringify(feedback())).toContain("近期累计疲劳差 8.0 点");
  });

  it("keeps recent fatigue as an overridable tradeoff for manual swaps", () => {
    const state = recentFatigueScenario();
    state.assignments = fatigueAssignments(state, [6, 10]);
    const analysis = analyzeManualSwap(state, date, "a0", "a1");
    expect(analysis.outcome).toBe("soft-tradeoff");
    expect(analysis.blockers).toEqual([]);
    expect(analysis.tradeoffs).toContain("调整会扩大工时或疲劳差");
  });

  it("keeps qualification and coverage ahead of recent points", async () => {
    const state = recentFatigueScenario();
    state.positionRules[1]!.qualifiedStaffIds = ["p0"];
    const result = await generateSchedule(state, date);
    expect(result.unfilledCount).toBe(0);
    expect(
      result.assignments.find((a) => a.positionRuleId === "r1")?.staffId
    ).toBe("p0");
    expect(result.safetyCredential).toBeDefined();
  });
});
