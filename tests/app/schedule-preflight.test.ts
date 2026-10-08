import { describe, expect, it, vi } from "vitest";
import { createDefaultState } from "../../src/defaults";
import type { ApplicationPreferences } from "../../src/app/application-preferences";
import type { AppState, ScheduleResult } from "../../src/model";
import { createScheduleSafetySession } from "../../src/domain/kernel/schedule-safety-session";
import { createScheduleRunFacts } from "../../src/domain/shared/schedule-run-facts";
import { createStatePersistence } from "../../src/infrastructure/storage";
import {
  buildConfigWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";
import { replaceWeeklyFlightPlan } from "../../src/domain/flights/weekly-flight-plan";
import {
  createTestApplicationCoordinator,
  createTestAutoscheduleStore,
  setTestScheduleRunner,
} from "../helpers/application";

const date = "2026-08-15";
const preferences: ApplicationPreferences = {
  loadScheduleDate: () => date,
  saveScheduleDate: () => undefined,
  loadScheduleZoom: () => null,
  saveScheduleZoom: () => undefined,
};

function fixture() {
  const state = createDefaultState();
  state.staff = state.staff.slice(0, 2).map((person, index) => ({
    ...person,
    name: index ? "乙" : "甲",
    status: "正常" as const,
  }));
  // Same id in another group must never receive this draft.
  state.groups.B.staff = [{ ...state.staff[0]!, name: "B 组甲" }];
  state.flights = [state.flights[0]!];
  state.assignments = [
    {
      id: "original",
      flightId: state.flights[0]!.id,
      flightNo: state.flights[0]!.flightNo,
      positionRuleId: null,
      position: "原岗位",
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
  state.activeScheduleDate = date;
  state.weeklyFlightPlans = replaceWeeklyFlightPlan(
    state.weeklyFlightPlans,
    1,
    [state.templates[0]!.flightNo]
  );
  return state;
}

function safeResult(state: AppState, resultDate: string): ScheduleResult {
  return {
    assignments: [],
    warnings: [],
    unfilledCount: 0,
    safetyCredential: createScheduleSafetySession({
      phase: "final",
      state,
      date: resultDate,
      runFacts: createScheduleRunFacts(state, resultDate),
    }).createCredential(resultDate, []),
  };
}

const entries = [
  {
    name: "生成排班",
    open: "generate-schedule",
    kind: "schedule-preflight",
    update: "update-schedule-preflight-staff-status",
    confirm: "confirm-schedule-preflight",
  },
  {
    name: "归档并排后天",
    open: "archive-next-duty-day",
    kind: "next-workday-flight-picker",
    update: "update-next-workday-flight-picker-staff-status",
    confirm: "confirm-next-workday-flight-picker",
  },
] as const;

describe.each(entries)("排班前确认：$name", (entry) => {
  async function setup() {
    const state = fixture();
    let raw: string | null = null;
    const setItem = vi.fn((_key: string, value: string) => {
      raw = value;
    });
    const persistence = createStatePersistence({
      getItem: () => raw,
      setItem,
      removeItem: () => {
        raw = null;
      },
    });
    const coordinator = createTestApplicationCoordinator(
      createTestAutoscheduleStore(state, persistence),
      { preferences, confirm: () => true }
    );
    const calculate = vi.fn(async (input: AppState, resultDate: string) => ({
      kind: "completed" as const,
      result: safeResult(input, resultDate),
    }));
    setTestScheduleRunner(coordinator, { calculate, isRunning: () => false });
    const before = structuredClone(coordinator.model());
    await coordinator.handle({ type: entry.open });
    const dialog = coordinator.view().dialog;
    if (
      dialog?.kind !== "schedule-preflight" &&
      dialog?.kind !== "next-workday-flight-picker"
    )
      throw new Error("缺少预检弹窗");
    expect(dialog.kind).toBe(entry.kind);
    expect(dialog.staffStatuses).toEqual(
      Object.fromEntries(
        before.staff.map((person) => [person.id, person.status])
      )
    );
    expect(calculate).not.toHaveBeenCalled();
    await coordinator.handle({
      type: entry.update,
      staffId: state.staff[0]!.id,
      status: "休假",
    });
    return { coordinator, calculate, before, persistence, setItem, dialog };
  }

  it("确认前只改草稿，取消不保存任何数据", async () => {
    const { coordinator, before, calculate, setItem } = await setup();
    expect(coordinator.model()).toEqual(before);
    await coordinator.handle({ type: "close-dialog" });
    expect(coordinator.model()).toEqual(before);
    expect(calculate).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });

  it("成功一起提交，配置、当前组、保存恢复与 Excel 状态一致", async () => {
    const { coordinator, before, calculate, persistence, setItem, dialog } =
      await setup();
    await coordinator.handle({
      type: entry.confirm,
      selectedIds: dialog.selectedIds,
    });
    expect(coordinator.view().toast?.tone).not.toBe("danger");
    const staffId = before.staff[0]!.id;
    expect(calculate).toHaveBeenCalledTimes(1);
    expect(
      calculate.mock.calls[0]![0].staff.find((person) => person.id === staffId)
        ?.status
    ).toBe("休假");
    const model = coordinator.model();
    expect(model.staff.find((person) => person.id === staffId)?.status).toBe(
      "休假"
    );
    expect(
      model.groups.A.staff.find((person) => person.id === staffId)?.status
    ).toBe("休假");
    expect(model.groups.B).toEqual(before.groups.B);
    expect(model.activeScheduleDate).toBe(dialog.date);
    expect(model.flights).toEqual(calculate.mock.calls[0]![0].flights);
    if (entry.kind === "next-workday-flight-picker") {
      expect(model.history).toEqual(
        expect.arrayContaining([expect.objectContaining({ date, staffId })])
      );
      expect(coordinator.view().date).toBe("2026-08-17");
    }
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(
      persistence.load().staff.find((person) => person.id === staffId)?.status
    ).toBe("休假");
    const imported = parseWorkbook(buildConfigWorkbook(model), model.staff);
    expect(
      imported.staff?.find((person) => person.id === staffId)?.status
    ).toBe("休假");
  });

  it.each([
    "error",
    "stopped-without-result",
    "stopped-with-result",
    "unsafe",
  ] as const)(
    "%s 时班表、人员状态、航班、历史和保存均不变",
    async (outcome) => {
      const { coordinator, before, calculate, setItem, dialog } = await setup();
      if (outcome === "error")
        calculate.mockImplementationOnce(async (state) => {
          // A later calculation stage may mutate its input before throwing.
          state.flights = [];
          state.staff[0]!.status = "病假";
          state.history = [];
          throw new Error("计算失败");
        });
      else
        setTestScheduleRunner(coordinator, {
          calculate: async (state, resultDate) =>
            outcome === "unsafe"
              ? {
                  kind: "completed",
                  result: { assignments: [], warnings: [], unfilledCount: 0 },
                }
              : outcome === "stopped-without-result"
                ? { kind: "stopped-without-result" }
                : {
                    kind: "stopped-with-result",
                    result: safeResult(state, resultDate),
                  },
          isRunning: () => false,
        });
      await coordinator.handle({
        type: entry.confirm,
        selectedIds: dialog.selectedIds,
      });
      expect(coordinator.model()).toEqual(before);
      expect(coordinator.view().date).toBe(date);
      expect(setItem).not.toHaveBeenCalled();
      expect(coordinator.view().toast?.tone).toBe(
        outcome === "error" || outcome === "unsafe" ? "danger" : "warning"
      );
    }
  );

  it("未选航班不能计算，配置状态重新打开时重新读取", async () => {
    const { coordinator, calculate, before } = await setup();
    await coordinator.handle({ type: entry.confirm, selectedIds: [] });
    expect(coordinator.model()).toEqual(before);
    expect(calculate).not.toHaveBeenCalled();
    await coordinator.handle({ type: "close-dialog" });
    await coordinator.handle({ type: "clear-schedule" });
    await coordinator.handle({
      type: "update-configuration",
      entity: "staff",
      id: before.staff[0]!.id,
      field: "status",
      value: "病假",
    });
    if (entry.kind === "next-workday-flight-picker") {
      // Restore a schedule through the store, with the latest configuration status.
      const current = structuredClone(coordinator.model());
      current.assignments = before.assignments;
      coordinator.store.getState().replaceModel(current);
    }
    await coordinator.handle({ type: entry.open });
    const reopened = coordinator.view().dialog;
    if (
      reopened?.kind !== "schedule-preflight" &&
      reopened?.kind !== "next-workday-flight-picker"
    )
      throw new Error("缺少重开的预检弹窗");
    expect(reopened.staffStatuses[before.staff[0]!.id]).toBe(
      entry.kind === "next-workday-flight-picker" ? "正常" : "病假"
    );
  });

  it.each(["switch-group", "change-date"] as const)(
    "%s 后拒绝旧草稿",
    async (change) => {
      const { coordinator, calculate, dialog } = await setup();
      if (change === "switch-group")
        await coordinator.handle({ type: change, groupId: "B" });
      else await coordinator.handle({ type: change, date: "2026-08-16" });
      const switched = structuredClone(coordinator.model());
      await coordinator.handle({
        type: entry.confirm,
        selectedIds: dialog.selectedIds,
      });
      expect(calculate).not.toHaveBeenCalled();
      expect(coordinator.model()).toEqual(switched);
      expect(coordinator.view().toast?.message).toContain("请重新打开确认窗口");
    }
  );
});

it("空白航班显示模板，勾选确认前不运行排班", async () => {
  const state = fixture();
  state.flights = [];
  state.assignments = [];
  state.activeScheduleDate = null;
  const coordinator = createTestApplicationCoordinator(
    createTestAutoscheduleStore(state),
    { preferences }
  );
  const calculate = vi.fn();
  setTestScheduleRunner(coordinator, { calculate, isRunning: () => false });
  await coordinator.handle({ type: "generate-schedule" });
  const dialog = coordinator.view().dialog;
  if (dialog?.kind !== "schedule-preflight") throw new Error("缺少预检弹窗");
  expect(dialog.candidates.length).toBeGreaterThan(0);
  expect(dialog.selectedIds).toEqual([]);
  expect(calculate).not.toHaveBeenCalled();
});

it("同日轮值人员状态为休假时报警并阻止生成，原模型保留", async () => {
  const state = fixture();
  const person = state.staff[0]!;
  person.dutyQualified = true;
  state.dutyRosterOverrides = [
    {
      date,
      cxPreflightStaffId: null,
      dutyStaffId: person.id,
      standbyStaffIds: [null, null],
    },
  ];
  const coordinator = createTestApplicationCoordinator(
    createTestAutoscheduleStore(state),
    { preferences }
  );
  const calculate = vi.fn();
  setTestScheduleRunner(coordinator, { calculate, isRunning: () => false });
  const before = structuredClone(coordinator.model());

  await coordinator.handle({ type: "generate-schedule" });
  const dialog = coordinator.view().dialog;
  if (dialog?.kind !== "schedule-preflight") throw new Error("缺少预检弹窗");
  expect(dialog.dutyRoster?.dutyStaffId).toBe(person.id);
  await coordinator.handle({
    type: "update-schedule-preflight-staff-status",
    staffId: person.id,
    status: "休假",
  });
  const updated = coordinator.view().dialog;
  if (updated?.kind !== "schedule-preflight") throw new Error("预检已关闭");
  await coordinator.handle({
    type: "confirm-schedule-preflight",
    selectedIds: updated.selectedIds,
  });

  expect(calculate).not.toHaveBeenCalled();
  expect(coordinator.model()).toEqual(before);
  expect(coordinator.view().toast?.message).toContain("主值班人员甲当前为休假");
});

it("重新排班默认读取统计页休假轮值人员并阻止计算", async () => {
  const state = fixture();
  const person = state.staff[0]!;
  person.dutyQualified = true;
  person.status = "休假";
  state.dutyRosterOverrides = [
    {
      date,
      cxPreflightStaffId: null,
      dutyStaffId: person.id,
      standbyStaffIds: [null, null],
    },
  ];
  const coordinator = createTestApplicationCoordinator(
    createTestAutoscheduleStore(state),
    { preferences }
  );
  const calculate = vi.fn();
  setTestScheduleRunner(coordinator, { calculate, isRunning: () => false });
  const before = structuredClone(coordinator.model());

  await coordinator.handle({ type: "open-reschedule-flight-picker" });
  const dialog = coordinator.view().dialog;
  if (dialog?.kind !== "reschedule-flight-picker")
    throw new Error("缺少重新排班预检");
  expect(dialog.dutyRoster?.dutyStaffId).toBe(person.id);
  await coordinator.handle({
    type: "confirm-reschedule-flight-picker",
    selectedIds: dialog.selectedIds,
  });

  expect(calculate).not.toHaveBeenCalled();
  expect(coordinator.model()).toEqual(before);
  expect(coordinator.view().toast?.message).toContain("主值班人员甲当前为休假");
});
