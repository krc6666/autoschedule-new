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
import { generateSchedule } from "../helpers/generate-schedule";
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

describe.each([
  { open: "generate-schedule", confirm: "confirm-schedule-preflight" },
  {
    open: "open-reschedule-flight-picker",
    confirm: "confirm-reschedule-flight-picker",
  },
  {
    open: "archive-next-duty-day",
    confirm: "confirm-next-workday-flight-picker",
  },
  { open: "toggle-administrative-mode", confirm: null },
] as const)("黄色空岗提醒：$open", (entry) => {
  it.each([
    {
      vacancies: true,
      warnings: ["重点岗位频率需要复核", "半休人员没有合适岗位"],
    },
    { vacancies: false, warnings: ["重点岗位频率需要复核"] },
    { vacancies: true, warnings: [] },
  ])(
    "只根据最终空岗列清单 $vacancies / $warnings",
    async ({ vacancies, warnings }) => {
      const state = fixture();
      const coordinator = createTestApplicationCoordinator(
        createTestAutoscheduleStore(state),
        {
          preferences,
          confirm: () => true,
        }
      );
      let result: ScheduleResult | undefined;
      setTestScheduleRunner(coordinator, {
        isRunning: () => false,
        calculate: vi.fn(async (model: AppState, targetDate: string) => {
          const assignments = vacancies
            ? [
                state.assignments[0]!,
                {
                  ...state.assignments[0]!,
                  id: "vacant-h05",
                  flightNo: "KE166",
                  position: "H05",
                  staffId: null,
                  staffName: "",
                  status: "unfilled" as const,
                  systemNotes: ["人员状态不允许安排"],
                },
                {
                  ...state.assignments[0]!,
                  id: "vacant-h03",
                  flightNo: "TR121",
                  position: "H03",
                  staffId: null,
                  staffName: "",
                  status: "unfilled" as const,
                },
              ]
            : [state.assignments[0]!];
          result = {
            assignments,
            warnings,
            unfilledCount: vacancies ? 2 : 0,
            safetyCredential: createScheduleSafetySession({
              phase: "final",
              state: model,
              date: targetDate,
              runFacts: createScheduleRunFacts(model, targetDate),
            }).createCredential(targetDate, assignments),
          };
          return { kind: "completed" as const, result };
        }),
      });
      if (entry.open === "toggle-administrative-mode") {
        await coordinator.handle({ type: entry.open, enabled: true });
      } else {
        await coordinator.handle({ type: entry.open });
        const dialog = coordinator.view().dialog;
        if (!dialog || !("selectedIds" in dialog))
          throw new Error("缺少准备确认窗口");
        await coordinator.handle({
          type: entry.confirm,
          selectedIds: dialog.selectedIds,
        });
      }
      expect(coordinator.model().assignments).toEqual(result!.assignments);
      expect(result!.warnings).toEqual(warnings);
      const toast = coordinator.view().toast;
      if (vacancies) {
        expect(toast?.tone).toBe("warning");
        expect(toast?.details?.facts).toEqual([
          "KE166 / H05：人员状态不允许安排",
          "TR121 / H03：空岗，具体原因未记录",
        ]);
        expect(toast?.details?.steps).toEqual([]);
        expect(toast?.details?.vacancies).toEqual([
          {
            assignmentId: "vacant-h05",
            label: "KE166 / H05：人员状态不允许安排",
            reasons: ["人员状态不允许安排"],
          },
          {
            assignmentId: "vacant-h03",
            label: "TR121 / H03：空岗，具体原因未记录",
            reasons: [],
          },
        ]);
        expect(JSON.stringify(toast)).not.toContain("频率");
        expect(JSON.stringify(toast)).not.toContain("半休");
      } else {
        expect(toast?.tone).toBe("success");
        expect(toast?.details).toBeUndefined();
      }
    }
  );
});

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

describe.each([
  ...entries,
  {
    name: "重新排班",
    open: "open-reschedule-flight-picker",
    kind: "reschedule-flight-picker",
    update: "update-reschedule-flight-picker-staff-status",
    confirm: "confirm-reschedule-flight-picker",
  },
] as const)("沿用已保存的人员状态：$name", (entry) => {
  it.each(["cancel", "error", "stopped", "completed"] as const)(
    "休假和病假默认保留，只改恢复人员，%s后符合保存合同",
    async (outcome) => {
      const state = fixture();
      const normal = { ...state.staff[0]!, id: "normal-worker", name: "丙" };
      state.staff.push(normal);
      state.staff[0]!.status = "休假";
      state.staff[1]!.status = "病假";
      state.assignments[0]!.staffId = normal.id;
      state.assignments[0]!.staffName = normal.name;
      let raw: string | null = null;
      const persistence = createStatePersistence({
        getItem: () => raw,
        setItem: (_key, value) => {
          raw = value;
        },
        removeItem: () => {
          raw = null;
        },
      });
      const coordinator = createTestApplicationCoordinator(
        createTestAutoscheduleStore(state, persistence),
        { preferences, confirm: () => true }
      );
      const calculate = vi.fn(async (input: AppState, targetDate: string) => {
        expect(input.staff[0]!.status).toBe("正常");
        expect(input.staff[1]!.status).toBe("病假");
        if (outcome === "error") throw new Error("计算失败");
        if (outcome === "stopped")
          return { kind: "stopped-without-result" as const };
        return {
          kind: "completed" as const,
          result: safeResult(input, targetDate),
        };
      });
      setTestScheduleRunner(coordinator, { calculate, isRunning: () => false });
      const before = structuredClone(coordinator.model());
      await coordinator.handle({ type: entry.open });
      const dialog = coordinator.view().dialog;
      if (!dialog || !("staffStatuses" in dialog))
        throw new Error("缺少人员状态草稿");
      expect(dialog.kind).toBe(entry.kind);
      expect(dialog.staffStatuses).toEqual(
        Object.fromEntries(before.staff.map((p) => [p.id, p.status]))
      );
      await coordinator.handle({
        type: entry.update,
        staffId: state.staff[0]!.id,
        status: "正常",
      });
      expect(coordinator.model()).toEqual(before);
      if (outcome === "cancel")
        await coordinator.handle({ type: "close-dialog" });
      else
        await coordinator.handle({
          type: entry.confirm,
          selectedIds: dialog.selectedIds,
        });
      if (outcome !== "completed") {
        expect(coordinator.model()).toEqual(before);
        expect(raw).toBeNull();
      } else {
        expect(coordinator.model().staff.map((p) => p.status)).toEqual([
          "正常",
          "病假",
          "正常",
        ]);
        expect(coordinator.model().groups.B).toEqual(before.groups.B);
        const restored = persistence.load();
        expect(restored.staff.map((p) => p.status)).toEqual([
          "正常",
          "病假",
          "正常",
        ]);
        const imported = parseWorkbook(
          buildConfigWorkbook(coordinator.model()),
          coordinator.model().staff
        );
        expect(imported.staff?.map((p) => p.status)).toEqual([
          "正常",
          "病假",
          "正常",
        ]);
        const reopened = createTestApplicationCoordinator(
          createTestAutoscheduleStore(restored),
          { preferences }
        );
        await reopened.handle({ type: "generate-schedule" });
        expect(reopened.view().dialog).toMatchObject({
          staffStatuses: Object.fromEntries(
            restored.staff.map((p) => [p.id, p.status])
          ),
        });
      }
    }
  );
});

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
    expect(reopened.staffStatuses[before.staff[0]!.id]).toBe("病假");
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

it("同日主值班休假时仍生成合法班表，保留计划和诊断事实", async () => {
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
  const calculate = vi.fn(async (model: AppState, targetDate: string) => ({
    kind: "completed" as const,
    result: await generateSchedule(model, targetDate),
  }));
  setTestScheduleRunner(coordinator, { calculate, isRunning: () => false });

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

  expect(calculate).toHaveBeenCalledOnce();
  expect(
    coordinator.model().assignments.some((row) => row.staffId === person.id)
  ).toBe(false);
  expect(
    coordinator.model().dutyRosterOverrides.find((row) => row.date === date)
      ?.dutyStaffId
  ).toBe(person.id);
  expect(
    (await calculate.mock.results[0]!.value).result.warnings.join("；")
  ).toContain("主值班人员甲当前为休假");
  expect(coordinator.view().toast?.details?.code).toBe("local-vacancies");
});

it("重新排班读取休假轮值计划，合法岗位照常生成且事实仍保留", async () => {
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
  const calculate = vi.fn(async (model: AppState, targetDate: string) => ({
    kind: "completed" as const,
    result: await generateSchedule(model, targetDate),
  }));
  setTestScheduleRunner(coordinator, { calculate, isRunning: () => false });

  await coordinator.handle({ type: "open-reschedule-flight-picker" });
  const dialog = coordinator.view().dialog;
  if (dialog?.kind !== "reschedule-flight-picker")
    throw new Error("缺少重新排班预检");
  expect(dialog.dutyRoster?.dutyStaffId).toBe(person.id);
  await coordinator.handle({
    type: "confirm-reschedule-flight-picker",
    selectedIds: dialog.selectedIds,
  });

  expect(calculate).toHaveBeenCalledOnce();
  expect(
    coordinator.model().assignments.some((row) => row.staffId === person.id)
  ).toBe(false);
  expect(
    (await calculate.mock.results[0]!.value).result.warnings.join("；")
  ).toContain("主值班人员甲当前为休假");
});

it("归档并排后天遇到休假主值班仍采用其他合法岗位，黄色框不重复轮值说明", async () => {
  const state = fixture();
  const person = state.staff[0]!;
  person.dutyQualified = true;
  state.dutyRosterOverrides = [
    {
      date: "2026-08-17",
      cxPreflightStaffId: null,
      dutyStaffId: person.id,
      standbyStaffIds: [null, null],
    },
  ];
  const coordinator = createTestApplicationCoordinator(
    createTestAutoscheduleStore(state),
    { preferences, confirm: () => true }
  );
  const calculate = vi.fn(async (model: AppState, targetDate: string) => ({
    kind: "completed" as const,
    result: await generateSchedule(model, targetDate),
  }));
  setTestScheduleRunner(coordinator, { calculate, isRunning: () => false });
  await coordinator.handle({ type: "archive-next-duty-day" });
  const dialog = coordinator.view().dialog;
  if (dialog?.kind !== "next-workday-flight-picker")
    throw new Error("缺少后天预检");
  await coordinator.handle({
    type: "update-next-workday-flight-picker-staff-status",
    staffId: person.id,
    status: "休假",
  });
  await coordinator.handle({
    type: "confirm-next-workday-flight-picker",
    selectedIds: dialog.selectedIds,
  });
  expect(calculate).toHaveBeenCalledOnce();
  expect(coordinator.model().activeScheduleDate).toBe("2026-08-17");
  expect(coordinator.model().history.some((row) => row.date === date)).toBe(
    true
  );
  expect(
    coordinator.model().assignments.some((row) => row.staffId === person.id)
  ).toBe(false);
  expect(
    (await calculate.mock.results[0]!.value).result.warnings.join("；")
  ).toContain("主值班人员甲当前为休假");
  expect(JSON.stringify(coordinator.view().toast)).not.toContain("主值班人员");
});

it.each(["generate-schedule", "open-reschedule-flight-picker"] as const)(
  "统计页保存的四个轮值槽位在%s预检中默认回显",
  async (open) => {
    const state = fixture();
    const [cx, duty] = state.staff;
    const standbyOne = { ...duty!, id: `${duty!.id}-standby-1`, name: "丙" };
    const standbyTwo = { ...duty!, id: `${duty!.id}-standby-2`, name: "丁" };
    state.staff.push(standbyOne, standbyTwo);
    cx!.cxPreflightQualified = true;
    cx!.dutyQualified = false;
    duty!.dutyQualified = true;
    standbyOne!.standbyQualified = true;
    standbyTwo!.standbyQualified = true;
    const coordinator = createTestApplicationCoordinator(
      createTestAutoscheduleStore(state),
      { preferences }
    );

    await coordinator.handle({
      type: "update-duty-roster",
      date,
      slot: "cx-preflight",
      staffId: cx!.id,
    });
    await coordinator.handle({
      type: "update-duty-roster",
      date,
      slot: "duty",
      staffId: duty!.id,
    });
    await coordinator.handle({
      type: "update-duty-roster",
      date,
      slot: "standby-0",
      staffId: standbyOne!.id,
    });
    await coordinator.handle({
      type: "update-duty-roster",
      date,
      slot: "standby-1",
      staffId: standbyTwo!.id,
    });

    await coordinator.handle({ type: open });
    const dialog = coordinator.view().dialog;
    if (
      dialog?.kind !== "schedule-preflight" &&
      dialog?.kind !== "reschedule-flight-picker"
    )
      throw new Error("缺少预检弹窗");
    expect(dialog.dutyRoster).toMatchObject({
      date,
      cxPreflightStaffId: cx!.id,
      dutyStaffId: duty!.id,
      standbyStaffIds: [standbyOne!.id, standbyTwo!.id],
    });
  }
);

it("统计页保存的四个后天轮值槽位在归档后天预检中默认回显", async () => {
  const state = fixture();
  const [cx, duty] = state.staff;
  const standbyOne = { ...duty!, id: `${duty!.id}-standby-1`, name: "丙" };
  const standbyTwo = { ...duty!, id: `${duty!.id}-standby-2`, name: "丁" };
  state.staff.push(standbyOne, standbyTwo);
  cx!.cxPreflightQualified = true;
  cx!.dutyQualified = false;
  duty!.dutyQualified = true;
  standbyOne.standbyQualified = true;
  standbyTwo.standbyQualified = true;
  const nextDate = "2026-08-17";
  state.dutyRosterOverrides = [
    {
      date: nextDate,
      cxPreflightStaffId: cx!.id,
      dutyStaffId: duty!.id,
      standbyStaffIds: [standbyOne.id, standbyTwo.id],
    },
  ];
  const coordinator = createTestApplicationCoordinator(
    createTestAutoscheduleStore(state),
    { preferences }
  );
  await coordinator.handle({ type: "archive-next-duty-day" });
  const dialog = coordinator.view().dialog;
  if (dialog?.kind !== "next-workday-flight-picker")
    throw new Error("缺少后天预检弹窗");
  expect(dialog.dutyRoster).toMatchObject({
    date: nextDate,
    cxPreflightStaffId: cx!.id,
    dutyStaffId: duty!.id,
    standbyStaffIds: [standbyOne.id, standbyTwo.id],
  });
});

it("统计页轮值保存并恢复后仍在生成预检中回显", async () => {
  const state = fixture();
  const person = state.staff[0]!;
  person.cxPreflightQualified = false;
  person.dutyQualified = true;
  let raw: string | null = null;
  const persistence = createStatePersistence({
    getItem: () => raw,
    setItem: (_key, value) => {
      raw = value;
    },
    removeItem: vi.fn(),
  });
  const coordinator = createTestApplicationCoordinator(
    createTestAutoscheduleStore(state, persistence),
    { preferences }
  );
  await coordinator.handle({
    type: "update-duty-roster",
    date,
    slot: "duty",
    staffId: person.id,
  });
  expect(coordinator.model().dutyRosterOverrides).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ date, dutyStaffId: person.id }),
    ])
  );
  coordinator.commit();
  const restored = persistence.load();
  expect(restored.dutyRosterOverrides).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ date, dutyStaffId: person.id }),
    ])
  );
  const reopened = createTestApplicationCoordinator(
    createTestAutoscheduleStore(restored),
    { preferences }
  );
  await reopened.handle({ type: "generate-schedule" });
  expect(reopened.view().dialog?.kind).toBe("schedule-preflight");
  expect(reopened.view().dialog).toMatchObject({
    dutyRoster: expect.objectContaining({ dutyStaffId: person.id }),
  });
});
