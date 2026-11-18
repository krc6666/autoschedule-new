// @vitest-environment happy-dom
import { expect, it } from "vitest";
import "../../src/ui/components/statistics-page";
import {
  relaxedMatrixFixture,
  matrixHistory,
} from "../helpers/relaxed-flight-matrix";
import {
  mountElement,
  settleLit,
  type LitTestElement,
} from "./lit-test-helpers";
import {
  UI_COMMAND_EVENT,
  type UiCommandEvent,
} from "../../src/ui/events/ui-command";

it("renders personnel × selectable flights and opens date-only details using the existing late table style", async () => {
  const state = relaxedMatrixFixture();
  const page = await mountElement<LitTestElement>(
    "autoschedule-statistics-page",
    { model: state, date: "2026-11-18" }
  );
  const table = page.querySelector(".relaxed-shift-table")!;
  expect(
    [...table.querySelectorAll("th")].map((c) => c.textContent?.trim())
  ).toEqual(["人员", "MF8001", "CX937", "下午空", "下午休"]);
  expect(
    [...table.querySelectorAll("tbody tr td:first-child")].map((c) =>
      c.textContent?.trim()
    )
  ).toEqual(["甲", "乙", "丙", "丁", "戊"]);
  const detail = table.querySelector<HTMLDetailsElement>(
    'tr:first-child td[data-label="MF8001"] details'
  )!;
  expect(detail.classList.contains("late-priority-count-detail")).toBe(true);
  expect(detail.querySelector("summary")!.textContent?.trim()).toBe("1");
  detail.open = true;
  detail.dispatchEvent(new Event("toggle"));
  expect(
    detail.querySelector(".late-priority-detail-list")!.textContent?.trim()
  ).toBe("11-18");
  const commands: unknown[] = [];
  page.addEventListener(UI_COMMAND_EVENT, (e) =>
    commands.push((e as UiCommandEvent).detail)
  );
  const choice = page.querySelector<HTMLInputElement>(
    'input[aria-label="轻松班次统计航班：CX937"]'
  )!;
  choice.checked = false;
  choice.dispatchEvent(new Event("change", { bubbles: true }));
  expect(commands).toContainEqual({
    type: "set-relaxed-shift-flights",
    flightNumbers: ["MF8001"],
  });
  expect(state.settings.latePriorityFlightNumbers.length).toBeGreaterThan(0);
});

it("switches months independently, keeps 0 clickable and recomputes after final assignments change", async () => {
  const state = relaxedMatrixFixture();
  state.history = [matrixHistory(state.assignments[0]!, "2026-10-20")];
  const page = await mountElement<LitTestElement>(
    "autoschedule-statistics-page",
    { model: state, date: "2026-11-18" }
  );
  const month = page.querySelector<HTMLInputElement>(
    'input[aria-label="轻松班次统计月份"]'
  )!;
  expect(month).not.toBeNull();
  month.value = "2026-10";
  month.dispatchEvent(new Event("change", { bubbles: true }));
  await settleLit();
  expect(
    page.querySelector(
      '.relaxed-shift-table tr:first-child td[data-label="MF8001"] .late-priority-detail-list'
    )!.textContent
  ).toContain("10-20");
  expect(
    page.querySelector<HTMLInputElement>(
      'input[aria-label="末班重点岗位统计月份"]'
    )!.value
  ).toBe("2026-11");
  const zero = page.querySelector(
    '.relaxed-shift-table tr:first-child td[data-label="CX937"] details'
  )!;
  expect(zero.querySelector("summary")!.textContent?.trim()).toBe("0");
  expect(zero.textContent).toContain("暂无日期");
  month.value = "2026-11";
  month.dispatchEvent(new Event("change", { bubbles: true }));
  await settleLit();
  const changed = structuredClone(state);
  changed.assignments[1]!.staffId = changed.staff[0]!.id;
  changed.assignments[1]!.staffName = changed.staff[0]!.name;
  Object.assign(page, { model: changed });
  await settleLit();
  expect(
    page
      .querySelector(
        '.relaxed-shift-table tr:first-child td[data-label="下午空"] summary'
      )!
      .textContent?.trim()
  ).toBe("1");
  expect(
    page
      .querySelector(
        '.relaxed-shift-table tr:first-child td[data-label="下午休"] summary'
      )!
      .textContent?.trim()
  ).toBe("0");
  changed.assignments = [];
  Object.assign(page, { model: structuredClone(changed) });
  await settleLit();
  expect(
    page
      .querySelector(
        '.relaxed-shift-table tr:first-child td[data-label="下午空"] summary'
      )!
      .textContent?.trim()
  ).toBe("0");
});
