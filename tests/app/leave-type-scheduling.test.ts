import { describe, expect, it } from "vitest";
import { createDefaultState } from "../../src/defaults";
import { setStaffStatus } from "../../src/domain/staff-status";
import { generateSchedule } from "../helpers/generate-schedule";
import {
  createTestApplicationCoordinator,
  createTestAutoscheduleStore,
  setTestScheduleRunner,
} from "../helpers/application";
import { replaceWeeklyFlightPlan } from "../../src/domain/flights/weekly-flight-plan";
import { diagnoseManualAssignmentEligibility } from "../../src/domain/candidates/assignment-eligibility";
import { reassignmentSafetyReasons } from "../../src/domain/reviews/rotation-review-safety";
import { assertDailyScheduleSafety } from "../../src/domain/kernel/daily-schedule-safety";
import { evaluateAutomaticHardConstraints } from "../../src/domain/rules/built-in-rule-registry";

const DATE = "2026-11-10";
const preferences = {
  loadScheduleDate: () => DATE,
  saveScheduleDate: () => {},
  loadScheduleZoom: () => null,
  saveScheduleZoom: () => {},
};
const entries = [
  {
    open: "generate-schedule",
    update: "update-schedule-preflight-staff-status",
    confirm: "confirm-schedule-preflight",
  },
  {
    open: "open-reschedule-flight-picker",
    update: "update-reschedule-flight-picker-staff-status",
    confirm: "confirm-reschedule-flight-picker",
  },
  {
    open: "archive-next-duty-day",
    update: "update-next-workday-flight-picker-staff-status",
    confirm: "confirm-next-workday-flight-picker",
  },
] as const;

function scenario() {
  const state = createDefaultState();
  state.leaveTypes = [{ id: "flight-leave", name: "飞行假", enabled: true }];
  state.staff = state.staff.slice(0, 2).map((person, index) => ({
    ...person,
    id: `example-${index}`,
    name: `示例${index}`,
    status: "正常" as const,
    teamLeader: false,
    dutyQualified: false,
    standbyQualified: false,
    cxPreflightQualified: false,
  }));
  const flight = {
    ...state.flights[0]!,
    flightNo: "F100",
    startTime: "13:00",
    endTime: "15:00",
    positions: ["G01"],
    bookedPassengers: 100,
  };
  state.flights = [flight];
  state.templates = [{ ...flight, id: "only-template" }];
  state.positionRules = [
    {
      ...state.positionRules[0]!,
      id: "only-rule",
      flightNo: flight.flightNo,
      name: "G01",
      remark: "",
      category: "常规",
      fatiguePoints: 1,
      minPassengers: 0,
      manual: false,
      qualifiedStaffIds: state.staff.map((person) => person.id),
    },
  ];
  state.weeklyFlightPlans = replaceWeeklyFlightPlan(
    state.weeklyFlightPlans,
    4,
    [flight.flightNo]
  );
  state.activeScheduleDate = DATE;
  state.assignments = [
    {
      id: "original",
      flightId: flight.id,
      flightNo: flight.flightNo,
      positionRuleId: "only-rule",
      position: "G01",
      staffId: state.staff[1]!.id,
      staffName: state.staff[1]!.name,
      startTime: flight.startTime,
      endTime: flight.endTime,
      workHours: 2,
      fatiguePoints: 1,
      remark: "",
      manualRemark: "",
      status: "assigned",
    },
  ];
  return state;
}

describe("custom leave scheduling paths", () => {
  it.each(entries)(
    "$open keeps the selection in its draft, commits it through the real kernel, and cancels safely",
    async (entry) => {
      const store = createTestAutoscheduleStore(scenario());
      const coordinator = createTestApplicationCoordinator(store, {
        preferences,
        confirm: () => true,
      });
      const before = structuredClone(coordinator.model());
      await coordinator.handle({ type: entry.open });
      await coordinator.handle({
        type: entry.update,
        staffId: before.staff[0]!.id,
        status: "leave:flight-leave",
      });
      expect(coordinator.model()).toEqual(before);
      await coordinator.handle({ type: "close-dialog" });
      expect(coordinator.model()).toEqual(before);
      await coordinator.handle({ type: entry.open });
      await coordinator.handle({
        type: entry.update,
        staffId: before.staff[0]!.id,
        status: "leave:flight-leave",
      });
      setTestScheduleRunner(coordinator, {
        calculate: async (model, date) => ({
          kind: "completed",
          result: await generateSchedule(model, date),
        }),
      });
      const dialog = coordinator.view().dialog;
      if (!dialog || !("selectedIds" in dialog))
        throw new Error("preparation window missing");
      await coordinator.handle({
        type: entry.confirm,
        selectedIds: dialog.selectedIds,
      });
      expect(coordinator.model().staff[0]).toMatchObject({
        status: "休假",
        leaveTypeId: "flight-leave",
      });
      expect(
        coordinator
          .model()
          .assignments.filter((row) => row.staffId === before.staff[0]!.id)
      ).toEqual([]);
      expect(
        coordinator
          .model()
          .assignments.filter((row) => row.staffId === before.staff[1]!.id)
      ).toHaveLength(1);
    }
  );

  it("rejects leave staff through manual, post-review and final safety checks after first producing a legal schedule", async () => {
    const state = scenario();
    const result = await generateSchedule(state, DATE);
    state.assignments = result.assignments;
    const target = result.assignments.find((row) => row.staffId)!;
    expect(target).toBeDefined();
    const replacement = state.staff.find(
      (person) => person.id !== target.staffId
    )!;
    expect(
      setStaffStatus(replacement, "leave:flight-leave", state.leaveTypes)
    ).toBe(true);
    const safety = (assignments: typeof state.assignments) =>
      assertDailyScheduleSafety({
        state,
        date: DATE,
        assignments,
        tasks: [
          {
            key: "only",
            flight: state.flights[0]!,
            rule: state.positionRules[0]!,
          },
        ],
        evaluateEligibility: evaluateAutomaticHardConstraints,
      });
    expect(() => safety(result.assignments)).not.toThrow();
    expect(
      diagnoseManualAssignmentEligibility(
        state,
        target.id,
        replacement.id
      ).violations.map((item) => item.code)
    ).toContain("staff-unavailable");
    for (const kind of [
      "position-frequency-review",
      "consecutive-rotation-review",
      "late-shift-recovery-review",
    ] as const) {
      expect(
        reassignmentSafetyReasons({
          kind: "plan",
          state,
          assignments: state.assignments,
          changes: [{ assignmentId: target.id, staffId: replacement.id }],
          primaryAssignmentId: target.id,
          date: DATE,
          intent: { kind },
        }).length
      ).toBeGreaterThan(0);
    }
    const tampered = result.assignments.map((row) =>
      row.id === target.id
        ? { ...row, staffId: replacement.id, staffName: replacement.name }
        : row
    );
    expect(() => safety(tampered)).toThrow(/状态|休假|不可用/);
    expect(setStaffStatus(replacement, "正常", state.leaveTypes)).toBe(true);
    expect(() => safety(tampered)).not.toThrow();
  });
});
