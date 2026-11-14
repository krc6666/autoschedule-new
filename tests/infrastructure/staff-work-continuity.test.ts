import { afterEach, expect, it, vi } from "vitest";
import * as XLSX from "xlsx-js-style";
import { createDefaultState } from "../../src/defaults";
import {
  continuityScenario,
  CONTINUITY_DATE,
} from "../helpers/staff-work-continuity-scenario";
import {
  buildConfigWorkbook,
  buildScheduleWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";
import { applyWorkbookImport } from "../../src/app/workbook-actions";
import { saveState, loadState } from "../../src/infrastructure/storage";
import { createScheduleGenerationFacts } from "../../src/domain/shared/scheduling-facts";
import type {
  ScheduleWorkerRequest,
  ScheduleWorkerResponse,
} from "../../src/infrastructure/schedule-worker-protocol";
import { createTestAutoscheduleStore } from "../helpers/application";

afterEach(() => vi.unstubAllGlobals());

it("keeps final compact work through configuration bytes, restart, real Worker/WASM, Store and schedule XLSX", async () => {
  const source = { ...createDefaultState(), ...continuityScenario() };
  source.settings.earlyDepartureBalanceEnabled = true;
  source.settings.afternoonRestBalanceEnabled = true;
  source.activeScheduleDate = CONTINUITY_DATE;
  source.staff.forEach((p) => {
    p.cxPreflightQualified = true;
    p.standbyQualified = true;
  });
  const configBytes = XLSX.write(buildConfigWorkbook(source), {
    bookType: "xlsx",
    type: "array",
  });
  const restored = createDefaultState();
  expect(
    applyWorkbookImport(
      restored,
      parseWorkbook(XLSX.read(configBytes, { type: "array" }), []),
      "all"
    ).errors
  ).toBeUndefined();
  let persisted = "";
  saveState(restored, {
    setItem: (_k, v) => {
      persisted = v;
    },
  });
  const restarted = loadState({ getItem: () => persisted });
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
        date: CONTINUITY_DATE,
        preferences: { halfRestStaffIds: [] },
      },
    })
  );
  expect(messages.filter((m) => m.type === "error")).toEqual([]);
  const response = messages.find((m) => m.type === "result");
  if (response?.type !== "result") throw new Error("no worker result");
  expect(response.result.unfilledCount).toBe(0);
  expect(response.result.safetyCredential).toBeDefined();
  const store = createTestAutoscheduleStore(restarted);
  store.getState().schedule.install(CONTINUITY_DATE, response.result);
  const model = store.getState().model;
  const scheduleBytes = XLSX.write(
    buildScheduleWorkbook(model, CONTINUITY_DATE),
    { bookType: "xlsx", type: "array" }
  );
  const book = XLSX.read(scheduleBytes, { type: "array" });
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(
    book.Sheets["排班结果"]!
  );
  const minutes = (value: string) =>
    Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const summary = model.staff.map((person) => {
    const own = rows.filter((r) => r["人员编号"] === person.id);
    expect(new Set(own.map((r) => r["航班号"])).size).toBe(2);
    // Re-read actual exported fields, independently of the domain profile.
    const span =
      Math.max(...own.map((r) => minutes(r["结束时间"]!))) -
      Math.min(...own.map((r) => minutes(r["开始时间"]!)));
    expect(span).toBeLessThan(900);
    return {
      staff: person.id,
      flights: own.map((r) => r["航班号"]),
      spanMinutes: span,
    };
  });
  saveState(model, {
    setItem: (_k, v) => {
      persisted = v;
    },
  });
  expect(loadState({ getItem: () => persisted }).assignments).toEqual(
    model.assignments
  );
  console.info("CONTINUITY_WORKER_XLSX", JSON.stringify(summary));
});
