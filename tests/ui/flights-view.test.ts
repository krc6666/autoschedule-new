// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import { createDefaultState } from "../../src/defaults";
import "../../src/ui/components/flights-page";
import { mountElement } from "./lit-test-helpers";

describe("flights page", () => {
  it("keeps online query, weekly plan, and every flight field", async () => {
    const state = createDefaultState();
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-flights-page", { model: state });
    const text = element.textContent ?? "";

    expect(text).toContain("在线查询航班");
    expect(text).toContain("每周航班计划");
    expect(element.querySelectorAll("[data-weekday]")).toHaveLength(7);
    expect(text).not.toContain("选择模板");
    expect(text).not.toContain("新增当日航班");
    expect(element.querySelectorAll("tbody tr")).toHaveLength(
      state.flights.length
    );
    expect(
      element.querySelectorAll('button[aria-label="删除航班"]')
    ).toHaveLength(0);
    ["航班号", "开始时间", "结束时间", "预定人数", "涉及岗位", "备注"].forEach(
      (label) =>
        expect(element.querySelector(`[aria-label="${label}"]`)).not.toBeNull()
    );
  });
});
