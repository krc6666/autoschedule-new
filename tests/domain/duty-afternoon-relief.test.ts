import { describe, expect, it } from "vitest";
import {
  dutyFlightCountScenario,
  DUTY_COUNT_DATE,
} from "../helpers/duty-flight-count-scenario";
import { generateSchedule } from "../helpers/generate-schedule";
import { reassignmentSafetyReasons } from "../../src/domain/reviews/rotation-review-safety";
import { createScheduleRunFacts } from "../../src/domain/shared/schedule-run-facts";
import { buildScheduleFeedback } from "../../src/domain/feedback/schedule-feedback";
import {
  isDutyAfternoonFlight,
  dutyAfternoonFlightIds,
} from "../../src/domain/assignments/duty-afternoon-relief";
import { prepareSchedule } from "../../src/domain/kernel/schedule-preparation";
import { evaluateAutomaticHardConstraints } from "../../src/domain/rules/built-in-rule-registry";
import { buildDailyScheduleModel } from "../../src/domain/kernel/daily-schedule-model";
import { buildMonthlyRelaxedShiftStatistics } from "../../src/domain/statistics/relaxed-shift-statistics";
import { fillConfiguredSupervisorTargets } from "../../src/domain/assignments/supervisor-fill";

describe("duty afternoon relief by flight start", () => {
  it("prefers other safe people when final configured-supervisor repair fills a regular counter", () => {
    const { state, rows } = dutyFlightCountScenario();
    const target = rows.find(
      (a) => a.flightNo === "TEST1" && a.staffId === "peer-a"
    )!;
    target.staffId = null;
    target.staffName = "";
    target.status = "unfilled";
    const source = rows.find(
      (a) => a.flightNo === "TEST1" && a.staffId === "peer-c"
    )!;
    source.position = "督导";
    const rule = state.positionRules.find(
      (r) => r.id === source.positionRuleId
    )!;
    rule.name = "督导";
    rule.category = "机动督导";
    state.settings.mobileSupervisorFillRules = [
      {
        id: "afternoon-fill",
        enabled: true,
        sourceFlightNo: "TEST1",
        sourcePositionKeyword: "督导",
        targetFlightNo: "TEST1",
        targetPositionKeyword: target.position,
        allowAutomatic: true,
        allowManual: true,
      },
    ];
    fillConfiguredSupervisorTargets(state, rows, source, "automatic", {
      dutyStaffId: "duty",
      regularOnly: true,
      validateRegularAssignments: () => true,
    });
    expect(target.staffId).toBe("peer-a");
  });
  it.each([0, 2])(
    "keeps afternoon free rather than catching up a 4/2 gap (%s extra flights)",
    async (extra) => {
      const { state } = dutyFlightCountScenario(extra);
      const result = await generateSchedule(state, DUTY_COUNT_DATE);
      const own = result.assignments.filter((a) => a.staffId === "duty");
      expect(result.unfilledCount).toBe(0);
      expect(new Set(own.map((a) => a.flightNo))).toEqual(
        new Set(["TEST0", "TEST3"])
      );
      const feedback = buildScheduleFeedback(
        { ...state, assignments: result.assignments },
        DUTY_COUNT_DATE
      ).find((f) => f.key === "duty-roster")!;
      expect(feedback.evidence).toContain("12:00—18:00");
      expect(feedback.evidence).toContain("下午避排优先");
      expect(feedback.evidence).not.toContain("还需补1个下午航班");
    }
  );

  it.each([
    ["17:30", true],
    ["17:55", true],
    ["18:00", false],
  ])(
    "links a 17:55 flight to afternoon end %s (catch-up %s)",
    async (end, expected) => {
      const { state } = dutyFlightCountScenario();
      state.settings.afternoonRestEndTime = end;
      const flight = state.flights.find((f) => f.flightNo === "TEST2")!;
      flight.flightNo = "CX931";
      flight.startTime = "17:55";
      flight.endTime = "19:55";
      for (const r of state.positionRules) {
        if (r.flightNo === "TEST2") r.flightNo = "CX931";
        if (r.flightNo === "TEST1")
          r.qualifiedStaffIds = r.qualifiedStaffIds.filter(
            (id) => id !== "duty"
          );
      }
      const result = await generateSchedule(state, DUTY_COUNT_DATE);
      expect(result.unfilledCount).toBe(0);
      expect(
        result.assignments.some(
          (a) => a.staffId === "duty" && a.flightNo === "CX931"
        )
      ).toBe(expected);
    }
  );

  it("uses duty in the afternoon when qualification shortage would otherwise leave a vacancy", async () => {
    const { state } = dutyFlightCountScenario();
    const target = state.positionRules.find((r) => r.flightNo === "TEST1")!;
    target.qualifiedStaffIds = ["duty"];
    const result = await generateSchedule(state, DUTY_COUNT_DATE);
    expect(result.unfilledCount).toBe(0);
    expect(
      result.assignments.find((a) => a.positionRuleId === target.id)?.staffId
    ).toBe("duty");
    expect(
      result.assignments.find((a) => a.positionRuleId === "flight-3-rule-0")
        ?.staffId
    ).toBe("duty");
    expect(
      result.assignments.some(
        (a) => a.staffId === "duty" && a.flightNo === "TEST0"
      )
    ).toBe(true);
  });

  it("uses the flight start, allowing a flight that starts before afternoon and runs into it", async () => {
    const { state } = dutyFlightCountScenario();
    state.settings.afternoonRestStartTime = "13:00";
    state.flights.find((f) => f.flightNo === "TEST1")!.endTime = "14:00";
    for (const rule of state.positionRules.filter(
      (r) => r.flightNo === "TEST2"
    ))
      rule.qualifiedStaffIds = rule.qualifiedStaffIds.filter(
        (id) => id !== "duty"
      );
    const result = await generateSchedule(state, DUTY_COUNT_DATE);
    expect(result.unfilledCount).toBe(0);
    expect(
      result.assignments.some(
        (a) => a.staffId === "duty" && a.flightNo === "TEST1"
      )
    ).toBe(true);
    // Attendance still uses actual overlap, so this is not an afternoon rest day.
    const statistics = buildMonthlyRelaxedShiftStatistics(
      {
        ...state,
        assignments: result.assignments,
        activeScheduleDate: DUTY_COUNT_DATE,
      },
      DUTY_COUNT_DATE
    );
    expect(
      statistics.currentAfternoonRest.some((p) => p.staffId === "duty")
    ).toBe(false);
  });

  it("prefers an available non-duty supervisor during final mobile-supervisor coverage", async () => {
    const { state } = dutyFlightCountScenario();
    state.positionRules = state.positionRules.filter(
      (r) => r.id !== "flight-1-rule-2"
    );
    for (const rule of state.positionRules.filter(
      (r) => r.flightNo === "TEST1"
    ))
      rule.qualifiedStaffIds = ["peer-b", "peer-c"];
    state.positionRules.push({
      ...state.positionRules[0]!,
      id: "afternoon-supervisor",
      flightNo: "TEST1",
      name: "督导",
      category: "机动督导",
      qualifiedStaffIds: ["duty", "peer-a"],
    });
    const result = await generateSchedule(state, DUTY_COUNT_DATE);
    expect(result.unfilledCount).toBe(0);
    expect(
      result.assignments.find(
        (a) => a.positionRuleId === "afternoon-supervisor"
      )?.staffId
    ).toBe("peer-a");
    expect(
      result.assignments
        .filter((a) => a.staffId === "duty")
        .map((a) => a.flightNo)
    ).not.toContain("TEST1");
  });

  it("keeps the afternoon objective even with no ordinary flight-count participants", () => {
    const { state } = dutyFlightCountScenario();
    for (const p of state.staff) if (p.id !== "duty") p.teamLeader = true;
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
    expect(
      model.problem.objectives.some(
        (o) => o.id === "duty-position:avoid-afternoon" && o.terms.length > 0
      )
    ).toBe(true);
    expect(
      model.problem.objectives.some(
        (o) => o.id === "duty-position:flight-count-shortfall"
      )
    ).toBe(false);
  });

  it.each([
    ["12:00", "18:00", "12:00", true],
    ["12:00", "18:00", "18:00", false],
    ["22:00", "02:00", "23:55", true],
    ["22:00", "02:00", "00:30", true],
    ["22:00", "02:00", "02:00", false],
    ["22:00", "02:00", "21:55", false],
  ])(
    "classifies start %s—%s / %s as afternoon %s",
    (from, until, startTime, expected) => {
      expect(
        isDutyAfternoonFlight(
          { startTime },
          { afternoonRestStartTime: from, afternoonRestEndTime: until }
        )
      ).toBe(expected);
    }
  );

  it("reads the actual flight start rather than an assignment start or duplicated reuse rows", () => {
    const { state, rows } = dutyFlightCountScenario();
    const row = rows.find((a) => a.flightNo === "TEST1")!;
    row.staffId = "duty";
    row.startTime = "11:00";
    rows.push({ ...row, id: "guide-reuse", workHours: 0 });
    expect([...dutyAfternoonFlightIds(state, rows, "duty")]).toEqual([
      row.flightId,
    ]);
    state.flights.find((f) => f.id === row.flightId)!.startTime = "18:00";
    row.startTime = "15:00";
    expect(dutyAfternoonFlightIds(state, rows, "duty").size).toBe(0);
  });

  it("allows coverage to use duty for an actual afternoon vacancy", () => {
    const { state, rows } = dutyFlightCountScenario();
    const row = rows.find(
      (a) => a.flightNo === "TEST1" && a.staffId === "peer-a"
    )!;
    row.staffId = null;
    row.staffName = "";
    row.status = "unfilled";
    const reasons = reassignmentSafetyReasons({
      kind: "plan",
      state,
      assignments: rows,
      date: DUTY_COUNT_DATE,
      primaryAssignmentId: row.id,
      changes: [{ assignmentId: row.id, staffId: "duty" }],
      facts: createScheduleRunFacts(state, DUTY_COUNT_DATE),
      intent: {
        kind: "team-leader-gap-fill",
        crossWorkdayReservation: "preserve",
      },
    });
    expect(reasons).toEqual([]);
  });

  it("rejects later recovery adding afternoon work merely to improve the count", () => {
    const { state, rows } = dutyFlightCountScenario();
    const row = rows.find(
      (a) => a.flightNo === "TEST1" && a.staffId === "peer-a"
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
    expect(reasons).toContain(
      "调整会增加值班人员的下午航班，下午避排优先于航班数补差"
    );
    const manualReasons = reassignmentSafetyReasons({
      kind: "plan",
      state,
      assignments: rows,
      date: DUTY_COUNT_DATE,
      primaryAssignmentId: row.id,
      changes: [{ assignmentId: row.id, staffId: "duty" }],
      facts: createScheduleRunFacts(state, DUTY_COUNT_DATE),
      intent: { kind: "manual-swap-analysis" },
    });
    expect(manualReasons).toEqual([]);
  });

  it("allows later recovery to release afternoon duty work even if the old count gap grows", () => {
    const { state, rows } = dutyFlightCountScenario();
    const row = rows.find(
      (a) => a.flightNo === "TEST1" && a.staffId === "peer-a"
    )!;
    row.staffId = "duty";
    row.staffName = "duty";
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
    expect(reasons).toEqual([]);
  });
});
