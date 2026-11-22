import { afterEach, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import * as XLSX from "xlsx-js-style";
import { createDefaultState } from "../../src/defaults";
import { createScheduleGenerationFacts } from "../../src/domain/shared/scheduling-facts";
import { createTestAutoscheduleStore } from "../helpers/application";
import {
  lateAirlineScenario,
  LATE_AIRLINE_DATE,
} from "../helpers/late-airline-scenario";
import type {
  ScheduleWorkerRequest,
  ScheduleWorkerResponse,
} from "../../src/infrastructure/schedule-worker-protocol";
import { buildScheduleWorkbook } from "../../src/infrastructure/excel";

afterEach(() => vi.unstubAllGlobals());
it("applies whole-day rotation in Worker/WASM, safety snapshots, installation and actual Excel output", async () => {
  const source = Object.assign(createDefaultState(), lateAirlineScenario());
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
        state: createScheduleGenerationFacts(source),
        date: LATE_AIRLINE_DATE,
        preferences: { halfRestStaffIds: [] },
      },
    })
  );
  expect(messages.filter((m) => m.type === "error")).toEqual([]);
  const response = messages.find((m) => m.type === "result");
  if (response?.type !== "result") throw Error("No worker result");
  expect(response.result.safetyCredential).toBeDefined();
  expect(response.result.unfilledCount).toBe(0);
  const snapshots = messages.filter((m) => m.type === "safe-result");
  expect(snapshots.length).toBeGreaterThan(0);
  for (const snapshot of snapshots) {
    if (snapshot.type !== "safe-result") continue;
    expect(
      snapshot.result.assignments.find((a) => a.flightNo === "AK103")?.staffId
    ).toBe("peer-a");
    expect(
      snapshot.result.assignments.find((a) => a.flightNo === "TR104")?.staffId
    ).toBe("peer-b");
    expect(snapshot.result.safetyCredential).toBeDefined();
  }
  const store = createTestAutoscheduleStore(source);
  store.getState().schedule.install(LATE_AIRLINE_DATE, response.result);
  const model = store.getState().model;
  const bytes = XLSX.write(buildScheduleWorkbook(model, LATE_AIRLINE_DATE), {
    type: "buffer",
    bookType: "xlsx",
  });
  const workbook = XLSX.read(bytes, { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(
    workbook.Sheets["排班结果"]!
  );
  // Derive expected people and carriers from the business example, not the rule projection.
  expect(rows).toHaveLength(4);
  const flightsFor = (id: string) =>
    rows
      .filter((r) => r["人员编号"] === id)
      .map((r) => r["航班号"])
      .sort();
  expect(flightsFor("peer-a")).toEqual(["AK103", "CX102"]);
  expect(flightsFor("peer-b")).toEqual(["FD101", "TR104"]);
  writeFileSync(
    "docs/acceptance/evidence/2026-11-21-late-airline-result.xlsx",
    bytes
  );
  writeFileSync(
    "docs/acceptance/evidence/2026-11-21-late-airline-final.json",
    JSON.stringify(
      {
        date: LATE_AIRLINE_DATE,
        previous: { "peer-a": "TR104", "peer-b": "AK103" },
        current: {
          "peer-a": flightsFor("peer-a"),
          "peer-b": flightsFor("peer-b"),
        },
        rows: rows.length,
        unfilledCount: response.result.unfilledCount,
        safetyCredential: !!response.result.safetyCredential,
        safeSnapshots: messages.filter((m) => m.type === "safe-result").length,
      },
      null,
      2
    ) + "\n"
  );
});
