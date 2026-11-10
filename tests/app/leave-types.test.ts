import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx-js-style";

import { createDefaultState } from "../../src/defaults";
import { createTestAutoscheduleStore } from "../helpers/application";
import {
  staffStatusLabel,
  staffStatusValue,
} from "../../src/domain/staff-status";
import { loadState } from "../../src/infrastructure/storage";
import { getLastRestorationReport } from "../../src/infrastructure/state-restoration";
import {
  buildConfigWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";
import { applyWorkbookImport } from "../../src/app/workbook-actions";

describe("maintainable leave types", () => {
  it("keeps leave rules fixed through rename, disabling, restore and returning to normal", () => {
    const store = createTestAutoscheduleStore(createDefaultState());
    const commands = store.getState().configuration;
    expect(commands.addLeaveType(" 飞行假 ").ok).toBe(true);
    const leave = store.getState().model.leaveTypes[0]!;
    const id = store.getState().model.staff[0]!.id;
    expect(
      store.getState().schedule.applyStaffStatus(id, `leave:${leave.id}`)
    ).toBe(true);
    expect(store.getState().model.staff[0]).toMatchObject({
      status: "休假",
      leaveTypeId: leave.id,
    });
    expect(commands.updateLeaveType(leave.id, { name: "飞行休假" }).ok).toBe(
      true
    );
    expect(
      staffStatusLabel(
        store.getState().model.staff[0]!,
        store.getState().model.leaveTypes
      )
    ).toBe("飞行休假");
    expect(commands.updateLeaveType(leave.id, { enabled: false }).ok).toBe(
      true
    );
    expect(commands.deleteLeaveType(leave.id).ok).toBe(false);
    const loaded = loadState({
      getItem: () => JSON.stringify(store.getState().model),
    });
    expect(loaded.staff[0]).toMatchObject({
      status: "休假",
      leaveTypeId: leave.id,
    });
    expect(loaded.leaveTypes).toEqual([
      { id: leave.id, name: "飞行休假", enabled: false },
    ]);
    expect(
      store
        .getState()
        .schedule.applyStaffStatus(
          store.getState().model.staff[1]!.id,
          `leave:${leave.id}`
        )
    ).toBe(false);
    expect(store.getState().schedule.applyStaffStatus(id, "正常")).toBe(true);
    expect(store.getState().model.staff[0]!.leaveTypeId).toBeUndefined();
    expect(commands.deleteLeaveType(leave.id).ok).toBe(true);
  });

  it("rejects blank, builtin and duplicate names without modifying people or assignments", () => {
    const store = createTestAutoscheduleStore(createDefaultState());
    const before = structuredClone(store.getState().model.staff);
    const commands = store.getState().configuration;
    for (const name of ["", "  ", "正常", "病假", "休假"])
      expect(commands.addLeaveType(name).ok).toBe(false);
    expect(commands.addLeaveType("飞行假").ok).toBe(true);
    expect(commands.addLeaveType(" 飞行假 ").ok).toBe(false);
    expect(store.getState().model.staff).toEqual(before);
    expect(store.getState().model.assignments).toEqual([]);
    const id = before[0]!.id;
    expect(
      store.getState().schedule.applyStaffStatus(id, "leave:missing")
    ).toBe(false);
    expect(store.getState().model.staff).toEqual(before);
  });

  it("isolates group catalogs and preserves them through switching and persistence", () => {
    const store = createTestAutoscheduleStore(createDefaultState());
    store.getState().configuration.addLeaveType("飞行假");
    const types = structuredClone(store.getState().model.leaveTypes);
    store.getState().switchGroup("B");
    expect(store.getState().model.leaveTypes).toEqual([]);
    store.getState().configuration.addLeaveType("年假");
    const restored = loadState({
      getItem: () => JSON.stringify(store.getState().model),
    });
    expect(restored.activeGroupId).toBe("B");
    expect(restored.leaveTypes.map((item) => item.name)).toEqual(["年假"]);
    expect(restored.groups.A.leaveTypes).toEqual(types);
    store.getState().switchGroup("A");
    expect(store.getState().model.leaveTypes).toEqual(types);
  });

  it("loads old data without changing statuses, and reports broken references without losing people", () => {
    const state = createDefaultState();
    const old = JSON.parse(JSON.stringify(state));
    delete old.leaveTypes;
    delete old.groups.A.leaveTypes;
    delete old.groups.B.leaveTypes;
    const loaded = loadState({ getItem: () => JSON.stringify(old) });
    expect(loaded.leaveTypes).toEqual([]);
    expect(loaded.staff).toEqual(state.staff);
    old.staff[0].status = "休假";
    old.staff[0].leaveTypeId = "missing";
    const damaged = loadState({ getItem: () => JSON.stringify(old) });
    expect(damaged.staff).toHaveLength(state.staff.length);
    expect(damaged.staff[0]!.status).toBe("休假");
    expect(
      getLastRestorationReport().issues.some((issue) =>
        issue.reason.includes("休假类别")
      )
    ).toBe(true);
  });

  it("round trips enabled and disabled categories and selected labels through real XLSX bytes", () => {
    const store = createTestAutoscheduleStore(createDefaultState());
    store.getState().configuration.addLeaveType("飞行假");
    store.getState().configuration.addLeaveType("年假");
    const [flightLeave, annualLeave] = store.getState().model.leaveTypes;
    store
      .getState()
      .schedule.applyStaffStatus(
        store.getState().model.staff[0]!.id,
        `leave:${flightLeave!.id}`
      );
    store
      .getState()
      .configuration.updateLeaveType(annualLeave!.id, { enabled: false });
    const state = store.getState().model;
    const workbook = XLSX.read(
      XLSX.write(buildConfigWorkbook(state), {
        type: "array",
        bookType: "xlsx",
      }),
      { type: "array" }
    );
    const parsed = parseWorkbook(workbook, []);
    expect(parsed.warnings).toEqual([]);
    const fresh = createDefaultState();
    applyWorkbookImport(fresh, parsed, "config");
    expect(fresh.leaveTypes).toEqual(state.leaveTypes);
    expect(staffStatusLabel(fresh.staff[0]!, fresh.leaveTypes)).toBe("飞行假");
    expect(staffStatusValue(fresh.staff[0]!)).toBe(`leave:${flightLeave!.id}`);
    expect(fresh.staff[0]!.status).toBe("休假");
    expect(fresh.groups.B.leaveTypes).toEqual([]);
  });

  it("keeps categories on old-file imports and never treats an unknown Excel status as normal", () => {
    const state = createDefaultState();
    state.leaveTypes = [{ id: "flight", name: "飞行假", enabled: true }];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["编号", "姓名", "是否可上夜班", "状态", "备注"],
        ["anonymous", "示例人员", "是", "陌生假", ""],
      ]),
      "人员信息"
    );
    const parsed = parseWorkbook(workbook, state.staff);
    expect(parsed.staff?.[0]!.status).toBe("休假");
    expect(parsed.warnings.some((message) => message.includes("陌生假"))).toBe(
      true
    );
    applyWorkbookImport(state, parsed, "config");
    expect(state.leaveTypes).toEqual([
      { id: "flight", name: "飞行假", enabled: true },
    ]);
    expect(state.staff[0]!.status).toBe("休假");
  });

  it("rejects invalid category sheets and prevents a category-only import from orphaning people", () => {
    const state = createDefaultState();
    state.leaveTypes = [{ id: "flight", name: "飞行假", enabled: true }];
    state.staff[0]!.status = "休假";
    state.staff[0]!.leaveTypeId = "flight";
    const original = structuredClone(state);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["类别编号", "名称", "启用"],
        ["one", "年假", "是"],
        ["one", "飞行假", "否"],
      ]),
      "休假类别"
    );
    const invalid = parseWorkbook(workbook, state.staff, {
      leaveTypes: state.leaveTypes,
    });
    expect(invalid.leaveTypes).toBeUndefined();
    expect(invalid.warnings.some((warning) => warning.includes("第3行"))).toBe(
      true
    );
    applyWorkbookImport(state, invalid, "config");
    expect(state).toEqual(original);
    const missingReference = applyWorkbookImport(
      state,
      { leaveTypes: [], warnings: [] },
      "config"
    );
    expect(missingReference.errors?.[0]).toContain("正在使用");
    expect(state).toEqual(original);
    delete state.staff[0]!.leaveTypeId;
    const empty = applyWorkbookImport(
      state,
      { leaveTypes: [], warnings: [] },
      "config"
    );
    expect(empty.changedConfig).toBe(true);
    expect(state.leaveTypes).toEqual([]);
  });

  it("maps label-only old personnel sheets using the current catalog without changing its stable id", () => {
    const state = createDefaultState();
    state.leaveTypes = [{ id: "flight", name: "飞行假", enabled: false }];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["编号", "姓名", "是否可上夜班", "状态", "备注"],
        ["example", "示例人员", "是", "飞行假", ""],
      ]),
      "人员信息"
    );
    const parsed = parseWorkbook(workbook, state.staff, {
      leaveTypes: state.leaveTypes,
    });
    expect(parsed.warnings).toEqual([]);
    applyWorkbookImport(state, parsed, "config");
    expect(state.staff[0]).toMatchObject({
      status: "休假",
      leaveTypeId: "flight",
    });
    expect(state.leaveTypes[0]!.enabled).toBe(false);
  });
});
