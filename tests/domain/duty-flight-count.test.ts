import { describe, it, expect } from "vitest";
import {
  dutyFlightCountScenario,
  DUTY_COUNT_DATE,
} from "../helpers/duty-flight-count-scenario";
import { generateSchedule } from "../helpers/generate-schedule";
import { prepareSchedule } from "../../src/domain/kernel/schedule-preparation";
import { buildDailyScheduleModel } from "../../src/domain/kernel/daily-schedule-model";
import { evaluateAutomaticHardConstraints } from "../../src/domain/rules/built-in-rule-registry";
import { reassignmentSafetyReasons } from "../../src/domain/reviews/rotation-review-safety";
import { createScheduleRunFacts } from "../../src/domain/shared/schedule-run-facts";
import { dutyFlightCountStatus } from "../../src/domain/assignments/duty-flight-count";
import { buildScheduleFeedback } from "../../src/domain/feedback/schedule-feedback";

// Independent count from final rows, not from the new policy/model helper.
function count(
  rows: readonly { staffId: string | null; flightNo: string; status: string }[],
  id: string
) {
  return new Set(
    rows
      .filter((r) => r.status === "assigned" && r.staffId === id)
      .map((r) => r.flightNo.trim().toUpperCase())
  ).size;
}

describe("duty afternoon flight count floor", () => {
  it("keeps the daily hours limit when afternoon catch-up would exceed it", async () => {
    const { state } = dutyFlightCountScenario();
    state.settings.maxDailyHours = 4;
    state.flights.find((f) => f.flightNo === "TEST0")!.endTime = "10:00";
    state.flights.find((f) => f.flightNo === "TEST3")!.endTime = "23:00";
    state.positionRules = state.positionRules.filter(
      (r) => !["TEST0", "TEST3"].includes(r.flightNo) || r.name === "G10"
    );
    for (const rule of state.positionRules.filter((r) =>
      ["TEST0", "TEST3"].includes(r.flightNo)
    ))
      rule.qualifiedStaffIds = ["duty"];
    for (const [index, startTime, endTime] of [
      [4, "14:00", "15:00"],
      [5, "18:00", "19:00"],
    ] as const) {
      state.flights.push({
        ...state.flights[1]!,
        id: `flight-${index}`,
        flightNo: `TEST${index}`,
        startTime,
        endTime,
      });
      state.positionRules.push(
        ...state.positionRules
          .filter((r) => r.flightNo === "TEST1")
          .map((r, j) => ({
            ...r,
            id: `flight-${index}-rule-${j}`,
            flightNo: `TEST${index}`,
          }))
      );
    }
    const result = await generateSchedule(state, DUTY_COUNT_DATE);
    expect(count(result.assignments, "duty")).toBe(2);
    expect(result.unfilledCount).toBe(0);
    expect(
      Math.max(
        ...state.staff
          .filter((p) => p.id !== "duty")
          .map((p) => count(result.assignments, p.id))
      )
    ).toBe(4);
    for (const person of state.staff)
      expect(
        result.assignments
          .filter((r) => r.staffId === person.id)
          .reduce((sum, r) => sum + r.workHours, 0)
      ).toBeLessThanOrEqual(4);
    const feedback = buildScheduleFeedback(
      { ...state, assignments: result.assignments },
      DUTY_COUNT_DATE
    ).find((f) => f.key === "duty-roster")!;
    expect(feedback.evidence).toContain("工时");
  });
  it("does not add an extra morning flight to make up the count", async () => {
    const { state } = dutyFlightCountScenario();
    state.flights.find((f) => f.flightNo === "TEST1")!.startTime = "10:00";
    state.flights.find((f) => f.flightNo === "TEST1")!.endTime = "11:00";
    // The preferred morning target moves to TEST1. TEST0 must be coverable
    // by the three peers, otherwise coverage itself requires a second morning.
    state.positionRules = state.positionRules.filter(
      (r) => r.id !== "flight-0-rule-0"
    );
    for (const rule of state.positionRules.filter(
      (r) => r.flightNo === "TEST2"
    ))
      rule.qualifiedStaffIds = rule.qualifiedStaffIds.filter(
        (id) => id !== "duty"
      );
    const result = await generateSchedule(state, DUTY_COUNT_DATE);
    expect(count(result.assignments, "duty")).toBe(2);
    expect(result.unfilledCount).toBe(0);
    expect(
      result.assignments.some(
        (r) => r.staffId === "duty" && r.flightNo === "TEST0"
      )
    ).toBe(false);
  });
  it("retains duty relief when the gap is already one", async () => {
    const { state } = dutyFlightCountScenario();
    state.flights = state.flights.filter((f) => f.flightNo !== "TEST2");
    state.positionRules = state.positionRules.filter(
      (r) => r.flightNo !== "TEST2"
    );
    const result = await generateSchedule(state, DUTY_COUNT_DATE);
    expect(count(result.assignments, "duty")).toBe(2);
    expect(result.unfilledCount).toBe(0);
  });
  it.each(["qualification", "time"])(
    "keeps the valid schedule and explains %s when afternoon catch-up is impossible",
    async (why) => {
      const { state } = dutyFlightCountScenario();
      if (why === "time") {
        state.flights.find((f) => f.flightNo === "TEST2")!.endTime = "22:00";
        state.settings.dutyPositionPriorities[0]!.flightNo = "TEST2";
        state.positionRules = state.positionRules.filter(
          (r) => r.id !== "flight-3-rule-0"
        );
        for (const r of state.positionRules.filter(
          (r) => r.flightNo === "TEST2" && r.name !== "G10"
        )) {
          r.earlyReleaseMinutes = 300;
          r.category = "分流";
        }
        for (const r of state.positionRules.filter(
          (r) => r.flightNo === "TEST1"
        ))
          r.qualifiedStaffIds = r.qualifiedStaffIds.filter(
            (id) => id !== "duty"
          );
      } else
        for (const rule of state.positionRules.filter((r) =>
          ["TEST1", "TEST2"].includes(r.flightNo)
        ))
          rule.qualifiedStaffIds = rule.qualifiedStaffIds.filter(
            (id) => id !== "duty"
          );
      const result = await generateSchedule(state, DUTY_COUNT_DATE);
      expect(count(result.assignments, "duty")).toBe(2);
      expect(result.unfilledCount).toBe(0);
      state.assignments = result.assignments;
      const feedback = buildScheduleFeedback(state, DUTY_COUNT_DATE).find(
        (f) => f.key === "duty-roster"
      )!;
      expect(feedback.level).toBe("attention");
      expect(feedback.evidence).toContain("还需补1个下午航班");
      expect(feedback.evidence).toContain(why === "time" ? "冲突" : "资质");
    }
  );
  it("uses distinct flights and excludes exempt peers from the maximum", () => {
    const { state, rows } = dutyFlightCountScenario();
    state.staff.find((p) => p.id === "peer-c")!.teamLeader = true;
    const entries = rows.filter(
      (r) => r.staffId !== "peer-b" || ["TEST0", "TEST3"].includes(r.flightNo)
    );
    entries.push({
      ...entries.find((r) => r.staffId === "duty")!,
      id: "duplicate",
      flightNo: " test0 ",
    });
    const result = dutyFlightCountStatus(state, entries, {
      dutyStaffId: "duty",
      halfRestStaffIds: new Set(["peer-a"]),
    });
    expect(result).toMatchObject({ maximum: 2, dutyCount: 2, shortfall: 0 });
    expect(
      dutyFlightCountStatus(state, entries, { dutyStaffId: null }).applicable
    ).toBe(false);
  });
  it.each([0, 2])(
    "adds an afternoon flight before duty relief for %s extra flights",
    async (extra) => {
      const { state } = dutyFlightCountScenario(extra);
      const result = await generateSchedule(state, DUTY_COUNT_DATE);
      const maximum = Math.max(
        ...state.staff
          .filter((p) => p.id !== "duty")
          .map((p) => count(result.assignments, p.id))
      );
      expect(maximum - count(result.assignments, "duty")).toBeLessThanOrEqual(
        1
      );
      expect(count(result.assignments, "duty")).toBe(3);
      expect(result.unfilledCount).toBe(0);
      expect(
        result.assignments.some(
          (r) => r.staffId === "duty" && r.flightNo === "TEST0"
        )
      ).toBe(true);
      expect(
        result.assignments.find((r) => r.positionRuleId === "flight-3-rule-0")
          ?.staffId
      ).toBe("duty");
      expect(
        result.assignments.some(
          (r) => r.staffId === "duty" && ["TEST1", "TEST2"].includes(r.flightNo)
        )
      ).toBe(true);
    }
  );
  it("places the count target before duty rest without imposing an unconditional hard difference", () => {
    const { state } = dutyFlightCountScenario();
    const preparation = prepareSchedule(
      state,
      DUTY_COUNT_DATE,
      evaluateAutomaticHardConstraints
    );
    const model = buildDailyScheduleModel({
      state,
      date: DUTY_COUNT_DATE,
      preparation,
      timeoutMs: 10000,
    })!;
    const ids = model.problem.objectives.map((o) => o.id);
    expect(ids).toContain("duty-position:flight-count-shortfall");
    expect(ids.indexOf("duty-position:flight-count-shortfall")).toBeLessThan(
      ids.indexOf("duty:between-target-rest")
    );
  });
  it("rejects a later rotation that takes away the afternoon remedy", () => {
    const { state, rows } = dutyFlightCountScenario();
    const row = rows.find(
      (r) => r.flightNo === "TEST1" && r.staffId === "peer-a"
    )!;
    row.staffId = "duty";
    row.staffName = "duty";
    state.assignments = rows;
    const reasons = reassignmentSafetyReasons({
      kind: "plan",
      state,
      assignments: rows,
      date: DUTY_COUNT_DATE,
      primaryAssignmentId: row.id,
      changes: [{ assignmentId: row.id, staffId: "peer-a" }],
      facts: createScheduleRunFacts(state, DUTY_COUNT_DATE),
      intent: { kind: "late-shift-recovery-review" },
    });
    expect(
      reasons.some((r) => r.includes("值班") && r.includes("航班数"))
    ).toBe(true);
    const manualReasons = reassignmentSafetyReasons({
      kind: "plan",
      state,
      assignments: rows,
      date: DUTY_COUNT_DATE,
      primaryAssignmentId: row.id,
      changes: [{ assignmentId: row.id, staffId: "peer-a" }],
      facts: createScheduleRunFacts(state, DUTY_COUNT_DATE),
      intent: { kind: "manual-swap-analysis" },
    });
    expect(
      manualReasons.some((r) => r.includes("值班") && r.includes("航班数"))
    ).toBe(false);
  });
  it("does not let a later recovery add morning work just to reduce the count gap", () => {
    const { state, rows } = dutyFlightCountScenario();
    const flight = state.flights.find((f) => f.flightNo === "TEST1")!;
    flight.startTime = "10:00";
    flight.endTime = "11:00";
    for (const row of rows.filter((r) => r.flightNo === "TEST1")) {
      row.startTime = flight.startTime;
      row.endTime = flight.endTime;
    }
    state.assignments = rows;
    const row = rows.find(
      (r) => r.flightNo === "TEST1" && r.staffId === "peer-a"
    )!;
    const reasons = reassignmentSafetyReasons({
      kind: "plan",
      state,
      assignments: rows,
      date: DUTY_COUNT_DATE,
      primaryAssignmentId: row.id,
      changes: [{ assignmentId: row.id, staffId: "duty" }],
      facts: createScheduleRunFacts(state, DUTY_COUNT_DATE),
      intent: { kind: "late-shift-recovery-review" },
    });
    expect(reasons).toContain("调整会增加值班人员的额外航班、重点岗位或疲劳");
  });
});
