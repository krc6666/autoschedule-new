// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { mountAutoscheduleApp } from "../../src/app";
import { createDefaultState } from "../../src/defaults";
import { createAutoscheduleStore } from "../../src/app/store/autoschedule-store";
import type { AutoscheduleAppElement } from "../../src/ui/components/autoschedule-app";
import { memoryPersistence } from "../helpers/history-sync";
import { settleLit } from "./lit-test-helpers";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
});
it("searches, toggles, saves and restarts using the same rules draft and Store", async () => {
  const persistence = memoryPersistence();
  const store = createAutoscheduleStore({
    initialState: createDefaultState(),
    persistence,
  });
  const root = document.createElement("div");
  document.body.append(root);
  dispose = mountAutoscheduleApp(root, { store }).dispose;
  const app = root.querySelector<AutoscheduleAppElement>("autoschedule-app")!;
  await app.commandHandler.handle({ type: "navigate", section: "policy" });
  await settleLit();
  const search = root.querySelector<HTMLInputElement>('input[type="search"]')!;
  search.value = "末班航司交替";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await settleLit();
  const input = root.querySelector<HTMLInputElement>(
    '[data-policy-setting="lateAirlineRotationEnabled"]'
  )!;
  expect(input).not.toBeNull();
  expect(input.checked).toBe(true);
  input.checked = false;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await settleLit();
  expect(store.getState().model.settings.lateAirlineRotationEnabled).toBe(true);
  expect(root.querySelector(".policy-save-bar")?.textContent).toContain(
    "未保存"
  );
  root
    .querySelector<HTMLButtonElement>(".policy-save-bar .btn-primary")!
    .click();
  await settleLit();
  expect(store.getState().model.settings.lateAirlineRotationEnabled).toBe(
    false
  );
  expect(persistence.load().settings.lateAirlineRotationEnabled).toBe(false);
  expect(
    store.getState().model.groups.B.settings.lateAirlineRotationEnabled
  ).toBe(true);
});
