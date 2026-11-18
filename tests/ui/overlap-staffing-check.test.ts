// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { overlapStaffingFixture } from "../helpers/overlap-staffing-fixture";
import { createAutoscheduleStore } from "../../src/app/store/autoschedule-store";
import "../../src/ui/components/daily-staff-flight-statistics";
import "../../src/ui/components/schedule-page";
import {
  mountElement,
  settleLit,
  type LitTestElement,
} from "./lit-test-helpers";

describe("overlap staffing check row", () => {
  it("does not claim that an installed history-edit reconstruction has complete shortage evidence", async () => {
    const state = overlapStaffingFixture();
    const element = await mountElement<LitTestElement>(
      "autoschedule-schedule-page",
      { model: state, date: "2026-11-18", historyEditDate: "2026-11-18" }
    );
    expect(
      element.querySelector(".overlap-staffing-check")?.textContent
    ).toContain("历史未保存空岗和督导补位关联");
  });
  it("adds a fourth row, shows evidence, and recomputes after a manual change", async () => {
    const state = overlapStaffingFixture();
    const store = createAutoscheduleStore({
      persistence: {
        load: () => state,
        save: (model) => ({
          state: model,
          sizeBytes: JSON.stringify(model).length,
          nearCapacity: false,
        }),
        clear() {},
      },
    });
    const element = await mountElement<
      LitTestElement & { model: typeof state }
    >("autoschedule-daily-staff-flight-statistics", {
      model: store.getState().model,
      date: "2026-11-18",
    });
    const fourth = () => element.querySelector(".overlap-staffing-check")!;
    expect(fourth()?.textContent).toContain("重叠航班人手检查");
    expect(
      element.querySelector(".daily-staff-flight-availability")
        ?.nextElementSibling
    ).toBe(fourth());
    expect(
      element.querySelectorAll(".daily-staff-flight-availability-row")
    ).toHaveLength(3);
    expect(fourth().textContent).toContain("09:00—10:00");
    expect(fourth().textContent).toContain("AA101/G01");
    expect(fourth().textContent).toContain("员工乙");
    expect(fourth().textContent).toContain("空闲");
    const unsubscribe = store.subscribe(({ model }) => {
      element.model = model;
    });
    store.getState().schedule.assignStaff("t0", "p1");
    await settleLit();
    expect(fourth().textContent).toContain("未发现");
    expect(fourth().textContent).not.toContain("AA101/G01");
    const query =
      element.querySelector<HTMLInputElement>('input[type="date"]')!;
    query.value = "2026-11-16";
    query.dispatchEvent(new Event("change"));
    await settleLit();
    expect(fourth().textContent).toContain("无法");
    unsubscribe();
  });
});
