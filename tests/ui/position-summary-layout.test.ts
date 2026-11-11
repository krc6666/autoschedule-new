// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { seasonalState } from "../helpers/seasonal-flight-scenario";
import { mountElement } from "./lit-test-helpers";
import type { PositionRulesSectionElement } from "../../src/ui/components/position-rules-section";
import "../../src/ui/components/position-rules-section";

describe("compact position group summary", () => {
  it.each([
    { enabled: true, hasTemplate: true },
    { enabled: false, hasTemplate: true },
    { enabled: true, hasTemplate: false },
    { enabled: false, hasTemplate: false },
  ])(
    "keeps metadata out of the count and arrow columns: %j",
    async ({ enabled, hasTemplate }) => {
      const model = seasonalState();
      model.flightSeasonOverrides = { NEW100: enabled };
      if (!hasTemplate) model.templates = [];
      const before = structuredClone(model);
      const el = await mountElement<PositionRulesSectionElement>(
        "autoschedule-position-rules",
        { model }
      );
      const details = el.querySelector("details.position-rule-group")!;
      const summary = details.querySelector("summary")!;
      // Three grid cells: flexible flight metadata, job counts, fixed-width arrow.
      // Extra badges/buttons previously put counts in the 18px arrow column.
      expect(summary.children).toHaveLength(3);
      const [identity, counts, arrow] = Array.from(summary.children);
      expect(identity!.querySelector("strong")!.textContent).toBe("NEW100");
      expect(summary.textContent).not.toContain("本季启用");
      if (!enabled)
        expect(identity!.textContent).toContain("暂不使用（岗位保留）");
      expect(identity!.querySelector("button") !== null).toBe(!hasTemplate);
      expect(counts!.textContent).toContain("常规");
      expect(counts!.textContent).toContain("行政支援");
      expect(arrow!.classList.contains("bi-chevron-down")).toBe(true);
      expect(details.hasAttribute("open")).toBe(false);
      expect(el.querySelectorAll("tbody tr")).toHaveLength(
        model.positionRules.length
      );
      expect(model).toEqual(before);
    }
  );
});
