// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import { createDefaultState } from "../../src/defaults";
import { buildNextWorkdayFlightCandidates } from "../../src/domain/flights/next-workday-flight-plan";
import { buildCurrentScheduleFlightCandidates } from "../../src/domain/flights/next-workday-flight-plan";
import { replaceWeeklyFlightPlan } from "../../src/domain/flights/weekly-flight-plan";
import {
  UI_COMMAND_EVENT,
  type UiCommandEvent,
} from "../../src/ui/events/ui-command";
import "../../src/ui/components/app-dialog";
import { mountElement } from "./lit-test-helpers";

describe("next workday flight picker dialog", () => {
  it("renders current reschedule choices with today's flights selected", async () => {
    const model = createDefaultState();
    const current = [model.flights[0]!];
    current[0]!.bookedPassengers = 88;
    const candidates = buildCurrentScheduleFlightCandidates(
      model.templates,
      current
    );
    const selectedIds = candidates
      .filter((item) => item.selectedByDefault)
      .map((item) => item.id);
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-app-dialog", {
      model,
      dialog: {
        kind: "reschedule-flight-picker",
        date: "2026-08-29",
        candidates,
        selectedIds,
      },
    });

    expect(element.textContent).toContain("确认并重新排班");
    expect(
      element.querySelector('section[aria-label="人员状态确认"]')
    ).not.toBeNull();
    expect(element.textContent).not.toContain("归档并生成后天排班");
    expect(
      element.querySelectorAll('input[type="checkbox"]:checked').length
    ).toBe(1);
    expect(
      element.querySelector<HTMLInputElement>(
        'input[aria-label="CX937 预定人数"]'
      )?.value
    ).toBe("88");
  });

  it("dispatches reschedule passenger updates and selection commands", async () => {
    const model = createDefaultState();
    const candidates = buildCurrentScheduleFlightCandidates(model.templates, [
      model.flights[0]!,
    ]);
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-app-dialog", {
      model,
      dialog: {
        kind: "reschedule-flight-picker",
        date: "2026-08-29",
        candidates,
        selectedIds: candidates
          .filter((item) => item.selectedByDefault)
          .map((item) => item.id),
      },
    });
    const commands: UiCommandEvent["detail"][] = [];
    element.addEventListener(UI_COMMAND_EVENT, (event) => {
      commands.push((event as UiCommandEvent).detail);
    });

    const input = element.querySelector<HTMLInputElement>(
      'input[aria-label="CX937 预定人数"]'
    )!;
    input.value = "128";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(commands.at(-1)).toEqual({
      type: "update-reschedule-flight-picker-passengers",
      candidateId: candidates.find((item) => item.flightNo === "CX937")!.id,
      bookedPassengers: 128,
    });

    const unchecked = element.querySelector<HTMLInputElement>(
      'input[type="checkbox"]:not(:checked)'
    )!;
    unchecked.checked = true;
    unchecked.dispatchEvent(new Event("change", { bubbles: true }));
    expect(commands.at(-1)).toMatchObject({
      type: "update-reschedule-flight-picker-selection",
    });
  });

  it("renders local flight choices without an online query control", async () => {
    const model = createDefaultState();
    model.weeklyFlightPlans = replaceWeeklyFlightPlan(
      model.weeklyFlightPlans,
      1,
      [model.templates[0]!.flightNo]
    );
    const candidates = buildNextWorkdayFlightCandidates(
      model.templates,
      model.weeklyFlightPlans[0]!.flightNos
    );
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-app-dialog", {
      model,
      dialog: {
        kind: "next-workday-flight-picker",
        date: "2026-08-17",
        sourceDate: "2026-08-15",
        groupId: model.activeGroupId,
        staffStatuses: Object.fromEntries(
          model.staff.map((person) => [person.id, person.status])
        ),
        weekday: 1,
        candidates,
        selectedIds: candidates
          .filter((item) => item.selectedByDefault)
          .map((item) => item.id),
      },
    });

    expect(element.textContent).toContain("选择");
    expect(element.textContent).toContain("星期一");
    expect(element.textContent).toContain("恢复星期一预设");
    expect(element.textContent).toContain("全选");
    expect(element.textContent).toContain("清空");
    expect(element.textContent).toContain("已选择");
    expect(element.querySelectorAll('input[type="checkbox"]').length).toBe(
      candidates.length
    );
    const passengerInputs = element.querySelectorAll<HTMLInputElement>(
      'input[type="number"][data-next-workday-passengers]'
    );
    expect(passengerInputs.length).toBe(candidates.length);
    expect(passengerInputs[0]!.min).toBe("0");
    expect(passengerInputs[0]!.step).toBe("1");
    expect(element.textContent).not.toContain("在线查询");
  });

  it("dispatches a temporary passenger update for the edited flight", async () => {
    const model = createDefaultState();
    const candidates = buildNextWorkdayFlightCandidates(model.templates, []);
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-app-dialog", {
      model,
      dialog: {
        kind: "next-workday-flight-picker",
        date: "2026-08-17",
        sourceDate: "2026-08-15",
        groupId: model.activeGroupId,
        staffStatuses: Object.fromEntries(
          model.staff.map((person) => [person.id, person.status])
        ),
        weekday: 1,
        candidates,
        selectedIds: [candidates[0]!.id],
      },
    });
    const commands: UiCommandEvent["detail"][] = [];
    element.addEventListener(UI_COMMAND_EVENT, (event) => {
      commands.push((event as UiCommandEvent).detail);
    });
    const input = element.querySelector<HTMLInputElement>(
      'input[type="number"][data-next-workday-passengers]'
    )!;

    input.value = "128";
    input.dispatchEvent(new Event("change", { bubbles: true }));

    expect(commands.at(-1)).toEqual({
      type: "update-next-workday-flight-picker-passengers",
      candidateId: candidates[0]!.id,
      bookedPassengers: 128,
    });
  });
  it("renders staff status controls for schedule preflight", async () => {
    const model = createDefaultState();
    const candidates = buildCurrentScheduleFlightCandidates(
      model.templates,
      model.flights
    );
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-app-dialog", {
      model,
      dialog: {
        kind: "schedule-preflight",
        date: "2026-08-29",
        groupId: model.activeGroupId,
        candidates,
        selectedIds: candidates
          .filter((item) => item.selectedByDefault)
          .map((item) => item.id),
        staffStatuses: Object.fromEntries(
          model.staff.map((person) => [person.id, person.status])
        ),
      },
    });

    expect(element.textContent).toContain("确认休假人员");
    expect(element.querySelectorAll('select[aria-label$="状态"]').length).toBe(
      model.staff.length
    );
  });

  it.each(["schedule-preflight", "next-workday-flight-picker"] as const)(
    "%s displays configuration statuses and emits draft updates and final confirmation",
    async (kind) => {
      const model = createDefaultState();
      model.staff[0]!.status = "休假";
      model.staff[1]!.status = "病假";
      const before = structuredClone(model);
      const candidates = buildCurrentScheduleFlightCandidates(
        model.templates,
        model.flights
      );
      const selectedIds = [candidates[0]!.id];
      const element = await mountElement<
        HTMLElement & { updateComplete: Promise<unknown> }
      >("autoschedule-app-dialog", {
        model,
        dialog: {
          kind,
          date: "2026-08-17",
          sourceDate: "2026-08-15",
          weekday: 1,
          groupId: model.activeGroupId,
          candidates,
          selectedIds,
          staffStatuses: Object.fromEntries(
            model.staff.map((person) => [person.id, person.status])
          ),
        },
      });
      const commands: UiCommandEvent["detail"][] = [];
      element.addEventListener(UI_COMMAND_EVENT, (event) =>
        commands.push((event as UiCommandEvent).detail)
      );
      const selects = element.querySelectorAll<HTMLSelectElement>(
        'select[aria-label$="状态"]'
      );
      expect(selects[0]!.value).toBe("休假");
      expect(selects[1]!.value).toBe("病假");
      selects[0]!.value = "正常";
      selects[0]!.dispatchEvent(new Event("change", { bubbles: true }));
      expect(commands.at(-1)).toEqual({
        type:
          kind === "schedule-preflight"
            ? "update-schedule-preflight-staff-status"
            : "update-next-workday-flight-picker-staff-status",
        staffId: model.staff[0]!.id,
        status: "正常",
      });
      element.querySelector<HTMLButtonElement>("button.btn-success")!.click();
      expect(commands.at(-1)).toEqual({
        type:
          kind === "schedule-preflight"
            ? "confirm-schedule-preflight"
            : "confirm-next-workday-flight-picker",
        selectedIds,
      });
      expect(element.textContent).toContain(
        kind === "schedule-preflight" ? "确认并生成排班" : "归档并生成后天排班"
      );
      expect(model).toEqual(before);
    }
  );

  it.each([
    "schedule-preflight",
    "reschedule-flight-picker",
    "next-workday-flight-picker",
  ] as const)("%s displays all four duty slots", async (kind) => {
    const model = createDefaultState();
    const candidates = buildCurrentScheduleFlightCandidates(
      model.templates,
      model.flights
    );
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-app-dialog", {
      model,
      dialog: {
        kind,
        date: "2026-08-29",
        sourceDate: "2026-08-27",
        weekday: 6,
        groupId: model.activeGroupId,
        candidates,
        selectedIds: candidates
          .filter((item) => item.selectedByDefault)
          .map((item) => item.id),
        staffStatuses: Object.fromEntries(
          model.staff.map((person) => [person.id, person.status])
        ),
        dutyRoster: {
          date: "2026-08-29",
          cxPreflightStaffId: null,
          dutyStaffId: null,
          standbyStaffIds: [null, null],
          adjusted: false,
        },
      } as never,
    });
    expect(
      element.querySelector('section[aria-label="人员状态确认"]')
    ).not.toBeNull();
    expect(
      element.querySelectorAll('section[aria-label="值班人员确认"] select')
    ).toHaveLength(4);
    expect(element.textContent).toContain("CX 航前");
    expect(element.textContent).toContain("主值班");
    expect(element.textContent).toContain("次日备勤一");
    expect(element.textContent).toContain("次日备勤二");
  });
});
