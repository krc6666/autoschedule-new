import { afterEach, expect, it, vi } from "vitest";
import * as XLSX from "xlsx-js-style";
import { writeFileSync } from "node:fs";
import {
  dutyEarliestScenario,
  DUTY_EARLIEST_DATE as date,
} from "../helpers/duty-earliest-scenario";
import { createScheduleGenerationFacts } from "../../src/domain/shared/scheduling-facts";
import type {
  ScheduleWorkerRequest,
  ScheduleWorkerResponse,
} from "../../src/infrastructure/schedule-worker-protocol";
import { createTestAutoscheduleStore } from "../helpers/application";
import { createStatePersistence } from "../../src/infrastructure/storage";
import {
  buildConfigWorkbook,
  buildScheduleWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";

afterEach(() => vi.unstubAllGlobals());

it("keeps earliest duty through real Worker/WASM, safe checkpoints, Store, persistence and Excel bytes", async () => {
  const state = dutyEarliestScenario();
  state.settings.crossFlightPriorityPolicies = [
    { id: "later-first", flightNo: "BB102", staffIds: ["p0"], enabled: true },
  ];
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
  await worker.onmessage!(
    new MessageEvent<ScheduleWorkerRequest>("message", {
      data: {
        state: createScheduleGenerationFacts(state),
        date,
        preferences: { halfRestStaffIds: [], halfRestModes: {} },
      },
    })
  );
  expect(messages.filter((message) => message.type === "error")).toEqual([]);
  const final = messages.find((message) => message.type === "result");
  if (final?.type !== "result") throw new Error("missing final result");
  expect(final.result.unfilledCount).toBe(0);
  const checkpoints = messages.filter(
    (message) => message.type === "safe-result"
  );
  expect(checkpoints.length).toBeGreaterThan(0);
  for (const message of [...checkpoints, final]) {
    if (message.type !== "result" && message.type !== "safe-result") continue;
    expect(
      message.result.assignments.find((row) => row.flightId === "early")
        ?.staffId
    ).toBe("p0");
    expect(
      message.result.assignments.find((row) => row.flightId === "late")?.staffId
    ).toBe("p0");
    expect(message.result.safetyCredential?.phase).toBe("final");
  }
  const store = createTestAutoscheduleStore(state);
  store.getState().schedule.install(date, final.result);
  let saved = "";
  const persistence = createStatePersistence({
    getItem: () => saved || null,
    setItem: (_key, value) => {
      saved = value;
    },
    removeItem: () => {
      saved = "";
    },
  });
  persistence.save(store.getState().model);
  const restored = persistence.load();
  expect(restored.assignments).toEqual(store.getState().model.assignments);
  const config = parseWorkbook(
    XLSX.read(
      XLSX.write(buildConfigWorkbook(restored), {
        type: "array",
        bookType: "xlsx",
      }),
      { type: "array" }
    ),
    []
  );
  expect(config.settings?.crossFlightPriorityPolicies).toEqual(
    state.settings.crossFlightPriorityPolicies
  );
  expect(config.dutyRosterOverrides).toEqual(restored.dutyRosterOverrides);
  const bytes = XLSX.write(buildScheduleWorkbook(restored, date), {
    type: "buffer",
    bookType: "xlsx",
  });
  const exported = XLSX.read(bytes, { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json<unknown[]>(
    exported.Sheets["排班结果"]!,
    { header: 1, defval: "" }
  );
  expect(rows.find((row) => row[1] === "AA101")?.[12]).toBe("p0");
  expect(rows.find((row) => row[1] === "AA101")?.[4]).toBe("07:00");
  expect(rows.find((row) => row[1] === "ZZ900")?.[12]).toBe("p0");
  if (process.env.DUTY_EARLIEST_EVIDENCE === "1") {
    const prefix = "docs/acceptance/evidence/2026-11-17-duty-earliest";
    writeFileSync(
      `${prefix}-artifact.json`,
      JSON.stringify(
        {
          date,
          input: createScheduleGenerationFacts(state),
          result: final.result,
          restoredAssignments: restored.assignments,
        },
        null,
        2
      )
    );
    writeFileSync(`${prefix}-artifact.xlsx`, bytes);
  }
}, 30_000);
