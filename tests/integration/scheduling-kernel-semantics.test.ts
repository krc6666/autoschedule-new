import { describe, expect, it } from "vitest";

import { createDefaultState } from "../../src/defaults";
import { diagnoseBaseAssignmentEligibility } from "../../src/domain/candidates/assignment-eligibility";
import { assignmentRule } from "../../src/domain/flights/schedule-position-rules";
import { prepareSchedule } from "../../src/domain/kernel/schedule-preparation";
import { evaluateAutomaticHardConstraints } from "../../src/domain/rules/built-in-rule-registry";
import { generateSchedule } from "../helpers/generate-schedule";

describe("scheduler semantic quality", { timeout: 30_000 }, () => {
  it("keeps the default schedule complete, eligible, and broadly shared without fixing staff names", async () => {
    const date = "2026-07-18";
    const state = createDefaultState();
    const preparation = prepareSchedule(
      state,
      date,
      evaluateAutomaticHardConstraints
    );
    const result = await generateSchedule(state, date);
    const assignmentKeys = result.assignments.map(
      (assignment) => `${assignment.flightId}:${assignment.positionRuleId}`
    );
    const expectedTaskKeys = preparation.tasks.map(
      (task) => `${task.flight.id}:${task.rule.id}`
    );

    expect(result.unfilledCount).toBe(0);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("最终班表负荷平衡需要复核"),
      ])
    );
    expect(new Set(assignmentKeys).size).toBe(assignmentKeys.length);
    expect(
      expectedTaskKeys.every((taskKey) => assignmentKeys.includes(taskKey))
    ).toBe(true);
    for (const assignment of result.assignments.filter(
      (item) => item.status === "assigned"
    )) {
      const person = state.staff.find((item) => item.id === assignment.staffId);
      const flight = state.flights.find(
        (item) => item.id === assignment.flightId
      );
      const rule = assignmentRule(state, assignment);
      expect(person).toBeDefined();
      expect(flight).toBeDefined();
      expect(rule).toBeDefined();
      if (rule!.category === "引导") continue;
      const diagnostic = diagnoseBaseAssignmentEligibility(
        state,
        flight!,
        rule!,
        person!
      );
      expect(
        diagnostic.eligible,
        `${assignment.flightNo} / ${assignment.position}: ${diagnostic.violations
          .map((violation) => violation.code)
          .join(", ")}`
      ).toBe(true);
    }

    const loadByStaff = new Map<string, { hours: number; fatigue: number }>();
    for (const assignment of result.assignments) {
      if (!assignment.staffId) continue;
      const load = loadByStaff.get(assignment.staffId) ?? {
        hours: 0,
        fatigue: 0,
      };
      load.hours += assignment.workHours;
      load.fatigue += assignment.fatiguePoints;
      loadByStaff.set(assignment.staffId, load);
    }
    const loads = [...loadByStaff.values()];
    expect(loads).toHaveLength(
      state.staff.filter(
        (person) =>
          person.status === "正常" &&
          person.staffType === "常规" &&
          !person.teamLeader
      ).length
    );
    expect(Math.max(...loads.map((load) => load.hours))).toBeLessThanOrEqual(
      state.settings.maxDailyHours
    );
    expect({
      totalHours: loads.reduce((sum, load) => sum + load.hours, 0),
      totalFatigue: loads.reduce((sum, load) => sum + load.fatigue, 0),
      minimumHours: Math.min(...loads.map((load) => load.hours)),
      maximumHours: Math.max(...loads.map((load) => load.hours)),
      minimumFatigue: Math.min(...loads.map((load) => load.fatigue)),
      maximumFatigue: Math.max(...loads.map((load) => load.fatigue)),
    }).toMatchObject({
      maximumFatigue: 13,
      maximumHours: 6,
      totalFatigue: 125.5,
      totalHours: 70,
    });
    expect(loads.every((load) => load.hours >= 0 && load.fatigue >= 0)).toBe(
      true
    );
  });
});
