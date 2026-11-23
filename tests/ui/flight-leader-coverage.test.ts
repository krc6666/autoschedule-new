// @vitest-environment happy-dom
import { expect, it } from "vitest";
import {
  flightLeaderScenario,
  LEADER_DATE,
} from "../helpers/flight-leader-scenario";
import {
  createTestApplicationCoordinator,
  createTestAutoscheduleStore,
} from "../helpers/application";
import { mountElement, settleLit } from "./lit-test-helpers";
import type { UiCommand } from "../../src/ui/events/ui-command";
import type { PolicyPageElement } from "../../src/ui/components/policy-page";
import type { StaffConfigSectionElement } from "../../src/ui/components/staff-config-section";
import type { SchedulePageElement } from "../../src/ui/components/schedule-page";
import "../../src/ui/components/policy-page";
import "../../src/ui/components/staff-config-section";
import "../../src/ui/components/schedule-page";

const preferences = {
  loadScheduleDate: () => null,
  saveScheduleDate: () => undefined,
  loadScheduleZoom: () => null,
  saveScheduleZoom: () => undefined,
};

it("updates the personnel checkbox through the real command without erasing the existing schedule", async () => {
  const state = flightLeaderScenario(),
    store = createTestAutoscheduleStore(state);
  const coordinator = createTestApplicationCoordinator(store, {
    confirm: () => true,
    preferences,
  });
  const element = await mountElement<StaffConfigSectionElement>(
    "autoschedule-staff-config",
    { model: store.getState().model }
  );
  let pending: Promise<void> | undefined;
  element.addEventListener("autoschedule-command", (event) => {
    pending = coordinator
      .handle((event as CustomEvent<UiCommand>).detail)
      .then(() => {
        element.model = store.getState().model;
      });
  });
  const toggle = element.querySelector<HTMLInputElement>(
    'input[aria-label="可担任负责人"]'
  )!;
  expect(toggle.checked).toBe(true);
  toggle.checked = false;
  toggle.dispatchEvent(new Event("change", { bubbles: true }));
  await pending;
  await settleLit();
  expect(store.getState().model.staff[0]!.flightLeaderQualified).toBe(false);
  expect(store.getState().model.assignments.map((a) => a.staffId)).toEqual(
    state.assignments.map((a) => a.staffId)
  );
  expect(store.getState().model.schedulePolicyStale).toBe(true);
});

it("saves the switch and required number through the existing unified rule draft", async () => {
  const state = flightLeaderScenario();
  state.settings.flightLeaderCoverageEnabled = false;
  const store = createTestAutoscheduleStore(state),
    coordinator = createTestApplicationCoordinator(store, {
      confirm: () => true,
      preferences,
    });
  const element = await mountElement<PolicyPageElement>(
    "autoschedule-policy-page",
    { model: store.getState().model, editing: coordinator.view().policyEditing }
  );
  const panel = element.querySelector<HTMLElement>(
    '[data-policy-panel="leaders"]'
  )!;
  expect(panel.hidden).toBe(true);
  element
    .querySelector<HTMLButtonElement>('[data-policy-section="leaders"]')!
    .click();
  await settleLit();
  expect(panel.hidden).toBe(false);
  expect(
    element.querySelector(
      '[data-policy-panel="general"] [data-policy-setting="minimumFlightLeaders"]'
    )
  ).toBeNull();
  let pending: Promise<void> | undefined;
  element.addEventListener("autoschedule-command", (event) => {
    pending = coordinator
      .handle((event as CustomEvent<UiCommand>).detail)
      .then(() => {
        element.model =
          coordinator.view().policyEditing?.model ?? store.getState().model;
        element.editing = coordinator.view().policyEditing;
      });
  });
  const toggle = element.querySelector<HTMLInputElement>(
    '[data-policy-setting="flightLeaderCoverageEnabled"]'
  )!;
  expect(toggle.checked).toBe(false);
  toggle.checked = true;
  toggle.dispatchEvent(new Event("change", { bubbles: true }));
  await pending;
  await settleLit();
  const count = element.querySelector<HTMLInputElement>(
    '[data-policy-setting="minimumFlightLeaders"]'
  )!;
  expect(count.min).toBe("1");
  count.value = "2";
  count.dispatchEvent(new Event("input", { bubbles: true }));
  await pending;
  await settleLit();
  expect(store.getState().model.settings.flightLeaderCoverageEnabled).toBe(
    false
  );
  const perFlight = element.querySelector<HTMLInputElement>(
    '[data-flight-leader-flight="ZZ100"]'
  )!;
  perFlight.value = "3";
  perFlight.dispatchEvent(new Event("input", { bubbles: true }));
  await pending;
  await settleLit();
  element
    .querySelector<HTMLButtonElement>('[data-policy-section="general"]')!
    .click();
  await settleLit();
  element
    .querySelector<HTMLButtonElement>(".policy-save-bar .btn-primary")!
    .click();
  await pending;
  await settleLit();
  expect(store.getState().model.settings).toMatchObject({
    flightLeaderCoverageEnabled: true,
    minimumFlightLeaders: 2,
    flightLeaderRequirements: [{ flightNo: "ZZ100", minimum: 3 }],
  });
  expect(store.getState().model.assignments).toHaveLength(4);
});

it("shows the same final warning after a manual swap and keeps manual assignments saveable", async () => {
  const state = flightLeaderScenario();
  // Start with one leader on each flight.
  [state.assignments[1]!.staffId, state.assignments[2]!.staffId] = [
    state.assignments[2]!.staffId,
    state.assignments[1]!.staffId,
  ];
  state.assignments.forEach(
    (a) => (a.staffName = state.staff.find((p) => p.id === a.staffId)!.name)
  );
  const store = createTestAutoscheduleStore(state);
  const element = await mountElement<SchedulePageElement>(
    "autoschedule-schedule-page",
    { model: store.getState().model, date: LEADER_DATE }
  );
  expect(element.textContent).not.toContain("ZZ101无负责人");
  const result = store
    .getState()
    .schedule.assignStaff("row-1", "worker-1", "row-2");
  expect(result.changed).toBe(true);
  element.model = store.getState().model;
  await settleLit();
  expect(element.textContent).toContain("ZZ101无负责人");
  expect(element.textContent).toContain("不影响保存和归档");
  expect(() => store.getState().persist()).not.toThrow();
  const coordinator = createTestApplicationCoordinator(store, {
    confirm: () => true,
    preferences,
  });
  await coordinator.handle({ type: "archive-schedule" });
  expect(store.getState().model.history).toHaveLength(4);
  expect(
    store
      .getState()
      .model.flightLeaderCoverageHistory?.[0]?.flights.map((f) => f.actual)
  ).toEqual([2, 0]);
});
