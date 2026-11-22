import { expect, it, vi } from "vitest";
import {
  lateAirlineScenario,
  LATE_AIRLINE_DATE,
} from "../helpers/late-airline-scenario";
import {
  improveStaffAirlineMix,
  staffAirlineMix,
} from "../../src/domain/reviews/staff-airline-mix";
import { createScheduleRunFacts } from "../../src/domain/shared/schedule-run-facts";
import { defaultHighsSolver } from "../../src/infrastructure/solver/highs-solver";
import type { Assignment } from "../../src/model";
import {
  staffLateAirlineRotation,
  preservesLateAirlineRotation,
} from "../../src/domain/reviews/late-airline-rotation";
import { buildScheduleFeedback } from "../../src/domain/feedback/schedule-feedback";
import { builtInRulePreferences } from "../../src/domain/rules/built-in-rule-registry";
import { ScheduleGuardError } from "../../src/domain/kernel/schedule-guard";
import { generateSchedule } from "../helpers/generate-schedule";
import { createScheduleSafetySession } from "../../src/domain/kernel/schedule-safety-session";
import {
  preservesStaffWorkContinuity,
  staffWorkContinuity,
} from "../../src/domain/reviews/staff-work-continuity";

const flightsFor = (rows: readonly Assignment[], id: string) =>
  rows
    .filter((a) => a.staffId === id)
    .map((a) => a.flightNo)
    .sort();
async function review(
  state = lateAirlineScenario(),
  lockedAssignmentIds = new Set<string>()
) {
  return improveStaffAirlineMix({
    state,
    date: LATE_AIRLINE_DATE,
    assignments: state.assignments,
    solver: defaultHighsSolver,
    facts: createScheduleRunFacts(state, LATE_AIRLINE_DATE),
    lockedAssignmentIds,
    assertSafe: () => {},
  });
}

it("changes morning and late duties together to achieve CX+AK and FD+TR, without moving repetition to another person", async () => {
  const state = lateAirlineScenario();
  const before = structuredClone(state.assignments);
  const result = await review(state);
  expect(flightsFor(result, "peer-a")).toEqual(["AK103", "CX102"]);
  expect(flightsFor(result, "peer-b")).toEqual(["FD101", "TR104"]);
  expect(staffAirlineMix(state, result).every((p) => !p.policyIds.length)).toBe(
    true
  );
  expect(state.assignments).toEqual(before);
});

it("lets the FD+AK preference yield for late rotation when all morning work is FD", async () => {
  const state = lateAirlineScenario(true);
  const result = await review(state);
  expect(flightsFor(result, "peer-a")).toContain("AK103");
  expect(flightsFor(result, "peer-b")).toContain("TR104");
  expect(result.every((a) => a.status === "assigned" && a.staffId)).toBe(true);
});

it("uses any legal outside morning airline, not a fixed CX exception", async () => {
  const state = lateAirlineScenario();
  state.flights[1]!.flightNo = "KE102";
  state.positionRules[1]!.flightNo = "KE102";
  state.assignments[1]!.flightNo = "KE102";
  expect(flightsFor(await review(state), "peer-a")).toEqual(["AK103", "KE102"]);
});

it("keeps occupied posts and locked workers when rotation is not safe", async () => {
  const state = lateAirlineScenario();
  const result = await review(
    state,
    new Set(state.assignments.map((a) => a.id))
  );
  expect(result.map((a) => [a.id, a.staffId])).toEqual(
    state.assignments.map((a) => [a.id, a.staffId])
  );
});

it("repairs FD+AK by changing the morning duty while keeping the already alternating AK", async () => {
  const state = lateAirlineScenario();
  const a = state.staff[0]!,
    b = state.staff[1]!;
  Object.assign(state.assignments[2]!, { staffId: a.id, staffName: a.name });
  Object.assign(state.assignments[3]!, { staffId: b.id, staffName: b.name });
  const result = await review(state);
  expect(flightsFor(result, a.id)).toEqual(["AK103", "CX102"]);
  expect(flightsFor(result, b.id)).toEqual(["FD101", "TR104"]);
  expect(
    staffLateAirlineRotation(state, result, LATE_AIRLINE_DATE).every(
      (p) => !p.repeatedAirlines.length
    )
  ).toBe(true);
});

it("can disable late rotation independently and keeps the old mix rule", async () => {
  const state = lateAirlineScenario();
  state.settings.lateAirlineRotationEnabled = false;
  const result = await review(state);
  expect(flightsFor(result, "peer-a")).toEqual(["FD101", "TR104"]);
  expect(staffLateAirlineRotation(state, result, LATE_AIRLINE_DATE)).toEqual(
    []
  );
  state.settings.airlineMixPolicies = [];
  expect(
    builtInRulePreferences(state.settings).find(
      (r) => r.id === "staff-airline-mix"
    )?.enabled
  ).toBe(false);
  state.settings.lateAirlineRotationEnabled = true;
  expect(
    builtInRulePreferences(state.settings).find(
      (r) => r.id === "staff-airline-mix"
    )?.enabled
  ).toBe(true);
  expect(flightsFor(await review(state), "peer-a")).toContain("AK103");
});

it.each([
  "no-history",
  "partial-latest",
  "no-late-scope",
  "not-late",
  "same-day",
  "absent-last-workday",
])("does not invent a previous late duty: %s", async (kind) => {
  const state = lateAirlineScenario();
  if (kind === "no-history") state.history = [];
  if (kind === "partial-latest")
    state.history.push({
      ...state.history[0]!,
      id: "partial",
      date: "2026-11-13",
      historyCoverage: "late-priority-only",
    });
  if (kind === "no-late-scope") state.settings.latePriorityFlightNumbers = [];
  if (kind === "not-late") state.settings.lateShiftEndTime = "23:59";
  if (kind === "same-day")
    state.history.forEach((r) => (r.date = LATE_AIRLINE_DATE));
  if (kind === "absent-last-workday")
    state.history.push({
      ...state.history[0]!,
      id: "different-staff-last-workday",
      staffId: "someone-else",
      date: "2026-11-13",
    });
  expect(
    staffLateAirlineRotation(state, state.assignments, LATE_AIRLINE_DATE).every(
      (p) => !p.repeatedAirlines.length
    )
  ).toBe(true);
  expect(flightsFor(await review(state), "peer-a")).toEqual(["FD101", "TR104"]);
});

it("counts same-flight multiple jobs once and uses actual late-duty duration across midnight", () => {
  const state = lateAirlineScenario();
  state.assignments.push({
    ...state.assignments[3]!,
    id: "second-job",
    flightNo: " tr 104 ",
    workHours: 0,
  });
  const row = staffLateAirlineRotation(
    state,
    state.assignments,
    LATE_AIRLINE_DATE
  ).find((p) => p.staffId === "peer-a")!;
  expect(row.currentAirlines).toEqual(["TR"]);
  expect(row.flightNumbers).toEqual(["TR104"]);
  state.assignments
    .filter((a) => a.flightNo === "TR104")
    .forEach((a) => (a.endTime = "00:10"));
  expect(
    staffLateAirlineRotation(state, state.assignments, LATE_AIRLINE_DATE)[0]!
      .repeatedAirlines
  ).toEqual(["TR"]);
  state.staff[0]!.status = "休假";
  expect(
    staffLateAirlineRotation(state, state.assignments, LATE_AIRLINE_DATE).some(
      (p) => p.staffId === "peer-a"
    )
  ).toBe(false);
});

it("cannot transfer a repeated airline to a person whose late duty was already alternating", async () => {
  const state = lateAirlineScenario();
  state.history
    .filter((r) => r.staffId === "peer-b" && r.flightNo === "AK103")
    .forEach((r) => (r.flightNo = "TR104"));
  const before = staffLateAirlineRotation(
    state,
    state.assignments,
    LATE_AIRLINE_DATE
  );
  const result = await review(state);
  expect(
    preservesLateAirlineRotation(
      before,
      staffLateAirlineRotation(state, result, LATE_AIRLINE_DATE)
    )
  ).toBe(true);
  expect(result.find((r) => r.flightNo === "TR104")?.staffId).toBe("peer-a");
});

it("respects qualification and a final safety refusal without clearing work", async () => {
  for (const guard of [false, true]) {
    const state = lateAirlineScenario();
    if (!guard)
      state.positionRules.forEach(
        (r) =>
          (r.qualifiedStaffIds = [
            state.assignments.find((a) => a.positionRuleId === r.id)!.staffId!,
          ])
      );
    const safe = vi.fn(() => {
      if (guard) throw new ScheduleGuardError([]);
    });
    const result = await improveStaffAirlineMix({
      state,
      date: LATE_AIRLINE_DATE,
      assignments: state.assignments,
      solver: defaultHighsSolver,
      facts: createScheduleRunFacts(state, LATE_AIRLINE_DATE),
      lockedAssignmentIds: new Set(),
      assertSafe: safe,
    });
    expect(result.map((a) => [a.id, a.staffId])).toEqual(
      state.assignments.map((a) => [a.id, a.staffId])
    );
    expect(result.every((a) => a.status === "assigned")).toBe(true);
    if (guard) expect(safe).toHaveBeenCalled();
  }
});

it("retains work and explains finite search timeout", async () => {
  const state = lateAirlineScenario();
  const solver = {
    solve: vi.fn(async () => ({
      termination: "timed-out" as const,
      selectedVariableIds: new Set<string>(),
      objectiveValues: new Map<string, number>(),
      diagnostic: "测试轮换计算超时",
    })),
  };
  const result = await improveStaffAirlineMix({
    state,
    date: LATE_AIRLINE_DATE,
    assignments: state.assignments,
    solver,
    facts: createScheduleRunFacts(state, LATE_AIRLINE_DATE),
    lockedAssignmentIds: new Set(),
    assertSafe: () => {},
  });
  expect(result.map((a) => a.staffId)).toEqual(
    state.assignments.map((a) => a.staffId)
  );
  expect(
    result[0]!.decisionTrace?.some((d) =>
      d.message.includes("测试轮换计算超时")
    )
  ).toBe(true);
  expect(solver.solve.mock.calls.length).toBeLessThanOrEqual(4);
});

it("reports final facts including a manual change back to repeated AK or TR", async () => {
  const state = lateAirlineScenario();
  const result = await review(state);
  let feedback = buildScheduleFeedback(
    { ...state, assignments: result },
    LATE_AIRLINE_DATE
  ).find((f) => f.key === "staff-airline-mix")!;
  expect(feedback.evidence).toContain("未发现与上一完整工作班重复");
  feedback = buildScheduleFeedback(state, LATE_AIRLINE_DATE).find(
    (f) => f.key === "staff-airline-mix"
  )!;
  expect(feedback.level).toBe("attention");
  expect(feedback.evidence).toContain("末班航司仍有连续");
});

it("runs the rule in the actual kernel without weakening final schedule safety", async () => {
  const state = lateAirlineScenario();
  const result = await generateSchedule(state, LATE_AIRLINE_DATE);
  expect(
    result.assignments.filter((a) => a.status === "assigned")
  ).toHaveLength(4);
  expect(
    staffLateAirlineRotation(
      state,
      result.assignments,
      LATE_AIRLINE_DATE
    ).every((p) => !p.repeatedAirlines.length)
  ).toBe(true);
  expect(
    staffAirlineMix(state, result.assignments).every((p) => !p.policyIds.length)
  ).toBe(true);
  const safety = createScheduleSafetySession({
    state,
    date: LATE_AIRLINE_DATE,
    phase: "final",
    runFacts: createScheduleRunFacts(state, LATE_AIRLINE_DATE),
  });
  expect(() => safety.assertAssignmentsSafe(result.assignments)).not.toThrow();
  expect(result.safetyCredential).toBeDefined();
});

it("does not trade away established late priority frequency fairness for carrier alternation", async () => {
  const state = lateAirlineScenario();
  state.positionRules[2]!.remark = "一号";
  state.assignments[2]!.remark = "一号";
  const pastAk = state.history.find((r) => r.flightNo === "AK103")!;
  for (const date of ["2026-11-02", "2026-11-04", "2026-11-06"]) {
    state.history.push({
      ...pastAk,
      id: `frequent-${date}`,
      date,
      staffId: "peer-a",
      staffName: "peer-a",
      remark: "一号",
    });
  }
  const result = await review(state);
  expect(result.find((a) => a.flightNo === "AK103")?.staffId).toBe("peer-b");
  expect(result.every((a) => a.status === "assigned")).toBe(true);
});

it("uses an actual three-person qualification cycle rather than requiring a direct two-person swap", async () => {
  const state = lateAirlineScenario();
  const third = { ...state.staff[0]!, id: "peer-c", name: "peer-c" };
  state.staff.push(third);
  const morning = { ...state.flights[1]!, id: "ke-morning", flightNo: "KE105" };
  const late = { ...state.flights[3]!, id: "tw-late", flightNo: "TW106" };
  state.flights.push(morning, late);
  for (const [flight, index] of [
    [morning, 4],
    [late, 5],
  ] as const) {
    const rule = {
      ...state.positionRules[0]!,
      id: `rule-${index}`,
      flightNo: flight.flightNo,
      name: `G${10 + index}`,
      qualifiedStaffIds: state.staff.map((p) => p.id),
    };
    state.positionRules.push(rule);
    state.assignments.push({
      ...state.assignments[0]!,
      id: `row-${index}`,
      flightId: flight.id,
      flightNo: flight.flightNo,
      positionRuleId: rule.id,
      position: rule.name,
      startTime: flight.startTime,
      endTime: flight.endTime,
      staffId: third.id,
      staffName: third.name,
    });
  }
  state.settings.latePriorityFlightNumbers.push("TW106");
  // TR A->C, AK B->A, TW C->B; no pair has the reverse qualification.
  state.positionRules[3]!.qualifiedStaffIds = ["peer-a", "peer-c"];
  state.positionRules[2]!.qualifiedStaffIds = ["peer-b", "peer-a"];
  state.positionRules[5]!.qualifiedStaffIds = ["peer-c", "peer-b"];
  state.history = state.assignments.map((a) => ({
    id: `past-${a.id}`,
    date: "2026-11-12",
    flightNo: a.flightNo,
    position: a.position,
    staffId: a.staffId!,
    staffName: a.staffName,
    startTime: a.startTime,
    endTime: a.endTime,
    workHours: a.workHours,
    fatiguePoints: a.fatiguePoints,
    remark: a.remark,
  }));
  const result = await review(state);
  expect(result.find((a) => a.flightNo === "TR104")?.staffId).toBe("peer-c");
  expect(result.find((a) => a.flightNo === "AK103")?.staffId).toBe("peer-a");
  expect(result.find((a) => a.flightNo === "TW106")?.staffId).toBe("peer-b");
  expect(result).toHaveLength(6);
  for (const p of state.staff)
    expect(new Set(flightsFor(result, p.id)).size).toBe(2);
});

it("still rotates an early-released late-flight job and uses the archived cutoff rather than today's template", () => {
  const state = lateAirlineScenario();
  const row = state.assignments.find((a) => a.flightNo === "TR104")!;
  row.startTime = "21:00";
  row.endTime = "21:30";
  const history = state.history.find((r) => r.flightNo === "TR104")!;
  history.startTime = "21:00";
  history.endTime = "21:30";
  history.flightCutoffTime = "23:00";
  expect(
    staffLateAirlineRotation(state, state.assignments, LATE_AIRLINE_DATE)[0]!
      .repeatedAirlines
  ).toEqual(["TR"]);
  state.flights.find((f) => f.flightNo === "TR104")!.endTime = "21:30";
  state.flights.find((f) => f.flightNo === "TR104")!.startTime = "21:00";
  const fact = staffLateAirlineRotation(
    state,
    state.assignments,
    LATE_AIRLINE_DATE
  )[0]!;
  expect(fact.previousAirlines).toEqual(["TR"]);
  expect(fact.currentAirlines).toEqual([]);
});

it.each(["already-alternating", "repeated", "only-fd-morning"] as const)(
  "uses the real unequal CX/FD and AK/TR times instead of freezing individual attendance spans: %s",
  async (kind) => {
    const state = lateAirlineScenario(kind === "only-fd-morning");
    const periods: Record<string, [string, string]> = {
      FD101: ["09:40", "11:40"],
      FD102: ["09:40", "11:40"],
      CX102: ["08:30", "10:30"],
      AK103: ["21:05", "23:05"],
      TR104: ["21:55", "23:55"],
    };
    for (const row of [
      ...state.flights,
      ...state.assignments,
      ...state.history,
    ]) {
      const [startTime, endTime] = periods[row.flightNo]!;
      Object.assign(row, { startTime, endTime });
    }
    if (kind === "already-alternating") {
      Object.assign(state.assignments[2]!, {
        staffId: "peer-a",
        staffName: "peer-a",
      });
      Object.assign(state.assignments[3]!, {
        staffId: "peer-b",
        staffName: "peer-b",
      });
    }
    const result = await review(state);
    expect(result.find((a) => a.flightNo === "AK103")?.staffId).toBe("peer-a");
    expect(result.find((a) => a.flightNo === "TR104")?.staffId).toBe("peer-b");
    if (kind !== "only-fd-morning") {
      expect(flightsFor(result, "peer-a")).toEqual(["AK103", "CX102"]);
      expect(flightsFor(result, "peer-b")).toEqual(["FD101", "TR104"]);
    }
    expect(result.every((a) => a.status === "assigned")).toBe(true);
  }
);

it("permits sharing existing longer days but refuses worse team gaps, spans or an additional split day", () => {
  const state = lateAirlineScenario();
  const before = staffWorkContinuity(state, state.assignments, null);
  const rows = structuredClone(state.assignments);
  for (const row of rows) {
    const id =
      row.flightNo === "AK103" || row.flightNo === "CX102"
        ? "peer-a"
        : "peer-b";
    row.staffId = id;
    row.staffName = id;
  }
  const after = staffWorkContinuity(state, rows, null);
  expect(preservesStaffWorkContinuity(before, after)).toBe(false);
  expect(preservesStaffWorkContinuity(before, after, true)).toBe(true);
  const worsened = structuredClone(rows);
  worsened.find((a) => a.flightNo === "CX102")!.startTime = "07:00";
  expect(
    preservesStaffWorkContinuity(
      before,
      staffWorkContinuity(state, worsened, null),
      true
    )
  ).toBe(false);
  const extraSplit = after.map((fact, i) => ({
    ...fact,
    split: i === 0 ? true : fact.split,
  }));
  expect(preservesStaffWorkContinuity(before, extraSplit, true)).toBe(false);
});
