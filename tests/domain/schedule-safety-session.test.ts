import { describe, expect, it } from "vitest";

import { createDefaultState } from "../../src/defaults";
import { createScheduleRunFacts } from "../../src/domain/shared/schedule-run-facts";
import { createScheduleSafetySession } from "../../src/domain/kernel/schedule-safety-session";

const DATE = "2026-09-24";

describe("schedule safety session", () => {
  it("derives the same complete safety fact set for partial and final phases", () => {
    const state = createDefaultState();
    const runFacts = createScheduleRunFacts(state, DATE);
    const warningSink: string[] = [];
    const partial = createScheduleSafetySession({
      phase: "partial",
      state,
      date: DATE,
      runFacts,
      warningSink,
    });
    const final = createScheduleSafetySession({
      phase: "final",
      state,
      date: DATE,
      runFacts,
      warningSink,
    });

    expect({ ...partial.context, phase: "final" }).toEqual(final.context);
    expect(Object.keys(final.context).sort()).toEqual([
      "airlineRotationFacts",
      "crossWorkdayQualificationReservationFacts",
      "dailyPrimaryPositionFacts",
      "dutyPositionFacts",
      "halfRestFacts",
      "highFatiguePositionFacts",
      "ke166SnapshotFacts",
      "latePriorityAggregateRotationFacts",
      "latePriorityFrequencyFacts",
      "lateShiftCutoffFacts",
      "lateShiftPositionReliefFacts",
      "minimumFlightTransitionFacts",
      "mobileSupervisorCoverageFacts",
      "phase",
      "positionFrequencyFacts",
      "positionTransitionFacts",
      "sameDayLateObligationFacts",
      "sameFlightStaffExclusionFacts",
      "scarceQualificationFacts",
      "strictNextWorkdayRecoveryFacts",
      "warningSink",
      "workloadBalanceFacts",
    ]);
  });

  it("includes mobile-supervisor coverage rules in final credential identity", () => {
    const state = createDefaultState();
    state.settings.mobileSupervisorCoverageRules = [
      {
        id: "coverage-rule",
        enabled: true,
        mode: "allow",
        flightNo: "CX931",
        matchField: "position",
        keyword: "G01",
      },
    ];
    const runFacts = createScheduleRunFacts(state, DATE);
    const first = createScheduleSafetySession({
      phase: "final",
      state,
      date: DATE,
      runFacts,
    }).createCredential(DATE, []);

    state.settings.mobileSupervisorCoverageRules[0]!.keyword = "G02";
    const second = createScheduleSafetySession({
      phase: "final",
      state,
      date: DATE,
      runFacts: createScheduleRunFacts(state, DATE),
    }).createCredential(DATE, []);

    expect(second.contextFingerprint).not.toBe(first.contextFingerprint);
  });
});
