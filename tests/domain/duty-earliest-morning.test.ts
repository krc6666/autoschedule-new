import { describe, expect, it } from "vitest";
import { generateSchedule } from "../helpers/generate-schedule";
import {
  dutyEarliestScenario,
  dutyEarliestAssignments,
  DUTY_EARLIEST_DATE as date,
} from "../helpers/duty-earliest-scenario";
import { reassignmentSafetyReasons } from "../../src/domain/reviews/rotation-review-safety";
import { createScheduleRunFacts } from "../../src/domain/shared/schedule-run-facts";
import { createScheduleLedger } from "../../src/domain/kernel/schedule-ledger";
import { createScheduleSafetySession } from "../../src/domain/kernel/schedule-safety-session";
import { runScheduleMutationPlan } from "../../src/domain/kernel/schedule-pipeline";
import {
  dutyMorningStart,
  dutyMorningRegressionReason,
} from "../../src/domain/assignments/duty-assignment";
import { analyzeManualSwap } from "../../src/domain/reviews/manual-swap-analysis";
import { buildScheduleFeedback } from "../../src/domain/feedback/schedule-feedback";

describe("duty earliest feasible morning", () => {
  it("selects the earliest morning while retaining late duty", async () => {
    const state = dutyEarliestScenario();
    const result = await generateSchedule(state, date);
    expect(result.unfilledCount).toBe(0);
    expect(
      result.assignments.find((a) => a.flightId === "early")?.staffId
    ).toBe("p0");
    expect(result.assignments.find((a) => a.flightId === "late")?.staffId).toBe(
      "p0"
    );
    expect(result.safetyCredential).toBeDefined();
  });

  it("lets a later cross-flight preference yield to earliest duty", async () => {
    const state = dutyEarliestScenario();
    state.settings.crossFlightPriorityPolicies = [
      { id: "later-first", flightNo: "BB102", staffIds: ["p0"], enabled: true },
    ];
    const result = await generateSchedule(state, date);
    expect(result.unfilledCount).toBe(0);
    expect(
      result.assignments.find((a) => a.flightId === "early")?.staffId
    ).toBe("p0");
  });

  it("can choose another counter in the earliest flight to keep all positions filled", async () => {
    const state = dutyEarliestScenario();
    state.positionRules[0]!.qualifiedStaffIds = ["p0", "p1"];
    state.positionRules.push({
      ...state.positionRules[0]!,
      id: "early-scarce",
      name: "G02",
      fatiguePoints: 3,
      qualifiedStaffIds: ["p0"],
    });
    const result = await generateSchedule(state, date);
    expect(result.unfilledCount).toBe(0);
    expect(
      result.assignments.find((a) => a.positionRuleId === "early-scarce")
        ?.staffId
    ).toBe("p0");
    expect(
      result.assignments.find((a) => a.positionRuleId === "r-early")?.staffId
    ).toBe("p1");
  });

  it("uses the next morning when the earliest has no qualified duty position", async () => {
    const state = dutyEarliestScenario();
    state.positionRules[0]!.qualifiedStaffIds = ["p1", "p2"];
    const result = await generateSchedule(state, date);
    expect(result.unfilledCount).toBe(0);
    expect(
      result.assignments.find((a) => a.flightId === "later")?.staffId
    ).toBe("p0");
  });

  it("keeps full coverage when another overlapping flight needs the duty worker exclusively", async () => {
    const state = dutyEarliestScenario();
    state.positionRules[1]!.qualifiedStaffIds = ["p0"];
    const result = await generateSchedule(state, date);
    expect(result.unfilledCount).toBe(0);
    expect(
      result.assignments.find((a) => a.flightId === "later")?.staffId
    ).toBe("p0");
  });

  it("keeps earliest duty ahead of ordinary fatigue preference", async () => {
    const state = dutyEarliestScenario();
    state.positionRules[0]!.fatiguePoints = 20;
    const result = await generateSchedule(state, date);
    expect(result.unfilledCount).toBe(0);
    expect(
      result.assignments.find((a) => a.flightId === "early")?.staffId
    ).toBe("p0");
  });

  it("retains earliest duty when ordinary priority rotation would prefer another person", async () => {
    const state = dutyEarliestScenario();
    state.settings.ordinaryPriorityPositions = [
      { airlineCode: "AA", position: "G01" },
    ];
    state.history = [
      {
        id: "previous-earliest",
        date: "2026-11-15",
        flightNo: "AA101",
        position: "G01",
        staffId: "p0",
        staffName: "员工0",
        startTime: "07:00",
        endTime: "10:00",
        workHours: 3,
        fatiguePoints: 1,
        remark: "",
      },
    ];
    const result = await generateSchedule(state, date);
    expect(result.unfilledCount).toBe(0);
    expect(
      result.assignments.find((row) => row.flightId === "early")?.staffId
    ).toBe("p0");
  });

  it("also selects earliest duty with more than six flights", async () => {
    const state = dutyEarliestScenario();
    for (let index = 0; index < 4; index++) {
      const flight = {
        ...state.flights[1]!,
        id: `extra-${index}`,
        flightNo: `EX10${index}`,
        startTime: `${10 + index}:00`,
        endTime: `${11 + index}:00`,
      };
      state.flights.push(flight);
      state.positionRules.push({
        ...state.positionRules[1]!,
        id: `r-${flight.id}`,
        flightNo: flight.flightNo,
      });
    }
    const result = await generateSchedule(state, date);
    expect(result.unfilledCount).toBe(0);
    expect(
      result.assignments.find((a) => a.flightId === "early")?.staffId
    ).toBe("p0");
    expect(result.assignments.find((a) => a.flightId === "late")?.staffId).toBe(
      "p0"
    );
  });

  it("permits no morning duty when no morning position is qualified", async () => {
    const state = dutyEarliestScenario();
    state.positionRules
      .slice(0, 2)
      .forEach((rule) => (rule.qualifiedStaffIds = ["p1", "p2"]));
    const result = await generateSchedule(state, date);
    expect(result.unfilledCount).toBe(0);
    expect(dutyMorningStart(state, result.assignments, "p0")).toBeNull();
    expect(result.warnings.join(" ")).toContain("没有落实12点前");
  });

  it("excludes dawn and noon using the configured night end and actual flight start", () => {
    const state = dutyEarliestScenario();
    const assignments = dutyEarliestAssignments(state);
    state.settings.nightEnd = "07:30";
    assignments[1]!.staffId = "p0";
    expect(dutyMorningStart(state, assignments, "p0")).toBe(480);
    state.flights[1]!.startTime = "12:00";
    expect(dutyMorningStart(state, assignments, "p0")).toBeNull();
    state.settings.nightEnd = "06:00";
    state.flights[0]!.startTime = "06:00";
    expect(dutyMorningStart(state, assignments, "p0")).toBe(360);
    assignments[0]!.workHours = 0;
    expect(dutyMorningStart(state, assignments, "p0")).toBeNull();
  });

  it("allows another counter at the same time and earlier work without freezing the person", () => {
    const state = dutyEarliestScenario();
    const original = dutyEarliestAssignments(state);
    const planned = structuredClone(original);
    planned[0]!.position = "G02";
    expect(
      dutyMorningRegressionReason(state, original, planned, "p0")
    ).toBeNull();
    state.flights[1]!.startTime = "06:30";
    planned[1]!.staffId = "p0";
    expect(
      dutyMorningRegressionReason(state, original, planned, "p0")
    ).toBeNull();
  });

  it("allows postponement only when it fills an existing vacancy without opening another", () => {
    const state = dutyEarliestScenario();
    const original = dutyEarliestAssignments(state);
    original[1]!.status = "unfilled";
    original[1]!.staffId = null;
    original[1]!.staffName = "";
    const planned = structuredClone(original);
    planned[0]!.staffId = "p1";
    planned[1]!.staffId = "p0";
    planned[1]!.status = "assigned";
    expect(
      dutyMorningRegressionReason(state, original, planned, "p0")
    ).toBeNull();
    planned[0]!.status = "unfilled";
    planned[0]!.staffId = null;
    expect(
      dutyMorningRegressionReason(state, original, planned, "p0")
    ).not.toBeNull();
  });

  it("keeps the existing manual swap permission", () => {
    const state = dutyEarliestScenario();
    state.assignments = dutyEarliestAssignments(state);
    const analysis = analyzeManualSwap(
      state,
      date,
      state.assignments[0]!.id,
      state.assignments[1]!.id
    );
    expect(analysis.outcome).not.toBe("blocked");
    expect(state.assignments[0]!.staffId).toBe("p0");
  });

  it("reports the actual earliest flight time from final rows, irrespective of row order", () => {
    const state = dutyEarliestScenario();
    state.assignments = dutyEarliestAssignments(state).reverse();
    state.assignments.find((row) => row.flightId === "later")!.staffId = "p0";
    const feedback = buildScheduleFeedback(state, date).find(
      (item) => item.key === "duty-roster"
    )!;
    expect(feedback.text).toContain("AA101/G01，实际最早上岗 07:00");
  });

  it("does not let an ordinary review postpone established morning work", () => {
    const state = dutyEarliestScenario();
    const assignments = dutyEarliestAssignments(state);
    const reasons = reassignmentSafetyReasons({
      kind: "plan",
      state,
      date,
      assignments,
      facts: createScheduleRunFacts(state, date),
      primaryAssignmentId: assignments[0]!.id,
      intent: { kind: "late-shift-recovery-review" },
      changes: [
        { assignmentId: assignments[0]!.id, staffId: "p1" },
        { assignmentId: assignments[1]!.id, staffId: "p0" },
      ],
    });
    expect(reasons).toContain("调整会推迟值班人员已落实的上午上岗时间");
  });

  it("rolls back a real pipeline mutation that moves the duty worker from 07:00 to 08:00", async () => {
    const state = dutyEarliestScenario();
    const assignments = dutyEarliestAssignments(state);
    const runFacts = createScheduleRunFacts(state, date);
    const ledger = createScheduleLedger(assignments, {
      safetySession: createScheduleSafetySession({
        phase: "partial",
        state,
        date,
        runFacts,
      }),
    });
    const warnings = await runScheduleMutationPlan(
      {
        state,
        date,
        ledger,
        runFacts,
        flights: state.flights,
        displayRulesByFlight: new Map(),
        lockedAssignmentIds: new Set(),
        solver: {
          solve: async () => {
            throw new Error("unused");
          },
        },
        finalizeMobileSupervisors: async () => undefined,
      },
      [
        {
          ruleId: "position-rotation",
          label: "轮岗",
          stage: "test-duty-postponement",
          executor: {
            kind: "post-schedule",
            id: "test-duty-postponement",
            pass: "primary",
            execute: async () => {
              const changed = structuredClone(assignments);
              changed[0]!.staffId = "p1";
              changed[0]!.staffName = state.staff[1]!.name;
              changed[1]!.staffId = "p0";
              changed[1]!.staffName = state.staff[0]!.name;
              return { assignments: changed, warnings: [] };
            },
          },
        },
      ]
    );
    expect(ledger.snapshot()[0]!.staffId).toBe("p0");
    expect(warnings.join(" ")).toContain("推迟值班人员");
  });
});
