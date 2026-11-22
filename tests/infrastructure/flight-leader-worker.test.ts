import { afterEach, expect, it, vi } from "vitest";
import * as XLSX from "xlsx-js-style";
import { writeFileSync } from "node:fs";
import {
  flightLeaderScenario,
  LEADER_DATE,
} from "../helpers/flight-leader-scenario";
import { createScheduleGenerationFacts } from "../../src/domain/shared/scheduling-facts";
import { buildScheduleWorkbook } from "../../src/infrastructure/excel";
import { createTestAutoscheduleStore } from "../helpers/application";
import { currentScheduleHistory } from "../../src/app/history-actions";
import type {
  ScheduleWorkerRequest,
  ScheduleWorkerResponse,
} from "../../src/infrastructure/schedule-worker-protocol";

afterEach(() => vi.unstubAllGlobals());

it("runs actual Worker-module/WASM, preserves shortage-only results through install/save/archive and checks final XLSX independently", async () => {
  const messages: ScheduleWorkerResponse[] = [];
  const host: {
    onmessage:
      ((event: MessageEvent<ScheduleWorkerRequest>) => Promise<void>) | null;
    postMessage(message: ScheduleWorkerResponse): void;
  } = {
    onmessage: null,
    postMessage: (message) => messages.push(structuredClone(message)),
  };
  vi.stubGlobal("self", host);
  await import("../../src/schedule.worker");
  const summaries = [];
  for (const shortage of [false, true]) {
    messages.length = 0;
    const state = flightLeaderScenario();
    state.assignments = [];
    if (shortage) state.staff.forEach((p) => (p.flightLeaderQualified = false));
    await host.onmessage!(
      new MessageEvent<ScheduleWorkerRequest>("message", {
        data: {
          state: createScheduleGenerationFacts(state),
          date: LEADER_DATE,
          preferences: { halfRestStaffIds: [] },
        },
      })
    );
    expect(messages.filter((message) => message.type === "error")).toEqual([]);
    const response = messages.find((message) => message.type === "result");
    if (response?.type !== "result") throw new Error("没有最终班表");
    expect(response.result.unfilledCount).toBe(0);
    expect(response.result.safetyCredential?.phase).toBe("final");
    const store = createTestAutoscheduleStore(state);
    expect(() =>
      store.getState().schedule.install(LEADER_DATE, response.result)
    ).not.toThrow();
    expect(() => store.getState().persist()).not.toThrow();
    const model = store.getState().model;
    store
      .getState()
      .records.replaceHistory(
        LEADER_DATE,
        currentScheduleHistory(model, LEADER_DATE)
      );
    expect(store.getState().model.history).toHaveLength(4);
    const output = XLSX.write(
      buildScheduleWorkbook(store.getState().model, LEADER_DATE),
      { type: "buffer", bookType: "xlsx" }
    );
    const book = XLSX.read(output),
      rows = XLSX.utils.sheet_to_json<Record<string, string>>(
        book.Sheets["排班结果"]!
      );
    const qualified = new Set(
      state.staff.filter((p) => p.flightLeaderQualified).map((p) => p.id)
    );
    const actual = state.flights.map((f) => ({
      flight: f.flightNo,
      count: new Set(
        rows
          .filter(
            (row) =>
              row["航班号"] === f.flightNo && qualified.has(row["人员编号"]!)
          )
          .map((row) => row["人员编号"])
      ).size,
    }));
    expect(actual.map((row) => row.count)).toEqual(shortage ? [0, 0] : [1, 1]);
    expect(
      response.result.warnings.filter((warning) => warning.includes("无负责人"))
    ).toHaveLength(shortage ? 2 : 0);
    const tag = shortage ? "shortage" : "covered";
    writeFileSync(
      `docs/acceptance/evidence/2026-11-22-flight-leader-${tag}.xlsx`,
      output
    );
    summaries.push({
      shortage,
      actual,
      jobs: rows.length,
      warnings: response.result.warnings,
      archived: store.getState().model.flightLeaderCoverageHistory,
      safetyCredential: response.result.safetyCredential?.phase,
    });
  }
  writeFileSync(
    "docs/acceptance/evidence/2026-11-22-flight-leader-final.json",
    JSON.stringify(summaries, null, 2) + "\n"
  );
});
