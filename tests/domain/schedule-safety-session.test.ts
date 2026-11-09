import { describe, expect, it } from "vitest";

import { createDefaultState } from "../../src/defaults";
import type { Assignment } from "../../src/model";
import { createScheduleRunFacts } from "../../src/domain/shared/schedule-run-facts";
import { createScheduleSafetySession } from "../../src/domain/kernel/schedule-safety-session";
import {
  createPositionFrequencyScheduleGuard,
  createStaffStatusScheduleGuard,
} from "../../src/domain/kernel/schedule-guard";

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
      "staffStatusFacts",
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

  it("includes active staff status in final credential identity", () => {
    const state = createDefaultState();
    const first = createScheduleSafetySession({
      phase: "final",
      state,
      date: DATE,
      runFacts: createScheduleRunFacts(state, DATE),
    }).createCredential(DATE, []);

    state.staff[0]!.status = "陪产假";
    const second = createScheduleSafetySession({
      phase: "final",
      state,
      date: DATE,
      runFacts: createScheduleRunFacts(state, DATE),
    }).createCredential(DATE, []);

    expect(second.contextFingerprint).not.toBe(first.contextFingerprint);
  });

  it("passes the run frequency index to the position-frequency guard", () => {
    const state = createDefaultState();
    state.settings.positionRotationEnabled = true;
    const rule = state.positionRules[0]!;
    const flight = state.flights.find(
      (candidate) => candidate.flightNo === rule.flightNo
    )!;
    const person = state.staff.find((candidate) =>
      rule.qualifiedStaffIds.includes(candidate.id)
    )!;
    const assignment: Assignment = {
      id: "frequency-guard-assignment",
      flightId: flight.id,
      flightNo: flight.flightNo,
      positionRuleId: rule.id,
      position: rule.name,
      staffId: person.id,
      staffName: person.name,
      startTime: flight.startTime,
      endTime: flight.endTime,
      workHours: 2,
      fatiguePoints: rule.fatiguePoints,
      remark: rule.remark,
      manualRemark: "",
      status: "assigned",
    };
    const runFacts = createScheduleRunFacts(state, DATE);
    const stateWithoutHistoryReads = new Proxy(state, {
      get(target, property, receiver) {
        if (property === "history")
          throw new Error("position-frequency guard rebuilt the history index");
        return Reflect.get(target, property, receiver);
      },
    });
    const session = createScheduleSafetySession({
      phase: "partial",
      state: stateWithoutHistoryReads,
      date: DATE,
      runFacts,
      guards: [createPositionFrequencyScheduleGuard()],
    });

    expect(() => session.assertAssignmentsSafe([assignment])).not.toThrow();
  });

  it("rejects a previously legal assignment after staff status changes", () => {
    const state = createDefaultState();
    const person = state.staff[0]!;
    const rule = state.positionRules.find((candidate) =>
      candidate.qualifiedStaffIds.includes(person.id)
    )!;
    const flight = state.flights.find(
      (candidate) => candidate.flightNo === rule.flightNo
    )!;
    const assignment: Assignment = {
      id: "status-guard-assignment",
      flightId: flight.id,
      flightNo: flight.flightNo,
      positionRuleId: rule.id,
      position: rule.name,
      staffId: person.id,
      staffName: person.name,
      startTime: flight.startTime,
      endTime: flight.endTime,
      workHours: 2,
      fatiguePoints: rule.fatiguePoints,
      remark: rule.remark,
      manualRemark: "",
      status: "assigned",
    };
    const session = createScheduleSafetySession({
      phase: "final",
      state,
      date: DATE,
      runFacts: createScheduleRunFacts(state, DATE),
      guards: [createStaffStatusScheduleGuard()],
    });

    expect(() => session.assertAssignmentsSafe([assignment])).not.toThrow();
    person.status = "陪产假";
    expect(() => session.assertAssignmentsSafe([assignment])).toThrow(
      /当前状态为陪产假/
    );
  });
});
