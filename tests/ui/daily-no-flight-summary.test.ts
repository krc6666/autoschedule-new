// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { createDefaultState } from "../../src/defaults";
import type { Assignment } from "../../src/model";
import "../../src/ui/components/daily-staff-flight-statistics";
import {
  mountElement,
  settleLit,
  type LitTestElement,
} from "./lit-test-helpers";

function fixture() {
  const state = createDefaultState();
  const regular = state.staff.find((person) => person.staffType === "常规")!;
  state.staff = [
    { ...regular, id: "one", name: "员工甲" },
    { ...regular, id: "two", name: "员工乙" },
    { ...regular, id: "idle", name: "员工丙" },
  ];
  state.activeScheduleDate = "2026-11-18";
  const base: Assignment = {
    id: "am",
    flightId: "am",
    flightNo: "AM1",
    positionRuleId: null,
    position: "G01",
    staffId: "one",
    staffName: "员工甲",
    startTime: "11:50",
    endTime: "13:00",
    workHours: 1,
    fatiguePoints: 1,
    remark: "",
    manualRemark: "",
    status: "assigned",
  };
  state.assignments = [
    base,
    {
      ...base,
      id: "pm",
      flightId: "pm",
      flightNo: "PM1",
      staffId: "two",
      staffName: "员工乙",
      startTime: "12:01",
      endTime: "14:00",
    },
  ];
  return state;
}

describe("daily no-flight summary", () => {
  it("always shows three lines, updates after manual reassignment, and keeps empty lines", async () => {
    const state = fixture();
    const before = structuredClone(state);
    const element = await mountElement<
      LitTestElement & { model: typeof state }
    >("autoschedule-daily-staff-flight-statistics", {
      model: state,
      date: "2026-11-18",
    });
    const lines = () => [
      ...element.querySelectorAll(".daily-staff-flight-availability-row"),
    ];
    expect(lines()).toHaveLength(3);
    expect(
      lines().map((line) => line.querySelector("strong")?.textContent)
    ).toEqual([
      "全天无航班人员：",
      "上午无航班人员：",
      "中午以后无航班人员（半休）：",
    ]);
    expect(
      lines().map((line) => line.querySelector("span")?.textContent?.trim())
    ).toEqual(["员工丙", "员工乙", "员工甲"]);
    expect(state).toEqual(before);

    element.model = {
      ...state,
      assignments: state.assignments.map((entry) => ({
        ...entry,
        staffId: "two",
        staffName: "员工乙",
      })),
    };
    await settleLit();
    expect(
      lines().map((line) => line.querySelector("span")?.textContent?.trim())
    ).toEqual(["员工甲、员工丙", "无", "无"]);
    element.model = {
      ...state,
      staff: [state.staff[1]!],
      assignments: element.model.assignments,
    };
    await settleLit();
    expect(lines()).toHaveLength(3);
    expect(
      lines().map((line) => line.querySelector("span")?.textContent?.trim())
    ).toEqual(["无", "无", "无"]);
  });

  it("follows the query date and never calls missing or partial history no-flight", async () => {
    const state = fixture();
    state.history = [
      {
        ...state.assignments[0]!,
        id: "history",
        staffId: "one",
        date: "2026-11-16",
        historyCoverage: "complete",
      },
      {
        ...state.assignments[0]!,
        id: "partial",
        staffId: "one",
        date: "2026-11-14",
        historyCoverage: "late-priority-only",
      },
    ];
    const element = await mountElement<LitTestElement>(
      "autoschedule-daily-staff-flight-statistics",
      { model: state, date: "2026-11-18" }
    );
    const date = element.querySelector<HTMLInputElement>('input[type="date"]')!;
    for (const query of ["2026-11-16", "2026-11-14", "2026-11-12"]) {
      date.value = query;
      date.dispatchEvent(new Event("change"));
      await settleLit();
      const lines = [
        ...element.querySelectorAll(".daily-staff-flight-availability-row"),
      ];
      expect(lines).toHaveLength(3);
      if (query === "2026-11-16") {
        expect(
          lines.map((line) => line.querySelector("span")?.textContent?.trim())
        ).toEqual(["员工乙、员工丙", "无", "员工甲"]);
      } else {
        expect(
          lines.every((line) => line.textContent?.includes("无法判断"))
        ).toBe(true);
      }
    }
  });
});
