import { afterEach, expect, it, vi } from "vitest";
import * as XLSX from "xlsx-js-style";
import { createDefaultState } from "../../src/defaults";
import {
  recentFatigueScenario,
  RECENT_FATIGUE_DATE as date,
} from "../helpers/recent-fatigue-scenario";
import {
  buildConfigWorkbook,
  buildScheduleWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";
import { applyWorkbookImport } from "../../src/app/workbook-actions";
import { saveState, loadState } from "../../src/infrastructure/storage";
import { createScheduleGenerationFacts } from "../../src/domain/shared/scheduling-facts";
import { workloadBalanceLoadSnapshots } from "../../src/domain/reviews/workload-balance";
import type {
  ScheduleWorkerRequest,
  ScheduleWorkerResponse,
} from "../../src/infrastructure/schedule-worker-protocol";
import { createTestAutoscheduleStore } from "../helpers/application";
import { currentScheduleHistory } from "../../src/app/history-actions";

afterEach(() => vi.unstubAllGlobals());

it("keeps input settings/history through configuration bytes and restart, then real Worker/WASM, Store, archive and schedule XLSX", async () => {
  const source = recentFatigueScenario();
  source.settings.historyWindowDays = 9;
  const bytes = XLSX.write(buildConfigWorkbook(source), {
    bookType: "xlsx",
    type: "array",
  });
  const restored = createDefaultState();
  const otherGroup = structuredClone(restored.groups.B);
  expect(
    applyWorkbookImport(
      restored,
      parseWorkbook(XLSX.read(bytes, { type: "array" }), []),
      "all"
    ).errors
  ).toBeUndefined();
  expect(restored.groups.B).toEqual(otherGroup);
  expect(restored.settings.historyWindowDays).toBe(9);
  expect(restored.settings.workloadBalanceEnabled).toBe(true);
  expect(restored.history.map((r) => r.fatiguePoints)).toEqual([10, 6]);
  let persisted = "";
  saveState(restored, {
    setItem: (_k, v) => {
      persisted = v;
    },
  });
  const restarted = loadState({ getItem: () => persisted });
  expect(restarted.settings.historyWindowDays).toBe(9);
  expect(
    workloadBalanceLoadSnapshots(restarted, [], date, null).map(
      (p) => p.recentFatigue
    )
  ).toEqual([10, 6]);
  const messages: ScheduleWorkerResponse[] = [];
  const host: {
    onmessage:
      ((e: MessageEvent<ScheduleWorkerRequest>) => Promise<void>) | null;
    postMessage: (m: ScheduleWorkerResponse) => void;
  } = {
    onmessage: null,
    postMessage: (m) => messages.push(structuredClone(m)),
  };
  vi.stubGlobal("self", host);
  await import("../../src/schedule.worker");
  await host.onmessage!(
    new MessageEvent<ScheduleWorkerRequest>("message", {
      data: {
        state: createScheduleGenerationFacts(restarted),
        date,
        preferences: { halfRestStaffIds: [] },
      },
    })
  );
  expect(messages.filter((m) => m.type === "error")).toEqual([]);
  const response = messages.find((m) => m.type === "result");
  if (response?.type !== "result") throw new Error("no worker result");
  expect(response.result.unfilledCount).toBe(0);
  const store = createTestAutoscheduleStore(restarted);
  store.getState().schedule.install(date, response.result);
  const model = store.getState().model;
  const exportBytes = XLSX.write(buildScheduleWorkbook(model, date), {
    bookType: "xlsx",
    type: "array",
  });
  const book = XLSX.read(exportBytes, { type: "array" });
  const rows = XLSX.utils.sheet_to_json<Record<string, string | number>>(
    book.Sheets["排班结果"]!
  );
  const points = ["p0", "p1"].map((id) =>
    rows
      .filter((r) => r["人员编号"] === id)
      .reduce((sum, r) => sum + Number(r["疲劳点数"]), 0)
  );
  expect(points).toEqual([6, 10]);
  store
    .getState()
    .records.replaceHistory(date, currentScheduleHistory(model, date));
  saveState(store.getState().model, {
    setItem: (_k, v) => {
      persisted = v;
    },
  });
  const archived = loadState({ getItem: () => persisted });
  expect(
    workloadBalanceLoadSnapshots(archived, [], "2026-11-09", null).map(
      (p) => p.recentFatigue
    )
  ).toEqual([16, 16]);
  expect(archived.settings.historyWindowDays).toBe(9);
  console.info(
    "RECENT_FATIGUE_WORKER_XLSX",
    JSON.stringify({
      date,
      historyWindowDays: 9,
      today: points,
      archived: [16, 16],
      coveredPositions: rows.length,
    })
  );
});
