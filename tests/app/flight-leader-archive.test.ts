import { expect, it } from "vitest";
import {
  flightLeaderScenario,
  LEADER_DATE,
} from "../helpers/flight-leader-scenario";
import {
  createTestApplicationCoordinator,
  createTestAutoscheduleStore,
  createTestScheduleRunner,
} from "../helpers/application";
import { generateSchedule } from "../helpers/generate-schedule";

const preferences = {
  loadScheduleDate: () => LEADER_DATE,
  saveScheduleDate: () => undefined,
  loadScheduleZoom: () => null,
  saveScheduleZoom: () => undefined,
};

it.each(["completed", "stopped-with-result", "failed"] as const)(
  "captures the old day's warning before next-day preparation: %s",
  async (kind) => {
    const store = createTestAutoscheduleStore(flightLeaderScenario());
    const original = structuredClone(store.getState().model);
    const coordinator = createTestApplicationCoordinator(
      store,
      { confirm: () => true, preferences },
      createTestScheduleRunner({
        calculate: async (state, date) => {
          if (kind === "failed") throw new Error("测试计算失败");
          return { kind, result: await generateSchedule(state, date) };
        },
      })
    );
    await coordinator.handle({ type: "archive-next-duty-day" });
    const dialog = coordinator.view().dialog;
    if (dialog?.kind !== "next-workday-flight-picker")
      throw new Error("没有后天选择窗口");
    await coordinator.handle({
      type: "confirm-next-workday-flight-picker",
      selectedIds: dialog.candidates.map((f) => f.id),
    });
    if (kind === "failed") {
      expect(store.getState().model).toEqual(original);
      return;
    }
    expect(store.getState().model.activeScheduleDate).toBe("2026-11-24");
    expect(
      store.getState().model.history.filter((r) => r.date === LEADER_DATE)
    ).toHaveLength(4);
    expect(
      store
        .getState()
        .model.flightLeaderCoverageHistory?.find(
          (day) => day.date === LEADER_DATE
        )
        ?.flights.map((f) => f.actual)
    ).toEqual([2, 0]);
  }
);
