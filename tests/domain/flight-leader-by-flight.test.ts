import { expect, it } from "vitest";
import { flightLeaderScenario } from "../helpers/flight-leader-scenario";
import { flightLeaderCoverage } from "../../src/domain/rules/flight-leader-coverage";
import { normalizeScheduleSettings } from "../../src/domain/rules/schedule-settings";
import { improveFlightLeaderCoverage } from "../../src/domain/reviews/flight-leader-coverage";
import { createScheduleRunFacts } from "../../src/domain/shared/schedule-run-facts";
import { defaultHighsSolver } from "../../src/infrastructure/solver/highs-solver";
import { LEADER_DATE } from "../helpers/flight-leader-scenario";
import { buildScheduleFeedback } from "../../src/domain/feedback/schedule-feedback";
import {
  renameGroupFlightReferences,
  removeFlightScopedReferences,
} from "../../src/domain/flights/group-flight-references";

it("uses the flight override and keeps one for flights without a row", () => {
  const state = flightLeaderScenario();
  state.settings.flightLeaderRequirements = [{ flightNo: "ZZ100", minimum: 2 }];
  expect(flightLeaderCoverage(state).map((row) => row.required)).toEqual([
    2, 1,
  ]);
});

it("defaults old settings to an empty override list", () => {
  expect(normalizeScheduleSettings({}).flightLeaderRequirements).toEqual([]);
});

it("satisfies a flight-specific two-person target and keeps the other default at one", async () => {
  const state = flightLeaderScenario(2, 3, 3);
  state.settings.flightLeaderRequirements = [{ flightNo: "ZZ101", minimum: 2 }];
  const result = await improveFlightLeaderCoverage({
    state,
    date: LEADER_DATE,
    assignments: state.assignments,
    facts: createScheduleRunFacts(state, LEADER_DATE),
    solver: defaultHighsSolver,
    lockedAssignmentIds: new Set(),
    assertSafe: () => undefined,
  });
  expect(
    flightLeaderCoverage(state, result).map((row) => [row.required, row.actual])
  ).toEqual([
    [1, 1],
    [2, 2],
  ]);
  state.assignments = result;
  expect(
    buildScheduleFeedback(state, LEADER_DATE).find(
      (row) => row.key === "flight-leader-coverage"
    )?.level
  ).toBe("ok");
  state.assignments = flightLeaderScenario(2, 3, 3).assignments;
  expect(
    buildScheduleFeedback(state, LEADER_DATE).find(
      (row) => row.key === "flight-leader-coverage"
    )?.evidence
  ).toContain("需要2名");
});

it("cleans invalid input centrally and carries overrides through rename and removal", () => {
  const settings = normalizeScheduleSettings({
    flightLeaderRequirements: [
      { flightNo: " zz100 ", minimum: 2 },
      { flightNo: "ZZ100", minimum: 3 },
      { flightNo: "ZZ101", minimum: 0 },
    ],
  });
  expect(settings.flightLeaderRequirements).toEqual([
    { flightNo: "ZZ100", minimum: 2 },
  ]);
  renameGroupFlightReferences([], settings, (no) =>
    no === "ZZ100" ? "ZZ200" : no
  );
  expect(settings.flightLeaderRequirements[0]?.flightNo).toBe("ZZ200");
  removeFlightScopedReferences(settings, "ZZ200");
  expect(settings.flightLeaderRequirements).toEqual([]);
});
