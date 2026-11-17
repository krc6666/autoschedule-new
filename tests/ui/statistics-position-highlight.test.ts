// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { createDefaultState } from "../../src/defaults";
import type { UiCommandEvent } from "../../src/ui/events/ui-command";
import "../../src/ui/components/statistics-page";
import { mountElement, settleLit } from "./lit-test-helpers";

function fixture() {
  const state = createDefaultState();
  state.staff = state.staff
    .filter((p) => p.staffType === "常规" && p.status === "正常")
    .slice(0, 2);
  state.staff.forEach((p, i) => {
    p.id = `highlight-${i}`;
    p.name = `测试人员${i + 1}`;
  });
  state.assignments = [];
  state.history = [];
  state.settings.ordinaryPriorityPositions = [
    { airlineCode: "AK", position: "G08" },
    { airlineCode: "TR", position: "H02" },
  ];
  state.settings.latePriorityFlightNumbers = ["TR121"];
  const base = state.positionRules[0]!;
  state.positionRules = [
    {
      ...base,
      id: "ak",
      flightNo: "AK151",
      name: "G08",
      category: "常规",
      remark: "",
      qualifiedStaffIds: state.staff.map((p) => p.id),
    },
    {
      ...base,
      id: "tr",
      flightNo: "TR121",
      name: "H02",
      category: "常规",
      remark: "一号",
      qualifiedStaffIds: state.staff.map((p) => p.id),
    },
    {
      ...base,
      id: "delivery",
      flightNo: "TR121",
      name: "H04",
      category: "常规",
      remark: "送资料",
      qualifiedStaffIds: state.staff.map((p) => p.id),
    },
  ];
  return state;
}
type Page = HTMLElement & {
  model: ReturnType<typeof fixture>;
  updateComplete: Promise<unknown>;
};
async function choose(page: HTMLElement, label: string) {
  page
    .querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
    .click();
  await settleLit();
}
const selected = ".statistics-position-selected";

describe("statistics position selection visibility", () => {
  it("marks the selected ordinary column, transfers and clears it without changing counts or commands", async () => {
    const state = fixture();
    const before = structuredClone(state);
    const page = await mountElement<Page>("autoschedule-statistics-page", {
      model: state,
      date: "2026-11-18",
    });
    const table = () => page.querySelector(".ordinary-priority-summary-table")!;
    const counts = () =>
      [...table().querySelectorAll("tbody summary")].map((p) =>
        p.textContent!.trim()
      );
    const originalCounts = counts();
    expect(table().querySelector(selected)).toBeNull();
    await choose(page, "普通重点岗位筛选：AK / G08");
    expect(
      [...table().querySelectorAll(`th${selected}`)].map((p) =>
        p.textContent!.trim()
      )
    ).toEqual(["AK / G08"]);
    expect(
      table().querySelectorAll(`td${selected}[data-label="AK / G08"]`)
    ).toHaveLength(2);
    const detail = table().querySelector<HTMLDetailsElement>("details")!;
    detail.querySelector("summary")!.click();
    await settleLit();
    const commands: UiCommandEvent["detail"][] = [];
    page.addEventListener("autoschedule-command", (e) =>
      commands.push((e as UiCommandEvent).detail)
    );
    detail
      .querySelector<HTMLButtonElement>('button[aria-label="AK/G08增加一次"]')!
      .click();
    expect(commands).toEqual([
      {
        type: "adjust-ordinary-priority-frequency",
        month: "2026-11",
        staffId: state.staff[0]!.id,
        airlineCode: "AK",
        position: "G08",
        delta: 1,
      },
    ]);
    await choose(page, "普通重点岗位筛选：TR / H02");
    expect(
      table().querySelectorAll(`td${selected}[data-label="TR / H02"]`)
    ).toHaveLength(2);
    expect(
      table().querySelector(`td${selected}[data-label="AK / G08"]`)
    ).toBeNull();
    await choose(page, "普通重点岗位筛选：全部");
    expect(table().querySelector(selected)).toBeNull();
    expect(counts()).toEqual(originalCounts);
    expect(state).toEqual(before);
  });

  it("marks late category totals and details independently and retains selection after month updates", async () => {
    const state = fixture();
    const before = structuredClone(state);
    const page = await mountElement<Page>("autoschedule-statistics-page", {
      model: state,
      date: "2026-11-18",
    });
    await choose(page, "普通重点岗位筛选：AK / G08");
    await choose(page, "末班重点岗位统计类别：一号");
    const late = () => page.querySelector(".late-priority-statistics")!;
    expect(late().querySelector(`th${selected}`)?.textContent!.trim()).toBe(
      "一号"
    );
    expect(
      late().querySelectorAll(`td${selected}[data-label="一号"]`)
    ).toHaveLength(2);
    expect(
      late().querySelector(`.late-priority-range-summary ${selected}`)
        ?.textContent
    ).toContain("一号最高");
    expect(
      late().querySelectorAll(
        `.late-priority-adjustment-row${selected}[data-late-priority-category="一号"]`
      )
    ).toHaveLength(2);
    expect(
      late().querySelector(
        `.late-priority-adjustment-row${selected}[data-late-priority-category="送资料"]`
      )
    ).toBeNull();
    const detail = late().querySelector<HTMLDetailsElement>("details")!;
    detail.querySelector("summary")!.click();
    await settleLit();
    expect(detail.open).toBe(true);
    if (process.env.STATISTICS_HIGHLIGHT_ARTIFACT === "1") {
      writeFileSync(
        "docs/acceptance/evidence/2026-11-17-statistics-highlight.html",
        page.outerHTML
      );
    }
    const month = late().querySelector<HTMLInputElement>(
      'input[type="month"]'
    )!;
    month.value = "2026-10";
    month.dispatchEvent(new Event("change", { bubbles: true }));
    await settleLit();
    expect(late().querySelector(`th${selected}`)?.textContent!.trim()).toBe(
      "一号"
    );
    expect(
      page.querySelector<HTMLInputElement>(
        'input[aria-label="普通重点岗位统计月份"]'
      )!.value
    ).toBe("2026-11");
    await choose(page, "末班重点岗位统计类别：送资料");
    expect(late().querySelector(`th${selected}`)?.textContent!.trim()).toBe(
      "送资料"
    );
    expect(
      late().querySelector(
        `.late-priority-adjustment-row${selected}[data-late-priority-category="一号"]`
      )
    ).toBeNull();
    await choose(page, "末班重点岗位统计类别：全部");
    expect(late().querySelector(selected)).toBeNull();
    expect(
      page.querySelectorAll(`.ordinary-priority-summary-table td${selected}`)
    ).toHaveLength(2);
    expect(state).toEqual(before);
  });

  it("falls back to all when a selected ordinary position disappears", async () => {
    const state = fixture();
    const page = await mountElement<Page>("autoschedule-statistics-page", {
      model: state,
      date: "2026-11-18",
    });
    await choose(page, "普通重点岗位筛选：AK / G08");
    expect(
      page.querySelector(`.ordinary-priority-summary-table ${selected}`)
    ).not.toBeNull();
    const next = structuredClone(state);
    next.settings.ordinaryPriorityPositions = [
      { airlineCode: "TR", position: "H02" },
    ];
    page.model = next;
    await settleLit();
    expect(
      page.querySelector(`.ordinary-priority-summary-table ${selected}`)
    ).toBeNull();
    expect(
      page
        .querySelector('button[aria-label="普通重点岗位筛选：全部"]')!
        .getAttribute("aria-pressed")
    ).toBe("true");
  });
});
