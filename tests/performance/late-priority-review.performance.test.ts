import { describe, expect, it } from "vitest";
import { createScheduleFrequencyFacts } from "../../src/domain/statistics/schedule-frequency";
import {
  assessLatePriorityAggregateBalance,
  assessLatePriorityFrequencyBalance,
} from "../../src/domain/reviews/late-priority-frequency-balance";
import { createLatePriorityPressureState } from "./fixtures/late-priority";

describe("late priority complete review cost", () => {
  it("reuses history for category and aggregate checks while projecting each schedule", () => {
    const { state, assignments, date } = createLatePriorityPressureState();
    const facts = createScheduleFrequencyFacts(state, date);
    const started = performance.now();
    for (let pass = 0; pass < 3; pass++) {
      for (const target of assignments) {
        expect(
          assessLatePriorityFrequencyBalance(
            state,
            target,
            assignments,
            date,
            facts
          )
        ).not.toBeNull();
        expect(
          assessLatePriorityAggregateBalance(
            state,
            target,
            assignments,
            date,
            facts
          )
        ).not.toBeNull();
      }
    }
    const elapsed = performance.now() - started;
    console.info(
      "[performance] late category+aggregate 3 passes/900 history",
      Math.round(elapsed),
      "ms"
    );
    expect(elapsed).toBeLessThan(2_000);
  }, 30_000);
});
