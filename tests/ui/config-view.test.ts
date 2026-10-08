// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import { createDefaultState } from "../../src/defaults";
import { replaceWeeklyFlightPlan } from "../../src/domain/flights/weekly-flight-plan";
import { UI_COMMAND_EVENT } from "../../src/ui/events/ui-command";
import "../../src/ui/components/position-rules-section";
import "../../src/ui/components/config-page";
import "../../src/ui/components/flights-page";
import { mountElement } from "./lit-test-helpers";

describe("configuration page", () => {
  it("keeps people, position rules, templates, and constraints separated", async () => {
    const state = createDefaultState();
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-config-page", { model: state });
    const text = element.textContent ?? "";

    expect(text).toContain("人员信息");
    expect(text).toContain("岗位规则");
    expect(text).toContain("排班约束");
    expect(text).toContain("航班计划模板");
    expect(text).not.toContain("每周航班计划");
    expect(element.querySelectorAll("[data-weekday]")).toHaveLength(0);
    expect(text).not.toContain("排班规则");
    expect(
      element.querySelector(".config-collapsible")?.hasAttribute("open")
    ).toBe(false);
    ["是否为分队长", "CX航前资质", "值班资质", "备勤资质", "可上夜班"].forEach(
      (label) =>
        expect(element.querySelector(`[aria-label="${label}"]`)).not.toBeNull()
    );
    expect(text).toContain("机动督导");
    expect(text).toContain("复制岗位配置");
    expect(text).toContain("行政支援岗位常规人员优先");
    expect(text).not.toContain(">督导<");
  });

  it("shows the selected weekday preset as checked template rows", async () => {
    const state = createDefaultState();
    state.weeklyFlightPlans = replaceWeeklyFlightPlan(
      state.weeklyFlightPlans,
      1,
      [state.templates[0]!.flightNo]
    );

    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-flights-page", { model: state });

    expect(
      element.querySelector<HTMLInputElement>(
        `[aria-label="星期一 ${state.templates[0]!.flightNo}"]`
      )?.checked
    ).toBe(true);
    expect(
      element.querySelector<HTMLInputElement>(
        `[aria-label="星期一 ${state.templates[1]!.flightNo}"]`
      )?.checked
    ).toBe(false);
  });

  it("shows persisted non-default staff and position selections after remount", async () => {
    const state = createDefaultState();
    const positionRule = state.positionRules[0]!;
    const administrativeStaff = state.staff[0]!;
    const unavailableStaff = state.staff[1]!;
    positionRule.category = "分流";
    positionRule.earlyReleaseMinutes = 60;
    administrativeStaff.staffType = "行政支援";
    unavailableStaff.status = "休假";

    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-config-page", { model: state });
    const rows = [...element.querySelectorAll("tr")];
    const positionRow = rows.find(
      (row) =>
        row.querySelector<HTMLInputElement>('input[aria-label="航班号"]')
          ?.value === positionRule.flightNo &&
        row.querySelector<HTMLInputElement>('input[aria-label="岗位名称"]')
          ?.value === positionRule.name
    );
    const administrativeRow = rows.find(
      (row) =>
        row.querySelector<HTMLInputElement>('input[aria-label="编号"]')
          ?.value === administrativeStaff.id
    );
    const unavailableRow = rows.find(
      (row) =>
        row.querySelector<HTMLInputElement>('input[aria-label="编号"]')
          ?.value === unavailableStaff.id
    );

    expect(
      positionRow?.querySelector<HTMLSelectElement>('select[aria-label="分类"]')
        ?.value
    ).toBe("分流");
    expect(
      administrativeRow?.querySelector<HTMLSelectElement>(
        'select[aria-label="人员类型"]'
      )?.value
    ).toBe("行政支援");
    expect(
      unavailableRow?.querySelector<HTMLSelectElement>(
        'select[aria-label="状态"]'
      )?.value
    ).toBe("休假");
  });

  it("shows a regular position's supervisor-fill role", async () => {
    const state = createDefaultState();
    const positionRule = state.positionRules.find(
      (rule) => rule.category === "常规"
    )!;
    positionRule.coverageRole = "supervisor-fill";

    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-position-rules", { model: state });
    const row = [...element.querySelectorAll("tr")].find(
      (candidate) =>
        candidate.querySelector<HTMLInputElement>('input[aria-label="航班号"]')
          ?.value === positionRule.flightNo &&
        candidate.querySelector<HTMLInputElement>(
          'input[aria-label="岗位名称"]'
        )?.value === positionRule.name
    );

    expect(
      row?.querySelector<HTMLSelectElement>('select[aria-label="补位性质"]')
        ?.value
    ).toBe("supervisor-fill");
  });

  it("dispatches the selected target when copying a position group", async () => {
    const state = createDefaultState();
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-position-rules", { model: state });
    const source = state.positionRules[0]!.flightNo;
    const sourceSelect = element.querySelector(
      '[aria-label="复制来源航班"]'
    ) as HTMLSelectElement;
    const targetSelect = element.querySelector(
      '[aria-label="复制目标航班"]'
    ) as HTMLSelectElement;
    const target = [...targetSelect.options].find(
      (option) => option.value
    )?.value;
    expect(target).toBeTruthy();
    let command: Event | undefined;
    element.addEventListener(UI_COMMAND_EVENT, (event) => {
      command = event;
    });
    sourceSelect.value = source;
    sourceSelect.dispatchEvent(new Event("change", { bubbles: true }));
    targetSelect.value = target!;
    targetSelect.dispatchEvent(new Event("change", { bubbles: true }));
    const copyButton = element.querySelector<HTMLButtonElement>(
      ".position-copy-controls button"
    );
    expect(copyButton?.disabled).toBe(false);
    copyButton?.click();
    expect((command as CustomEvent).detail).toEqual({
      type: "copy-position-rules",
      sourceFlightNo: source,
      targetFlightNo: target,
    });
  });
});
