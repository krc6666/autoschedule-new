import { afterEach, expect, it, vi } from "vitest";
import { createLatePriorityPressureState } from "../performance/fixtures/late-priority";
import { createScheduleGenerationFacts } from "../../src/domain/shared/scheduling-facts";
import type {
  ScheduleWorkerRequest,
  ScheduleWorkerResponse,
} from "../../src/infrastructure/schedule-worker-protocol";
import { installGeneratedSchedule } from "../../src/domain/kernel/schedule-lifecycle";
import {
  assertScheduleAssignmentsSafe,
  createDefaultScheduleGuards,
} from "../../src/domain/kernel/schedule-guard";
import { applyFlightIdentityChange } from "../../src/app/flight-identity-actions";
import { flightIdentityChangeFingerprint } from "../../src/domain/flights/flight-identity-change";
import { buildMonthlyLatePriorityStatistics } from "../../src/domain/statistics/monthly-late-priority-statistics";

afterEach(() => vi.unstubAllGlobals());

it("carries renamed flights through Worker/WASM, installation, history counts and final rejection", async () => {
  const { state, date } = createLatePriorityPressureState();
  state.settings.positionTransitionPolicies = [];
  state.settings.crossFlightPriorityPolicies = [];
  state.settings.crossWorkdayQualificationReservations = [];
  state.settings.lateShiftRecoveryEnabled = false;
  state.settings.highLoadProtectionEnabled = false;
  state.settings.rollingLoadProtectionEnabled = false;
  state.settings.minimumRegularTransitionMinutes = 0;
  state.history = state.history.map((row) =>
    row.flightNo === "TR121" && row.remark === "一号"
      ? { ...row, position: "H02", remark: "申报" }
      : row
  );
  state.positionRules
    .filter((rule) => rule.name === "督导")
    .forEach((rule) => {
      rule.category = "机动督导";
    });
  const directory = [
    {
      id: "tr",
      displayName: "长期TR",
      aliases: [
        { flightNo: "TR121" },
        { flightNo: "AB999", positionSourceFlightNo: "TR121" },
      ],
    },
    {
      id: "tw",
      displayName: "长期TW",
      aliases: [
        { flightNo: "TW616" },
        { flightNo: "ZX200", positionSourceFlightNo: "TW616" },
      ],
    },
  ];
  expect(
    applyFlightIdentityChange(
      state,
      directory,
      flightIdentityChangeFingerprint(state)
    ).ok
  ).toBe(true);
  state.flights[0]!.flightNo = "AB999";
  state.flights[1]!.flightNo = "ZX200";
  const history = structuredClone(state.history);
  const expectedCounts = buildMonthlyLatePriorityStatistics(state, date);
  const facts = createScheduleGenerationFacts(state);
  expect(facts.flightIdentities).toEqual(directory);
  const messages: ScheduleWorkerResponse[] = [];
  const worker = {
    onmessage: null as
      ((event: MessageEvent<ScheduleWorkerRequest>) => Promise<void>) | null,
    postMessage: (message: ScheduleWorkerResponse) =>
      messages.push(structuredClone(message)),
  };
  vi.stubGlobal("self", worker);
  await import("../../src/schedule.worker");
  await worker.onmessage!(
    new MessageEvent("message", {
      data: {
        state: facts,
        date,
        preferences: { halfRestStaffIds: [], halfRestModes: {} },
      },
    })
  );
  expect(messages.filter((m) => m.type === "error")).toEqual([]);
  const final = messages.find((m) => m.type === "result");
  if (final?.type !== "result") throw new Error("缺少最终结果");
  expect(final.result.assignments).toHaveLength(8);
  expect(final.result.unfilledCount).toBe(0);
  expect(new Set(final.result.assignments.map((a) => a.flightNo))).toEqual(
    new Set(["AB999", "ZX200"])
  );
  installGeneratedSchedule(state, date, final.result);
  expect(state.history).toEqual(history);
  expect(
    buildMonthlyLatePriorityStatistics(
      { ...state, assignments: [], activeScheduleDate: null },
      date
    ).rows
  ).toEqual(expectedCounts.rows);
  const legal = final.result.assignments;
  const context = {
    phase: "final" as const,
    sameFlightStaffExclusionFacts: { state },
  };
  state.settings.sameFlightStaffExclusions = [
    {
      id: "pair",
      enabled: true,
      flightNo: "TR121",
      staffIds: [legal[0]!.staffId!, legal[1]!.staffId!],
    },
  ];
  const safe = legal.map((a, i) =>
    i === 1 ? { ...a, flightId: "separate-flight" } : a
  );
  const guards = createDefaultScheduleGuards();
  expect(() =>
    assertScheduleAssignmentsSafe({ assignments: safe, context, guards })
  ).not.toThrow();
  expect(() =>
    assertScheduleAssignmentsSafe({ assignments: legal, context, guards })
  ).toThrow();
  state.shared.flightIdentities![0]!.aliases = [{ flightNo: "TR121" }];
  expect(() => installGeneratedSchedule(state, date, final.result)).toThrow();
}, 30_000);
