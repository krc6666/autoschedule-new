import { describe, expect, it, vi } from "vitest";
import { createDefaultState } from "../../src/defaults";
import { loadState, saveState } from "../../src/infrastructure/storage";
import {
  createTestApplicationCoordinator,
  createTestAutoscheduleStore,
  createTestScheduleRunner,
} from "../helpers/application";
import { createScheduleSafetySession } from "../../src/domain/kernel/schedule-safety-session";
import { createScheduleRunFacts } from "../../src/domain/shared/schedule-run-facts";
import { currentScheduleHistory } from "../../src/app/history-actions";
import { normalizeHalfRestSelections } from "../../src/domain/records/half-rest-selections";

const preferences = {
  loadScheduleDate: () => "2026-11-10",
  saveScheduleDate: () => {},
  loadScheduleZoom: () => 1,
  saveScheduleZoom: () => {},
};
describe("dated half-rest selection", () => {
  it("restores older saved groups with empty selections without changing their staff or history", () => {
    const state = createDefaultState();
    const raw = JSON.parse(JSON.stringify(state));
    delete raw.halfRestSelections;
    delete raw.groups.A.halfRestSelections;
    delete raw.groups.B.halfRestSelections;
    const restored = loadState({ getItem: () => JSON.stringify(raw) });
    expect(restored.halfRestSelections).toEqual([]);
    expect(restored.groups.A.halfRestSelections).toEqual([]);
    expect(restored.groups.B.halfRestSelections).toEqual([]);
    expect(restored.staff).toEqual(state.staff);
    expect(restored.history).toEqual(state.history);
  });
  it.each([
    ["generate-schedule", "confirm-schedule-preflight", false],
    [
      "open-reschedule-flight-picker",
      "confirm-reschedule-flight-picker",
      false,
    ],
    ["archive-next-duty-day", "confirm-next-workday-flight-picker", true],
  ] as const)(
    "%s consumes the target date selection while keeping another date intact",
    async (open, confirm, nextWorkday) => {
      const state = createDefaultState();
      state.staff = state.staff
        .filter((p) => p.status === "正常" && p.staffType === "常规")
        .slice(0, 2);
      const person = state.staff[0]!;
      const flight = state.flights[0]!;
      const rule = state.positionRules.find(
        (r) => r.flightNo === flight.flightNo
      )!;
      state.assignments = [
        {
          id: "archive-source",
          flightId: flight.id,
          flightNo: flight.flightNo,
          positionRuleId: rule.id,
          position: rule.name,
          staffId: person.id,
          staffName: person.name,
          startTime: flight.startTime,
          endTime: flight.endTime,
          workHours: 2,
          fatiguePoints: 1,
          remark: "",
          manualRemark: "",
          status: "assigned",
        },
      ];
      state.activeScheduleDate = "2026-11-10";
      state.halfRestSelections = [
        { date: "2026-11-10", modes: { [person.id]: "early-finish" } },
        { date: "2026-11-12", modes: { [person.id]: "late-start" } },
      ];
      const calculate = vi.fn(async (input, date, preferences) => ({
        kind: "completed" as const,
        result: {
          assignments: [],
          warnings: [],
          unfilledCount: 0,
          safetyCredential: createScheduleSafetySession({
            phase: "final",
            state: input,
            date,
            runFacts: createScheduleRunFacts(input, date, preferences),
          }).createCredential(date, []),
        },
      }));
      const coordinator = createTestApplicationCoordinator(
        createTestAutoscheduleStore(state),
        { preferences, confirm: () => true },
        createTestScheduleRunner({ calculate })
      );
      await coordinator.handle({ type: open });
      const dialog = coordinator.view().dialog;
      if (!dialog || !("candidates" in dialog))
        throw new Error("missing preflight picker");
      await coordinator.handle({
        type: confirm,
        selectedIds: [dialog.candidates[0]!.id],
      });
      expect(calculate).toHaveBeenCalledOnce();
      expect(calculate.mock.calls[0]![1]).toBe(
        nextWorkday ? "2026-11-12" : "2026-11-10"
      );
      expect(calculate.mock.calls[0]![2]).toEqual({
        halfRestStaffIds: [person.id],
        halfRestModes: {
          [person.id]: nextWorkday ? "late-start" : "early-finish",
        },
      });
      expect(coordinator.model().halfRestSelections).toEqual(
        state.halfRestSelections
      );
    }
  );

  it("rejects malformed saved facts and never derives half-rest from an early finish", () => {
    expect(
      normalizeHalfRestSelections([
        { date: "2026-02-30", modes: {} },
        { date: "2026-11-10", modes: { p: "unknown" } },
        { date: "2026-11-12", modes: [] },
      ])
    ).toEqual([]);
    const coordinator = createTestApplicationCoordinator(
      createTestAutoscheduleStore(),
      { preferences }
    );
    expect(coordinator.view().halfRestStaffIds).toEqual([]);
  });

  it("uses the archived date during history editing and restores the active date on cancel", async () => {
    const state = createDefaultState();
    const person = state.staff.find(
      (p) => p.status === "正常" && p.staffType === "常规"
    )!;
    const rule = state.positionRules[0]!;
    const flight = state.flights.find((f) => f.flightNo === rule.flightNo)!;
    state.assignments = [
      {
        id: "history-probe",
        flightId: flight.id,
        flightNo: flight.flightNo,
        positionRuleId: rule.id,
        position: rule.name,
        staffId: person.id,
        staffName: person.name,
        startTime: flight.startTime,
        endTime: flight.endTime,
        workHours: 2,
        fatiguePoints: 1,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
    ];
    state.activeScheduleDate = "2026-11-10";
    state.history = currentScheduleHistory(state, "2026-11-08");
    state.halfRestSelections = [
      { date: "2026-11-08", modes: { [person.id]: "late-start" } },
    ];
    const coordinator = createTestApplicationCoordinator(
      createTestAutoscheduleStore(state),
      { preferences }
    );
    await coordinator.handle({ type: "edit-history-date", date: "2026-11-08" });
    expect(coordinator.view().halfRestStaffIds).toEqual([person.id]);
    expect(coordinator.view().halfRestModes[person.id]).toBe("late-start");
    await coordinator.handle({ type: "cancel-history-edit" });
    expect(coordinator.view().halfRestStaffIds).toEqual([]);
    expect(coordinator.model().halfRestSelections).toEqual(
      state.halfRestSelections
    );
  });
  it("survives actual save/restore, group/date switches and an explicit clear", async () => {
    const state = createDefaultState();
    state.groups.B.staff = [
      { ...state.staff[0]!, id: "b-person", status: "正常" },
    ];
    const store = createTestAutoscheduleStore(state);
    const coordinator = createTestApplicationCoordinator(store, {
      preferences,
      confirm: () => true,
    });
    const id = state.staff.find(
      (p) => p.status === "正常" && p.staffType === "常规"
    )!.id;
    await coordinator.handle({
      type: "set-half-rest-staff",
      staffIds: [id],
      modes: { [id]: "late-start" },
    });
    let saved = "";
    saveState(coordinator.model(), {
      setItem: (_k, value) => {
        saved = value;
      },
    });
    const restored = loadState({ getItem: () => saved });
    const resumed = createTestApplicationCoordinator(
      createTestAutoscheduleStore(restored),
      { preferences, confirm: () => true }
    );
    expect(resumed.view().halfRestStaffIds).toEqual([id]);
    expect(resumed.view().halfRestModes).toEqual({ [id]: "late-start" });
    await resumed.handle({ type: "change-date", date: "2026-11-12" });
    expect(resumed.view().halfRestStaffIds).toEqual([]);
    await resumed.handle({ type: "change-date", date: "2026-11-10" });
    expect(resumed.view().halfRestStaffIds).toEqual([id]);
    await resumed.handle({ type: "switch-group", groupId: "B" });
    expect(resumed.view().halfRestStaffIds).toEqual([]);
    await resumed.handle({ type: "switch-group", groupId: "A" });
    expect(resumed.view().halfRestStaffIds).toEqual([id]);
    await resumed.handle({ type: "set-half-rest-staff", staffIds: [] });
    expect(resumed.view().halfRestStaffIds).toEqual([]);
    expect(resumed.model().halfRestSelections).toEqual([
      { date: "2026-11-10", modes: {} },
    ]);
  });
});
