import { describe, expect, it, vi } from "vitest";

import {
  createTestApplicationCoordinator,
  createTestAutoscheduleStore,
  setTestScheduleRunner,
} from "../helpers/application";
import { createDefaultState } from "../../src/defaults";
import {
  createStatePersistence,
  STORAGE_KEY,
} from "../../src/infrastructure/storage";

const preferences = {
  loadScheduleDate: () => null,
  saveScheduleDate: vi.fn(),
  loadScheduleZoom: () => null,
  saveScheduleZoom: vi.fn(),
};

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

describe("configuration controller", () => {
  it("does not give a save warning when a configured flight is merely absent from today's plan", async () => {
    const initial = createDefaultState();
    initial.templates = [
      { ...initial.templates[0]!, id: "tw", flightNo: "TW616" },
    ];
    initial.flights = [];
    const base = initial.positionRules[0]!;
    initial.positionRules = [
      {
        ...base,
        id: "source",
        flightNo: "TW616",
        name: "督导",
        category: "机动督导",
      },
      {
        ...base,
        id: "target",
        flightNo: "TW616",
        name: "G16",
        category: "常规",
        coverageRole: "supervisor-fill",
      },
    ];
    initial.settings.mobileSupervisorFillRules = [
      {
        id: "fill",
        enabled: true,
        sourceFlightNo: "TW616",
        sourcePositionKeyword: "督导",
        targetFlightNo: "TW616",
        targetPositionKeyword: "G16",
        allowAutomatic: true,
        allowManual: true,
      },
    ];
    const store = createTestAutoscheduleStore(initial);
    const coordinator = createTestApplicationCoordinator(store, {
      preferences,
    });
    await coordinator.handle({
      type: "update-policy",
      entity: "supervisor-fill",
      id: "fill",
      field: "allowAutomatic",
      value: true,
    });
    expect(coordinator.view().toast?.tone).not.toBe("warning");
    expect(
      store.getState().model.settings.mobileSupervisorFillRules[0]
        ?.sourceFlightNo
    ).toBe("TW616");
  });

  it("warns when saving a supervisor-fill relation whose target lacks the fill role", async () => {
    const initial = createDefaultState();
    const flight = initial.flights[0]!;
    const base = initial.positionRules[0]!;
    initial.positionRules.push(
      {
        ...base,
        id: "source-supervisor",
        flightNo: flight.flightNo,
        name: "机动督导",
        category: "机动督导",
        coverageRole: "none",
      },
      {
        ...base,
        id: "target-h05",
        flightNo: flight.flightNo,
        name: "H05",
        category: "常规",
        coverageRole: "none",
      }
    );
    initial.settings.mobileSupervisorFillRules = [
      {
        id: "fill-rule",
        enabled: true,
        sourceFlightNo: flight.flightNo,
        sourcePositionKeyword: "机动督导",
        targetFlightNo: flight.flightNo,
        targetPositionKeyword: "H05",
        allowAutomatic: true,
        allowManual: true,
      },
    ];
    const store = createTestAutoscheduleStore(initial);
    const coordinator = createTestApplicationCoordinator(store, {
      preferences,
    });

    await coordinator.handle({
      type: "update-policy",
      entity: "supervisor-fill",
      id: "fill-rule",
      field: "allowAutomatic",
      value: true,
    });

    expect(coordinator.view().toast).toMatchObject({
      message: "目标岗位未标记为督导补位（H05），当前关系不会生效",
      tone: "warning",
    });
  });

  it("overwrites the late flight rules with the selected early flight rules", async () => {
    const initial = createDefaultState();
    const sourceFlightNo = "CX937 （早）";
    const targetFlightNo = "CX937 （晚）";
    const sourceRules = initial.positionRules
      .filter((rule) => rule.flightNo === "CX937")
      .map((rule) => ({ ...rule, flightNo: sourceFlightNo }));
    const targetRules = initial.positionRules
      .filter((rule) => rule.flightNo === "FD573")
      .map((rule) => ({
        ...rule,
        id: `late-${rule.id}`,
        flightNo: targetFlightNo,
      }));
    initial.positionRules = [...sourceRules, ...targetRules];
    initial.templates = [
      { ...initial.templates[0]!, id: "early", flightNo: sourceFlightNo },
      { ...initial.templates[1]!, id: "late", flightNo: targetFlightNo },
    ];
    const store = createTestAutoscheduleStore(initial);
    const confirm = vi.fn(() => true);
    const coordinator = createTestApplicationCoordinator(store, {
      preferences,
      confirm,
    });

    await coordinator.handle({
      type: "copy-position-rules",
      sourceFlightNo,
      targetFlightNo,
    });

    const copied = store
      .getState()
      .model.positionRules.filter((rule) => rule.flightNo === targetFlightNo);
    expect(confirm).toHaveBeenCalledWith(
      `目标航班 ${targetFlightNo} 已有岗位规则，确认覆盖？`
    );
    expect(copied).toHaveLength(sourceRules.length);
    expect(copied.map((rule) => rule.name)).toEqual(
      sourceRules.map((rule) => rule.name)
    );
    expect(copied.map((rule) => rule.qualifiedStaffIds)).toEqual(
      sourceRules.map((rule) => rule.qualifiedStaffIds)
    );
    expect(
      copied.some((rule) => targetRules.some((old) => old.id === rule.id))
    ).toBe(false);
    expect(coordinator.view().toast?.message).toBe(
      `已将 ${sourceFlightNo} 的岗位配置复制到 ${targetFlightNo}`
    );
  });

  it("persists a staff status change when background rescheduling fails", async () => {
    const storage = memoryStorage();
    const initial = createDefaultState();
    const person = initial.staff.find((item) => item.status === "正常")!;
    initial.activeScheduleDate = "2026-08-01";
    const store = createTestAutoscheduleStore(
      initial,
      createStatePersistence(storage)
    );
    const coordinator = createTestApplicationCoordinator(store, {
      preferences: {
        ...preferences,
        loadScheduleDate: () => "2026-08-01",
      },
    });
    setTestScheduleRunner(coordinator, {
      calculate: vi.fn().mockRejectedValue(new Error("worker failed")),
    });

    await coordinator.handle({
      type: "update-configuration",
      entity: "staff",
      id: person.id,
      field: "status",
      value: "病假",
    });

    expect(JSON.parse(storage.getItem(STORAGE_KEY) ?? "null")).toMatchObject({
      staff: expect.arrayContaining([
        expect.objectContaining({ id: person.id, status: "病假" }),
      ]),
    });
    expect(coordinator.view().toast).toMatchObject({
      message: "人员状态已更新，但排班重新计算失败：worker failed",
      tone: "danger",
    });
  });
});
