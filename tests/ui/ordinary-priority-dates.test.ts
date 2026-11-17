// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { createDefaultState } from "../../src/defaults";
import type { HistoryRecord } from "../../src/model";
import type { UiCommandEvent } from "../../src/ui/events/ui-command";
import "../../src/ui/components/statistics-page";
import { mountElement, settleLit } from "./lit-test-helpers";

function fixture() {
  const state = createDefaultState();
  state.staff = state.staff
    .filter((p) => p.staffType === "常规" && p.status === "正常")
    .slice(0, 3);
  state.staff.forEach((person, index) => {
    person.name = `日期测试人员${index + 1}`;
  });
  const [first, second] = state.staff;
  state.assignments = [];
  state.settings.ordinaryPriorityPositions = [
    { airlineCode: "AK", position: "G08" },
  ];
  state.positionRules = [
    {
      ...state.positionRules[0]!,
      id: "ak-g08",
      flightNo: "AK151",
      name: "G08",
      category: "常规",
      qualifiedStaffIds: state.staff.map((p) => p.id),
    },
  ];
  const row: HistoryRecord = {
    id: "first",
    date: "2026-11-02",
    flightNo: "AK151",
    position: "G08",
    staffId: first!.id,
    staffName: first!.name,
    startTime: "08:00",
    endTime: "10:00",
    workHours: 2,
    fatiguePoints: 3,
    remark: "",
  };
  state.history = [
    row,
    { ...row, id: "second", date: "2026-11-06", flightNo: "AK153" },
    { ...row, id: "other-month", date: "2026-10-08" },
    {
      ...row,
      id: "recipient",
      date: "2026-11-10",
      staffId: second!.id,
      staffName: second!.name,
      countBaseline: { staffId: first!.id, staffName: first!.name },
    },
  ];
  state.ordinaryPriorityFrequencyAdjustments = [
    {
      month: "2026-11",
      staffId: first!.id,
      airlineCode: "AK",
      position: "G08",
      delta: 1,
    },
  ];
  return state;
}
type Page = HTMLElement & {
  model: ReturnType<typeof fixture>;
  updateComplete: Promise<unknown>;
};
const detailFor = (page: HTMLElement, id: string) =>
  page.querySelector<HTMLDetailsElement>(
    `.ordinary-priority-count-detail[data-staff-id="${id}"]`
  )!;
const datesFor = (page: HTMLElement, id: string) =>
  detailFor(page, id)
    .querySelector(".late-priority-detail-list")
    ?.textContent?.trim();

describe("ordinary priority count dates", () => {
  it("expands dates only using the late-priority detail style, preserving correction commands and month selection", async () => {
    const state = fixture();
    const page = await mountElement<Page>("autoschedule-statistics-page", {
      model: state,
      date: "2026-11-18",
    });
    const first = state.staff[0]!;
    const detail = detailFor(page, first.id);
    expect(detail.open).toBe(false);
    detail.querySelector("summary")!.click();
    await settleLit();
    expect(detail.open).toBe(true);
    expect(datesFor(page, first.id)).toBe("11-02、11-06");
    expect(detail.querySelector("summary")!.textContent!.trim()).toBe("3");
    expect(detail.textContent!.replace(/\s+/g, " ")).toContain(
      "实际 3 · 修正 +0"
    );
    expect(datesFor(page, state.staff[1]!.id)).toBe("11-10");
    expect(datesFor(page, state.staff[2]!.id)).toBeUndefined();
    const commands: UiCommandEvent["detail"][] = [];
    page.addEventListener("autoschedule-command", (event) =>
      commands.push((event as UiCommandEvent).detail)
    );
    detail
      .querySelector<HTMLButtonElement>('button[aria-label="AK/G08增加一次"]')!
      .click();
    expect(commands).toEqual([
      {
        type: "adjust-ordinary-priority-frequency",
        month: "2026-11",
        staffId: first.id,
        airlineCode: "AK",
        position: "G08",
        delta: 1,
      },
    ]);
    const before = structuredClone(state);
    page
      .querySelector<HTMLButtonElement>(
        'button[aria-label="普通重点岗位筛选：AK / G08"]'
      )!
      .click();
    await settleLit();
    expect(datesFor(page, first.id)).toBe("11-02、11-06");
    writeFileSync(
      "docs/acceptance/evidence/2026-11-17-ordinary-dates.html",
      page.outerHTML
    );
    const month = page.querySelector<HTMLInputElement>(
      'input[aria-label="普通重点岗位统计月份"]'
    )!;
    month.value = "2026-10";
    month.dispatchEvent(new Event("change", { bubbles: true }));
    await settleLit();
    expect(datesFor(page, first.id)).toBe("10-08");
    expect(
      page.querySelector<HTMLInputElement>(
        'input[aria-label="末班重点岗位统计月份"]'
      )?.value
    ).not.toBe("2026-10");
    expect(state).toEqual(before);
  });

  it("uses current final staff instead of the same-date archive and retains actual dates without today's qualification", async () => {
    const state = fixture();
    const row = state.history[0]!;
    state.history = [{ ...row, date: "2026-11-18" }];
    state.activeScheduleDate = "2026-11-18";
    state.assignments = [
      {
        ...row,
        id: "current",
        flightId: "ak151",
        positionRuleId: "ak-g08",
        staffId: state.staff[1]!.id,
        staffName: state.staff[1]!.name,
        countBaseline: {
          staffId: state.staff[0]!.id,
          staffName: state.staff[0]!.name,
        },
        status: "assigned",
        manualRemark: "",
      },
    ];
    state.positionRules[0]!.qualifiedStaffIds = [];
    const page = await mountElement<Page>("autoschedule-statistics-page", {
      model: state,
      date: "2026-11-18",
    });
    expect(datesFor(page, state.staff[0]!.id)).toBeUndefined();
    expect(datesFor(page, state.staff[1]!.id)).toBe("11-18");
    const next = structuredClone(state);
    next.assignments[0]!.staffId = null;
    next.assignments[0]!.staffName = "";
    next.assignments[0]!.status = "unfilled";
    page.model = next;
    await settleLit();
    expect(datesFor(page, state.staff[0]!.id)).toBeUndefined();
    expect(
      page.querySelectorAll(
        ".ordinary-priority-count-detail .late-priority-detail-list"
      )
    ).toHaveLength(0);
  });
});
