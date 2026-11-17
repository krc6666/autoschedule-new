import { describe, expect, it, vi } from "vitest";
import { createDefaultState } from "../../src/defaults";
import { historySyncState, syncDate } from "../helpers/history-sync";
import {
  createTestApplicationCoordinator,
  createTestAutoscheduleStore,
} from "../helpers/application";
import { todayIso } from "../../src/utils";
import { scheduleDisplaySource } from "../../src/domain/records/schedule-dates";
import type { UiCommand } from "../../src/ui/events/ui-command";

function setup(state = historySyncState()) {
  const saveScheduleDate = vi.fn();
  const app = createTestApplicationCoordinator(
    createTestAutoscheduleStore(state),
    {
      confirm: () => true,
      preferences: {
        loadScheduleDate: () => "2020-01-01",
        saveScheduleDate,
        loadScheduleZoom: () => null,
        saveScheduleZoom: () => {},
      },
    }
  );
  return { app, saveScheduleDate };
}

describe("latest schedule date on entry and group change", () => {
  it("uses the actual current date rather than today's date or an unrelated saved preference", () => {
    const { app } = setup();
    expect(app.view().date).toBe(syncDate);
  });
  it("uses a later complete archive but ignores partial-only, mixed partial and duty-only days", () => {
    const state = historySyncState();
    const row = state.history[0]!;
    state.history.push(
      { ...row, id: "later", date: "2026-11-20" },
      {
        ...row,
        id: "partial",
        date: "2026-11-22",
        historyCoverage: "late-priority-only",
      },
      { ...row, id: "mixed", date: "2026-11-22" },
      { ...row, id: "roster", date: "2026-11-24", flightNo: "轮值" }
    );
    expect(setup(state).app.view().date).toBe("2026-11-20");
  });
  it("uses today only when no dated roster exists and preserves manual date selection during navigation", async () => {
    const { app } = setup(createDefaultState());
    expect(app.view().date).toBe(todayIso());
    await app.handle({ type: "change-date", date: "2026-12-01" });
    await app.handle({ type: "navigate", section: "schedule" });
    expect(app.view().date).toBe("2026-12-01");
  });
  it("selects each group's latest date and never uses the other group's date", async () => {
    const state = historySyncState();
    state.groups.B.history = [
      { ...state.history[0]!, id: "group-b", date: "2026-12-02" },
    ];
    const { app } = setup(state);
    await app.handle({ type: "switch-group", groupId: "B" });
    expect(app.view().date).toBe("2026-12-02");
    await app.handle({ type: "switch-group", groupId: "A" });
    expect(app.view().date).toBe(syncDate);
  });
  it("does not change date when switching groups is cancelled", async () => {
    const state = historySyncState();
    const store = createTestAutoscheduleStore(state);
    const app = createTestApplicationCoordinator(store, {
      confirm: () => false,
      preferences: {
        loadScheduleDate: () => syncDate,
        saveScheduleDate: () => {},
        loadScheduleZoom: () => null,
        saveScheduleZoom: () => {},
      },
    });
    store.getState().configuration.addStaff();
    await app.handle({ type: "switch-group", groupId: "B" });
    expect(app.model().activeGroupId).toBe("A");
    expect(app.view().date).toBe(syncDate);
  });

  it("uses current unsaved edits for an active matching day, including cleared slots", () => {
    const state = historySyncState();
    state.assignments[0]!.staffId = null;
    state.assignments[0]!.staffName = "";
    expect(scheduleDisplaySource(state, syncDate)).toBe("current");
    state.schedulePolicyStale = true;
    expect(scheduleDisplaySource(state, syncDate)).toBe("history");
    state.history = [];
    expect(scheduleDisplaySource(state, syncDate)).toBe("current");
    expect(scheduleDisplaySource(state, "2026-12-01")).toBe("empty");
  });

  it("rejects current-table modification, archiving or export commands while an archived date is being shown", async () => {
    const state = historySyncState();
    state.activeScheduleDate = "2026-11-16";
    const { app } = setup(state);
    await app.handle({ type: "navigate", section: "schedule" });
    const before = structuredClone(app.model());
    const commands: UiCommand[] = [
      {
        type: "assign-staff",
        assignmentId: state.assignments[0]!.id,
        staffId: "",
      },
      { type: "clear-schedule" },
      { type: "archive-schedule" },
      { type: "export-schedule" },
      { type: "export-share-html" },
      { type: "export-share-png" },
      { type: "select-swap-target", assignmentId: state.assignments[0]!.id },
      { type: "apply-swap-analysis" },
      { type: "preview-team-leader-gap-fill" },
      { type: "confirm-team-leader-gap-fill" },
    ];
    for (const command of commands) {
      await app.handle({ type: "dismiss-toast" });
      await app.handle(command);
      expect(app.model()).toEqual(before);
      expect(app.view().toast?.message).toContain("请先点击“编辑该日排班”");
    }
    await app.handle({ type: "change-date", date: "2026-12-30" });
    await app.handle({ type: "archive-schedule" });
    expect(app.model()).toEqual(before);
    expect(app.view().toast?.message).toContain("当前日期没有班表");
  });
});
