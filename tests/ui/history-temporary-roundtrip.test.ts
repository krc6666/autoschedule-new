// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { mountAutoscheduleApp } from "../../src/app";
import { createAutoscheduleStore } from "../../src/app/store/autoschedule-store";
import { currentScheduleHistory } from "../../src/app/history-actions";
import { createTemporaryAssignment } from "../../src/app/schedule-actions";
import type { AutoscheduleAppElement } from "../../src/ui/components/autoschedule-app";
import {
  historySyncState,
  memoryPersistence,
  syncDate,
} from "../helpers/history-sync";
import { settleLit } from "./lit-test-helpers";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("restores a bottom temporary slot, changes its person in the mounted form, saves and restarts", async () => {
  vi.stubGlobal("confirm", () => true);
  const state = historySyncState();
  createTemporaryAssignment(
    state,
    state.flights[0]!.id,
    "资料交接",
    state.staff[1]!.name,
    "bottom",
    2
  );
  state.history = currentScheduleHistory(state, syncDate);
  const persistence = memoryPersistence();
  const store = createAutoscheduleStore({ initialState: state, persistence });
  const root = document.createElement("div");
  document.body.append(root);
  dispose = mountAutoscheduleApp(root, {
    store,
    preferences: {
      loadScheduleDate: () => syncDate,
      saveScheduleDate: () => {},
      loadScheduleZoom: () => null,
      saveScheduleZoom: () => {},
    },
  }).dispose;
  const app = root.querySelector<AutoscheduleAppElement>("autoschedule-app")!;
  await app.commandHandler.handle({
    type: "edit-history-date",
    date: syncDate,
  });
  await settleLit();
  const label = [
    ...root.querySelectorAll<HTMLInputElement>('[aria-label="临时岗位名称"]'),
  ].find((i) => i.value === "资料交接");
  expect(label).toBeDefined();
  const temporary = store
    .getState()
    .model.assignments.find((a) => a.position === "资料交接")!;
  expect(temporary.layoutGroup).toBe("bottom");
  const row = label!.closest("tr")!;
  const input = row.querySelector<HTMLInputElement>(".schedule-name-input")!;
  const controls = input
    .closest(".schedule-name-row")!
    .querySelectorAll("button.icon-btn");
  expect(
    [...controls].map((button) => button.getAttribute("aria-label"))
  ).toEqual(["删除本次临时岗位", "清空人员"]);
  (controls[1] as HTMLButtonElement).click();
  await settleLit();
  expect(
    store.getState().model.assignments.find((a) => a.id === temporary.id)
      ?.staffName
  ).toBe("");
  input.value = state.staff[0]!.name;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await settleLit();
  expect(
    store.getState().model.assignments.find((a) => a.id === temporary.id)
      ?.staffId
  ).toBe(state.staff[0]!.id);
  const save = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.includes("保存并更新历史")
  )!;
  save.click();
  await settleLit();
  const saved = persistence.load();
  const record = saved.history.find(
    (r) => r.date === syncDate && r.position === "资料交接"
  )!;
  expect(record).toMatchObject({
    staffId: state.staff[0]!.id,
    temporaryPosition: { layoutGroup: "bottom", layoutIndex: 2 },
  });
  expect(record.countBaseline).toEqual({ staffId: null, staffName: "" });
  expect(record.workHours).toBe(0);
  expect(record.fatiguePoints).toBe(0);
});
