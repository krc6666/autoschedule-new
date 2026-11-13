import { describe, expect, it, vi } from "vitest";
import { createDefaultState } from "../../src/defaults";
import { createBrowserPreferences } from "../../src/infrastructure/browser-preferences";
import { PREFLIGHT_DRAFTS_KEY } from "../../src/infrastructure/preflight-draft-storage";
import { createScheduleSafetySession } from "../../src/domain/kernel/schedule-safety-session";
import { createScheduleRunFacts } from "../../src/domain/shared/schedule-run-facts";
import type { ApplicationDialog } from "../../src/app/application-view-state";
import type { AppState } from "../../src/model";
import type { ApplicationCoordinator } from "../../src/app/application-coordinator";
import type { UiCommand } from "../../src/ui/events/ui-command";
import {
  createTestApplicationCoordinator,
  createTestAutoscheduleStore,
  setTestScheduleRunner,
} from "../helpers/application";

const date = "2026-11-13";
const entries = [
  { open: "generate-schedule", prefix: "schedule-preflight" },
  { open: "open-reschedule-flight-picker", prefix: "reschedule-flight-picker" },
  { open: "archive-next-duty-day", prefix: "next-workday-flight-picker" },
] as const;
type Preparation = Extract<ApplicationDialog, { selectedIds: string[] }>;

function preparation(coordinator: ApplicationCoordinator): Preparation {
  const dialog = coordinator.view().dialog;
  if (!dialog || !("selectedIds" in dialog)) throw new Error("缺少确认窗口");
  return dialog;
}

// Compare every user choice; the domain recalculates adjustment/recovery metadata.
function options(dialog: Preparation) {
  const roster = dialog.dutyRoster;
  return {
    ...dialog,
    dutyRoster: roster
      ? {
          date: roster.date,
          cxPreflightStaffId: roster.cxPreflightStaffId,
          dutyStaffId: roster.dutyStaffId,
          standbyStaffIds: roster.standbyStaffIds,
        }
      : undefined,
  };
}

function fixture() {
  const state = createDefaultState();
  const flight = state.flights[0]!;
  const rule = state.positionRules.find(
    (item) => item.flightNo === flight.flightNo
  )!;
  const person = state.staff[0]!;
  state.activeScheduleDate = date;
  state.assignments = [
    {
      id: "original",
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
  const saved = new Map<string, string>();
  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => {
      saved.set(key, value);
    },
  };
  const preferences = createBrowserPreferences(storage);
  preferences.saveScheduleDate(date);
  const store = createTestAutoscheduleStore(state);
  const create = () =>
    createTestApplicationCoordinator(store, {
      preferences: createBrowserPreferences(storage),
      confirm: () => true,
    });
  return { state, saved, storage, store, preferences, create };
}

async function edit(
  coordinator: ApplicationCoordinator,
  entry: (typeof entries)[number]
) {
  await coordinator.handle({ type: entry.open });
  const initial = preparation(coordinator);
  const candidate = initial.candidates[0]!;
  const person = coordinator
    .model()
    .staff.find((item) => item.status === "正常")!;
  await coordinator.handle({
    type: `update-${entry.prefix}-selection`,
    selectedIds: [candidate.id],
  } as UiCommand);
  await coordinator.handle({
    type: `update-${entry.prefix}-passengers`,
    candidateId: candidate.id,
    bookedPassengers: 123,
  } as UiCommand);
  await coordinator.handle({
    type: `update-${entry.prefix}-staff-status`,
    staffId: person.id,
    status: "休假",
  } as UiCommand);
  await coordinator.handle({
    type: "update-preflight-administrative-mode",
    enabled: !initial.adminSupportEnabled,
  });
  await coordinator.handle({
    type: `update-${entry.prefix}-duty-roster`,
    slot: "duty",
    staffId: "",
  } as UiCommand);
  return structuredClone(preparation(coordinator));
}

describe("排班确认窗口按组按日记忆", () => {
  it.each(entries)(
    "$open 关闭及刷新后恢复全部准备选项，正式模型不变",
    async (entry) => {
      const f = fixture();
      const coordinator = f.create();
      const original = structuredClone(coordinator.model());
      const expected = await edit(coordinator, entry);
      await coordinator.handle({ type: entry.open });
      expect(options(preparation(coordinator))).toEqual(options(expected));
      await coordinator.handle({ type: "close-dialog" });
      await coordinator.handle({ type: entry.open });
      expect(options(preparation(coordinator))).toEqual(options(expected));
      const refreshed = f.create();
      await refreshed.handle({ type: entry.open });
      expect(options(preparation(refreshed))).toEqual(options(expected));
      expect(refreshed.model()).toEqual(original);
      expect(f.store.getState().isDirty()).toBe(false);
    }
  );

  it("生成与重新排班共享同一天记忆，后天草稿按目标日供其他入口读取", async () => {
    const f = fixture();
    const coordinator = f.create();
    const expected = await edit(coordinator, entries[0]);
    await coordinator.handle({ type: "close-dialog" });
    await coordinator.handle({ type: entries[1].open });
    expect(options(preparation(coordinator))).toEqual({
      ...options(expected),
      kind: "reschedule-flight-picker",
    });
    await coordinator.handle({ type: "close-dialog" });
    const next = await edit(coordinator, entries[2]);
    await coordinator.handle({ type: "close-dialog" });
    await coordinator.handle({ type: "change-date", date: next.date });
    await coordinator.handle({ type: entries[0].open });
    const restored = preparation(coordinator);
    expect(restored.selectedIds).toEqual(next.selectedIds);
    expect(restored.staffStatuses).toEqual(next.staffStatuses);
    expect(options(restored).dutyRoster).toEqual(options(next).dutyRoster);
    expect(restored.candidates[0]!.bookedPassengers).toBe(123);
  });

  it("日期及A/B隔离，切回原日期和组仍恢复", async () => {
    const f = fixture();
    const coordinator = f.create();
    const expected = await edit(coordinator, entries[0]);
    await coordinator.handle({ type: "close-dialog" });
    await coordinator.handle({ type: "change-date", date: "2026-11-14" });
    await coordinator.handle({ type: entries[0].open });
    expect(preparation(coordinator).candidates[0]!.bookedPassengers).not.toBe(
      123
    );
    await coordinator.handle({ type: "close-dialog" });
    await coordinator.handle({ type: "change-date", date });
    await coordinator.handle({ type: "switch-group", groupId: "B" });
    await coordinator.handle({ type: entries[0].open });
    expect(preparation(coordinator).candidates[0]!.bookedPassengers).not.toBe(
      123
    );
    await coordinator.handle({ type: "close-dialog" });
    await coordinator.handle({ type: "switch-group", groupId: "A" });
    await coordinator.handle({ type: entries[0].open });
    expect(options(preparation(coordinator))).toEqual(options(expected));
  });

  it("全不选、0、false和空轮值也保存，重置初始数据清空草稿", async () => {
    const f = fixture();
    const coordinator = f.create();
    await edit(coordinator, entries[0]);
    await coordinator.handle({
      type: "update-schedule-preflight-selection",
      selectedIds: [],
    });
    await coordinator.handle({
      type: "update-schedule-preflight-passengers",
      candidateId: preparation(coordinator).candidates[0]!.id,
      bookedPassengers: 0,
    });
    await coordinator.handle({
      type: "update-preflight-administrative-mode",
      enabled: false,
    });
    const expected = structuredClone(preparation(coordinator));
    const refreshed = f.create();
    await refreshed.handle({ type: entries[0].open });
    expect(options(preparation(refreshed))).toEqual(options(expected));
    await refreshed.handle({ type: "close-dialog" });
    await refreshed.handle({ type: "reset-all" });
    expect(JSON.parse(f.saved.get(PREFLIGHT_DRAFTS_KEY)!)).toEqual([]);
    await refreshed.handle({ type: entries[0].open });
    expect(preparation(refreshed).staffStatuses).not.toEqual(
      expected.staffStatuses
    );
  });

  it.each(
    entries.flatMap((entry) =>
      ["error", "stop", "invalid-result"].map((mode) => ({ entry, mode }))
    )
  )(
    "$entry.open $mode 后再次打开保留准备内容，正式班表不变",
    async ({ entry, mode }) => {
      const f = fixture();
      const coordinator = f.create();
      const original = structuredClone(coordinator.model());
      const expected = await edit(coordinator, entry);
      setTestScheduleRunner(coordinator, {
        calculate: vi.fn(async () => {
          if (mode === "error") throw new Error("测试失败");
          if (mode === "stop")
            return { kind: "stopped-without-result" as const };
          return {
            kind: "completed" as const,
            result: { assignments: [], warnings: [], unfilledCount: 0 },
          };
        }),
      });
      await coordinator.handle({
        type: `confirm-${entry.prefix}`,
        selectedIds: expected.selectedIds,
      } as UiCommand);
      expect(coordinator.model()).toEqual(original);
      await coordinator.handle({ type: entry.open });
      expect(options(preparation(coordinator))).toEqual(options(expected));
    }
  );

  it.each(entries)(
    "$open 恢复草稿后只计算一次，安全结果采用后同日选项继续保留",
    async (entry) => {
      const f = fixture();
      const coordinator = f.create();
      const expected = await edit(coordinator, entry);
      await coordinator.handle({ type: "close-dialog" });
      const refreshed = f.create();
      await refreshed.handle({ type: entry.open });
      const calculate = vi.fn(async (state: AppState, resultDate: string) => ({
        kind: "completed" as const,
        result: {
          assignments: [],
          warnings: [],
          unfilledCount: 0,
          safetyCredential: createScheduleSafetySession({
            phase: "final",
            state,
            date: resultDate,
            runFacts: createScheduleRunFacts(state, resultDate),
          }).createCredential(resultDate, []),
        },
      }));
      setTestScheduleRunner(refreshed, { calculate });
      await refreshed.handle({
        type: `confirm-${entry.prefix}`,
        selectedIds: expected.selectedIds,
      } as UiCommand);
      expect(calculate).toHaveBeenCalledTimes(1);
      const input = calculate.mock.calls[0]![0];
      expect(input.flights.map((flight) => flight.flightNo)).toEqual([
        expected.candidates[0]!.flightNo,
      ]);
      expect(input.flights[0]!.bookedPassengers).toBe(123);
      expect(input.settings.adminSupportEnabled).toBe(
        expected.adminSupportEnabled
      );
      expect(refreshed.model().activeScheduleDate).toBe(expected.date);
      expect(refreshed.model().flights[0]!.bookedPassengers).toBe(123);
      await refreshed.handle({ type: "generate-schedule" });
      const actual = preparation(refreshed);
      expect(actual.selectedIds).toHaveLength(1);
      expect(actual.staffStatuses).toEqual(expected.staffStatuses);
      expect(options(actual).dutyRoster).toEqual(options(expected).dutyRoster);
      expect(actual.adminSupportEnabled).toBe(expected.adminSupportEnabled);
    }
  );

  it("四个轮值槽位的具体人选也能跨刷新保留", async () => {
    const f = fixture();
    const model = structuredClone(f.store.getState().model);
    model.staff = model.staff.map((person) => ({
      ...person,
      cxPreflightQualified: true,
      dutyQualified: true,
      standbyQualified: true,
    }));
    f.store.getState().replaceModel(model);
    const coordinator = f.create();
    await coordinator.handle({ type: "generate-schedule" });
    const slots = ["cx-preflight", "duty", "standby-0", "standby-1"] as const;
    for (const [index, slot] of slots.entries())
      await coordinator.handle({
        type: "update-schedule-preflight-duty-roster",
        slot,
        staffId: model.staff[index]!.id,
      });
    const expected = options(preparation(coordinator)).dutyRoster;
    expect(expected).toMatchObject({
      cxPreflightStaffId: model.staff[0]!.id,
      dutyStaffId: model.staff[1]!.id,
      standbyStaffIds: [model.staff[2]!.id, model.staff[3]!.id],
    });
    const refreshed = f.create();
    await refreshed.handle({ type: "generate-schedule" });
    expect(options(preparation(refreshed)).dutyRoster).toEqual(expected);
  });

  it("存储不可写时当前页面继续保留并显示跨刷新保存失败", async () => {
    const f = fixture();
    const preferences = createBrowserPreferences({
      ...f.storage,
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
    });
    const coordinator = createTestApplicationCoordinator(f.store, {
      preferences,
    });
    const expected = await edit(coordinator, entries[0]);
    expect(coordinator.view().toast?.message).toContain("准备选项");
    expect(coordinator.view().toast?.message).toContain("刷新");
    await coordinator.handle({ type: "close-dialog" });
    await coordinator.handle({ type: entries[0].open });
    expect(options(preparation(coordinator))).toEqual(options(expected));
  });

  it.each(entries)(
    "$open 逐步调整其他人员状态不会抹掉已选的轮值",
    async (entry) => {
      const f = fixture();
      const coordinator = f.create();
      await coordinator.handle({ type: entry.open });
      await coordinator.handle({
        type: `update-${entry.prefix}-duty-roster`,
        slot: "duty",
        staffId: "",
      } as UiCommand);
      const roster = options(preparation(coordinator)).dutyRoster;
      await coordinator.handle({
        type: `update-${entry.prefix}-staff-status`,
        staffId: coordinator.model().staff.at(-1)!.id,
        status: "病假",
      } as UiCommand);
      expect(options(preparation(coordinator)).dutyRoster).toEqual(roster);
    }
  );

  it("自建假别保留；目录变化后不复活已删除人员/航班或失效假别和轮值", async () => {
    const f = fixture();
    const initial = structuredClone(f.store.getState().model);
    initial.leaveTypes = [{ id: "custom", name: "测试假", enabled: true }];
    f.store.getState().replaceModel(initial);
    const coordinator = f.create();
    await edit(coordinator, entries[0]);
    const person = coordinator.model().staff[0]!;
    await coordinator.handle({
      type: "update-schedule-preflight-staff-status",
      staffId: person.id,
      status: "leave:custom",
    });
    const expected = preparation(coordinator);
    const restored = f.create();
    await restored.handle({ type: entries[0].open });
    expect(preparation(restored).staffStatuses?.[person.id]).toBe(
      "leave:custom"
    );
    const changed = structuredClone(restored.model());
    const removedFlight = expected.candidates[0]!.flightNo;
    const removedPerson = changed.staff.at(-1)!.id;
    changed.leaveTypes = [];
    changed.staff = changed.staff
      .filter((item) => item.id !== removedPerson)
      .map((item) => ({ ...item, dutyQualified: false }));
    changed.positionRules = changed.positionRules.filter(
      (rule) => rule.flightNo !== removedFlight
    );
    changed.templates = changed.templates
      .filter((item) => item.flightNo !== removedFlight)
      .map((item) => ({ ...item, id: `${item.id}-new` }));
    changed.flights = changed.flights.filter(
      (item) => item.flightNo !== removedFlight
    );
    f.store.getState().replaceModel(changed);
    const reopened = f.create();
    await reopened.handle({ type: entries[0].open });
    const actual = preparation(reopened);
    expect(
      actual.candidates.some((item) => item.flightNo === removedFlight)
    ).toBe(false);
    expect(actual.staffStatuses).not.toHaveProperty(removedPerson);
    expect(actual.staffStatuses?.[person.id]).toBe("正常");
    expect(actual.dutyRoster?.dutyStaffId).toBeNull();
    expect(actual.adminSupportEnabled).toBe(expected.adminSupportEnabled);
  });

  it("航班临时ID变化仍按航班号找回勾选和人数", async () => {
    const f = fixture();
    const coordinator = f.create();
    const expected = await edit(coordinator, entries[0]);
    const changed = structuredClone(coordinator.model());
    changed.templates = changed.templates.map((item) => ({
      ...item,
      id: `${item.id}-new`,
    }));
    f.store.getState().replaceModel(changed);
    const refreshed = f.create();
    await refreshed.handle({ type: entries[1].open });
    const actual = preparation(refreshed);
    expect(actual.selectedIds).toEqual([`${expected.selectedIds[0]}-new`]);
    expect(actual.candidates[0]!.bookedPassengers).toBe(123);
  });

  it.each(["{", "null", "{}", '[{"groupId":"A","date":"bad"}]'])(
    "损坏存储 %s 不妨碍打开默认窗口",
    async (raw) => {
      const f = fixture();
      f.saved.set(PREFLIGHT_DRAFTS_KEY, raw);
      const coordinator = f.create();
      await coordinator.handle({ type: entries[0].open });
      expect(preparation(coordinator).candidates[0]!.bookedPassengers).toBe(0);
      expect(preparation(coordinator).selectedIds.length).toBeGreaterThan(0);
    }
  );
});
