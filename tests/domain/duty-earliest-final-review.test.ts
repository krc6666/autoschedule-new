import { afterEach, expect, it, vi } from "vitest";
import {
  BUILT_IN_RULE_REGISTRY,
  builtInRulePreferences,
} from "../../src/domain/rules/built-in-rule-registry";
import { generateSchedule } from "../helpers/generate-schedule";
import {
  dutyEarliestScenario,
  DUTY_EARLIEST_DATE as date,
} from "../helpers/duty-earliest-scenario";

afterEach(() => vi.restoreAllMocks());

it("rolls back a final review that postpones safe duty work and still returns a final credential", async () => {
  const state = dutyEarliestScenario();
  const executor = BUILT_IN_RULE_REGISTRY.executionPlan(
    builtInRulePreferences(state.settings)
  )
    .flatMap((hook) => hook.execute)
    .find((item) => item.kind === "final-review")!;
  if (executor.kind !== "final-review") throw new Error("missing final review");
  const attempted = vi
    .spyOn(executor, "execute")
    .mockImplementation(({ assignments }) => {
      const changed = structuredClone([...assignments]);
      const early = changed.find((row) => row.flightId === "early")!;
      const later = changed.find((row) => row.flightId === "later")!;
      early.staffId = "p1";
      early.staffName = state.staff[1]!.name;
      later.staffId = "p0";
      later.staffName = state.staff[0]!.name;
      return changed;
    });
  const result = await generateSchedule(state, date);
  expect(attempted).toHaveBeenCalled();
  expect(result.unfilledCount).toBe(0);
  expect(
    result.assignments.find((row) => row.flightId === "early")?.staffId
  ).toBe("p0");
  expect(
    result.assignments.find((row) => row.flightId === "late")?.staffId
  ).toBe("p0");
  expect(result.warnings.join(" ")).toContain("推迟值班人员");
  expect(result.safetyCredential?.phase).toBe("final");
});
