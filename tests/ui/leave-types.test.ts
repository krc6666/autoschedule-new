// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { createDefaultState } from "../../src/defaults";
import {
  createTestApplicationCoordinator,
  createTestAutoscheduleStore,
} from "../helpers/application";
import {
  UI_COMMAND_EVENT,
  type UiCommand,
} from "../../src/ui/events/ui-command";
import "../../src/ui/components/config-page";
import "../../src/ui/components/app-dialog";
import { mountElement, settleLit } from "./lit-test-helpers";

describe("leave types in personnel configuration", () => {
  it.each([
    "generate-schedule",
    "open-reschedule-flight-picker",
    "archive-next-duty-day",
  ] as const)(
    "%s offers custom names and retains a selected disabled category",
    async (open) => {
      const state = createDefaultState();
      state.leaveTypes = [
        { id: "flight", name: "飞行假", enabled: true },
        { id: "annual", name: "年假", enabled: false },
      ];
      state.staff = state.staff.slice(0, 2).map((person, index) => ({
        ...person,
        name: index ? "乙" : "甲",
        status: index ? "正常" : "休假",
        ...(index ? {} : { leaveTypeId: "annual" }),
      }));
      state.activeScheduleDate = "2026-11-10";
      const coordinator = createTestApplicationCoordinator(
        createTestAutoscheduleStore(state),
        {
          preferences: {
            loadScheduleDate: () => "2026-11-10",
            saveScheduleDate: () => {},
            loadScheduleZoom: () => null,
            saveScheduleZoom: () => {},
          },
          confirm: () => true,
        }
      );
      await coordinator.handle({ type: open });
      const element = await mountElement<
        HTMLElement & { updateComplete: Promise<unknown> }
      >("autoschedule-app-dialog", {
        model: coordinator.model(),
        dialog: coordinator.view().dialog,
      });
      const selected = element.querySelector<HTMLSelectElement>(
        '[aria-label="甲 状态"]'
      )!;
      expect(selected.value).toBe("leave:annual");
      expect(selected.selectedOptions[0]!.textContent).toContain("年假");
      const normal = element.querySelector<HTMLSelectElement>(
        '[aria-label="乙 状态"]'
      )!;
      expect(
        [...normal.options].map((option) => option.textContent?.trim())
      ).toEqual(["正常", "病假", "休假", "飞行假"]);
      const commands: UiCommand[] = [];
      element.addEventListener(UI_COMMAND_EVENT, (event) =>
        commands.push((event as CustomEvent<UiCommand>).detail)
      );
      normal.value = "leave:flight";
      normal.dispatchEvent(new Event("change", { bubbles: true }));
      expect(commands[0]).toMatchObject({
        staffId: state.staff[1]!.id,
        status: "leave:flight",
      });
    }
  );
  it("adds a named leave through the page and lets the operator select it as a person's status", async () => {
    const initial = createDefaultState();
    initial.staff = [
      { ...initial.staff[0]!, id: "example", name: "示例人员", status: "正常" },
    ];
    const store = createTestAutoscheduleStore(initial);
    const coordinator = createTestApplicationCoordinator(store, {
      preferences: {
        loadScheduleDate: () => null,
        saveScheduleDate: () => {},
        loadScheduleZoom: () => null,
        saveScheduleZoom: () => {},
      },
    });
    const element = await mountElement<
      HTMLElement & { model: typeof initial; updateComplete: Promise<unknown> }
    >("autoschedule-config-page", { model: store.getState().model });
    const management = element.querySelector<HTMLDetailsElement>(
      "autoschedule-leave-types details"
    );
    expect(management).not.toBeNull();
    expect(management!.open).toBe(false);
    const toggle = management!.querySelector<HTMLElement>("summary")!;
    expect(toggle.textContent?.trim()).toBe("管理休假类别");
    toggle.click();
    expect(management!.open).toBe(true);
    const pending: Promise<void>[] = [];
    element.addEventListener(UI_COMMAND_EVENT, (event) => {
      pending.push(
        coordinator
          .handle((event as CustomEvent<UiCommand>).detail)
          .then(() => {
            element.model = store.getState().model;
          })
      );
    });
    const input = element.querySelector<HTMLInputElement>(
      '[aria-label="新增休假类别名称"]'
    );
    expect(input).not.toBeNull();
    input!.value = "飞行假";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    element
      .querySelector<HTMLButtonElement>('[aria-label="新增休假类别"]')!
      .click();
    await Promise.all(pending);
    await settleLit();
    const status = element.querySelector<HTMLSelectElement>(
      'select[aria-label="状态"]'
    )!;
    const option = [...status.options].find(
      (item) => item.textContent?.trim() === "飞行假"
    );
    expect(option).toBeDefined();
    expect([...status.options].map((item) => item.textContent?.trim())).toEqual(
      ["正常", "病假", "休假", "飞行假"]
    );
    status.value = option!.value;
    status.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.all(pending);
    await settleLit();
    expect(store.getState().model.staff[0]!.status).toBe("休假");
    expect(
      element
        .querySelector<HTMLSelectElement>('select[aria-label="状态"]')!
        .selectedOptions[0]!.textContent?.trim()
    ).toBe("飞行假");
    const name = element.querySelector<HTMLInputElement>(
      '[aria-label="休假类别名称：飞行假"]'
    )!;
    name.value = "正常";
    name.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.all(pending);
    await settleLit();
    expect(store.getState().model.leaveTypes[0]!.name).toBe("飞行假");
    expect(name.value).toBe("飞行假");
    expect(management!.open).toBe(true);
    const commandsBeforeToggle = pending.length;
    toggle.click();
    expect(management!.open).toBe(false);
    expect(pending).toHaveLength(commandsBeforeToggle);
    expect(status.value).toBe(option!.value);
    toggle.click();
    expect(management!.open).toBe(true);
    expect(name.value).toBe("飞行假");
  });
});
