import { describe, expect, it, vi } from "vitest";
import { createDefaultState } from "../../src/defaults";
import {
  buildCurrentScheduleFlightCandidates,
  materializeCurrentScheduleFlights,
} from "../../src/domain/flights/next-workday-flight-plan";
import {
  createTestApplicationCoordinator,
  createTestAutoscheduleStore,
  setTestScheduleRunner,
} from "../helpers/application";
import { saveState, loadState } from "../../src/infrastructure/storage";
import {
  buildConfigWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";
import { applyWorkbookImport } from "../../src/app/workbook-actions";
import { makeUnfilled } from "../../src/domain/flights/schedule-position-rules";
import { createScheduleSafetySession } from "../../src/domain/kernel/schedule-safety-session";
import { createScheduleRunFacts } from "../../src/domain/shared/schedule-run-facts";
import { replaceWeeklyFlightPlan } from "../../src/domain/flights/weekly-flight-plan";
import type { AppState } from "../../src/model";

function scenario() {
  const state = createDefaultState();
  const template = { ...state.templates[0]!, id: "tw", flightNo: "TWB616" };
  state.templates = [template];
  state.flights = [
    {
      ...template,
      id: "a-flight",
      bookedPassengers: 123,
      startTime: "22:10",
      endTime: "00:10",
      remark: "当天备注",
    },
  ];
  state.groups.B.flights = [
    { ...state.flights[0]!, id: "b-flight", bookedPassengers: 90 },
  ];
  const rule = state.positionRules[0]!;
  state.positionRules = [{ ...rule, flightNo: "TWB616" }];
  state.settings.mobileSupervisorFillRules = [
    {
      id: "fill",
      enabled: true,
      sourceFlightNo: "TWB616",
      sourcePositionKeyword: "督导",
      targetFlightNo: "TWB616",
      targetPositionKeyword: "G16",
      allowAutomatic: true,
      allowManual: true,
    },
  ];
  return createTestAutoscheduleStore(state);
}

describe("flight rename synchronization", () => {
  it.each([
    {
      open: "generate-schedule",
      confirm: "confirm-schedule-preflight",
      kind: "schedule-preflight",
    },
    {
      open: "open-reschedule-flight-picker",
      confirm: "confirm-reschedule-flight-picker",
      kind: "reschedule-flight-picker",
    },
    {
      open: "archive-next-duty-day",
      confirm: "confirm-next-workday-flight-picker",
      kind: "next-workday-flight-picker",
    },
  ] as const)(
    "passes the new name from $kind selection into the runner and committed state",
    async (entry) => {
      const store = scenario();
      const initial = structuredClone(store.getState().model);
      initial.weeklyFlightPlans = replaceWeeklyFlightPlan(
        initial.weeklyFlightPlans,
        3,
        ["TWB616"]
      );
      store.getState().replaceModel(initial);
      store
        .getState()
        .configuration.updateField("template", "tw", "flightNo", "TW616");
      const seeded = structuredClone(store.getState().model);
      seeded.staff.forEach((person) => {
        person.status = "正常";
      });
      seeded.assignments = [
        {
          ...makeUnfilled(
            seeded.flights[0]!,
            seeded.positionRules[0]!.name,
            seeded.positionRules[0]
          ),
          staffId: seeded.staff[0]!.id,
          staffName: seeded.staff[0]!.name,
          status: "assigned",
        },
      ];
      seeded.activeScheduleDate = "2026-10-12";
      store.getState().replaceModel(seeded);
      const coordinator = createTestApplicationCoordinator(store, {
        preferences: {
          loadScheduleDate: () => "2026-10-12",
          saveScheduleDate: () => undefined,
          loadScheduleZoom: () => null,
          saveScheduleZoom: () => undefined,
        },
        confirm: () => true,
      });
      const calculate = vi.fn(async (input: AppState, date: string) => ({
        kind: "completed" as const,
        result: {
          assignments: [],
          warnings: [],
          unfilledCount: 0,
          safetyCredential: createScheduleSafetySession({
            phase: "final",
            state: input,
            date,
            runFacts: createScheduleRunFacts(input, date),
          }).createCredential(date, []),
        },
      }));
      setTestScheduleRunner(coordinator, { calculate });
      await coordinator.handle({ type: entry.open });
      const dialog = coordinator.view().dialog;
      if (
        dialog?.kind !== "schedule-preflight" &&
        dialog?.kind !== "reschedule-flight-picker" &&
        dialog?.kind !== "next-workday-flight-picker"
      )
        throw new Error("missing flight preparation");
      expect(dialog.kind).toBe(entry.kind);
      expect(
        dialog.candidates
          .filter((item) => dialog.selectedIds.includes(item.id))
          .map((item) => item.flightNo)
      ).toEqual(["TW616"]);
      await coordinator.handle({
        type: entry.confirm,
        selectedIds: dialog.selectedIds,
      });
      expect(coordinator.view().toast?.tone).not.toBe("danger");
      expect(calculate).toHaveBeenCalledOnce();
      expect(
        calculate.mock.calls[0]![0].flights.map((flight) => flight.flightNo)
      ).toEqual(["TW616"]);
      expect(
        coordinator.model().flights.map((flight) => flight.flightNo)
      ).toEqual(["TW616"]);
    }
  );

  it("clears affected group schedules but leaves unrelated group schedules and history alone", () => {
    const store = scenario();
    const initial = structuredClone(store.getState().model);
    initial.groups.B.assignments = [
      makeUnfilled(
        initial.groups.B.flights[0]!,
        "G16",
        initial.positionRules[0]
      ),
    ];
    initial.groups.B.activeScheduleDate = "2026-10-12";
    initial.groups.B.schedulePolicyStale = true;
    initial.groups.B.scheduleRuleFingerprint = "old-context";
    store.getState().replaceModel(initial);
    store
      .getState()
      .configuration.updateField("template", "tw", "flightNo", "TW616");
    expect(store.getState().model.groups.B.assignments).toEqual([]);
    expect(store.getState().model.groups.B.activeScheduleDate).toBeNull();
    expect(
      store.getState().model.groups.B.scheduleRuleFingerprint
    ).toBeUndefined();

    const independent = structuredClone(initial);
    independent.groups.B.flights[0]!.flightNo = "EXTRA900";
    independent.groups.B.assignments[0]!.flightNo = "EXTRA900";
    store.getState().replaceModel(independent);
    const before = structuredClone(store.getState().model.groups.B);
    store
      .getState()
      .configuration.updateField("template", "tw", "flightNo", "TW616");
    expect(store.getState().model.groups.B).toEqual(before);
  });

  it("retains the renamed default choice and relation through storage and both groups' Excel exports", () => {
    const store = scenario();
    store
      .getState()
      .configuration.updateField("template", "tw", "flightNo", "TW616");
    let serialized = "";
    saveState(store.getState().model, {
      setItem: (_key, value) => {
        serialized = value;
      },
    });
    const restored = createTestAutoscheduleStore(
      loadState({ getItem: () => serialized })
    );
    for (const groupId of ["A", "B"] as const) {
      restored.getState().switchGroup(groupId);
      const state = restored.getState().model;
      expect(state.flights[0]!.flightNo).toBe("TW616");
      const parsed = parseWorkbook(buildConfigWorkbook(state), state.staff);
      expect(
        parsed.flights?.map((flight) => [
          flight.flightNo,
          flight.bookedPassengers,
          flight.startTime,
          flight.remark,
        ])
      ).toEqual(
        state.flights.map((flight) => [
          flight.flightNo,
          flight.bookedPassengers,
          flight.startTime,
          flight.remark,
        ])
      );
      expect(parsed.templates?.map((template) => template.flightNo)).toEqual([
        "TW616",
      ]);
      expect(parsed.settings?.mobileSupervisorFillRules?.[0]).toMatchObject({
        sourceFlightNo: "TW616",
        targetFlightNo: "TW616",
        id: "fill",
      });
      const target = structuredClone(state);
      target.flights = [];
      expect(applyWorkbookImport(target, parsed, "all").changedConfig).toBe(
        true
      );
      expect(
        buildCurrentScheduleFlightCandidates(
          target.templates,
          target.flights
        ).map((item) => [item.flightNo, item.selectedByDefault])
      ).toEqual([["TW616", true]]);
    }
  });

  it("exposes an old restored name for explicit repair, then persists the correction without aliases", () => {
    const store = scenario();
    const old = structuredClone(store.getState().model);
    old.templates[0]!.flightNo = "TW616";
    store.getState().replaceModel(old);
    let serialized = "";
    const storage = {
      setItem: (_key: string, value: string) => {
        serialized = value;
      },
      getItem: () => serialized,
    };
    saveState(store.getState().model, storage);
    const restored = createTestAutoscheduleStore(loadState(storage));
    expect(restored.getState().model.flights[0]!.flightNo).toBe("TWB616");
    expect(
      restored
        .getState()
        .configuration.renameCurrentFlightToTemplate("a-flight", "tw")
    ).toBe("updated");
    saveState(restored.getState().model, storage);
    const repaired = loadState(storage);
    expect(repaired.flights[0]).toMatchObject({
      flightNo: "TW616",
      bookedPassengers: 123,
    });
    expect(repaired.groups.B.flights[0]!.flightNo).toBe("TW616");
    expect(repaired.settings.mobileSupervisorFillRules[0]!.targetFlightNo).toBe(
      "TW616"
    );
  });

  it("rejects unsafe or stale explicit repair choices without changing anything", () => {
    const store = scenario();
    expect(
      store
        .getState()
        .configuration.renameCurrentFlightToTemplate("a-flight", "tw")
    ).toBe("invalid-source");
    expect(
      store
        .getState()
        .configuration.renameCurrentFlightToTemplate("missing", "tw")
    ).toBe("missing");
    const old = structuredClone(store.getState().model);
    old.templates[0]!.flightNo = "TW616";
    old.groups.B.flights.push({
      ...old.groups.B.flights[0]!,
      id: "new",
      flightNo: "TW616",
    });
    store.getState().replaceModel(old);
    const before = structuredClone(store.getState().model);
    expect(
      store
        .getState()
        .configuration.renameCurrentFlightToTemplate("a-flight", "tw")
    ).toBe("duplicate");
    expect(store.getState().model).toEqual(before);
  });

  it("repairs an already saved old flight only after an explicit template choice and confirmation", async () => {
    const store = scenario();
    const old = structuredClone(store.getState().model);
    old.templates[0]!.flightNo = "TW616";
    old.positionRules.forEach((rule) => {
      rule.flightNo = "TW616";
    });
    old.settings.mobileSupervisorFillRules[0]!.sourceFlightNo = "TW616";
    old.settings.mobileSupervisorFillRules[0]!.targetFlightNo = "TW616";
    store.getState().replaceModel(old);
    const confirm = vi.fn(() => false);
    const coordinator = createTestApplicationCoordinator(store, {
      preferences: {
        loadScheduleDate: () => "2026-10-12",
        saveScheduleDate: () => undefined,
        loadScheduleZoom: () => null,
        saveScheduleZoom: () => undefined,
      },
      confirm,
    });
    const before = structuredClone(coordinator.model());
    await coordinator.handle({
      type: "rename-current-flight-to-template",
      flightId: "a-flight",
      templateId: "tw",
    });
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("TWB616 → TW616")
    );
    expect(coordinator.model()).toEqual(before);
    confirm.mockReturnValue(true);
    await coordinator.handle({
      type: "rename-current-flight-to-template",
      flightId: "a-flight",
      templateId: "tw",
    });
    expect(coordinator.model().flights).toEqual(
      before.flights.map((flight) => ({ ...flight, flightNo: "TW616" }))
    );
    expect(coordinator.model().groups.B.flights[0]!.flightNo).toBe("TW616");
    expect(coordinator.model().settings.mobileSupervisorFillRules).toEqual(
      before.settings.mobileSupervisorFillRules
    );
  });

  it("uses the renamed flight by default in prepare and retains operational data in both groups", () => {
    const store = scenario();
    const before = structuredClone(store.getState().model);
    expect(
      store
        .getState()
        .configuration.updateField("template", "tw", "flightNo", "TW616")
    ).toBe("updated");
    const state = store.getState().model;
    expect(state.flights).toEqual(
      before.flights.map((flight) => ({ ...flight, flightNo: "TW616" }))
    );
    expect(state.groups.B.flights).toEqual(
      before.groups.B.flights.map((flight) => ({
        ...flight,
        flightNo: "TW616",
      }))
    );
    expect(state.history).toEqual(before.history);
    expect(state.groups.B.history).toEqual(before.groups.B.history);
    const candidates = buildCurrentScheduleFlightCandidates(
      state.templates,
      state.flights
    );
    expect(
      candidates.map((item) => [item.flightNo, item.selectedByDefault])
    ).toEqual([["TW616", true]]);
    expect(
      materializeCurrentScheduleFlights(
        candidates,
        candidates
          .filter((item) => item.selectedByDefault)
          .map((item) => item.id)
      )
    ).toEqual(state.flights);
    store.getState().switchGroup("B");
    expect(store.getState().model.flights[0]).toMatchObject({
      flightNo: "TW616",
      bookedPassengers: 90,
    });
  });

  it.each(["A", "B"] as const)(
    "rejects a rename atomically if group %s already has the target flight",
    (groupId) => {
      const store = scenario();
      const input = structuredClone(store.getState().model);
      const extra = {
        ...input.flights[0]!,
        id: "already-new",
        flightNo: "TW616",
      };
      if (groupId === "A") input.flights.push(extra);
      else input.groups.B.flights.push(extra);
      store.getState().replaceModel(input);
      const before = structuredClone(store.getState().model);
      expect(
        store
          .getState()
          .configuration.updateField("template", "tw", "flightNo", "TW616")
      ).toBe("duplicate");
      expect(store.getState().model).toEqual(before);
    }
  );

  it("preserves an independent non-template flight through rename and prepare", () => {
    const store = scenario();
    const input = structuredClone(store.getState().model);
    const extra = {
      ...input.flights[0]!,
      id: "independent",
      flightNo: "EXTRA900",
      bookedPassengers: 45,
    };
    input.flights.push(extra);
    store.getState().replaceModel(input);
    store
      .getState()
      .configuration.updateField("template", "tw", "flightNo", "TW616");
    const state = store.getState().model;
    expect(state.flights.find((flight) => flight.id === "independent")).toEqual(
      extra
    );
    expect(
      buildCurrentScheduleFlightCandidates(state.templates, state.flights).map(
        (item) => [item.flightNo, item.selectedByDefault]
      )
    ).toEqual([
      ["EXTRA900", true],
      ["TW616", true],
    ]);
  });
});
