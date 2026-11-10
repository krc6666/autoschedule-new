// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultState } from "../../src/defaults";
import "../../src/ui/components/statistics-page";
import "../../src/ui/components/schedule-page";
import "../../src/ui/components/overview-page";
import { mountElement, settleLit } from "./lit-test-helpers";
import { UI_COMMAND_EVENT } from "../../src/ui/events/ui-command";

afterEach(() => vi.useRealTimers());
function fixture() {
  const state = createDefaultState();
  state.staff = state.staff.filter((p) => p.staffType === "常规").slice(0, 2);
  state.staff.forEach((p, i) => {
    p.name = `P${i}`;
  });
  state.history = [
    {
      id: "oct",
      date: "2026-10-22",
      flightNo: "TEST",
      position: "G01",
      staffId: state.staff[0]!.id,
      staffName: "P0",
      startTime: "08:00",
      endTime: "10:00",
      workHours: 2,
      fatiguePoints: 8,
      remark: "",
    },
    {
      id: "nov",
      date: "2026-11-02",
      flightNo: "TEST",
      position: "G01",
      staffId: state.staff[1]!.id,
      staffName: "P1",
      startTime: "08:00",
      endTime: "10:00",
      workHours: 2,
      fatiguePoints: 5,
      remark: "",
    },
  ];
  state.assignments = [];
  state.activeScheduleDate = null;
  return state;
}
type Page = HTMLElement & { updateComplete: Promise<unknown> };
function rows(element: HTMLElement) {
  return [...element.querySelectorAll(".staff-fatigue-table tbody tr")].map(
    (row) =>
      [...row.querySelectorAll("td")].map((cell) => cell.textContent!.trim())
  );
}
describe("statistics staff fatigue", () => {
  it("opens statistics from the overview fatigue shortcut", async () => {
    const page = await mountElement<Page>("autoschedule-overview-page", {
      model: fixture(),
      date: "2026-10-22",
    });
    const command = vi.fn();
    page.addEventListener(UI_COMMAND_EVENT, command);
    [...page.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "查看全部")!
      .click();
    expect(command.mock.calls[0]?.[0].detail).toEqual({
      type: "navigate",
      section: "statistics",
    });
  });
  it("keeps custom leave labels, updates after manual changes and starts a new real month at zero", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 10, 12));
    const state = fixture();
    state.leaveTypes = [{ id: "leave", name: "飞行假", enabled: true }];
    state.staff[0]!.status = "休假";
    state.staff[0]!.leaveTypeId = "leave";
    const page = await mountElement<
      Page & { model: typeof state; date: string }
    >("autoschedule-statistics-page", { model: state, date: "2026-10-22" });
    expect(rows(page).find((r) => r[0] === "P0")?.[1]).toBe("飞行假");
    const next = structuredClone(state);
    next.history[1]!.fatiguePoints = 7;
    page.model = next;
    await settleLit();
    expect(rows(page).find((r) => r[0] === "P1")?.[3]).toBe("7.0");
    vi.setSystemTime(new Date(2026, 11, 1, 12));
    page.date = "2026-10-23";
    await settleLit();
    expect(
      page.querySelector<HTMLInputElement>(
        'input[aria-label="人员疲劳统计月份"]'
      )!.value
    ).toBe("2026-12");
    expect(rows(page).every((r) => r[3] === "0.0")).toBe(true);
    expect(next.history[1]!.fatiguePoints).toBe(7);
  });
  it("moves fatigue into statistics and defaults to the real month rather than the schedule date", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 10, 12));
    const state = fixture();
    const page = await mountElement<Page>("autoschedule-statistics-page", {
      model: state,
      date: "2026-10-22",
    });
    const month = page.querySelector<HTMLInputElement>(
      'input[aria-label="人员疲劳统计月份"]'
    );
    expect(month?.value).toBe("2026-11");
    expect(
      [...page.querySelectorAll(".staff-fatigue-table th")].map((h) =>
        h.textContent?.trim()
      )
    ).toEqual(["人员", "状态", "当日岗位疲劳", "月份累计岗位疲劳"]);
    expect(rows(page).map((r) => [r[0], r[2], r[3]])).toEqual([
      ["P1", "0.0", "5.0"],
      ["P0", "8.0", "0.0"],
    ]);
    expect(
      page.querySelector(".staff-fatigue-statistics")?.textContent
    ).toContain("2026-11-02");
    expect(
      page.querySelector(".staff-fatigue-statistics")?.textContent
    ).toContain("2026-10-22");
    state.activeScheduleDate = "2026-10-22";
    state.assignments = [
      {
        ...state.history[0]!,
        flightId: state.flights[0]!.id,
        positionRuleId: null,
        status: "assigned",
        manualRemark: "",
      },
    ];
    const schedule = await mountElement<Page>("autoschedule-schedule-page", {
      model: state,
      date: "2026-10-22",
    });
    expect(schedule.querySelector("autoschedule-schedule-grid")).not.toBeNull();
    expect(schedule.querySelector("autoschedule-staff-load-table")).toBeNull();
  });
  it("switches month, sorts both figures, restores a cleared default, and never mutates schedule or other statistics", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 10, 12));
    const state = fixture();
    const before = structuredClone(state);
    const page = await mountElement<Page>("autoschedule-statistics-page", {
      model: state,
      date: "2026-10-22",
    });
    const command = vi.fn();
    page.addEventListener(UI_COMMAND_EVENT, command);
    const ordinaryMonth = page.querySelector<HTMLInputElement>(
      'input[aria-label="普通重点岗位统计月份"]'
    )!.value;
    const month = page.querySelector<HTMLInputElement>(
      'input[aria-label="人员疲劳统计月份"]'
    )!;
    expect(month).not.toBeNull();
    month.value = "2026-10";
    month.dispatchEvent(new Event("change", { bubbles: true }));
    await settleLit();
    expect(rows(page).map((r) => [r[0], r[3]])).toEqual([
      ["P0", "8.0"],
      ["P1", "0.0"],
    ]);
    const direction = page.querySelector<HTMLSelectElement>(
      '[aria-label="疲劳排序方向"]'
    )!;
    direction.value = "asc";
    direction.dispatchEvent(new Event("change"));
    await settleLit();
    expect(rows(page)[0]?.[0]).toBe("P1");
    month.value = "2026-12";
    month.dispatchEvent(new Event("change"));
    await settleLit();
    expect(rows(page).every((r) => r[3] === "0.0")).toBe(true);
    month.value = "";
    month.dispatchEvent(new Event("change"));
    await settleLit();
    expect(month.value).toBe("2026-11");
    const field = page.querySelector<HTMLSelectElement>(
      '[aria-label="疲劳排序字段"]'
    )!;
    field.value = "todayFatigue";
    field.dispatchEvent(new Event("change"));
    direction.value = "desc";
    direction.dispatchEvent(new Event("change"));
    await settleLit();
    expect(rows(page)[0]?.[0]).toBe("P0");
    expect(
      page.querySelector<HTMLInputElement>(
        'input[aria-label="普通重点岗位统计月份"]'
      )!.value
    ).toBe(ordinaryMonth);
    expect(state).toEqual(before);
    expect(command).not.toHaveBeenCalled();
  });
});
