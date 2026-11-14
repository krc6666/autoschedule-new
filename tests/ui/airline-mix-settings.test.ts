// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { createDefaultState } from "../../src/defaults";
import {
  createTestApplicationCoordinator,
  createTestAutoscheduleStore,
} from "../helpers/application";
import type { UiCommand } from "../../src/ui/events/ui-command";
import "../../src/ui/components/policy-page";
import "../../src/ui/components/app-dialog";
import { mountElement, settleLit } from "./lit-test-helpers";

it("edits, disables, adds and deletes carrier groups through actual controls, controller and Store", async () => {
  const initial = createDefaultState();
  initial.assignments = [
    {
      id: "manual",
      flightId: "one",
      flightNo: "FD101",
      positionRuleId: null,
      position: "临时岗位",
      staffId: null,
      staffName: "",
      startTime: "08:00",
      endTime: "10:00",
      workHours: 0,
      fatiguePoints: 0,
      remark: "",
      manualRemark: "",
      status: "manual",
    },
  ];
  const store = createTestAutoscheduleStore(initial);
  const coordinator = createTestApplicationCoordinator(store, {
    confirm: () => true,
    preferences: {
      loadScheduleDate: () => null,
      saveScheduleDate: () => undefined,
      loadScheduleZoom: () => null,
      saveScheduleZoom: () => undefined,
    },
  });
  const element = await mountElement<
    HTMLElement & { model: typeof initial; updateComplete: Promise<unknown> }
  >("autoschedule-policy-page", { model: store.getState().model });
  let pending: Promise<void> | undefined;
  const unsubscribe = store.subscribe(() => {
    element.model = store.getState().model;
  });
  element.addEventListener("autoschedule-command", (event) => {
    pending = coordinator.handle((event as CustomEvent<UiCommand>).detail);
  });
  const card = () =>
    element.querySelector<HTMLElement>("[data-airline-mix-policies]")!;
  expect(card().textContent).toContain("当天只有组内航班");
  const input = card().querySelector<HTMLInputElement>('input[type="text"]')!;
  input.value = "cx，tr,KE";
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await pending;
  await settleLit();
  expect(
    store.getState().model.settings.airlineMixPolicies[0]!.airlineCodes
  ).toEqual(["CX", "TR", "KE"]);
  expect(store.getState().model.schedulePolicyStale).toBe(true);
  const invalid = card().querySelector<HTMLInputElement>('input[type="text"]')!;
  invalid.value = "FD573,AK151";
  invalid.dispatchEvent(new Event("change", { bubbles: true }));
  await pending;
  await settleLit();
  expect(
    store.getState().model.settings.airlineMixPolicies[0]!.airlineCodes
  ).toEqual(["CX", "TR", "KE"]);
  expect(coordinator.view().toast?.message).toContain("原设置未更改");
  const toggle = card().querySelector<HTMLInputElement>(
    'input[type="checkbox"]'
  )!;
  toggle.checked = false;
  toggle.dispatchEvent(new Event("change", { bubbles: true }));
  await pending;
  await settleLit();
  expect(store.getState().model.settings.airlineMixPolicies[0]!.enabled).toBe(
    false
  );
  const ledger = [...element.querySelectorAll(".policy-ledger tbody tr")].find(
    (row) => row.textContent?.includes("航司搭配偏好")
  )!;
  expect(ledger.textContent).toContain("已停用");
  card().querySelector<HTMLButtonElement>("button")!.click();
  await pending;
  await settleLit();
  expect(store.getState().model.settings.airlineMixPolicies).toHaveLength(2);
  const draft = [
    ...card().querySelectorAll<HTMLElement>("[data-airline-mix-id]"),
  ].at(-1)!;
  expect(draft.textContent).toContain("至少两个航司代码");
  draft.querySelector<HTMLButtonElement>('button[aria-label="删除"]')!.click();
  await pending;
  await settleLit();
  expect(store.getState().model.settings.airlineMixPolicies).toHaveLength(1);
  unsubscribe();
});

it("finds the preference and the editor by searching its name or a configured carrier", async () => {
  const element = await mountElement<
    HTMLElement & { updateComplete: Promise<unknown> }
  >("autoschedule-policy-page", { model: createDefaultState() });
  const search = element.querySelector<HTMLInputElement>(
    'input[type="search"]'
  )!;
  search.value = "航司搭配偏好";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await settleLit();
  expect(element.querySelectorAll(".policy-ledger tbody tr")).toHaveLength(1);
  expect(element.querySelector("[data-airline-mix-policies]")).not.toBeNull();
  search.value = "AK";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await settleLit();
  expect(
    element.querySelector<HTMLDetailsElement>("[data-airline-mix-policies]")!
      .open
  ).toBe(true);
});

it("shows imported carrier groups, their disabled state, and explicit clearing in the import preview", async () => {
  const model = createDefaultState();
  model.settings.airlineMixPolicies = [
    { id: "custom", enabled: false, airlineCodes: ["KE", "TR"] },
  ];
  const imported = { settings: structuredClone(model.settings), warnings: [] };
  const element = await mountElement<
    HTMLElement & { dialog: unknown; updateComplete: Promise<unknown> }
  >("autoschedule-app-dialog", {
    model,
    dialog: {
      kind: "workbook-import",
      mode: "config",
      imported,
      recognized: "规则配置",
      changedConfig: true,
      sharedTemplatesAvailable: false,
      replaceSharedTemplates: false,
      warnings: [],
    },
  });
  expect(element.textContent).toContain("航司搭配偏好");
  expect(element.textContent).toContain("KE、TR（停用）");
  imported.settings.airlineMixPolicies = [];
  element.dialog = {
    kind: "workbook-import",
    mode: "config",
    imported,
    recognized: "规则配置",
    changedConfig: true,
    sharedTemplatesAvailable: false,
    replaceSharedTemplates: false,
    warnings: [],
  };
  await settleLit();
  expect(element.textContent).toContain("清空全部组合偏好");
});
