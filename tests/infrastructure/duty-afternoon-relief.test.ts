import { afterEach, expect, it, vi } from "vitest";
import * as XLSX from "xlsx-js-style";
import {
  dutyFlightCountScenario,
  DUTY_COUNT_DATE,
} from "../helpers/duty-flight-count-scenario";
import { createDefaultState } from "../../src/defaults";
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

it("carries afternoon settings through XLSX/restart, real worker/WASM and final Store installation", async () => {
  const { state: facts } = dutyFlightCountScenario();
  const source = { ...createDefaultState(), ...facts };
  for (const person of source.staff) {
    person.cxPreflightQualified = true;
    person.standbyQualified = true;
  }
  source.settings.afternoonRestEndTime = "17:30";
  const evening = source.flights.find((f) => f.flightNo === "TEST2")!;
  evening.startTime = "17:55";
  evening.endTime = "19:55";
  source.templates = source.flights.map((f) => ({ ...f }));
  const bytes = XLSX.write(buildConfigWorkbook(source), {
    type: "array",
    bookType: "xlsx",
  });
  const imported = parseWorkbook(XLSX.read(bytes, { type: "array" }), []);
  const target = createDefaultState();
  expect(applyWorkbookImport(target, imported, "all").errors).toBeUndefined();
  let persisted = "";
  saveState(target, {
    setItem: (_key, value) => {
      persisted = value;
    },
  });
  const restarted = loadState({ getItem: () => persisted });
  expect(restarted.settings.afternoonRestStartTime).toBe("12:00");
  expect(restarted.settings.afternoonRestEndTime).toBe("17:30");
  const messages: ScheduleWorkerResponse[] = [];
  const worker: {
    onmessage:
      ((event: MessageEvent<ScheduleWorkerRequest>) => Promise<void>) | null;
    postMessage: (message: ScheduleWorkerResponse) => void;
  } = {
    onmessage: null,
    postMessage: (message) => messages.push(structuredClone(message)),
  };
  vi.stubGlobal("self", worker);
  await import("../../src/schedule.worker");
  const snapshots: Array<{
    afternoonEnd: string;
    flights: string[];
    assigned: number;
  }> = [];
  for (const [afternoonEnd, expectedFlights] of [
    ["17:30", ["TEST0", "TEST2", "TEST3"]],
    ["18:00", ["TEST0", "TEST3"]],
  ] as const) {
    restarted.settings.afternoonRestEndTime = afternoonEnd;
    messages.length = 0;
    await worker.onmessage!(
      new MessageEvent<ScheduleWorkerRequest>("message", {
        data: {
          state: createScheduleGenerationFacts(restarted),
          date: DUTY_COUNT_DATE,
          preferences: { halfRestStaffIds: [] },
        },
      })
    );
    expect(messages.filter((m) => m.type === "error")).toEqual([]);
    const response = messages.find((m) => m.type === "result");
    if (response?.type !== "result") throw new Error("未返回班表");
    expect(response.result.unfilledCount).toBe(0);
    expect(response.result.safetyCredential).toBeDefined();
    const store = createTestAutoscheduleStore(restarted);
    store.getState().schedule.install(DUTY_COUNT_DATE, response.result);
    const model = store.getState().model;
    const ownFlights = [
      ...new Set(
        model.assignments
          .filter((a) => a.staffId === "duty")
          .map((a) => a.flightNo)
      ),
    ].sort();
    expect(ownFlights).toEqual([...expectedFlights]);
    // Independently inspect the emitted machine-readable assignment cells.
    const workbook = buildConfigWorkbook(model);
    const exported = parseWorkbook(
      XLSX.read(XLSX.write(workbook, { type: "array", bookType: "xlsx" }), {
        type: "array",
      }),
      model.staff
    );
    expect(exported.settings?.afternoonRestEndTime).toBe(afternoonEnd);
    const scheduleBytes = XLSX.write(
      buildScheduleWorkbook(model, DUTY_COUNT_DATE),
      { type: "array", bookType: "xlsx" }
    );
    const scheduleWorkbook = XLSX.read(scheduleBytes, { type: "array" });
    const assignmentRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(
      scheduleWorkbook.Sheets["排班结果"]!
    );
    expect(assignmentRows.length).toBe(model.assignments.length);
    expect(
      [
        ...new Set(
          assignmentRows
            .filter((r) => r["人员编号"] === "duty")
            .map((r) => r["航班号"])
        ),
      ].sort()
    ).toEqual([...expectedFlights]);
    for (const person of model.staff) {
      if (person.id === "duty") continue;
      expect(
        new Set(
          assignmentRows
            .filter((r) => r["人员编号"] === person.id)
            .map((r) => r["航班号"])
        ).size
      ).toBeGreaterThanOrEqual(3);
    }
    saveState(model, {
      setItem: (_key, value) => {
        persisted = value;
      },
    });
    const savedResult = loadState({ getItem: () => persisted });
    expect(savedResult.assignments.map((a) => [a.flightNo, a.staffId])).toEqual(
      model.assignments.map((a) => [a.flightNo, a.staffId])
    );
    snapshots.push({
      afternoonEnd,
      flights: ownFlights,
      assigned: model.assignments.filter((a) => a.status === "assigned").length,
    });
  }
  console.info("DUTY_AFTERNOON_WORKER_EVIDENCE", JSON.stringify(snapshots));
});
