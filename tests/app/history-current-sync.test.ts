import {
  historySyncState,
  memoryPersistence,
  syncDate,
} from "../helpers/history-sync";
import { describe, expect, it, vi } from "vitest";
import { scheduleRuleFingerprint } from "../../src/domain/rules/schedule-rule-fingerprint";
import {
  buildConfigWorkbook,
  buildScheduleWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";
import { buildMonthlyStaffFatigue } from "../../src/domain/statistics/monthly-staff-fatigue";
import * as XLSX from "xlsx-js-style";
import { writeFileSync } from "node:fs";
import {
  createTestApplicationCoordinator,
  createTestAutoscheduleStore,
} from "../helpers/application";

function setup(state = historySyncState(), accepted = true) {
  const persistence = { ...memoryPersistence() };
  const save = vi.spyOn(persistence, "save");
  const confirm = vi.fn(() => accepted);
  const store = createTestAutoscheduleStore(state, persistence);
  const app = createTestApplicationCoordinator(store, {
    restoredScheduleNotice: true,
    confirm,
    preferences: {
      loadScheduleDate: () => syncDate,
      saveScheduleDate: () => {},
      loadScheduleZoom: () => null,
      saveScheduleZoom: () => {},
    },
  });
  return { app, store, persistence, save, confirm };
}

async function edit(app: ReturnType<typeof setup>["app"]) {
  await app.handle({ type: "edit-history-date", date: syncDate });
  const slot = app.model().assignments[0]!;
  await app.handle({
    type: "update-assignment",
    id: slot.id,
    field: "staffName",
    value: app.model().staff[1]!.name,
  });
  await app.handle({
    type: "update-assignment",
    id: slot.id,
    field: "manualRemark",
    value: "历史保存的新备注",
  });
  return structuredClone(app.model().assignments);
}

describe("history saves synchronize the active date", () => {
  it("retains historical flight numbers, times and cutoff through changing staff, save, reload, repeated edit and Excel", async () => {
    const state = historySyncState();
    Object.assign(state.history[0]!, {
      startTime: "08:20",
      endTime: "09:20",
      flightCutoffTime: "10:20",
    });
    const original = structuredClone(state.history[0]!);
    const { app, persistence } = setup(state);
    await edit(app);
    expect(app.model().assignments[0]).toMatchObject({
      startTime: "08:20",
      endTime: "09:20",
    });
    await app.handle({ type: "save-history-edit" });
    const restored = persistence.load();
    const row = restored.history.find((r) => r.date === syncDate)!;
    expect(row).toMatchObject({
      flightNo: original.flightNo,
      startTime: "08:20",
      endTime: "09:20",
      flightCutoffTime: "10:20",
      workHours: original.workHours,
      fatiguePoints: original.fatiguePoints,
      staffId: state.staff[1]!.id,
    });
    const config = XLSX.read(
      XLSX.write(buildConfigWorkbook(restored), {
        type: "buffer",
        bookType: "xlsx",
      }),
      { type: "buffer" }
    );
    expect(
      parseWorkbook(config, restored.staff).history!.find(
        (r) => r.date === syncDate
      )
    ).toMatchObject({
      startTime: "08:20",
      endTime: "09:20",
      flightCutoffTime: "10:20",
    });
    const next = setup(restored);
    await next.app.handle({ type: "edit-history-date", date: syncDate });
    expect(next.app.model().assignments[0]).toMatchObject({
      flightNo: original.flightNo,
      startTime: "08:20",
      endTime: "09:20",
    });
    const before = structuredClone(restored);
    await next.app.handle({ type: "cancel-history-edit" });
    expect(next.app.model().flights).toEqual(before.flights);
    expect(next.app.model().assignments).toEqual(before.assignments);
    expect(next.app.model().history).toEqual(before.history);
    const resultBytes = XLSX.write(buildScheduleWorkbook(restored, syncDate), {
      type: "buffer",
      bookType: "xlsx",
    });
    const result = XLSX.read(resultBytes, { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json(result.Sheets["排班结果"]!);
    expect(JSON.stringify(rows)).toContain("08:20");
    expect(JSON.stringify(rows)).toContain("09:20");
    writeFileSync(
      "docs/acceptance/evidence/2026-11-17-history-time-result.xlsx",
      resultBytes
    );
    writeFileSync(
      "docs/acceptance/evidence/2026-11-17-history-time-final.json",
      JSON.stringify(
        {
          date: syncDate,
          current: restored.assignments,
          history: row,
          flight: restored.flights[0],
          configHistory: parseWorkbook(config, restored.staff).history!.find(
            (r) => r.date === syncDate
          ),
        },
        null,
        2
      ) + "\n"
    );
  });

  it("commits the edited facts to current, history, stored reload and result Excel without touching the other date/group", async () => {
    const { app, persistence } = setup();
    const before = structuredClone(app.model());
    const edited = await edit(app);
    await app.handle({ type: "save-history-edit" });
    expect(app.model().assignments).toEqual(edited);
    expect(app.model().activeScheduleDate).toBe(syncDate);
    expect(app.view().restoredScheduleNotice).toBe(false);
    expect(app.model().groups.A.assignments).toEqual(edited);
    expect(app.model().groups.B).toEqual(before.groups.B);
    expect(app.model().history.filter((r) => r.date !== syncDate)).toEqual(
      before.history.filter((r) => r.date !== syncDate)
    );
    expect(app.model().history.find((r) => r.date === syncDate)).toMatchObject({
      staffId: edited[0]!.staffId,
      staffName: edited[0]!.staffName,
      assignmentRemarks: { manualRemark: "历史保存的新备注" },
    });
    const reloaded = persistence.load();
    expect(reloaded.assignments).toEqual(edited);
    expect(reloaded.schedulePolicyStale).toBe(false);
    expect(reloaded.scheduleRuleFingerprint).toBe(
      scheduleRuleFingerprint(reloaded)
    );
    const workbook = buildScheduleWorkbook(reloaded, syncDate);
    expect(JSON.stringify(workbook.Sheets["排班结果"])).toContain(
      edited[0]!.staffName
    );
    expect(JSON.stringify(workbook.Sheets["排班结果"])).toContain(
      "历史保存的新备注"
    );
    const resultBytes = XLSX.write(workbook, {
      type: "buffer",
      bookType: "xlsx",
    });
    const resultBook = XLSX.read(resultBytes, { type: "buffer" });
    const resultRows = XLSX.utils.sheet_to_json(resultBook.Sheets["排班结果"]!);
    expect(JSON.stringify(resultRows)).toContain(edited[0]!.staffName);
    expect(JSON.stringify(resultRows)).toContain("历史保存的新备注");
    const configBytes = XLSX.write(buildConfigWorkbook(reloaded), {
      type: "buffer",
      bookType: "xlsx",
    });
    const imported = parseWorkbook(
      XLSX.read(configBytes, { type: "buffer" }),
      reloaded.staff
    );
    expect(imported.history?.find((r) => r.date === syncDate)).toMatchObject({
      staffId: edited[0]!.staffId,
      countBaseline: edited[0]!.countBaseline,
    });
    const fatigue = buildMonthlyStaffFatigue(
      reloaded,
      "2026-11",
      syncDate
    ).rows;
    // One old-date record belongs to worker 1; the current/history pair for
    // this date belongs to worker 2 and must count once, never twice.
    expect(fatigue.map((r) => [r.todayFatigue, r.monthFatigue])).toEqual([
      [0, 3],
      [3, 3],
    ]);
    writeFileSync(
      "docs/acceptance/evidence/2026-11-17-history-sync-result.xlsx",
      resultBytes
    );
    writeFileSync(
      "docs/acceptance/evidence/2026-11-17-history-sync-final.json",
      JSON.stringify(
        {
          date: syncDate,
          current: reloaded.assignments.map((a) => ({
            flightNo: a.flightNo,
            position: a.position,
            staffName: a.staffName,
            startTime: a.startTime,
            endTime: a.endTime,
            manualRemark: a.manualRemark,
            fatiguePoints: a.fatiguePoints,
          })),
          history: reloaded.history
            .filter((r) => r.date === syncDate)
            .map((r) => ({
              flightNo: r.flightNo,
              position: r.position,
              staffName: r.staffName,
              fatiguePoints: r.fatiguePoints,
              assignmentRemarks: r.assignmentRemarks,
            })),
          ruleStaleAfterReload: reloaded.schedulePolicyStale,
          fatigue: fatigue.map((r) => ({
            name: r.staff.name,
            today: r.todayFatigue,
            month: r.monthFatigue,
          })),
          resultRows,
          otherGroupPreserved:
            JSON.stringify(app.model().groups.B) ===
            JSON.stringify(before.groups.B),
        },
        null,
        2
      ) + "\n"
    );
    await app.handle({ type: "switch-group", groupId: "B" });
    await app.handle({ type: "switch-group", groupId: "A" });
    expect(app.model().assignments).toEqual(edited);
    await app.handle({ type: "edit-history-date", date: syncDate });
    await app.handle({ type: "save-history-edit" });
    expect(app.model().history.filter((r) => r.date === syncDate)).toHaveLength(
      1
    );
    expect(app.model().assignments[0]).toMatchObject({
      staffId: edited[0]!.staffId,
      countBaseline: edited[0]!.countBaseline,
    });
    expect(persistence.load().schedulePolicyStale).toBe(false);
  });

  it("still invalidates the synchronized result when later configuration changes", async () => {
    const { app, store, persistence } = setup();
    await edit(app);
    await app.handle({ type: "save-history-edit" });
    const edited = structuredClone(app.model().assignments);
    store.getState().savePolicySettings({
      ...app.model().settings,
      maxDailyHours: app.model().settings.maxDailyHours + 1,
    });
    expect(app.model().assignments).toEqual(edited);
    expect(app.model().schedulePolicyStale).toBe(true);
    expect(persistence.load().schedulePolicyStale).toBe(true);
  });

  it("synchronizes cleared slots without resurrecting the old staff or their fatigue", async () => {
    const { app, persistence } = setup();
    await app.handle({ type: "edit-history-date", date: syncDate });
    await app.handle({ type: "clear-schedule" });
    await app.handle({ type: "save-history-edit" });
    const saved = persistence.load();
    expect(saved.assignments).toHaveLength(1);
    expect(saved.assignments[0]!.staffId).toBeNull();
    expect(saved.history.find((r) => r.date === syncDate)?.staffId).toBe("");
    expect(
      buildMonthlyStaffFatigue(saved, "2026-11", syncDate).rows.map(
        (r) => r.todayFatigue
      )
    ).toEqual([0, 0]);
  });

  it("restores all current facts and fingerprint on same-date cancel", async () => {
    const { app } = setup();
    const before = structuredClone(app.model());
    await edit(app);
    await app.handle({ type: "cancel-history-edit" });
    expect(app.model().assignments).toEqual(before.assignments);
    expect(app.model().flights).toEqual(before.flights);
    expect(app.model().history).toEqual(before.history);
    expect(app.model().scheduleRuleFingerprint).toBe(
      before.scheduleRuleFingerprint
    );
    expect(app.view().restoredScheduleNotice).toBe(true);
  });

  it("preserves the active schedule and its notice when editing another date", async () => {
    const state = historySyncState();
    state.activeScheduleDate = "2026-11-20";
    const { app, persistence } = setup(state);
    const before = structuredClone(app.model());
    await edit(app);
    await app.handle({ type: "save-history-edit" });
    expect(app.model().assignments).toEqual(before.assignments);
    expect(app.model().flights).toEqual(before.flights);
    expect(app.model().activeScheduleDate).toBe("2026-11-20");
    expect(app.view().restoredScheduleNotice).toBe(true);
    expect(persistence.load().schedulePolicyStale).toBe(false);
  });

  it.each(["stale", "missing", "mismatch"])(
    "does not certify a %s original rule fingerprint by saving historical edits",
    async (kind) => {
      const state = historySyncState();
      if (kind === "stale") state.schedulePolicyStale = true;
      if (kind === "missing") delete state.scheduleRuleFingerprint;
      if (kind === "mismatch") state.scheduleRuleFingerprint = "old-rules";
      const { app, persistence } = setup(state);
      const edited = await edit(app);
      await app.handle({ type: "save-history-edit" });
      expect(app.model().assignments).toEqual(edited);
      expect(app.model().schedulePolicyStale).toBe(true);
      expect(persistence.load().schedulePolicyStale).toBe(true);
    }
  );

  it("leaves history and the active edit intact when overwrite is declined or matching is incomplete", async () => {
    const declined = setup(undefined, false);
    const original = structuredClone(declined.app.model().history);
    const edited = await edit(declined.app);
    await declined.app.handle({ type: "save-history-edit" });
    expect(declined.app.model().assignments).toEqual(edited);
    expect(declined.app.model().history).toEqual(original);
    expect(declined.save).not.toHaveBeenCalled();
    expect(declined.app.view().historyEditDate).toBe(syncDate);

    const state = historySyncState();
    state.history.push({
      ...state.history[0]!,
      id: "unmatched",
      position: "不存在的岗位",
    });
    const invalid = setup(state);
    await invalid.app.handle({ type: "edit-history-date", date: syncDate });
    await invalid.app.handle({ type: "save-history-edit" });
    expect(invalid.app.view().toast?.message).toContain("不能覆盖保存");
    expect(invalid.app.model().history).toEqual(state.history);
    expect(invalid.save).not.toHaveBeenCalled();
  });

  it("keeps the synchronized page but reports persistence failure and preserves the previous stored version", async () => {
    const { app, persistence, save } = setup();
    app.commit();
    const stored = persistence.load();
    const edited = await edit(app);
    save.mockImplementationOnce(() => {
      throw new Error("disk unavailable");
    });
    await app.handle({ type: "save-history-edit" });
    expect(app.model().assignments).toEqual(edited);
    expect(app.view().toast).toMatchObject({
      tone: "danger",
      message: expect.stringContaining("未能保存到浏览器"),
    });
    expect(persistence.load().assignments).toEqual(stored.assignments);
    expect(persistence.load().history).toEqual(stored.history);
  });
});
