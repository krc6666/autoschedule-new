import { describe, expect, it, vi } from "vitest";
import { createDefaultState } from "../../src/defaults";
import { replaceWeeklyFlightPlan } from "../../src/domain/flights/weekly-flight-plan";
import type { AppState } from "../../src/model";
import {
  createTestApplicationCoordinator,
  createTestAutoscheduleStore,
  setTestScheduleRunner,
} from "../helpers/application";

const emptyAssignments = (state: AppState) => {
  state.assignments = [];
};

function openGenerate(state: AppState, viewDate: string) {
  const coordinator = createTestApplicationCoordinator(
    createTestAutoscheduleStore(state),
    {
      preferences: {
        loadScheduleDate: () => viewDate,
        saveScheduleDate: () => undefined,
        loadScheduleZoom: () => null,
        saveScheduleZoom: () => undefined,
      },
    }
  );
  return coordinator.handle({ type: "generate-schedule" }).then(() => ({
    coordinator,
    dialog: coordinator.view().dialog,
  }));
}

describe("empty schedule weekly flight defaults", () => {
  it.each([
    ["2026-08-16", 7],
    ["2026-08-17", 1],
    ["2026-08-18", 2],
    ["2026-08-19", 3],
    ["2026-08-20", 4],
    ["2026-08-21", 5],
    ["2026-08-22", 6],
    ["2026-08-31", 1],
    ["2026-09-01", 2],
  ] as const)(
    "uses the displayed date %s weekday %i, even with leftover flights",
    async (viewDate, weekday) => {
      const state = createDefaultState();
      emptyAssignments(state);
      const [first, second] = state.templates;
      state.flights = [
        {
          ...state.flights[0]!,
          flightNo: first!.flightNo,
          startTime: "04:10",
          bookedPassengers: 37,
          remark: "existing same-day facts",
        },
        {
          ...state.flights[0]!,
          id: "stale-flight",
          flightNo: second!.flightNo,
        },
      ];
      state.weeklyFlightPlans = replaceWeeklyFlightPlan(
        state.weeklyFlightPlans,
        weekday,
        [second!.flightNo]
      );
      state.activeScheduleDate = "2026-08-15";

      const { dialog, coordinator } = await openGenerate(state, viewDate);
      if (dialog?.kind !== "schedule-preflight")
        throw new Error("missing schedule preflight");

      expect(dialog.date).toBe(viewDate);
      expect(dialog.groupId).toBe(state.activeGroupId);
      expect(
        dialog.candidates.map(({ flightNo, selectedByDefault }) => [
          flightNo,
          selectedByDefault,
        ])
      ).toContainEqual([second!.flightNo, true]);
      expect(
        dialog.candidates.find(({ flightNo }) => flightNo === first!.flightNo)
      ).toMatchObject({
        selectedByDefault: false,
        startTime: "04:10",
        bookedPassengers: 37,
        remark: "existing same-day facts",
        sourceFlightId: state.flights[0]!.id,
      });
      expect(dialog.selectedIds).toEqual(
        dialog.candidates
          .filter((candidate) => candidate.selectedByDefault)
          .map((candidate) => candidate.id)
      );
      expect(coordinator.model().flights).toEqual(state.flights);
    }
  );

  it.each([
    ["empty", []],
    ["invalid", ["MISSING"]],
  ] as const)(
    "defaults no leftover flight when that weekday plan is %s",
    async (_label, flightNos) => {
      const state = createDefaultState();
      emptyAssignments(state);
      const leftover = state.flights[0]!;
      state.flights = [leftover];
      state.weeklyFlightPlans = replaceWeeklyFlightPlan(
        state.weeklyFlightPlans,
        6,
        [...flightNos]
      );

      const { dialog } = await openGenerate(state, "2026-08-22");
      if (dialog?.kind !== "schedule-preflight")
        throw new Error("missing schedule preflight");
      expect(dialog.candidates.length).toBeGreaterThan(0);
      expect(dialog.selectedIds).toEqual([]);
      expect(
        dialog.candidates.every((candidate) => !candidate.selectedByDefault)
      ).toBe(true);
      expect(dialog.candidates).toContainEqual(
        expect.objectContaining({
          flightNo: leftover.flightNo,
          sourceFlightId: leftover.id,
        })
      );
    }
  );

  it("lets the user add a flight beyond the weekly default before running", async () => {
    const state = createDefaultState();
    emptyAssignments(state);
    state.flights = [];
    const [defaultTemplate, addedTemplate] = state.templates;
    state.weeklyFlightPlans = replaceWeeklyFlightPlan(
      state.weeklyFlightPlans,
      6,
      [defaultTemplate!.flightNo]
    );
    const coordinator = createTestApplicationCoordinator(
      createTestAutoscheduleStore(state),
      {
        preferences: {
          loadScheduleDate: () => "2026-08-22",
          saveScheduleDate: () => undefined,
          loadScheduleZoom: () => null,
          saveScheduleZoom: () => undefined,
        },
      }
    );
    const calculate = vi.fn(
      async (_state: AppState, _date: string) =>
        ({ kind: "stopped-without-result" }) as const
    );
    setTestScheduleRunner(coordinator, { calculate, isRunning: () => false });
    const before = structuredClone(coordinator.model());

    await coordinator.handle({ type: "generate-schedule" });
    const dialog = coordinator.view().dialog;
    if (dialog?.kind !== "schedule-preflight")
      throw new Error("missing schedule preflight");
    const extraId = dialog.candidates.find(
      (candidate) => candidate.flightNo === addedTemplate!.flightNo
    )!.id;
    await coordinator.handle({
      type: "update-schedule-preflight-selection",
      selectedIds: [...dialog.selectedIds, extraId],
    });
    const edited = coordinator.view().dialog;
    if (edited?.kind !== "schedule-preflight")
      throw new Error("missing edited schedule preflight");
    await coordinator.handle({
      type: "confirm-schedule-preflight",
      selectedIds: edited.selectedIds,
    });

    expect(calculate).toHaveBeenCalledOnce();
    expect(
      calculate.mock.calls[0]![0].flights.map((flight) => flight.flightNo)
    ).toEqual([defaultTemplate!.flightNo, addedTemplate!.flightNo].sort());
    expect(coordinator.model()).toEqual(before);
  });

  it.each(["generate-schedule", "open-reschedule-flight-picker"] as const)(
    "keeps the saved-flight defaults when assignments exist (%s)",
    async (entry) => {
      const state = createDefaultState();
      state.flights = [state.flights[0]!];
      state.assignments = [
        {
          id: "existing-assignment",
          flightId: state.flights[0]!.id,
          flightNo: state.flights[0]!.flightNo,
          positionRuleId: null,
          position: "post",
          staffId: state.staff[0]!.id,
          staffName: state.staff[0]!.name,
          startTime: state.flights[0]!.startTime,
          endTime: state.flights[0]!.endTime,
          workHours: 2,
          fatiguePoints: 2,
          remark: "",
          manualRemark: "",
          status: "assigned",
        },
      ];
      state.weeklyFlightPlans = replaceWeeklyFlightPlan(
        state.weeklyFlightPlans,
        6,
        [state.templates[1]!.flightNo]
      );
      const coordinator = createTestApplicationCoordinator(
        createTestAutoscheduleStore(state),
        {
          preferences: {
            loadScheduleDate: () => "2026-08-22",
            saveScheduleDate: () => undefined,
            loadScheduleZoom: () => null,
            saveScheduleZoom: () => undefined,
          },
        }
      );

      await coordinator.handle({ type: entry });
      const dialog = coordinator.view().dialog;
      if (
        dialog?.kind !== "schedule-preflight" &&
        dialog?.kind !== "reschedule-flight-picker"
      )
        throw new Error("missing flight picker");
      expect(
        dialog.candidates
          .filter((candidate) => candidate.selectedByDefault)
          .map((candidate) => candidate.flightNo)
      ).toEqual([state.flights[0]!.flightNo]);
    }
  );
});
