import { describe, expect, it, vi } from "vitest";
import { createDefaultState } from "../../src/defaults";
import type { AppState, ScheduleResult } from "../../src/model";
import type { ApplicationDialog } from "../../src/app/application-view-state";
import type { UiCommand } from "../../src/ui/events/ui-command";
import { createScheduleSafetySession } from "../../src/domain/kernel/schedule-safety-session";
import { createScheduleRunFacts } from "../../src/domain/shared/schedule-run-facts";
import { replaceWeeklyFlightPlan } from "../../src/domain/flights/weekly-flight-plan";
import { generateSchedule } from "../helpers/generate-schedule";
import { createStatePersistence } from "../../src/infrastructure/storage";
import {
  buildConfigWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";
import {
  createTestApplicationCoordinator,
  createTestAutoscheduleStore,
  createMemoryStatePersistence,
  setTestScheduleRunner,
} from "../helpers/application";

const entries = [
  "generate-schedule",
  "open-reschedule-flight-picker",
  "archive-next-duty-day",
] as const;
const preferences = {
  loadScheduleDate: () => "2026-08-15",
  saveScheduleDate: () => undefined,
  loadScheduleZoom: () => null,
  saveScheduleZoom: () => undefined,
};

function stateWithSchedule(enabled: boolean) {
  const state = createDefaultState();
  state.settings.adminSupportEnabled = enabled;
  state.activeScheduleDate = "2026-08-15";
  state.weeklyFlightPlans = replaceWeeklyFlightPlan(
    state.weeklyFlightPlans,
    1,
    [state.templates[0]!.flightNo]
  );
  const flight = state.flights[0]!;
  const rule = state.positionRules.find(
    (item) => item.flightNo === flight.flightNo && item.category === "常规"
  )!;
  const person = state.staff.find((item) =>
    rule.qualifiedStaffIds.includes(item.id)
  )!;
  state.assignments = [
    {
      id: "original-post",
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
    },
  ];
  return state;
}

function confirmation(dialog: ApplicationDialog | null): UiCommand {
  if (!dialog || !("selectedIds" in dialog))
    throw new Error("missing preparation dialog");
  return {
    type:
      dialog.kind === "schedule-preflight"
        ? "confirm-schedule-preflight"
        : dialog.kind === "reschedule-flight-picker"
          ? "confirm-reschedule-flight-picker"
          : "confirm-next-workday-flight-picker",
    selectedIds: dialog.selectedIds,
  };
}

function certifiedResult(state: AppState, date: string): ScheduleResult {
  return {
    assignments: [],
    warnings: [],
    unfilledCount: 0,
    safetyCredential: createScheduleSafetySession({
      phase: "final",
      state,
      date,
      runFacts: createScheduleRunFacts(state, date),
    }).createCredential(date, []),
  };
}

describe("preflight administrative mode draft", () => {
  it("blocks a second mode draft or calculation while the confirmed run is pending", async () => {
    const coordinator = createTestApplicationCoordinator(
      createTestAutoscheduleStore(stateWithSchedule(false)),
      { preferences }
    );
    const original = structuredClone(coordinator.model());
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const calculate = vi.fn(async (state: AppState, date: string) => {
      await pending;
      return {
        kind: "completed" as const,
        result: certifiedResult(state, date),
      };
    });
    setTestScheduleRunner(coordinator, { calculate });
    await coordinator.handle({ type: "generate-schedule" });
    await coordinator.handle({
      type: "update-preflight-administrative-mode",
      enabled: true,
    });
    const run = coordinator.handle(confirmation(coordinator.view().dialog));
    await coordinator.handle({
      type: "update-preflight-administrative-mode",
      enabled: false,
    });
    await coordinator.handle({ type: "generate-schedule" });
    expect(coordinator.view().toast?.message).toContain("排班正在计算");
    expect(coordinator.view().dialog).toBeNull();
    expect(coordinator.model()).toEqual(original);
    expect(calculate).toHaveBeenCalledTimes(1);
    complete();
    await run;
    expect(coordinator.model().settings.adminSupportEnabled).toBe(true);
  });

  it.each(
    entries.flatMap((entry) =>
      [false, true].map((enabled) => ({ entry, enabled }))
    )
  )(
    "$entry uses selected $enabled through the real kernel, final guard, storage and next dialog",
    async ({ entry, enabled }) => {
      const state = stateWithSchedule(!enabled);
      state.staff = state.staff.slice(0, 2).map((person, index) => ({
        ...person,
        name: ["甲", "乙"][index]!,
        teamLeader: false,
        status: "正常",
        dutyQualified: false,
        cxPreflightQualified: false,
      }));
      const flight = {
        ...state.flights[0]!,
        startTime: "13:00",
        endTime: "15:00",
        positions: [],
        bookedPassengers: 100,
      };
      state.flights = [flight];
      state.templates = [{ ...flight, id: "template-test" }];
      const base = state.positionRules[0]!;
      state.positionRules = [
        {
          ...base,
          id: "regular",
          flightNo: flight.flightNo,
          name: "G01",
          category: "常规",
          manual: false,
          minPassengers: 0,
          qualifiedStaffIds: [state.staff[0]!.id],
        },
        {
          ...base,
          id: "admin",
          flightNo: flight.flightNo,
          name: "支援柜台",
          category: "行政支援",
          manual: false,
          minPassengers: 0,
          qualifiedStaffIds: [state.staff[1]!.id],
        },
      ];
      state.assignments = [
        {
          ...state.assignments[0]!,
          positionRuleId: "regular",
          position: "G01",
          staffId: state.staff[0]!.id,
          staffName: "甲",
          startTime: "13:00",
          endTime: "15:00",
        },
      ];
      const values = new Map<string, string>();
      const persistence = createStatePersistence({
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => {
          values.set(key, value);
        },
        removeItem: (key) => {
          values.delete(key);
        },
      });
      const coordinator = createTestApplicationCoordinator(
        createTestAutoscheduleStore(state, persistence),
        { preferences, confirm: () => true }
      );
      const calculate = vi.fn(async (input: AppState, date: string) => ({
        kind: "completed" as const,
        result: await generateSchedule(input, date),
      }));
      setTestScheduleRunner(coordinator, { calculate });
      await coordinator.handle({ type: entry });
      await coordinator.handle({
        type: "update-preflight-administrative-mode",
        enabled,
      });
      await coordinator.handle(confirmation(coordinator.view().dialog));
      expect(calculate).toHaveBeenCalledTimes(1);
      expect(coordinator.view().toast?.tone).not.toBe("danger");
      const model = coordinator.model();
      expect(model.settings.adminSupportEnabled).toBe(enabled);
      expect(
        model.assignments.find((item) => item.positionRuleId === "regular")
      ).toMatchObject({
        staffId: state.staff[0]!.id,
        status: "assigned",
        workHours: 2,
      });
      const admin = model.assignments.find(
        (item) => item.positionRuleId === "admin"
      );
      if (enabled)
        expect(admin).toMatchObject({
          staffId: state.staff[1]!.id,
          status: "assigned",
          workHours: 2,
          fatiguePoints: base.fatiguePoints,
        });
      else expect(admin).toBeUndefined();
      const restored = persistence.load();
      expect(restored.settings.adminSupportEnabled).toBe(enabled);
      expect(restored.assignments).toEqual(model.assignments);
      expect(
        parseWorkbook(buildConfigWorkbook(model), model.staff).settings
      ).not.toHaveProperty("adminSupportEnabled");
      const reopened = createTestApplicationCoordinator(
        createTestAutoscheduleStore(restored, persistence),
        {
          preferences: {
            ...preferences,
            loadScheduleDate: () => model.activeScheduleDate,
          },
        }
      );
      await reopened.handle({ type: "generate-schedule" });
      expect(reopened.view().dialog).toHaveProperty(
        "adminSupportEnabled",
        enabled
      );
      if (entry === "archive-next-duty-day")
        expect(
          model.history.some(
            (item) => item.date === "2026-08-15" && item.position === "G01"
          )
        ).toBe(true);
    }
  );

  it.each(
    entries.flatMap((entry) =>
      [false, true].map((enabled) => ({ entry, enabled }))
    )
  )(
    "$entry inherits $enabled and commits the selected mode after exactly one calculation",
    async ({ entry, enabled }) => {
      const persistence = createMemoryStatePersistence();
      const coordinator = createTestApplicationCoordinator(
        createTestAutoscheduleStore(stateWithSchedule(enabled), persistence),
        { preferences, confirm: () => true }
      );
      const original = structuredClone(coordinator.model());
      const calculate = vi.fn(async (state: AppState, date: string) => {
        expect(state.settings.adminSupportEnabled).toBe(!enabled);
        expect(coordinator.model()).toEqual(original);
        return {
          kind: "completed" as const,
          result: certifiedResult(state, date),
        };
      });
      setTestScheduleRunner(coordinator, { calculate });
      await coordinator.handle({ type: entry });
      expect(coordinator.view().dialog).toHaveProperty(
        "adminSupportEnabled",
        enabled
      );
      await coordinator.handle({
        type: "update-preflight-administrative-mode",
        enabled: !enabled,
      });
      expect(coordinator.view().dialog).toHaveProperty(
        "adminSupportEnabled",
        !enabled
      );
      expect(coordinator.model()).toEqual(original);
      expect(calculate).not.toHaveBeenCalled();
      await coordinator.handle(confirmation(coordinator.view().dialog));
      expect(calculate).toHaveBeenCalledTimes(1);
      expect(coordinator.model().settings.adminSupportEnabled).toBe(!enabled);
      expect(persistence.load().settings.adminSupportEnabled).toBe(!enabled);
      expect(coordinator.model().shared.settings.adminSupportEnabled).toBe(
        !enabled
      );
      await coordinator.handle({ type: "generate-schedule" });
      expect(coordinator.view().dialog).toHaveProperty(
        "adminSupportEnabled",
        !enabled
      );
    }
  );

  it.each(
    entries.flatMap((entry) => [true, false].map((safe) => ({ entry, safe })))
  )(
    "$entry adopts a stopped result and its mode only for a safe reschedule ($safe)",
    async ({ entry, safe }) => {
      const persistence = createMemoryStatePersistence();
      const saveScheduleDate = vi.fn();
      const coordinator = createTestApplicationCoordinator(
        createTestAutoscheduleStore(stateWithSchedule(false), persistence),
        {
          preferences: { ...preferences, saveScheduleDate },
          confirm: () => true,
        }
      );
      const original = structuredClone(coordinator.model());
      const calculate = vi.fn(async (state: AppState, date: string) => ({
        kind: "stopped-with-result" as const,
        result: safe
          ? certifiedResult(state, date)
          : { assignments: [], warnings: [], unfilledCount: 0 },
      }));
      setTestScheduleRunner(coordinator, { calculate });
      await coordinator.handle({ type: entry });
      await coordinator.handle({
        type: "update-preflight-administrative-mode",
        enabled: true,
      });
      await coordinator.handle(confirmation(coordinator.view().dialog));
      expect(calculate).toHaveBeenCalledTimes(1);
      expect(coordinator.view().date).toBe("2026-08-15");
      expect(saveScheduleDate).not.toHaveBeenCalled();
      if (entry === "open-reschedule-flight-picker" && safe) {
        expect(coordinator.model().settings.adminSupportEnabled).toBe(true);
        expect(coordinator.model().assignments).toEqual([]);
        expect(persistence.load().settings.adminSupportEnabled).toBe(true);
        expect(persistence.load().assignments).toEqual([]);
        expect(coordinator.view().toast?.message).toContain("已采用");
      } else {
        expect(coordinator.model()).toEqual(original);
        if (entry === "open-reschedule-flight-picker")
          expect(coordinator.view().toast?.tone).toBe("danger");
      }
      await coordinator.handle({ type: entry });
      expect(coordinator.view().dialog).toHaveProperty(
        "adminSupportEnabled",
        entry === "open-reschedule-flight-picker" && safe
      );
    }
  );

  it.each(
    entries.flatMap((entry) =>
      ["cancel", "failure", "invalid-result", "stopped-without-result"].map(
        (outcome) => ({ entry, outcome })
      )
    )
  )(
    "$entry preserves the entire original model and mode on $outcome",
    async ({ entry, outcome }) => {
      const saveScheduleDate = vi.fn();
      const coordinator = createTestApplicationCoordinator(
        createTestAutoscheduleStore(stateWithSchedule(false)),
        {
          preferences: { ...preferences, saveScheduleDate },
          confirm: () => true,
        }
      );
      const original = structuredClone(coordinator.model());
      const calculate = vi.fn(async () => {
        if (outcome === "failure") throw new Error("calculation failed");
        if (outcome === "stopped-without-result")
          return { kind: "stopped-without-result" as const };
        return {
          kind: "completed" as const,
          result: { assignments: [], warnings: [], unfilledCount: 0 },
        };
      });
      setTestScheduleRunner(coordinator, { calculate });
      await coordinator.handle({ type: entry });
      await coordinator.handle({
        type: "update-preflight-administrative-mode",
        enabled: true,
      });
      expect(coordinator.view().dialog).toHaveProperty(
        "adminSupportEnabled",
        true
      );
      if (outcome === "cancel")
        await coordinator.handle({ type: "close-dialog" });
      else await coordinator.handle(confirmation(coordinator.view().dialog));
      expect(coordinator.model()).toEqual(original);
      expect(coordinator.view().date).toBe("2026-08-15");
      expect(saveScheduleDate).not.toHaveBeenCalled();
      expect(calculate).toHaveBeenCalledTimes(outcome === "cancel" ? 0 : 1);
      if (outcome === "failure" || outcome === "invalid-result")
        expect(coordinator.view().toast?.tone).toBe("danger");
      await coordinator.handle({ type: entry });
      expect(coordinator.view().dialog).toHaveProperty(
        "adminSupportEnabled",
        false
      );
    }
  );
});
