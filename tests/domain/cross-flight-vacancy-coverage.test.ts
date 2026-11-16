import { describe, expect, it } from "vitest";
import type { Assignment, PositionRule } from "../../src/model";
import {
  vacancyScenario,
  occupiedSnapshot,
} from "../helpers/cross-flight-vacancy-scenario";
import { generateSchedule } from "../helpers/generate-schedule";
import { crossFlightPriorityReassignmentReasons } from "../../src/domain/rules/cross-flight-priority";
import { fillAutomaticVacancies } from "../../src/domain/coverage/automatic-vacancy-coverage";
import { prepareSchedule } from "../../src/domain/kernel/schedule-preparation";
import { evaluateAutomaticHardConstraints } from "../../src/domain/rules/built-in-rule-registry";
import { createScheduleSafetySession } from "../../src/domain/kernel/schedule-safety-session";
import { assertDailyScheduleSafety } from "../../src/domain/kernel/daily-schedule-safety";
import { defaultHighsSolver } from "../../src/infrastructure/solver/highs-solver";

const DATE = "2026-11-18";

describe("cross-flight vacancy coverage", () => {
  it("fills an overlapping vacancy before retaining the configured priority person", async () => {
    const state = vacancyScenario();
    const result = await generateSchedule(state, DATE);
    expect(result.assignments.filter((a) => a.status === "unfilled")).toEqual(
      []
    );
    expect(result.assignments.find((a) => a.position === "G12")?.staffId).toBe(
      "bridge"
    );
    expect(result.assignments.find((a) => a.position === "H07")?.staffId).toBe(
      "replacement"
    );
  });

  it("uses a configured same-flight supervisor fill to complete an overlapping flight", async () => {
    const state = vacancyScenario(true);
    const result = await generateSchedule(state, DATE);
    expect(result.assignments.filter((a) => a.status === "unfilled")).toEqual(
      []
    );
    const source = result.assignments.find((a) => a.position === "督导")!;
    const target = result.assignments.find((a) => a.position === "H05")!;
    expect(target.staffId).toBe(source.staffId);
    expect(target.supervisorSourceAssignmentId).toBe(source.id);
    expect(target.supervisorFillRuleId).toBe("configured-fill");
    expect(target.workHours).toBe(0);
    expect(target.fatiguePoints).toBe(0);
    expect(result.assignments.find((a) => a.position === "G12")?.staffId).toBe(
      "bridge"
    );
  });

  it("lets priority yield to a net vacancy repair but refuses relocating the vacancy", () => {
    const state = vacancyScenario();
    const original = occupiedSnapshot(state);
    const planned = structuredClone(original);
    Object.assign(
      planned.find((a) => a.position === "H07")!,
      { staffId: "replacement", staffName: "replacement" }
    );
    Object.assign(
      planned.find((a) => a.position === "G12")!,
      { staffId: "bridge", staffName: "bridge", status: "assigned" }
    );
    expect(
      crossFlightPriorityReassignmentReasons(state, original, planned, DATE)
    ).toEqual([]);
    Object.assign(
      planned.find((a) => a.position === "H07")!,
      { staffId: null, staffName: "", status: "unfilled" }
    );
    expect(
      crossFlightPriorityReassignmentReasons(state, original, planned, DATE)
        .length
    ).toBeGreaterThan(0);
  });

  const repair = async (
    state: ReturnType<typeof vacancyScenario>,
    rows: Assignment[],
    locks: ReadonlySet<string> = new Set()
  ) => {
    const prep = prepareSchedule(state, DATE, evaluateAutomaticHardConstraints);
    const session = createScheduleSafetySession({
      phase: "final",
      state,
      date: DATE,
      runFacts: prep.runFacts,
    });
    const assertSafe = (planned: Assignment[]) => {
      session.assertAssignmentsSafe(planned);
      assertDailyScheduleSafety({
        state,
        date: DATE,
        assignments: planned,
        tasks: prep.tasks,
        evaluateEligibility: evaluateAutomaticHardConstraints,
        allowFinalizedConcurrency: true,
        halfRestFacts: prep.runFacts.halfRest,
      });
    };
    assertSafe(rows);
    await fillAutomaticVacancies(
      defaultHighsSolver,
      state,
      rows,
      DATE,
      locks,
      prep.runFacts,
      (planned) => {
        try {
          assertSafe(planned);
          return true;
        } catch {
          return false;
        }
      }
    );
    return assertSafe;
  };

  it("releases the configured counter, chains two people across flights and refreshes reused guides", async () => {
    const state = vacancyScenario(true);
    const rows = occupiedSnapshot(state);
    for (const flight of state.flights) {
      const base = state.positionRules.find(
        (r) => r.flightNo === flight.flightNo
      )!;
      const rule: PositionRule = {
        ...base,
        id: `guide-${flight.id}`,
        name: "引导",
        category: "引导",
      };
      state.positionRules.push(rule);
      const source = rows.find(
        (row) =>
          row.flightId === flight.id &&
          row.position === (flight.id === "source-flight" ? "H07" : "G19")
      )!;
      rows.push({
        ...source,
        id: rule.id,
        positionRuleId: rule.id,
        position: rule.name,
        workHours: 0,
        fatiguePoints: 0,
      });
    }
    const assertSafe = await repair(state, rows);
    expect(rows.find((a) => a.position === "H05")?.staffId).toBe("supervisor");
    expect(rows.find((a) => a.position === "H07")?.staffId).toBe("replacement");
    expect(rows.find((a) => a.position === "G12")?.staffId).toBe("bridge");
    expect(
      rows.find((a) => a.positionRuleId === "guide-source-flight")?.staffId
    ).toBe("replacement");
    expect(
      rows.find((a) => a.position === "G12")?.decisionTrace?.[0]?.message
    ).toContain("优先为本次补空让步");
    assertSafe(rows);
    const broken = structuredClone(rows);
    const target = broken.find((a) => a.position === "H05")!;
    delete target.supervisorSourceAssignmentId;
    delete target.supervisorFillRuleId;
    expect(() => assertSafe(broken)).toThrow();
    const mutuallyExclusive = structuredClone(rows);
    Object.assign(
      mutuallyExclusive.find((a) => a.position === "G12")!,
      { staffId: "replacement", staffName: "replacement" }
    );
    expect(() => assertSafe(mutuallyExclusive)).toThrow();
  });

  it.each([
    "no-relation",
    "disabled",
    "manual-only",
    "pending",
    "locked-fill",
    "locked-source-counter",
    "unqualified",
    "manual-vacancy",
    "below-threshold",
  ])(
    "keeps the entire original snapshot when blocked by %s",
    async (boundary) => {
      const state = vacancyScenario(true);
      const rows = occupiedSnapshot(state);
      const locks = new Set<string>();
      if (boundary === "no-relation")
        state.settings.mobileSupervisorFillRules = [];
      if (boundary === "disabled")
        state.settings.mobileSupervisorFillRules[0]!.enabled = false;
      if (boundary === "manual-only")
        state.settings.mobileSupervisorFillRules[0]!.allowAutomatic = false;
      if (boundary === "pending")
        state.settings.mobileSupervisorFillRules[0]!.requiresConfirmation = true;
      if (boundary === "locked-fill") locks.add("fill-rule");
      if (boundary === "locked-source-counter") locks.add("source-rule");
      if (boundary === "unqualified")
        state.positionRules.find(
          (r) => r.id === "vacancy-rule"
        )!.qualifiedStaffIds = ["replacement"];
      if (boundary === "manual-vacancy")
        state.positionRules.find((r) => r.id === "vacancy-rule")!.manual = true;
      if (boundary === "below-threshold")
        state.positionRules.find(
          (r) => r.id === "vacancy-rule"
        )!.minPassengers = 200;
      const before = structuredClone(rows);
      await repair(state, rows, locks);
      expect(rows).toEqual(before);
    }
  );

  it("keeps an independent supervisor when ordinary staff can complete the plan", async () => {
    const state = vacancyScenario(true);
    state.staff.push({ ...state.staff[0]!, id: "spare", name: "spare" });
    state.positionRules
      .find((r) => r.id === "vacancy-rule")!
      .qualifiedStaffIds.push("spare");
    const rows = occupiedSnapshot(state);
    await repair(state, rows);
    expect(rows.find((a) => a.position === "G12")?.staffId).toBe("spare");
    expect(rows.find((a) => a.position === "H05")?.staffId).toBe("replacement");
    expect(
      rows.find((a) => a.position === "H05")?.supervisorSourceAssignmentId
    ).toBeUndefined();
  });

  it("does not reintroduce a team leader through ordinary vacancy repair", async () => {
    const state = vacancyScenario();
    state.staff.find((person) => person.id === "replacement")!.teamLeader =
      true;
    const rows = occupiedSnapshot(state);
    const before = structuredClone(rows);
    await repair(state, rows);
    expect(rows).toEqual(before);
    const result = await generateSchedule(state, DATE);
    expect(
      result.assignments.some((row) => row.staffId === "replacement")
    ).toBe(false);
    expect(result.assignments.some((row) => row.status === "unfilled")).toBe(
      true
    );
  });

  it.each(["timeout", "final-rejection"])(
    "commits no partial change after %s",
    async (failure) => {
      const state = vacancyScenario(true);
      const rows = occupiedSnapshot(state);
      const before = structuredClone(rows);
      const prep = prepareSchedule(
        state,
        DATE,
        evaluateAutomaticHardConstraints
      );
      const solver =
        failure === "timeout"
          ? {
              solve: async () => ({
                termination: "timed-out" as const,
                selectedVariableIds: new Set<string>(),
                objectiveValues: new Map<string, number>(),
              }),
            }
          : defaultHighsSolver;
      await fillAutomaticVacancies(
        solver,
        state,
        rows,
        DATE,
        new Set(),
        prep.runFacts,
        () => false
      );
      expect(rows).toEqual(before);
    }
  );
});
