// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

import { createDefaultState } from "../../src/defaults";
import { APPLICATION_NAVIGATION } from "../../src/ui/projections/application-navigation";
import "../../src/ui/components/autoschedule-app";
import type { ApplicationViewState } from "../../src/app/application-view-state";
import { mountElement } from "./lit-test-helpers";

const view: ApplicationViewState = {
  section: "policy",
  date: "2026-07-18",
  zoom: 1,
  halfRestStaffIds: [],
  halfRestModes: {},
  dialog: null,
  toast: null,
  progress: {
    outcome: "idle",
    visible: false,
    stage: "prepare",
    percent: 0,
    steps: [],
    canAdoptCurrentResult: false,
  },
};

describe("application shell", () => {
  it("keeps the seven work modules in their confirmed order and all data entries", async () => {
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-app", {
      model: createDefaultState(),
      view,
      commandHandler: { handle: vi.fn().mockResolvedValue(undefined) },
    });
    const labels = [
      ...element.querySelectorAll<HTMLButtonElement>(".app-nav button"),
    ].map((button) => button.textContent?.trim());

    expect(APPLICATION_NAVIGATION.map((item) => item.id)).toEqual([
      "overview",
      "config",
      "flights",
      "schedule",
      "policy",
      "statistics",
      "history",
    ]);
    expect(labels).toEqual([
      "总览",
      "配置",
      "航班",
      "排班",
      "规则",
      "统计",
      "历史",
      "导入数据",
      "导出配置",
    ]);
    expect(
      element
        .querySelector('button[title="规则"]')
        ?.classList.contains("active")
    ).toBe(true);
    expect(
      element.querySelector('input[type="date"]')?.getAttribute("aria-label")
    ).toBe("排班日期");
  });

  it("renders the non-blocking task progress component", async () => {
    const runningView: ApplicationViewState = {
      ...view,
      progress: {
        outcome: "running",
        visible: true,
        stage: "optimize",
        percent: 15,
        steps: [
          { stage: "prepare", percent: 5, label: "准备航班和岗位" },
          { stage: "optimize", percent: 15, label: "整体计算岗位与人员" },
          { stage: "complete", percent: 100, label: "排班完成" },
        ],
        canAdoptCurrentResult: false,
      },
    };
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-app", {
      model: createDefaultState(),
      view: runningView,
      commandHandler: { handle: vi.fn().mockResolvedValue(undefined) },
    });

    expect(element.querySelectorAll(".schedule-progress-task")).toHaveLength(3);
    expect(
      element.querySelector(".schedule-progress-task.is-completed")?.textContent
    ).toContain("准备航班和岗位");
    expect(
      element.querySelector(".schedule-progress-task.is-active")?.textContent
    ).toContain("整体计算岗位与人员");
    expect(
      element
        .querySelector('[role="progressbar"]')
        ?.getAttribute("aria-valuenow")
    ).toBe("15");
  });
});
