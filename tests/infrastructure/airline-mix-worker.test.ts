import { afterEach, expect, it, vi } from "vitest";
import * as XLSX from "xlsx-js-style";
import { createDefaultState } from "../../src/defaults";
import {
  airlineMixScenario,
  AIRLINE_MIX_DATE,
} from "../helpers/airline-mix-scenario";
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

it("uses restored editable preferences in real Worker/WASM and independently checks final XLSX carrier mixes", async () => {
  const source = { ...createDefaultState(), ...airlineMixScenario() };
  source.settings.earlyDepartureBalanceEnabled = true;
  source.settings.afternoonRestBalanceEnabled = true;
  source.activeScheduleDate = AIRLINE_MIX_DATE;
  source.staff.forEach((p) => {
    p.cxPreflightQualified = true;
    p.standbyQualified = true;
  });
  const bytes = XLSX.write(buildConfigWorkbook(source), {
    bookType: "xlsx",
    type: "array",
  });
  const restored = createDefaultState();
  expect(
    applyWorkbookImport(
      restored,
      parseWorkbook(XLSX.read(bytes, { type: "array" }), []),
      "all"
    ).errors
  ).toBeUndefined();
  expect(restored.settings.airlineMixPolicies).toEqual(
    source.settings.airlineMixPolicies
  );
  let saved = "";
  saveState(restored, {
    setItem: (_k, v) => {
      saved = v;
    },
  });
  const restarted = loadState({ getItem: () => saved });
  const messages: ScheduleWorkerResponse[] = [];
  const host: {
    onmessage:
      ((e: MessageEvent<ScheduleWorkerRequest>) => Promise<void>) | null;
    postMessage: (m: ScheduleWorkerResponse) => void;
  } = {
    onmessage: null,
    postMessage: (m) => {
      messages.push(structuredClone(m));
    },
  };
  vi.stubGlobal("self", host);
  await import("../../src/schedule.worker");
  await host.onmessage!(
    new MessageEvent<ScheduleWorkerRequest>("message", {
      data: {
        state: createScheduleGenerationFacts(restarted),
        date: AIRLINE_MIX_DATE,
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
  store.getState().schedule.install(AIRLINE_MIX_DATE, response.result);
  const model = store.getState().model;
  const output = XLSX.write(buildScheduleWorkbook(model, AIRLINE_MIX_DATE), {
    bookType: "xlsx",
    type: "array",
  });
  const book = XLSX.read(output, { type: "array" });
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(
    book.Sheets["排班结果"]!
  );
  expect(rows).toHaveLength(4);
  const minutes = (value: string) =>
    Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const summary = model.staff.map((p) => {
    const own = rows.filter((r) => r["人员编号"] === p.id);
    const flights = [...new Set(own.map((r) => r["航班号"]))];
    expect(flights).toHaveLength(2);
    // Independent business check against the actual exported fields.
    expect(flights.some((f) => !/^(FD|AK)\d/.test(f!))).toBe(true);
    const spanMinutes =
      Math.max(...own.map((r) => minutes(r["结束时间"]!))) -
      Math.min(...own.map((r) => minutes(r["开始时间"]!)));
    expect(spanMinutes).toBeLessThanOrEqual(390);
    return { staff: p.id, flights, spanMinutes };
  });
  saveState(model, {
    setItem: (_k, v) => {
      saved = v;
    },
  });
  expect(loadState({ getItem: () => saved }).assignments).toEqual(
    model.assignments
  );
  expect(
    parseWorkbook(book, model.staff).history?.filter((r) => r.staffId).length
  ).toBe(4);
  console.info("AIRLINE_MIX_WORKER_XLSX", JSON.stringify(summary));
});
