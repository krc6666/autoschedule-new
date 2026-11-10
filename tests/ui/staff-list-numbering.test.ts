// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { createDefaultState } from "../../src/defaults";
import type { AppState } from "../../src/model";
import "../../src/ui/components/staff-palette";
import "../../src/ui/components/daily-staff-flight-statistics";
import { mountElement, settleLit } from "./lit-test-helpers";

function fixture() {
  const state = createDefaultState();
  state.staff = state.staff.slice(0, 4).map((person, index) => ({
    ...person,
    id: `staff-${index + 10}`,
    name: `P${index + 1}`,
    status: index === 1 ? "休假" : "正常",
    staffType: index === 3 ? "行政支援" : "常规",
  }));
  state.settings.adminSupportEnabled = true;
  return state;
}

const numbers = (element: Element, selector: string) =>
  [...element.querySelectorAll(selector)].map((item) =>
    item.textContent?.trim()
  );

describe("schedule personnel numbering", () => {
  it("numbers the visible palette continuously, includes leave and follows roster changes", async () => {
    const state = fixture();
    const element = await mountElement<
      HTMLElement & { model: AppState; updateComplete: Promise<unknown> }
    >("autoschedule-staff-palette", { model: state });
    expect(numbers(element, ".staff-palette-number")).toEqual([
      "1",
      "2",
      "3",
      "4",
    ]);
    expect(
      element.querySelectorAll('.staff-palette-item[draggable="false"]')
    ).toHaveLength(1);
    expect(
      element.querySelector<HTMLInputElement>(".staff-palette-name")?.value
    ).toBe("P4");
    element.model = {
      ...state,
      settings: { ...state.settings, adminSupportEnabled: false },
    };
    await settleLit();
    expect(numbers(element, ".staff-palette-number")).toEqual(["1", "2", "3"]);
    element.model = { ...state, staff: [state.staff[2]!, state.staff[0]!] };
    await settleLit();
    expect(numbers(element, ".staff-palette-number")).toEqual(["1", "2"]);
    expect(
      numbers(element, ".staff-palette-item > span:not(.staff-palette-number)")
    ).toEqual(["P3", "P1"]);
  });

  it("keeps actual staff identities in both drag commands", async () => {
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-staff-palette", { model: fixture() });
    const item = element.querySelector(".staff-palette-item")!;
    const pointer = vi.fn();
    element.addEventListener("autoschedule-pointer-drag-start", pointer);
    item.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(pointer.mock.calls[0]![0].detail).toEqual({ staffId: "staff-10" });
    const setData = vi.fn();
    const drag = new Event("dragstart");
    Object.defineProperty(drag, "dataTransfer", { value: { setData } });
    item.dispatchEvent(drag);
    expect(setData).toHaveBeenCalledWith(
      "application/x-autoschedule",
      JSON.stringify({ staffId: "staff-10" })
    );
  });

  it("renumbers daily rows after sorting and retains the zero-flight warning", async () => {
    const state = fixture();
    state.activeScheduleDate = "2026-11-10";
    state.assignments = [
      {
        id: "assigned",
        flightId: "f1",
        flightNo: "AM100",
        positionRuleId: null,
        position: "G01",
        staffId: state.staff[2]!.id,
        staffName: "P3",
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 1,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
    ];
    const element = await mountElement<
      HTMLElement & { model: AppState; updateComplete: Promise<unknown> }
    >("autoschedule-daily-staff-flight-statistics", {
      model: state,
      date: "2026-11-10",
    });
    const rows = () =>
      [...element.querySelectorAll<HTMLElement>(".daily-staff-flight-row")].map(
        (row) => ({
          id: row.dataset.staffId,
          number: row
            .querySelector(".daily-staff-flight-number")
            ?.textContent?.trim(),
          count: row
            .querySelector(".daily-staff-flight-count")
            ?.textContent?.trim(),
        })
      );
    expect(rows()).toEqual([
      { id: "staff-12", number: "1", count: "1" },
      { id: "staff-10", number: "2", count: "0" },
    ]);
    expect(
      element.querySelector(".daily-staff-flight-unassigned")?.textContent
    ).toContain("P1");
    const select = element.querySelector("select")!;
    for (const mode of ["asc", "original"]) {
      select.value = mode;
      select.dispatchEvent(new Event("change"));
      await settleLit();
      expect(rows()).toEqual([
        { id: "staff-10", number: "1", count: "0" },
        { id: "staff-12", number: "2", count: "1" },
      ]);
    }
    element.model = { ...state, staff: [state.staff[2]!] };
    await settleLit();
    expect(rows()).toEqual([{ id: "staff-12", number: "1", count: "1" }]);
    expect(element.querySelector(".daily-staff-flight-unassigned")).toBeNull();
  });
});
