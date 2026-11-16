// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { createDefaultState } from "../../src/defaults";
import "../../src/ui/components/position-rules-section";
import { mountElement } from "./lit-test-helpers";

describe("重点岗位固定名称提示", () => {
  it.each(["常规", "分流", "机动督导"] as const)(
    "%s 仅命中航司与岗位名单时禁止改名",
    async (category) => {
      const state = createDefaultState();
      const original = state.positionRules[0]!;
      state.positionRules = [
        {
          ...original,
          id: "priority",
          flightNo: "KE777",
          name: "督导",
          category,
        },
        {
          ...original,
          id: "other-airline",
          flightNo: "CX777",
          name: "督导",
          category,
        },
        {
          ...original,
          id: "other-position",
          flightNo: "KE777",
          name: "H02",
          category,
        },
      ];
      state.settings.ordinaryPriorityPositions = [
        { airlineCode: "KE", position: "督导" },
      ];
      const element = await mountElement<
        HTMLElement & { updateComplete: Promise<unknown> }
      >("autoschedule-position-rules", { model: state });
      const names = [
        ...element.querySelectorAll<HTMLInputElement>(
          '[aria-label="岗位名称"]'
        ),
      ];
      const locked = names.find(
        (input) =>
          input
            .closest("tr")
            ?.querySelector<HTMLInputElement>('[aria-label="航班号"]')
            ?.value === "KE777" && input.value === "督导"
      )!;
      expect(locked.disabled).toBe(true);
      expect(locked.closest("td")?.textContent).toContain("重点岗位名称固定");
      expect(
        names
          .filter((input) => input !== locked)
          .every((input) => !input.disabled)
      ).toBe(true);
    }
  );
});
