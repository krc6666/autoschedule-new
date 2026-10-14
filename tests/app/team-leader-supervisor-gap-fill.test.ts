import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx-js-style";
import type { ApplicationPreferences } from "../../src/app/application-preferences";
import {
  buildScheduleWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";
import {
  createStatePersistence,
  loadState,
} from "../../src/infrastructure/storage";
import {
  createTestApplicationCoordinator,
  createTestAutoscheduleStore,
} from "../helpers/application";
import {
  createSupervisorGapFillScenario,
  SUPERVISOR_GAP_FILL_DATE,
} from "../helpers/supervisor-gap-fill";

const preferences: ApplicationPreferences = {
  loadScheduleDate: () => SUPERVISOR_GAP_FILL_DATE,
  saveScheduleDate: () => undefined,
  loadScheduleZoom: () => null,
  saveScheduleZoom: () => undefined,
};

describe("supervisor gap-fill controller workflow", () => {
  it.each([true, false])(
    "previews and confirms direct=%s, then preserves the final result through storage, Excel and archive",
    async (direct) => {
      const { state, leader, worker, vacancy, source } =
        createSupervisorGapFillScenario(direct);
      const values = new Map<string, string>();
      const storage = {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          values.set(key, value);
        },
        removeItem: (key: string) => {
          values.delete(key);
        },
      };
      const store = createTestAutoscheduleStore(
        state,
        createStatePersistence(storage)
      );
      const coordinator = createTestApplicationCoordinator(store, {
        preferences,
        confirm: () => true,
      });
      const before = structuredClone(coordinator.model().assignments);
      await coordinator.handle({ type: "open-team-leader-gap-fill" });
      await coordinator.handle({
        type: "update-team-leader-gap-fill-vacancies",
        assignmentIds: [vacancy.id],
      });
      await coordinator.handle({ type: "preview-team-leader-gap-fill" });
      expect(coordinator.model().assignments).toEqual(before);
      expect(coordinator.view().dialog).toMatchObject({
        kind: "team-leader-gap-fill",
        preview: { vacancyAssignmentIds: [vacancy.id] },
      });
      await coordinator.handle({ type: "confirm-team-leader-gap-fill" });
      expect(coordinator.view().dialog).toBeNull();
      expect(coordinator.view().toast?.message).toBe("分队长补差已应用");
      const model = coordinator.model();
      const expectedStaff = direct ? leader : worker;
      const target = model.assignments.find((row) => row.id === vacancy.id)!;
      expect(target).toMatchObject({
        staffId: expectedStaff.id,
        staffName: expectedStaff.name,
        status: "assigned",
        workHours: 2,
        fatiguePoints: 9,
      });
      expect(target.systemNotes).toBeUndefined();
      expect(
        model.assignments.find((row) => row.id === source.id)?.staffId
      ).toBe(direct ? worker.id : leader.id);
      expect(
        model.assignments.filter((row) => row.status === "unfilled")
      ).toHaveLength(0);
      expect(model.groups.B).toEqual(state.groups.B);
      const restored = loadState(storage);
      expect(restored.assignments).toEqual(model.assignments);
      expect(
        restored.positionRules.find((rule) => rule.id === target.positionRuleId)
          ?.category
      ).toBe("机动督导");
      const bytes = XLSX.write(
        buildScheduleWorkbook(model, SUPERVISOR_GAP_FILL_DATE),
        { type: "array", bookType: "xlsx" }
      );
      const workbook = XLSX.read(bytes, { type: "array" });
      const imported = parseWorkbook(workbook, model.staff);
      expect(
        imported.history?.find(
          (row) => row.flightNo === "TW616" && row.position === "督导/引导"
        )
      ).toMatchObject({
        date: SUPERVISOR_GAP_FILL_DATE,
        staffId: expectedStaff.id,
        startTime: "22:10",
        endTime: "00:10",
        workHours: 2,
        fatiguePoints: 9,
      });
      await coordinator.handle({ type: "archive-schedule" });
      expect(
        coordinator
          .model()
          .history.find(
            (row) => row.flightNo === "TW616" && row.position === "督导/引导"
          )
      ).toMatchObject({
        date: SUPERVISOR_GAP_FILL_DATE,
        staffId: expectedStaff.id,
        workHours: 2,
        fatiguePoints: 9,
        ...(direct ? { teamLeaderGapFill: true } : {}),
      });
    }
  );

  it("shows a concrete conflict and keeps the whole schedule when no safe supervisor plan exists", async () => {
    const { state, leader, vacancy, source } =
      createSupervisorGapFillScenario(true);
    state.positionRules[0]!.category = "机动督导";
    state.positionRules[0]!.name = source.position = "督导";
    source.staffId = leader.id;
    source.staffName = leader.name;
    const coordinator = createTestApplicationCoordinator(
      createTestAutoscheduleStore(state),
      {
        preferences,
      }
    );
    const before = structuredClone(coordinator.model());
    await coordinator.handle({ type: "open-team-leader-gap-fill" });
    await coordinator.handle({
      type: "update-team-leader-gap-fill-vacancies",
      assignmentIds: [vacancy.id],
    });
    await coordinator.handle({ type: "preview-team-leader-gap-fill" });
    const dialog = coordinator.view().dialog;
    expect(dialog?.kind).toBe("team-leader-gap-fill");
    if (dialog?.kind !== "team-leader-gap-fill")
      throw new Error("gap-fill dialog closed");
    expect(dialog.preview).toBeNull();
    expect(dialog.reasons.join("；")).toMatch(
      /分队长甲.*TW616\/督导\/引导.*时间冲突/
    );
    await coordinator.handle({ type: "confirm-team-leader-gap-fill" });
    expect(coordinator.model()).toEqual(before);
  });
});
