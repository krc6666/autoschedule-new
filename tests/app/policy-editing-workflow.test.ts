import { describe, expect, it, vi } from "vitest";
import { createDefaultState } from "../../src/defaults";
import * as XLSX from "xlsx-js-style";
import {
  buildConfigWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";
import { createStatePersistence } from "../../src/infrastructure/storage";
import {
  createTestApplicationCoordinator,
  createTestAutoscheduleStore,
  createMemoryStatePersistence,
} from "../helpers/application";

const preferences = {
  loadScheduleDate: () => "2026-11-18",
  saveScheduleDate: () => {},
  loadScheduleZoom: () => 1,
  saveScheduleZoom: () => {},
};

describe("whole-page policy editing", () => {
  it("does not prompt for edits reverted to their original value and isolates A/B settings", async () => {
    const confirm = vi.fn(() => false);
    const app = createTestApplicationCoordinator(
      createTestAutoscheduleStore(),
      { preferences, confirm }
    );
    const value = app.model().settings.maxTodayFatigueDifference;
    const originalB = structuredClone(app.model().groups.B.settings);
    await app.handle({
      type: "edit-policy-input",
      input: { maxTodayFatigueDifference: value + 1 },
    });
    await app.handle({ type: "switch-group", groupId: "B" });
    expect(confirm).toHaveBeenCalledOnce();
    expect(app.model().activeGroupId).toBe("A");
    expect(app.view().policyEditing?.dirty).toBe(true);
    await app.handle({
      type: "edit-policy-input",
      input: { maxTodayFatigueDifference: value },
    });
    expect(app.hasUnsavedRules()).toBe(false);
    await app.handle({ type: "switch-group", groupId: "B" });
    expect(confirm).toHaveBeenCalledOnce();
    expect(app.model().settings).toEqual(originalB);
  });

  it("collects reordering, protection, ordinary fields and structured edits in the same save", async () => {
    const app = createTestApplicationCoordinator(
      createTestAutoscheduleStore(),
      { preferences }
    );
    const before = structuredClone(app.model());
    const first = before.settings.dutyPositionPriorities[0]!;
    const position = before.positionRules.find(
      (rule) => rule.category === "常规" && rule.flightNo !== "KE166"
    )!;
    await app.handle({
      type: "move-duty-priority",
      id: first.id,
      direction: 1,
    });
    await app.handle({
      type: "update-policy",
      entity: "duty-priority",
      id: first.id,
      field: "positionKeyword",
      value: "新岗位",
    });
    await app.handle({
      type: "set-team-leader-gap-fill-positions-movable",
      positionRuleIds: [position.id],
      movable: true,
    });
    await app.handle({ type: "add-ordinary-priority-position" });
    const index =
      app.view().policyEditing!.model.settings.ordinaryPriorityPositions
        .length - 1;
    await app.handle({
      type: "update-ordinary-priority-position",
      index,
      field: "airlineCode",
      value: "AB",
    });
    await app.handle({
      type: "update-ordinary-priority-position",
      index,
      field: "position",
      value: "G99",
    });
    expect(app.model()).toEqual(before);
    await app.handle({ type: "save-policy" });
    expect(app.hasUnsavedRules()).toBe(false);
    expect(app.model().settings.dutyPositionPriorities[1]).toMatchObject({
      id: first.id,
      positionKeyword: "新岗位",
    });
    expect(app.model().settings.ordinaryPriorityPositions.at(-1)).toEqual({
      airlineCode: "AB",
      position: "G99",
    });
    expect(
      app.model().settings.teamLeaderGapFillPositionPolicies
    ).toContainEqual({
      flightNo: position.flightNo,
      position: position.name,
      movable: true,
    });
    expect(app.model().groups.B.settings).toEqual(before.groups.B.settings);
    expect(app.model().staff).toEqual(before.staff);
    expect(app.model().history).toEqual(before.history);
  });

  it("does not silently drop invalid text or incomplete collections when saving", async () => {
    const app = createTestApplicationCoordinator(
      createTestAutoscheduleStore(),
      { preferences, confirm: () => true }
    );
    const before = structuredClone(app.model());
    const airline = before.settings.airlineMixPolicies[0]!;
    await app.handle({
      type: "update-policy",
      entity: "airline-mix",
      id: airline.id,
      field: "airlineCodes",
      value: "CX931",
    });
    expect(app.hasUnsavedRules()).toBe(true);
    await app.handle({ type: "save-policy" });
    expect(app.model()).toEqual(before);
    expect(app.view().toast?.message).toContain("航司代码");
    await app.handle({
      type: "delete-policy-item",
      collection: "airline-mix",
      id: airline.id,
    });
    await app.handle({
      type: "add-policy-item",
      collection: "same-flight-staff-exclusion",
    });
    const item = app
      .view()
      .policyEditing!.model.settings.sameFlightStaffExclusions.at(-1)!;
    await app.handle({
      type: "update-policy",
      entity: "same-flight-staff-exclusion",
      id: item.id,
      field: "staffIds",
      value: "",
    });
    await app.handle({ type: "save-policy" });
    expect(app.model()).toEqual(before);
    expect(app.hasUnsavedRules()).toBe(true);
    expect(app.view().toast?.message).toContain("填写不完整");
  });

  it("exports saved rules through real Excel bytes, imports to an empty group and reloads storage", async () => {
    const app = createTestApplicationCoordinator(
      createTestAutoscheduleStore(),
      { preferences }
    );
    await app.handle({
      type: "edit-policy-input",
      input: {
        maxTodayFatigueDifference: 8,
        earlyDepartureBalanceEnabled: false,
      },
    });
    await app.handle({
      type: "add-policy-item",
      collection: "same-flight-staff-exclusion",
    });
    await app.handle({ type: "save-policy" });
    const bytes = XLSX.write(buildConfigWorkbook(app.model()), {
      type: "array",
      bookType: "xlsx",
    });
    const empty = createDefaultState();
    empty.staff = [];
    empty.positionRules = [];
    empty.settings.sameFlightStaffExclusions = [];
    const data = new Map<string, string>();
    const persistence = createStatePersistence({
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        data.set(key, value);
      },
      removeItem: (key) => {
        data.delete(key);
      },
    });
    const store = createTestAutoscheduleStore(empty, persistence);
    store
      .getState()
      .records.applyWorkbookImport(
        parseWorkbook(XLSX.read(bytes, { type: "array" }), []),
        "config"
      );
    store.getState().persist();
    const reloaded = createTestAutoscheduleStore(persistence.load());
    expect(reloaded.getState().model.settings.maxTodayFatigueDifference).toBe(
      8
    );
    expect(
      reloaded.getState().model.settings.earlyDepartureBalanceEnabled
    ).toBe(false);
    expect(
      reloaded.getState().model.settings.sameFlightStaffExclusions
    ).toEqual(app.model().settings.sameFlightStaffExclusions);
    expect(reloaded.getState().model.groups.B.settings).toEqual(
      empty.groups.B.settings
    );
  });
  it("keeps scalar edits, structured edits and order out of the formal model until one save", async () => {
    const initial = createDefaultState();
    const flight = initial.flights[0]!;
    initial.assignments = [
      {
        id: "existing-manual",
        flightId: flight.id,
        flightNo: flight.flightNo,
        positionRuleId: null,
        position: "临时岗位",
        staffId: null,
        staffName: "",
        startTime: flight.startTime,
        endTime: flight.endTime,
        workHours: 0,
        fatiguePoints: 0,
        remark: "原班表",
        manualRemark: "",
        status: "manual",
      },
    ];
    const store = createTestAutoscheduleStore(initial);
    const save = vi.spyOn(store.getState(), "persist");
    const app = createTestApplicationCoordinator(store, {
      preferences,
      confirm: () => false,
    });
    const before = structuredClone(app.model());
    await app.handle({
      type: "edit-policy-input",
      input: { ...before.settings, maxTodayFatigueDifference: 8 },
    });
    await app.handle({
      type: "add-policy-item",
      collection: "same-flight-staff-exclusion",
    });
    expect(app.model()).toEqual(before);
    expect(save).not.toHaveBeenCalled();
    expect(app.view().policyEditing?.dirty).toBe(true);
    expect(
      app.view().policyEditing?.model.settings.maxTodayFatigueDifference
    ).toBe(8);
    await app.handle({ type: "save-policy" });
    expect(app.model().settings.maxTodayFatigueDifference).toBe(8);
    expect(app.model().assignments).toEqual(before.assignments);
    expect(app.model().schedulePolicyStale).toBe(true);
    expect(app.model().groups.A.schedulePolicyStale).toBe(true);
    expect(app.model().settings.sameFlightStaffExclusions).toHaveLength(
      before.settings.sameFlightStaffExclusions.length + 1
    );
    expect(app.view().policyEditing?.dirty).toBe(false);
  });

  it("retains drafts when reset is cancelled or formal rules changed outside the editor", async () => {
    const confirm = vi.fn(() => false);
    const store = createTestAutoscheduleStore();
    const app = createTestApplicationCoordinator(store, {
      preferences,
      confirm,
    });
    await app.handle({
      type: "edit-policy-input",
      input: { maxTodayFatigueDifference: 8 },
    });
    await app.handle({ type: "reset-all" });
    expect(app.hasUnsavedRules()).toBe(true);
    const formal = structuredClone(app.model());
    store.getState().policy.apply({ ...formal.settings, maxDailyHours: 10 });
    const changed = structuredClone(app.model());
    await app.handle({ type: "save-policy" });
    expect(app.model()).toEqual(changed);
    expect(
      app.view().policyEditing?.model.settings.maxTodayFatigueDifference
    ).toBe(8);
    expect(app.view().toast?.message).toContain("正式规则已被其他操作改变");
  });

  it("retains the entire draft when navigation is cancelled, and discards only after confirmation", async () => {
    const confirm = vi.fn(() => false);
    const app = createTestApplicationCoordinator(
      createTestAutoscheduleStore(),
      { preferences, confirm }
    );
    await app.handle({ type: "navigate", section: "policy" });
    const before = structuredClone(app.model());
    await app.handle({
      type: "edit-policy-input",
      input: { ...before.settings, maxTodayFatigueDifference: 9 },
    });
    await app.handle({ type: "navigate", section: "schedule" });
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("未保存"));
    expect(app.view().section).toBe("policy");
    expect(
      app.view().policyEditing?.model.settings.maxTodayFatigueDifference
    ).toBe(9);
    expect(app.model()).toEqual(before);
    confirm.mockReturnValue(true);
    await app.handle({ type: "navigate", section: "schedule" });
    expect(app.view().section).toBe("schedule");
    expect(app.view().policyEditing?.dirty).toBe(false);
    expect(app.model()).toEqual(before);
  });

  it("keeps both formal settings and the draft on persistence failure and permits retry", async () => {
    const persistence = createMemoryStatePersistence();
    const save = vi.spyOn(persistence, "save").mockImplementationOnce(() => {
      throw new Error("disk unavailable");
    });
    const app = createTestApplicationCoordinator(
      createTestAutoscheduleStore(createDefaultState(), persistence),
      { preferences }
    );
    const before = structuredClone(app.model());
    await app.handle({
      type: "edit-policy-input",
      input: { ...before.settings, maxTodayFatigueDifference: 9 },
    });
    await app.handle({ type: "save-policy" });
    expect(save).toHaveBeenCalledOnce();
    expect(app.model()).toEqual(before);
    expect(app.view().policyEditing?.dirty).toBe(true);
    expect(app.view().toast?.tone).toBe("danger");
    await app.handle({ type: "save-policy" });
    expect(app.model().settings.maxTodayFatigueDifference).toBe(9);
    expect(app.view().policyEditing?.dirty).toBe(false);
  });
});
