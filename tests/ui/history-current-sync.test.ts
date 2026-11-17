// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { mountAutoscheduleApp } from "../../src/app";
import { createAutoscheduleStore } from "../../src/app/store/autoschedule-store";
import type { AutoscheduleAppElement } from "../../src/ui/components/autoschedule-app";
import type { UiCommand } from "../../src/ui/events/ui-command";
import {
  historySyncState,
  memoryPersistence,
  syncDate,
} from "../helpers/history-sync";
import { settleLit } from "./lit-test-helpers";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

async function mount(
  state = historySyncState(),
  persistence = memoryPersistence()
) {
  const root = document.createElement("div");
  document.body.append(root);
  const store = createAutoscheduleStore({ initialState: state, persistence });
  dispose = mountAutoscheduleApp(root, {
    store,
    preferences: {
      loadScheduleDate: () => syncDate,
      saveScheduleDate: () => {},
      loadScheduleZoom: () => null,
      saveScheduleZoom: () => {},
    },
  }).dispose;
  const element =
    root.querySelector<AutoscheduleAppElement>("autoschedule-app")!;
  const command = async (command: UiCommand) => {
    await element.commandHandler.handle(command);
    await settleLit();
  };
  await command({ type: "navigate", section: "schedule" });
  return { root, store, command, persistence };
}

describe("same-date history through the mounted application", () => {
  it("opens the latest archive with original people and time when the active table has a different date or no date", async () => {
    for (const internalDate of ["2026-11-16", null]) {
      const state = historySyncState();
      state.activeScheduleDate = internalDate;
      state.flights[0]!.startTime = "08:45";
      state.assignments[0]!.staffName = "另一份当前表";
      const app = await mount(state);
      const before = structuredClone(app.store.getState().model);
      expect(
        app.root.querySelector<HTMLInputElement>('input[type="date"]')!.value
      ).toBe(syncDate);
      const board = app.root.querySelector(
        "autoschedule-schedule-page autoschedule-archived-schedule-board"
      )!;
      expect(board).not.toBeNull();
      expect(board.textContent).toContain("08:30–10:30");
      expect(board.textContent).toContain(state.history[0]!.staffName);
      expect(board.textContent).not.toContain("另一份当前表");
      expect(
        app.root.querySelector("autoschedule-schedule-page")!.textContent
      ).not.toContain("这是旧班表");
      expect(app.store.getState().model).toEqual(before);
      writeFileSync(
        "docs/acceptance/evidence/2026-11-17-latest-view.html",
        app.root.querySelector("autoschedule-schedule-page")!.outerHTML
      );
      writeFileSync(
        "docs/acceptance/evidence/2026-11-17-latest-view-final.json",
        JSON.stringify(
          {
            selectedDate:
              app.root.querySelector<HTMLInputElement>('input[type="date"]')!
                .value,
            internalDate,
            source: "history",
            visibleDate: board.closest("section")!.querySelector("h3")!
              .textContent,
            visibleTime: board.querySelector(".schedule-flight-head span")!
              .textContent,
            visiblePerson: board.querySelector(".history-person")!.textContent,
            expectedHistoryPerson: state.history[0]!.staffName,
            expectedHistoryTime: `${state.history[0]!.startTime}–${state.history[0]!.endTime}`,
            currentModelUntouched:
              JSON.stringify(app.store.getState().model) ===
              JSON.stringify(before),
            staleNoticeVisible: app.root
              .querySelector("autoschedule-schedule-page")!
              .textContent!.includes("这是旧班表"),
          },
          null,
          2
        ) + "\n"
      );
      dispose?.();
      app.root.remove();
    }
  });

  it("shows saved history instead of a stale same-day current table, while retaining underlying staleness", async () => {
    const state = historySyncState();
    state.schedulePolicyStale = true;
    state.assignments[0]!.staffName = "旧表人员";
    const app = await mount(state);
    const board = app.root.querySelector(
      "autoschedule-schedule-page autoschedule-archived-schedule-board"
    )!;
    expect(board).not.toBeNull();
    expect(board.textContent).toContain(state.history[0]!.staffName);
    expect(board.textContent).not.toContain("旧表人员");
    expect(app.store.getState().model.schedulePolicyStale).toBe(true);
  });

  it("keeps the edited historical date visible after saving while preserving a different active roster", async () => {
    vi.stubGlobal("confirm", () => true);
    const state = historySyncState();
    state.activeScheduleDate = "2026-11-20";
    state.templates[0]!.startTime = "08:45";
    state.templates[0]!.endTime = "10:45";
    const app = await mount(state);
    const before = structuredClone(app.store.getState().model.assignments);
    await app.command({ type: "change-date", date: syncDate });
    await app.command({ type: "edit-history-date", date: syncDate });
    expect(app.store.getState().model.assignments[0]).toMatchObject({
      startTime: "08:30",
      endTime: "10:30",
    });
    const id = app.store.getState().model.assignments[0]!.id;
    await app.command({
      type: "update-assignment",
      id,
      field: "staffName",
      value: state.staff[1]!.name,
    });
    await app.command({ type: "save-history-edit" });
    await app.command({ type: "navigate", section: "schedule" });
    expect(
      app.root.querySelector<HTMLInputElement>('input[type="date"]')!.value
    ).toBe(syncDate);
    expect(
      app.root.querySelector(
        "autoschedule-schedule-page autoschedule-archived-schedule-board"
      )!.textContent
    ).toContain(state.staff[1]!.name);
    expect(
      app.root.querySelector("autoschedule-archived-schedule-board")!
        .textContent
    ).toContain("08:30–10:30");
    expect(
      app.store.getState().model.history.find((r) => r.date === syncDate)
    ).toMatchObject({ startTime: "08:30", endTime: "10:30" });
    expect(app.store.getState().model.assignments).toEqual(before);
    dispose?.();
    app.root.remove();
    const reloaded = await mount(app.persistence.load(), app.persistence);
    expect(
      reloaded.root.querySelector<HTMLInputElement>('input[type="date"]')!.value
    ).toBe("2026-11-20");
  });

  it("does not relabel another date's current roster when the chosen date has no saved result", async () => {
    const app = await mount();
    await app.command({ type: "change-date", date: "2026-12-30" });
    expect(app.root.querySelector("autoschedule-schedule-grid")).toBeNull();
    expect(
      app.root.querySelector("autoschedule-schedule-page")!.textContent
    ).toContain("2026-12-30");
    expect(
      app.root.querySelector("autoschedule-schedule-page")!.textContent
    ).toContain("没有班表");
  });
  it("shows saved history edits on the schedule page and after a real storage reload without a false old-table notice", async () => {
    vi.stubGlobal("confirm", () => true);
    const app = await mount();
    await app.command({ type: "edit-history-date", date: syncDate });
    const name = app.store.getState().model.staff[1]!.name;
    const input = app.root.querySelector<HTMLInputElement>(
      ".schedule-name-input"
    )!;
    input.value = name;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await settleLit();
    const remark = app.root.querySelector<HTMLInputElement>(
      ".schedule-manual-remark"
    )!;
    remark.value = "同日同步备注";
    remark.dispatchEvent(new Event("change", { bubbles: true }));
    await settleLit();
    const save = [
      ...app.root.querySelectorAll<HTMLButtonElement>("button"),
    ].find((b) => b.textContent?.includes("保存并更新历史"))!;
    save.click();
    await settleLit();
    await app.command({ type: "navigate", section: "schedule" });
    const assertSchedule = (root: HTMLElement) => {
      expect(
        root.querySelector("autoschedule-schedule-page")?.textContent
      ).not.toContain("这是旧班表");
      expect(
        root.querySelector("autoschedule-schedule-page")?.textContent
      ).not.toContain("排班规则已更新");
      expect(
        [...root.querySelectorAll<HTMLInputElement>("input")].some(
          (input) => input.value === name
        )
      ).toBe(true);
      expect(
        root.querySelector<HTMLInputElement>(".schedule-manual-remark")?.value
      ).toBe("同日同步备注");
    };
    assertSchedule(app.root);
    dispose?.();
    app.root.remove();
    const reloaded = await mount(app.persistence.load(), app.persistence);
    assertSchedule(reloaded.root);
    expect(
      reloaded.store.getState().model.history.find((r) => r.date === syncDate)
        ?.staffName
    ).toBe(name);
  });

  it("does not mark a valid restored schedule old just because assignments exist", async () => {
    const app = await mount();
    expect(app.root.textContent).not.toContain("这是旧班表");
  });

  it("keeps actual rule-staleness warnings after the same-date manual save and reload", async () => {
    vi.stubGlobal("confirm", () => true);
    const state = historySyncState();
    state.schedulePolicyStale = true;
    const originalHistory = structuredClone(state.history);
    state.history = [];
    const app = await mount(state);
    expect(app.root.textContent).toContain("这是旧班表");
    expect(app.root.textContent).toContain("排班规则已更新");
    app.store.getState().replaceModel({
      ...app.store.getState().model,
      history: originalHistory,
    });
    await app.command({ type: "edit-history-date", date: syncDate });
    await app.command({ type: "save-history-edit" });
    await app.command({ type: "navigate", section: "schedule" });
    expect(app.store.getState().model.schedulePolicyStale).toBe(true);
    expect(
      app.root.querySelector("autoschedule-archived-schedule-board")
    ).not.toBeNull();
    dispose?.();
    app.root.remove();
    const reloaded = await mount(app.persistence.load(), app.persistence);
    expect(reloaded.store.getState().model.schedulePolicyStale).toBe(true);
    expect(
      reloaded.root.querySelector("autoschedule-archived-schedule-board")
    ).not.toBeNull();
  });
});
