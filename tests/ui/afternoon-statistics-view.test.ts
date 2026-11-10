// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { createDefaultState } from "../../src/defaults";
import "../../src/ui/components/statistics-page";
import "../../src/ui/components/schedule-relaxed-shift-summary";
import { mountElement } from "./lit-test-helpers";

it("shows the same independently expected afternoon people on both pages", async () => {
  const state = createDefaultState();
  state.staff = state.staff.slice(0, 2).map((p, i) => ({
    ...p,
    id: `p${i}`,
    name: `测试人员${i}`,
    status: "正常",
    staffType: "常规",
  }));
  state.activeScheduleDate = "2026-11-10";
  state.history = [];
  state.settings.afternoonRestStartTime = "13:00";
  state.settings.afternoonRestEndTime = "17:00";
  state.flights = [
    {
      id: "am",
      flightNo: "AM",
      startTime: "08:00",
      endTime: "10:00",
      positions: ["柜台"],
      bookedPassengers: 0,
      remark: "",
    },
  ];
  state.assignments = [
    {
      id: "am",
      flightId: "am",
      flightNo: "AM",
      positionRuleId: null,
      position: "柜台",
      staffId: "p0",
      staffName: "测试人员0",
      startTime: "08:00",
      endTime: "10:00",
      workHours: 2,
      fatiguePoints: 1,
      remark: "",
      manualRemark: "",
      status: "assigned",
    },
  ];
  for (const hasAfternoon of [false, true]) {
    if (hasAfternoon) {
      state.flights.push({
        ...state.flights[0]!,
        id: "pm",
        flightNo: "PM",
        startTime: "16:00",
        endTime: "18:00",
      });
      state.assignments.push({
        ...state.assignments[0]!,
        id: "pm",
        flightId: "pm",
        flightNo: "PM",
        staffId: "p1",
        staffName: "测试人员1",
        startTime: "16:00",
        endTime: "18:00",
      });
    }
    for (const tag of [
      "autoschedule-statistics-page",
      "autoschedule-schedule-relaxed-shift-summary",
    ]) {
      const page = await mountElement<
        HTMLElement & { updateComplete: Promise<unknown> }
      >(tag, { model: structuredClone(state), date: "2026-11-10" });
      const summary =
        tag === "autoschedule-statistics-page"
          ? page.querySelector(".relaxed-shift-today > div:last-child")
          : page.querySelector(
              'section[aria-labelledby="schedule-afternoon-rest-title"]'
            );
      expect(summary).not.toBeNull();
      expect(summary!.textContent?.includes("测试人员0")).toBe(hasAfternoon);
      expect(summary!.textContent).not.toContain("测试人员1");
      if (hasAfternoon) expect(summary!.textContent).toContain("本月 1 次");
    }
  }
});
