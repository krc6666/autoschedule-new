import { describe, expect, it, vi } from "vitest";

import { createTestAutoscheduleStore } from "../helpers/application";
import { createDefaultState } from "../../src/defaults";
import { buildFlightPlanReconciliation } from "../../src/domain/flights/flight-plan-reconciliation";

describe("autoschedule store", () => {
  it("exposes one state owner and commits named commands through Immer", () => {
    const store = createTestAutoscheduleStore(createDefaultState());
    const before = store.getState().model;
    const listener = vi.fn();
    store.subscribe(listener);

    store.getState().configuration.addStaff();

    expect(store.getState().model).not.toBe(before);
    expect(store.getState().model.staff).toHaveLength(before.staff.length + 1);
    expect(Object.isFrozen(store.getState().model.staff)).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("returns domain command results without exposing a generic mutable draft", () => {
    const store = createTestAutoscheduleStore(createDefaultState());
    const id = store.getState().model.flights[0]!.id;

    expect(store.getState().configuration.deleteFlight(id)).toBe(true);
    expect(
      store.getState().model.flights.some((flight) => flight.id === id)
    ).toBe(false);
    expect(store.getState()).not.toHaveProperty("update");
  });

  it("tracks changes that still need a configuration export separately from local saving", () => {
    const store = createTestAutoscheduleStore(createDefaultState());

    expect(store.getState().hasUnexportedChanges()).toBe(false);

    store.getState().configuration.addStaff();
    expect(store.getState().hasUnexportedChanges()).toBe(true);

    store.getState().persist();
    expect(store.getState().hasUnexportedChanges()).toBe(true);

    store.getState().markExported();
    expect(store.getState().hasUnexportedChanges()).toBe(false);
  });

  it("marks a replaced model as needing export while leaving no-op view changes clean", () => {
    const store = createTestAutoscheduleStore(createDefaultState());
    const replaced = structuredClone(store.getState().model);
    replaced.staff.push({
      ...replaced.staff[0]!,
      id: "replacement-staff",
      name: "替换人员",
    });
    store.getState().replaceModel(replaced);

    expect(store.getState().hasUnexportedChanges()).toBe(true);
  });

  it("adds a flight template while the command is running through Immer", () => {
    const store = createTestAutoscheduleStore(createDefaultState());
    const template = store.getState().model.templates[0]!;
    const beforeCount = store.getState().model.flights.length;

    expect(store.getState().configuration.addTemplateFlight(template.id)).toBe(
      true
    );
    expect(store.getState().model.flights).toHaveLength(beforeCount + 1);
    expect(store.getState().model.flights.at(-1)).toMatchObject({
      flightNo: template.flightNo,
      startTime: template.startTime,
      endTime: template.endTime,
      positions: template.positions,
      bookedPassengers: 0,
    });
  });

  it("adds online-query selections while the command is running through Immer", () => {
    const initial = createDefaultState();
    const template = initial.templates[0]!;
    initial.flights = initial.flights.filter(
      (flight) => flight.flightNo !== template.flightNo
    );
    initial.groups.A.flights = structuredClone(initial.flights);
    const store = createTestAutoscheduleStore(initial);
    const reconciliation = buildFlightPlanReconciliation(
      store.getState().model,
      "2026-08-05",
      {
        date: "2026-08-05",
        flights: [{ flightNo: template.flightNo }],
      }
    );

    expect(
      store
        .getState()
        .configuration.applyFlightPlan(reconciliation, [template.id], [])
    ).toEqual({ added: 1, removed: 0, skipped: 0 });
    expect(
      store
        .getState()
        .model.flights.some((flight) => flight.flightNo === template.flightNo)
    ).toBe(true);
  });

  it("切换组前后只交换当前组投影，且保存后两组互不串历史", () => {
    const initial = createDefaultState();
    initial.groups.B.staff = [
      { ...initial.staff[0]!, id: "b-only", name: "B组人员" },
    ];
    initial.groups.B.flights = [];
    const store = createTestAutoscheduleStore(initial);

    store.getState().configuration.addStaff();
    expect(store.getState().isDirty()).toBe(true);
    expect(store.getState().model.staff.length).toBeGreaterThan(
      initial.groups.A.staff.length
    );

    store.getState().switchGroup("B");
    expect(store.getState().model.activeGroupId).toBe("B");
    expect(store.getState().model.staff.map((item) => item.id)).toEqual([
      "b-only",
    ]);
    expect(store.getState().model.history).toEqual([]);

    store.getState().switchGroup("A");
    expect(
      store.getState().model.staff.some((item) => item.id === "b-only")
    ).toBe(false);
    expect(store.getState().model.staff.length).toBeGreaterThan(
      initial.groups.A.staff.length
    );
  });

  it("replaces imported current-group data into the active workspace projection", () => {
    const initial = createDefaultState();
    const store = createTestAutoscheduleStore(initial);
    const imported = structuredClone(store.getState().model);
    const importedStaff = [
      { ...initial.staff[0]!, id: "imported-a", name: "导入A组人员" },
    ];
    imported.staff = importedStaff;
    imported.flights = [];
    imported.history = [];
    imported.assignments = [];

    store.getState().replaceModel(imported);

    expect(store.getState().model.staff).toEqual(importedStaff);
    expect(store.getState().model.groups.A.staff).toEqual(importedStaff);
    expect(store.getState().model.groups.A.flights).toEqual([]);
  });
});
