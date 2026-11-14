import { expect, it, vi } from "vitest";
import {
  BUILT_IN_RULE_REGISTRY,
  builtInRulePreferences,
} from "../../src/domain/rules/built-in-rule-registry";
import { createScheduleRunFacts } from "../../src/domain/shared/schedule-run-facts";
import { defaultHighsSolver } from "../../src/infrastructure/solver/highs-solver";
import {
  airlineMixScenario,
  AIRLINE_MIX_DATE,
} from "../helpers/airline-mix-scenario";
import {
  staffAirlineMix,
  improveStaffAirlineMix,
} from "../../src/domain/reviews/staff-airline-mix";
import { staffWorkContinuity } from "../../src/domain/reviews/staff-work-continuity";
import { buildScheduleFeedback } from "../../src/domain/feedback/schedule-feedback";
import { ScheduleGuardError } from "../../src/domain/kernel/schedule-guard";
import { optimizeReassignment } from "../../src/domain/solver/reassignment-optimizer";
import type { Assignment } from "../../src/model";

const assignedPeople = (rows: readonly Assignment[]) =>
  rows.map((a) => [a.id, a.staffId, a.status, a.startTime, a.endTime]);
function reviewContext(state = airlineMixScenario()) {
  return {
    state,
    date: AIRLINE_MIX_DATE,
    assignments: state.assignments,
    lockedAssignmentIds: new Set<string>(),
    solver: defaultHighsSolver,
    facts: createScheduleRunFacts(state, AIRLINE_MIX_DATE),
    assertSafe: (_rows: readonly Assignment[]) => undefined,
  };
}

export async function finalAirlineMix(
  state = airlineMixScenario(),
  lockedAssignmentIds = new Set<string>()
) {
  const hook = BUILT_IN_RULE_REGISTRY.executionPlan(
    builtInRulePreferences(state.settings)
  ).find((h) => h.id === "staff-airline-mix");
  const executor = hook?.execute.find((e) => e.kind === "final-review");
  return executor?.kind === "final-review"
    ? await executor.execute({
        state,
        date: AIRLINE_MIX_DATE,
        assignments: state.assignments,
        lockedAssignmentIds,
        solver: defaultHighsSolver,
        facts: createScheduleRunFacts(state, AIRLINE_MIX_DATE),
        assertSafe: () => undefined,
      })
    : state.assignments;
}

it("mixes FD/AK-only work with outside carriers without adding flights or transferring the combination", async () => {
  const state = airlineMixScenario();
  const result = await finalAirlineMix(state);
  for (const p of state.staff) {
    const flights = new Set(
      result.filter((a) => a.staffId === p.id).map((a) => a.flightNo)
    );
    expect(flights.size).toBe(2);
    expect([...flights].some((f) => !/^(FD|AK)/.test(f))).toBe(true);
  }
  expect(state.assignments[1]!.staffId).toBe("peer-a");
  expect(result.every((a) => a.status === "assigned")).toBe(true);
});

it("registers the final mix review after work continuity", () => {
  const ids = BUILT_IN_RULE_REGISTRY.executionPlan()
    .filter((h) => h.execute.some((e) => e.kind === "final-review"))
    .map((h) => h.id);
  expect(ids.slice(-2)).toEqual(["staff-work-continuity", "staff-airline-mix"]);
});

it("allows the combination if the day only contains those carriers", async () => {
  const state = airlineMixScenario();
  state.flights = state.flights.slice(0, 2);
  state.assignments = state.assignments.slice(0, 2);
  expect(await finalAirlineMix(state)).toEqual(state.assignments);
  const feedback = buildScheduleFeedback(state, AIRLINE_MIX_DATE).find(
    (f) => f.key === "staff-airline-mix"
  )!;
  expect(feedback.level).toBe("ok");
  expect(feedback.evidence).toContain("不适用");
});

it.each([
  { policies: [] },
  {
    policies: [{ id: "disabled", enabled: false, airlineCodes: ["FD", "AK"] }],
  },
  { policies: [{ id: "draft", enabled: true, airlineCodes: ["FD"] }] },
])(
  "does not enforce empty, disabled or incomplete preferences %j",
  async ({ policies }) => {
    const state = airlineMixScenario();
    state.settings.airlineMixPolicies = policies;
    expect(await finalAirlineMix(state)).toEqual(state.assignments);
  }
);

it("applies an edited three-carrier group with a non-CX/TR outside carrier", async () => {
  const state = airlineMixScenario();
  state.settings.airlineMixPolicies = [
    { id: "custom", enabled: true, airlineCodes: ["FD", "AK", "CX"] },
  ];
  state.flights[2]!.flightNo = "KE103";
  state.assignments[2]!.flightNo = "KE103";
  state.positionRules[2]!.flightNo = "KE103";
  const result = await finalAirlineMix(state);
  expect(result.find((a) => a.flightNo === "KE103")!.staffId).toBe("peer-a");
  expect(staffAirlineMix(state, result).every((p) => !p.policyIds.length)).toBe(
    true
  );
});

it("does not resolve FD/AK by creating another configured group or moving it to someone else", async () => {
  const state = airlineMixScenario();
  state.settings.airlineMixPolicies.push(
    { id: "cx-fd", enabled: true, airlineCodes: ["FD", "CX"] },
    { id: "fd-tr", enabled: true, airlineCodes: ["FD", "TR"] }
  );
  const result = await finalAirlineMix(state);
  const before = staffAirlineMix(state, state.assignments);
  for (const p of staffAirlineMix(state, result))
    expect(
      p.policyIds.every((id) =>
        before.find((b) => b.staffId === p.staffId)!.policyIds.includes(id)
      )
    ).toBe(true);
});

it("counts one normalized flight once, includes zero-hour work, and ignores administrative staff", () => {
  const state = airlineMixScenario();
  state.assignments[1]!.workHours = 0;
  state.assignments.push({
    ...state.assignments[0]!,
    id: "duplicate",
    flightNo: " fd 101 ",
  });
  expect(staffAirlineMix(state, state.assignments)[0]).toMatchObject({
    flightNumbers: ["FD101", "AK102"],
    policyIds: ["airline-mix-fd-ak"],
  });
  state.staff[0]!.staffType = "行政支援";
  expect(
    staffAirlineMix(state, state.assignments).some(
      (p) => p.staffId === "peer-a"
    )
  ).toBe(false);
});

it("does not add a second task for a single-flight worker or use an unselected outside template", async () => {
  const state = airlineMixScenario();
  state.assignments = [state.assignments[0]!];
  expect(staffAirlineMix(state, state.assignments)[0]!.policyIds).toEqual([]);
  expect(await finalAirlineMix(state)).toEqual(state.assignments);
});

it.each(["locked", "qualification", "manual", "linked"])(
  "retains original workers when %s prevents a complete exchange",
  async (reason) => {
    const state = airlineMixScenario();
    const locked = new Set<string>();
    if (reason === "locked") state.assignments.forEach((a) => locked.add(a.id));
    if (reason === "qualification")
      state.positionRules.forEach((r, i) => {
        r.qualifiedStaffIds = [state.assignments[i]!.staffId!];
      });
    if (reason === "manual")
      state.positionRules.forEach((r) => {
        r.manual = true;
      });
    if (reason === "linked")
      state.assignments.forEach((a) => {
        a.supervisorSourceAssignmentId = "protected-source";
      });
    const result = await finalAirlineMix(state, locked);
    expect(assignedPeople(result)).toEqual(assignedPeople(state.assignments));
    const feedback = buildScheduleFeedback(
      { ...state, assignments: result },
      AIRLINE_MIX_DATE
    ).find((f) => f.key === "staff-airline-mix")!;
    expect(feedback.level).toBe("attention");
    expect(feedback.evidence).toContain("允许保留原搭配");
  }
);

it("preserves individual attendance and monthly rest opportunities with default switches enabled", async () => {
  const state = airlineMixScenario();
  state.settings.earlyDepartureBalanceEnabled = true;
  state.settings.afternoonRestBalanceEnabled = true;
  const before = staffWorkContinuity(state, state.assignments, null);
  const result = await finalAirlineMix(state);
  expect(staffAirlineMix(state, result).every((p) => !p.policyIds.length)).toBe(
    true
  );
  for (const p of staffWorkContinuity(state, result, null)) {
    const old = before.find((b) => b.staffId === p.staffId)!;
    expect(p.spanMinutes).toBeLessThanOrEqual(old.spanMinutes);
    expect(p.maximumGapMinutes).toBeLessThanOrEqual(old.maximumGapMinutes);
    expect(p.split && !old.split).toBe(false);
  }
});

it("rejects an otherwise qualified mix that would lengthen an ordinary worker's day", async () => {
  const state = airlineMixScenario();
  state.flights[2]!.startTime = "20:00";
  state.flights[2]!.endTime = "22:00";
  state.assignments[2]!.startTime = "20:00";
  state.assignments[2]!.endTime = "22:00";
  const result = await finalAirlineMix(state);
  expect(assignedPeople(result)).toEqual(assignedPeople(state.assignments));
});

it("keeps complete original work on timeout and records the actual fallback", async () => {
  const context = reviewContext();
  const solve = vi.fn(async () => ({
    termination: "timed-out" as const,
    selectedVariableIds: new Set<string>(),
    objectiveValues: new Map<string, number>(),
    diagnostic: "测试求解达到时限",
  }));
  const result = await improveStaffAirlineMix({
    ...context,
    solver: { solve },
  });
  expect(assignedPeople(result)).toEqual(assignedPeople(context.assignments));
  expect(solve.mock.calls.length).toBeLessThanOrEqual(2);
  expect(
    result[0]!.decisionTrace?.some((d) =>
      d.message.includes("测试求解达到时限")
    )
  ).toBe(true);
});

it("does not adopt any proposal rejected by the final safety guard", async () => {
  const context = reviewContext();
  const assertSafe = vi.fn(() => {
    throw new ScheduleGuardError([]);
  });
  const result = await improveStaffAirlineMix({ ...context, assertSafe });
  expect(assertSafe).toHaveBeenCalled();
  expect(assignedPeople(result)).toEqual(assignedPeople(context.assignments));
});

it("repairs a legal mixed result after a real recovery reassigner creates an FD/AK-only day", async () => {
  const state = airlineMixScenario();
  const mixed = await finalAirlineMix(state);
  expect(staffAirlineMix(state, mixed).every((p) => !p.policyIds.length)).toBe(
    true
  );
  const primary = mixed.find((a) => a.flightNo === "AK102")!;
  const recovery = await optimizeReassignment({
    solver: defaultHighsSolver,
    state,
    date: AIRLINE_MIX_DATE,
    assignments: mixed,
    primary,
    movableAssignments: mixed,
    facts: createScheduleRunFacts(state, AIRLINE_MIX_DATE),
    intent: { kind: "late-shift-recovery-review" },
    primaryCandidateAllowed: (p) => p.id === "peer-a",
    candidateAllowed: (a, p) =>
      a.flightNo.startsWith("FD") || a.flightNo.startsWith("AK")
        ? p.id === "peer-a"
        : p.id === "peer-b",
    preserveStaffAssignmentCounts: true,
    maxParticipants: 5,
  });
  expect(recovery.changes).not.toBeNull();
  const changes = new Map(
    recovery.changes!.map((c) => [c.assignmentId, c.staffId])
  );
  state.assignments = mixed.map((a) => ({
    ...a,
    staffId: changes.get(a.id) ?? a.staffId,
  }));
  expect(staffAirlineMix(state, state.assignments)[0]!.policyIds).toContain(
    "airline-mix-fd-ak"
  );
  const result = await finalAirlineMix(state);
  expect(staffAirlineMix(state, result).every((p) => !p.policyIds.length)).toBe(
    true
  );
});

it("checks six flights and twelve staff without increasing anyone's flight count", async () => {
  const state = airlineMixScenario();
  state.staff = Array.from({ length: 12 }, (_, i) => ({
    ...state.staff[0]!,
    id: `peer-${i}`,
    name: `peer-${i}`,
  }));
  state.flights = Array.from({ length: 6 }, (_, i) => ({
    ...state.flights[i % 4]!,
    id: `flight-${i}`,
    flightNo: ["FD101", "AK102", "CX103", "TR104", "KE105", "FD106"][i]!,
  }));
  Object.assign(state.flights[4]!, { startTime: "19:00", endTime: "20:00" });
  Object.assign(state.flights[5]!, { startTime: "21:00", endTime: "22:00" });
  state.positionRules = state.flights.map((f, i) => ({
    ...state.positionRules[0]!,
    id: `rule-${i}`,
    flightNo: f.flightNo,
    qualifiedStaffIds: state.staff.map((p) => p.id),
  }));
  state.assignments = state.flights.map((f, i) => ({
    ...state.assignments[i % 4]!,
    id: `row-${i}`,
    flightId: f.id,
    flightNo: f.flightNo,
    positionRuleId: `rule-${i}`,
    startTime: f.startTime,
    endTime: f.endTime,
    staffId: i < 2 ? "peer-0" : "peer-1",
    staffName: i < 2 ? "peer-0" : "peer-1",
  }));
  const result = await finalAirlineMix(state);
  expect(staffAirlineMix(state, result)[0]!.policyIds).toEqual([]);
  expect(result).toHaveLength(6);
  for (const p of state.staff)
    expect(
      new Set(result.filter((a) => a.staffId === p.id).map((a) => a.flightNo))
        .size
    ).toBe(
      new Set(
        state.assignments
          .filter((a) => a.staffId === p.id)
          .map((a) => a.flightNo)
      ).size
    );
});
