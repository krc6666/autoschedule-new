// @vitest-environment happy-dom
import { expect, it } from "vitest";
import {
  independentGuideScenario,
  GUIDE_DATE,
} from "../helpers/independent-guide-scenario";
import { buildSchedulePageModel } from "../../src/ui/projections/schedule-page-model";
import { createTestAutoscheduleStore } from "../helpers/application";
import {
  UI_COMMAND_EVENT,
  type UiCommandEvent,
} from "../../src/ui/events/ui-command";
import "../../src/ui/components/schedule-grid";
import { mountElement, settleLit } from "./lit-test-helpers";

it("实际姓名输入命令清柜台再填独立人员，重渲染与候选列表保留该人", async () => {
  const store = createTestAutoscheduleStore(independentGuideScenario());
  const element = await mountElement<
    HTMLElement & {
      model: ReturnType<typeof independentGuideScenario>;
      view: ReturnType<typeof buildSchedulePageModel>;
      updateComplete: Promise<unknown>;
    }
  >("autoschedule-schedule-grid", {
    model: store.getState().model,
    view: buildSchedulePageModel(store.getState().model, GUIDE_DATE, {
      zoom: 1,
    }),
  });
  element.addEventListener(UI_COMMAND_EVENT, (event) => {
    const command = (event as UiCommandEvent).detail;
    if (command.type === "update-assignment")
      store
        .getState()
        .schedule.updateAssignment(command.id, command.field, command.value);
  });
  const lowerInput = element.querySelector<HTMLInputElement>(
    '[data-assignment-id="a1"] .schedule-name-input'
  )!;
  lowerInput.value = "";
  lowerInput.dispatchEvent(new Event("change", { bubbles: true }));
  const input = element.querySelector<HTMLInputElement>(
    '[data-assignment-id="a2"] .schedule-name-input'
  )!;
  input.value = "人员1";
  input.dispatchEvent(new Event("change", { bubbles: true }));
  element.model = store.getState().model;
  element.view = buildSchedulePageModel(element.model, GUIDE_DATE, { zoom: 1 });
  await settleLit();
  expect(element.model.assignments[2]).toMatchObject({
    staffId: "p1",
    guideMode: "independent",
    workHours: 2,
    fatiguePoints: 5,
  });
  expect(
    element.querySelector<HTMLInputElement>(
      '[data-assignment-id="a2"] .schedule-name-input'
    )?.value
  ).toBe("人员1");
  expect(
    [
      ...element.querySelectorAll<HTMLOptionElement>(
        "#schedule-guide-staff-0 option"
      ),
    ].map((o) => o.value)
  ).toContain("人员2");
});
