// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { seasonalState } from "../helpers/seasonal-flight-scenario";
import {
  createTestApplicationCoordinator,
  createTestAutoscheduleStore,
  createTestScheduleRunner,
} from "../helpers/application";
import { mountElement, settleLit } from "./lit-test-helpers";
import type { AutoscheduleAppElement } from "../../src/ui/components/autoschedule-app";
import "../../src/ui/components/autoschedule-app";
import { flightSeasonSyncPreview } from "../../src/domain/flights/flight-season-sync";
import {
  addTemplateFlight,
  applyFlightPlanReconciliation,
  updateConfigurationField,
} from "../../src/app/configuration-actions";
import { buildFlightPlanReconciliation } from "../../src/domain/flights/flight-plan-reconciliation";

const preferences = {
  loadScheduleDate: () => "2026-11-11",
  saveScheduleDate: () => undefined,
  loadScheduleZoom: () => null,
  saveScheduleZoom: () => undefined,
};

describe("B season synchronization controls and later paths", () => {
  it("removes the yellow review when B matches A even if A has its own temporary daily time", async () => {
    const state = seasonalState();
    state.groups.B.positionRules = state.positionRules.map((r) => ({
      ...r,
      id: "b-same",
    }));
    state.groups.B.flights = [];
    state.flights = [
      {
        ...state.groups.A.flights[0]!,
        id: "a-time-difference",
        flightNo: "NEW100",
        startTime: "13:10",
        endTime: "15:10",
      },
    ];
    const store = createTestAutoscheduleStore(state);
    store.getState().switchGroup("B");
    const coordinator = createTestApplicationCoordinator(store, {
      preferences,
    });
    const el = await mountElement<AutoscheduleAppElement>("autoschedule-app", {
      model: store.getState().model,
      view: coordinator.view(),
      commandHandler: coordinator,
    });
    const before = structuredClone(store.getState().model);
    expect(el.querySelector("[data-flight-season-review]")).toBeNull();
    expect(store.getState().model).toEqual(before);
  });
  it("removes the whole yellow review immediately after a complete B-to-A synchronization", async () => {
    const state = seasonalState();
    state.groups.B.positionRules.push({
      ...state.positionRules[0]!,
      id: "b-new",
      category: "分流",
    });
    const store = createTestAutoscheduleStore(state);
    store.getState().switchGroup("B");
    const coordinator = createTestApplicationCoordinator(store, {
      preferences,
      confirm: () => true,
    });
    const el = await mountElement<AutoscheduleAppElement>("autoschedule-app", {
      model: store.getState().model,
      view: coordinator.view(),
      commandHandler: coordinator,
    });
    const unsubscribe = store.subscribe((s) => {
      el.model = s.model;
    });
    const before = structuredClone(store.getState().model);
    try {
      el.querySelector<HTMLButtonElement>("[data-sync-b-season]")!.click();
      await settleLit();
      expect(el.querySelector("[data-flight-season-review]")).toBeNull();
      expect(store.getState().model.positionRules).toEqual(
        before.positionRules
      );
      expect(store.getState().model.groups.A).toEqual(before.groups.A);
    } finally {
      unsubscribe();
    }
  });
  it.each([false, true])(
    "previews and confirms the actual button; acceptance=%s",
    async (accept) => {
      const store = createTestAutoscheduleStore(seasonalState());
      store.getState().switchGroup("B");
      const prompts: string[] = [];
      const coordinator = createTestApplicationCoordinator(store, {
        preferences,
        confirm: (message) => {
          prompts.push(message);
          return accept;
        },
      });
      const el = await mountElement<AutoscheduleAppElement>(
        "autoschedule-app",
        {
          model: store.getState().model,
          view: coordinator.view(),
          commandHandler: coordinator,
        }
      );
      const before = structuredClone(store.getState().model);
      const button = el.querySelector<HTMLButtonElement>(
        "[data-sync-b-season]"
      )!;
      expect(button.textContent).toContain("B组本季航班按A组更新");
      expect(el.textContent).toContain("岗位性质");
      button.click();
      await settleLit();
      expect(prompts[0]).toContain("OLD100");
      expect(prompts[0]).toContain("NEW100");
      const model = store.getState().model;
      expect(model.positionRules).toEqual(before.positionRules);
      expect(model.groups.A).toEqual(before.groups.A);
      if (accept) {
        expect(model.flightSeasonOverrides).toEqual({
          NEW100: true,
          OLD100: false,
        });
        el.model = model;
        await settleLit();
        expect(el.textContent).toContain("待配置B组岗位及资质");
      } else expect(model).toEqual(before);
    }
  );

  it("shows inactive job details unchanged and restores them using the real toggle", async () => {
    const state = seasonalState();
    state.templates.push({
      ...state.templates[0]!,
      id: "old",
      flightNo: "OLD100",
    });
    const store = createTestAutoscheduleStore(state);
    store.getState().switchGroup("B");
    store
      .getState()
      .configuration.syncFlightSeason(
        flightSeasonSyncPreview(store.getState().model).fingerprint
      );
    const coordinator = createTestApplicationCoordinator(store, {
      preferences,
      confirm: () => true,
    });
    await coordinator.handle({ type: "navigate", section: "config" });
    const el = await mountElement<AutoscheduleAppElement>("autoschedule-app", {
      model: store.getState().model,
      view: coordinator.view(),
      commandHandler: coordinator,
    });
    const jobs = structuredClone(store.getState().model.positionRules);
    const toggle = el.querySelector<HTMLButtonElement>(
      '[data-season-toggle="OLD100"]'
    )!;
    expect(toggle.textContent).toContain("恢复本季使用");
    expect(toggle.closest("details")!.textContent).toContain(
      "暂不使用（岗位保留）"
    );
    toggle.click();
    await settleLit();
    expect(store.getState().model.flightSeasonOverrides?.OLD100).toBe(true);
    expect(store.getState().model.positionRules).toEqual(jobs);
  });

  it("does not let pending job setup masquerade as a complete generated schedule", async () => {
    const store = createTestAutoscheduleStore(seasonalState());
    store.getState().switchGroup("B");
    store
      .getState()
      .configuration.syncFlightSeason(
        flightSeasonSyncPreview(store.getState().model).fingerprint
      );
    const calculate = vi.fn();
    const coordinator = createTestApplicationCoordinator(
      store,
      { preferences },
      createTestScheduleRunner({ calculate })
    );
    for (const [open, confirm] of [
      ["generate-schedule", "confirm-schedule-preflight"],
      ["open-reschedule-flight-picker", "confirm-reschedule-flight-picker"],
    ] as const) {
      await coordinator.handle({ type: open });
      const dialog = coordinator.view().dialog;
      expect(
        dialog &&
          "candidates" in dialog &&
          dialog.candidates.map((f) => f.flightNo)
      ).toEqual(["NEW100"]);
      if (!dialog || !("candidates" in dialog))
        throw new Error("missing picker");
      const before = structuredClone(coordinator.model());
      await coordinator.handle({
        type: confirm,
        selectedIds: dialog.candidates.map((f) => f.id),
      });
      expect(coordinator.model()).toEqual(before);
      expect(coordinator.view().toast?.message).toContain("尚未配置本组岗位");
      await coordinator.handle({ type: "close-dialog" });
    }
    expect(calculate).not.toHaveBeenCalled();
  });

  it("keeps inactive flights out of online/direct additions and carries the choice through a shared rename", () => {
    const state = seasonalState();
    state.flightSeasonOverrides = { NEW100: false };
    expect(addTemplateFlight(state, "new")).toBe(false);
    const reconciliation = buildFlightPlanReconciliation(state, "2026-11-11", {
      date: "2026-11-11",
      flights: [{ flightNo: "NEW100" }],
    });
    expect(reconciliation.additions).toEqual([]);
    const before = structuredClone(state);
    expect(
      applyFlightPlanReconciliation(state, reconciliation, ["new"], []).added
    ).toBe(0);
    expect(state).toEqual(before);
    expect(
      updateConfigurationField(state, "template", "new", "flightNo", "NEW200")
    ).toBe("updated");
    expect(state.flightSeasonOverrides).toEqual({ NEW200: false });
    expect(addTemplateFlight(state, "new")).toBe(false);
  });
});
