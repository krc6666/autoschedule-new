// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import { createDefaultState } from "../../src/defaults";
import "../../src/ui/components/flights-page";
import { mountElement } from "./lit-test-helpers";

describe("flights page", () => {
  it("keeps only online query and weekly plan", async () => {
    const state = createDefaultState();
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-flights-page", { model: state });
    const text = element.textContent ?? "";

    expect(text).toContain("在线查询航班");
    expect(text).toContain("每周航班计划");
    expect(text).not.toContain("当日航班计划");
    expect(element.querySelectorAll("[data-weekday]")).toHaveLength(7);
    expect(text).not.toContain("选择模板");
    expect(text).not.toContain("新增当日航班");
    expect(element.querySelector("table")).toBeNull();
    expect(element.querySelectorAll('button[type="button"]')).toHaveLength(8);
  });
});
