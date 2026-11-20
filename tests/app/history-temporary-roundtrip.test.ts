import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx-js-style";
import { writeFileSync } from "node:fs";
import {
  currentScheduleHistory,
  buildHistoricalScheduleDraft,
} from "../../src/app/history-actions";
import { createTemporaryAssignment } from "../../src/app/schedule-actions";
import { applyWorkbookImport } from "../../src/app/workbook-actions";
import {
  buildConfigWorkbook,
  buildScheduleWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";
import {
  historySyncState,
  memoryPersistence,
  syncDate,
} from "../helpers/history-sync";
import {
  createTestApplicationCoordinator,
  createTestAutoscheduleStore,
} from "../helpers/application";
import { restoreManualCountEvidence } from "../../src/infrastructure/manual-count-evidence";
import { deleteTemporaryAssignment } from "../../src/app/schedule-actions";

function temporaryState(
  position = "临时岗位",
  group: "primary" | "bottom" = "primary",
  staffName?: string
) {
  const state = historySyncState();
  const result = createTemporaryAssignment(
    state,
    state.flights[0]!.id,
    position,
    staffName ?? state.staff[1]!.name,
    group,
    3
  );
  expect(result.changed).toBe(true);
  state.assignments.at(-1)!.manualRemark = "当次临时说明";
  state.history = currentScheduleHistory(state, syncDate);
  return state;
}

function workbookBytes(workbook: XLSX.WorkBook) {
  return XLSX.read(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }), {
    type: "buffer",
  });
}

describe("historical temporary positions through archive and reopen", () => {
  it("restores the known old default temporary record without weakening unknown-position protection", () => {
    const state = historySyncState();
    state.history = state.history.filter((r) => r.date === syncDate);
    state.history.push({
      ...state.history[0]!,
      id: "legacy-temp",
      position: "临时岗位",
      workHours: 0,
      fatiguePoints: 0,
    });
    const draft = buildHistoricalScheduleDraft(state, syncDate);
    expect(draft.warnings).toEqual([]);
    expect(
      draft.assignments.find((a) => a.position === "临时岗位")
    ).toMatchObject({
      positionRuleId: null,
      layoutGroup: "primary",
      workHours: 0,
      fatiguePoints: 0,
      staffId: state.history.at(-1)!.staffId,
    });
    state.history.at(-1)!.position = "已删除的正式岗位";
    expect(
      buildHistoricalScheduleDraft(state, syncDate).warnings.join("；")
    ).toContain("与当前岗位不匹配");
    state.history.at(-1)!.position = "临时岗位";
    state.history.at(-1)!.workHours = 2;
    expect(buildHistoricalScheduleDraft(state, syncDate).warnings).toHaveLength(
      1
    );
  });

  it.each(["primary", "bottom"] as const)(
    "keeps a custom temporary name, %s layout, remarks and person",
    (group) => {
      const state = temporaryState("临时资料交接", group);
      const before = structuredClone(state.history);
      const draft = buildHistoricalScheduleDraft(state, syncDate);
      expect(draft.warnings).toEqual([]);
      expect(
        draft.assignments.find((a) => a.position === "临时资料交接")
      ).toMatchObject({
        positionRuleId: null,
        layoutGroup: group,
        layoutIndex: 3,
        staffId: state.staff[1]!.id,
        manualRemark: "当次临时说明",
        workHours: 0,
        fatiguePoints: 0,
      });
      expect(state.history).toEqual(before);
    }
  );

  it("does not use a temporary record to occupy a same-name configured position", () => {
    const state = temporaryState();
    state.assignments.at(-1)!.position = state.positionRules[0]!.name;
    state.history = currentScheduleHistory(state, syncDate);
    const draft = buildHistoricalScheduleDraft(state, syncDate);
    expect(draft.warnings).toEqual([]);
    expect(
      draft.assignments.filter(
        (a) => a.position === state.positionRules[0]!.name
      )
    ).toHaveLength(2);
    expect(
      draft.assignments.find((a) => a.positionRuleId !== null)?.staffId
    ).toBe(state.staff[0]!.id);
    expect(draft.assignments.find((a) => a.layoutGroup)?.staffId).toBe(
      state.staff[1]!.id
    );
  });

  it.each(["config", "schedule"])(
    "keeps custom and blank temporary rows through %s Excel bytes, import and restart",
    (kind) => {
      const source = temporaryState("临时交接", "bottom");
      createTemporaryAssignment(
        source,
        source.flights[0]!.id,
        "待填资料岗",
        "",
        "primary",
        4
      );
      source.history = currentScheduleHistory(source, syncDate);
      const workbook = workbookBytes(
        kind === "config"
          ? buildConfigWorkbook(source)
          : buildScheduleWorkbook(source, syncDate)
      );
      const parsed = parseWorkbook(workbook, source.staff);
      expect(
        parsed.history?.find((r) => r.position === "待填资料岗")
      ).toMatchObject({ staffId: "", staffName: "", workHours: 0 });
      const destination = historySyncState();
      destination.history = [];
      destination.assignments = [];
      applyWorkbookImport(destination, parsed, "all");
      const persistence = memoryPersistence();
      persistence.save(destination);
      const reopened = persistence.load();
      const draft = buildHistoricalScheduleDraft(reopened, syncDate);
      expect(draft.warnings).toEqual([]);
      expect(
        draft.assignments.find((a) => a.position === "临时交接")
      ).toMatchObject({
        layoutGroup: "bottom",
        layoutIndex: 3,
        manualRemark: "当次临时说明",
      });
      expect(
        draft.assignments.find((a) => a.position === "待填资料岗")
      ).toMatchObject({
        layoutGroup: "primary",
        layoutIndex: 4,
        staffId: null,
      });
    }
  );

  it("keeps two same-name temporary slots for one person when importing the same workbook twice", () => {
    const source = temporaryState("临时交接");
    createTemporaryAssignment(
      source,
      source.flights[0]!.id,
      "临时交接",
      source.staff[1]!.name,
      "bottom",
      4
    );
    source.history = currentScheduleHistory(source, syncDate);
    const imported = parseWorkbook(
      workbookBytes(buildConfigWorkbook(source)),
      source.staff
    );
    const target = historySyncState();
    target.history = [];
    applyWorkbookImport(target, imported, "history");
    applyWorkbookImport(target, imported, "history");
    expect(
      target.history.filter((r) => r.position === "临时交接")
    ).toHaveLength(2);
    const draft = buildHistoricalScheduleDraft(target, syncDate);
    expect(draft.warnings).toEqual([]);
    expect(
      draft.assignments.filter((a) => a.position === "临时交接")
    ).toHaveLength(2);
  });

  it("retains an archived gap-fill marker through actual JSON storage restoration", () => {
    const state = historySyncState();
    state.history[0]!.teamLeaderGapFill = true;
    const persistence = memoryPersistence();
    persistence.save(state);
    const restored = persistence.load();
    expect(
      restored.history.find((r) => r.id === state.history[0]!.id)
        ?.teamLeaderGapFill
    ).toBe(true);
    expect(
      buildHistoricalScheduleDraft(restored, syncDate).assignments[0]
        ?.teamLeaderGapFill
    ).toBe(true);
  });

  it("keeps missing flights and duplicate configured records blocked even beside a valid temporary row", async () => {
    const preferences = {
      loadScheduleDate: () => syncDate,
      saveScheduleDate: () => {},
      loadScheduleZoom: () => null,
      saveScheduleZoom: () => {},
    };
    for (const fault of [
      "missing-flight",
      "unknown-position",
      "duplicate-position",
    ] as const) {
      const state = temporaryState("临时交接");
      const faulty = { ...state.history[0]!, id: "faulty" };
      if (fault === "missing-flight") faulty.flightNo = "ZZ999";
      if (fault === "unknown-position") faulty.position = "已删除的正式岗位";
      state.history.push(faulty);
      const before = structuredClone(state.history);
      const coordinator = createTestApplicationCoordinator(
        createTestAutoscheduleStore(state),
        { preferences, confirm: () => true }
      );
      await coordinator.handle({ type: "edit-history-date", date: syncDate });
      await coordinator.handle({ type: "save-history-edit" });
      expect(coordinator.view().toast?.message).toContain("不能覆盖保存");
      expect(coordinator.model().history).toEqual(before);
      expect(coordinator.view().historyEditDate).toBe(syncDate);
    }
  });

  it("refuses partial archives and retains custom-name legacy ambiguity", () => {
    const state = temporaryState("未带来源的旧自定义名称");
    delete state.history.at(-1)!.temporaryPosition;
    expect(buildHistoricalScheduleDraft(state, syncDate).warnings).toHaveLength(
      1
    );
    state.history[0]!.historyCoverage = "late-priority-only";
    expect(buildHistoricalScheduleDraft(state, syncDate).assignments).toEqual(
      []
    );
  });

  it.each([
    { layoutGroup: "unknown", layoutIndex: 1 },
    { layoutGroup: "primary", layoutIndex: -1 },
    { layoutGroup: "bottom", layoutIndex: 0.5 },
    { layoutGroup: "primary", layoutIndex: "1" },
  ])("does not trust malformed temporary origin %j", (temporaryPosition) => {
    expect(
      restoreManualCountEvidence({ temporaryPosition }).temporaryPosition
    ).toBeUndefined();
  });

  it("retains manual evidence and permits deleting a restored temporary row", () => {
    const state = temporaryState("临时交接");
    const original = state.history.at(-1)!;
    original.countBaseline = {
      staffId: state.staff[0]!.id,
      staffName: state.staff[0]!.name,
    };
    original.manualOverrideWarnings = [
      { code: "time-conflict", message: "原人工确认的冲突" },
    ];
    const draft = buildHistoricalScheduleDraft(state, syncDate);
    const temp = draft.assignments.find((a) => a.layoutGroup)!;
    expect(temp.countBaseline).toEqual(original.countBaseline);
    expect(temp.manualOverrideWarnings).toEqual(
      original.manualOverrideWarnings
    );
    state.flights = draft.flights;
    state.assignments = draft.assignments;
    expect(deleteTemporaryAssignment(state, temp.id)).toBe(true);
    expect(
      currentScheduleHistory(state, syncDate).some(
        (r) => r.position === "临时交接"
      )
    ).toBe(false);
  });

  it("can edit, save, restart and edit again while preserving original history until confirmation", async () => {
    const state = temporaryState("临时交接", "bottom");
    const persistence = memoryPersistence();
    const coordinator = createTestApplicationCoordinator(
      createTestAutoscheduleStore(state, persistence),
      {
        confirm: () => true,
        preferences: {
          loadScheduleDate: () => syncDate,
          saveScheduleDate: () => {},
          loadScheduleZoom: () => null,
          saveScheduleZoom: () => {},
        },
      }
    );
    const before = structuredClone(coordinator.model().history);
    await coordinator.handle({ type: "edit-history-date", date: syncDate });
    expect(coordinator.model().history).toEqual(before);
    const temporary = coordinator
      .model()
      .assignments.find((a) => a.position === "临时交接")!;
    expect(temporary).toBeDefined();
    await coordinator.handle({
      type: "update-assignment",
      id: temporary.id,
      field: "manualRemark",
      value: "保存后的临时说明",
    });
    await coordinator.handle({ type: "save-history-edit" });
    expect(coordinator.view().historyEditDate).toBeNull();
    const reloaded = persistence.load();
    const draft = buildHistoricalScheduleDraft(reloaded, syncDate);
    expect(draft.warnings).toEqual([]);
    expect(
      draft.assignments.find((a) => a.position === "临时交接")
    ).toMatchObject({
      layoutGroup: "bottom",
      manualRemark: "保存后的临时说明",
      staffId: state.staff[1]!.id,
    });
    const finalHistory = reloaded.history.filter((r) => r.date === syncDate);
    writeFileSync(
      "docs/acceptance/evidence/2026-11-20-history-temporary-final.json",
      JSON.stringify(
        {
          date: syncDate,
          history: finalHistory,
          draft: draft.assignments.map(
            ({ id: _id, flightId: _flightId, ...a }) => a
          ),
          workHours: finalHistory.reduce((n, r) => n + r.workHours, 0),
          fatiguePoints: finalHistory.reduce((n, r) => n + r.fatiguePoints, 0),
        },
        null,
        2
      ) + "\n"
    );
  });
});
