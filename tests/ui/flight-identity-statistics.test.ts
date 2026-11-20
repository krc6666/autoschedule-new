// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { createDefaultState } from "../../src/defaults";
import "../../src/ui/components/statistics-page";
import { mountElement } from "./lit-test-helpers";

it("grouped counts show original flight numbers in both late-role and early-departure details", async () => {
  const state = createDefaultState();
  const person = { ...state.staff[0]!, name: "测试人员", dutyQualified: false };
  state.staff = [person];
  state.flights = [];
  state.assignments = [];
  state.shared.flightIdentities = [
    {
      id: "service",
      displayName: "统一航班",
      aliases: [{ flightNo: "OLD100" }, { flightNo: "NEW200" }],
    },
  ];
  state.settings.latePriorityFlightNumbers = ["@SERVICE"];
  state.settings.relaxedShiftFlightNumbers = ["@SERVICE"];
  state.settings.lateShiftEndTime = "22:00";
  state.settings.earlyDepartureCutoffTime = "12:00";
  state.positionRules = [
    {
      ...state.positionRules[0]!,
      flightNo: "NEW200",
      name: "H02",
      remark: "一号",
      category: "常规",
      qualifiedStaffIds: [person.id],
    },
  ];
  state.history = [
    {
      id: "late",
      date: "2026-11-01",
      flightNo: "NEW200",
      startTime: "20:00",
      endTime: "23:30",
    },
    {
      id: "early",
      date: "2026-11-02",
      flightNo: "OLD100",
      startTime: "08:00",
      endTime: "11:00",
    },
  ].map((r) => ({
    ...r,
    position: "H02",
    staffId: person.id,
    staffName: person.name,
    workHours: 3,
    fatiguePoints: 3,
    remark: "一号",
    flightCutoffTime: r.endTime,
  }));
  const element = await mountElement<
    HTMLElement & { updateComplete: Promise<unknown> }
  >("autoschedule-statistics-page", { model: state, date: "2026-11-20" });
  expect(
    element.querySelector(
      ".late-priority-statistics .late-priority-detail-list"
    )!.textContent
  ).toContain("NEW200");
  expect(
    element.querySelector(
      '.relaxed-shift-table td[data-label="统一航班"] .late-priority-detail-list'
    )!.textContent
  ).toContain("OLD100");
  element.remove();
});
