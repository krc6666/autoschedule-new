// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { createDefaultState } from "../../src/defaults";
import { createBrowserPreferences } from "../../src/infrastructure/browser-preferences";
import {
  UI_COMMAND_EVENT,
  type UiCommandEvent,
} from "../../src/ui/events/ui-command";
import "../../src/ui/components/app-dialog";
import { mountElement, settleLit } from "./lit-test-helpers";
import {
  createTestApplicationCoordinator,
  createTestAutoscheduleStore,
} from "../helpers/application";

describe("准备窗口控件保存与重新挂载", () => {
  it.each([
    "generate-schedule",
    "open-reschedule-flight-picker",
    "archive-next-duty-day",
  ] as const)("%s 输入后立即保存，新页面控件恢复相同选项", async (open) => {
    const model = createDefaultState();
    model.staff = model.staff.slice(0, 4).map((person, index) => ({
      ...person,
      name: `测试${index}`,
      status: "正常",
    }));
    model.activeScheduleDate = "2026-11-13";
    const flight = model.flights[0]!;
    model.assignments = [
      {
        id: "original",
        flightId: flight.id,
        flightNo: flight.flightNo,
        positionRuleId: null,
        position: "原岗位",
        staffId: model.staff[0]!.id,
        staffName: model.staff[0]!.name,
        startTime: flight.startTime,
        endTime: flight.endTime,
        workHours: 2,
        fatiguePoints: 1,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
    ];
    localStorage.clear();
    createBrowserPreferences().saveScheduleDate("2026-11-13");
    const store = createTestAutoscheduleStore(model);
    const create = () =>
      createTestApplicationCoordinator(store, {
        preferences: createBrowserPreferences(),
      });
    const coordinator = create();
    await coordinator.handle({ type: open });
    const original = structuredClone(coordinator.model());
    let element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-app-dialog", {
      model: coordinator.model(),
      dialog: coordinator.view().dialog,
    });
    const pending: Promise<void>[] = [];
    element.addEventListener(UI_COMMAND_EVENT, (event) => {
      pending.push(coordinator.handle((event as UiCommandEvent).detail));
    });
    const passenger = element.querySelector<HTMLInputElement>(
      "input[data-next-workday-passengers]"
    )!;
    const passengerLabel = passenger.getAttribute("aria-label")!;
    passenger.value = "246";
    passenger.dispatchEvent(new Event("input", { bubbles: true }));
    const status = element.querySelector<HTMLSelectElement>(
      'select[aria-label="测试0 状态"]'
    )!;
    status.value = "休假";
    status.dispatchEvent(new Event("change", { bubbles: true }));
    const mode = element.querySelector<HTMLInputElement>(
      'input[role="switch"]'
    )!;
    mode.checked = true;
    mode.dispatchEvent(new Event("change", { bubbles: true }));
    const duty = element.querySelector<HTMLSelectElement>(
      'select[aria-label="主值班"]'
    )!;
    duty.value = "";
    duty.dispatchEvent(new Event("change", { bubbles: true }));
    const boxes = [
      ...element.querySelectorAll<HTMLInputElement>(
        '.next-workday-flight-choice input[type="checkbox"]'
      ),
    ];
    boxes[0]!.checked = true;
    boxes[0]!.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.all(pending);
    const refreshed = create();
    await refreshed.handle({ type: open });
    element = await mountElement("autoschedule-app-dialog", {
      model: refreshed.model(),
      dialog: refreshed.view().dialog,
    });
    await settleLit();
    expect(
      element.querySelector<HTMLInputElement>(
        `input[aria-label="${passengerLabel}"]`
      )!.value
    ).toBe("246");
    expect(
      element.querySelector<HTMLSelectElement>(
        'select[aria-label="测试0 状态"]'
      )!.value
    ).toBe("休假");
    expect(
      element.querySelector<HTMLInputElement>('input[role="switch"]')!.checked
    ).toBe(true);
    expect(
      element.querySelector<HTMLSelectElement>('select[aria-label="主值班"]')!
        .value
    ).toBe("");
    expect(
      element.querySelector<HTMLInputElement>(
        '.next-workday-flight-choice input[type="checkbox"]'
      )!.checked
    ).toBe(true);
    const selectedCount = [
      ...element.querySelectorAll<HTMLInputElement>(
        '.next-workday-flight-choice input[type="checkbox"]'
      ),
    ].filter((input) => input.checked).length;
    expect(element.textContent).toContain(`已选择 ${selectedCount} 个航班`);
    expect(refreshed.model()).toEqual(original);
  });
});
