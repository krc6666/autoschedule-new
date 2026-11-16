import { afterEach, expect, it, vi } from "vitest";
import * as XLSX from "xlsx-js-style";
import { vacancyScenario } from "../helpers/cross-flight-vacancy-scenario";
import { createDefaultState } from "../../src/defaults";
import {
  buildConfigWorkbook,
  buildScheduleWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";
import { applyWorkbookImport } from "../../src/app/workbook-actions";
import { saveState, loadState } from "../../src/infrastructure/storage";
import { createScheduleGenerationFacts } from "../../src/domain/shared/scheduling-facts";
import { createTestAutoscheduleStore } from "../helpers/application";
import type {
  ScheduleWorkerRequest,
  ScheduleWorkerResponse,
} from "../../src/infrastructure/schedule-worker-protocol";

afterEach(() => vi.unstubAllGlobals());

it("restores priority/exclusion/fill settings, covers through Worker/WASM and exports a complete linked plan", async () => {
  const source = vacancyScenario(true);
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
  let saved = "";
  saveState(restored, {
    setItem: (_k, v) => {
      saved = v;
    },
  });
  const restarted = loadState({ getItem: () => saved });
  expect(restarted.settings.crossFlightPriorityPolicies).toEqual(
    source.settings.crossFlightPriorityPolicies
  );
  expect(restarted.settings.sameFlightStaffExclusions).toEqual(
    source.settings.sameFlightStaffExclusions
  );
  const messages: ScheduleWorkerResponse[] = [];
  const host: {
    onmessage:
      ((event: MessageEvent<ScheduleWorkerRequest>) => Promise<void>) | null;
    postMessage: (message: ScheduleWorkerResponse) => void;
  } = {
    onmessage: null,
    postMessage: (message) => {
      messages.push(structuredClone(message));
    },
  };
  vi.stubGlobal("self", host);
  await import("../../src/schedule.worker");
  await host.onmessage!(
    new MessageEvent<ScheduleWorkerRequest>("message", {
      data: {
        state: createScheduleGenerationFacts(restarted),
        date: "2026-11-18",
        preferences: { halfRestStaffIds: [] },
      },
    })
  );
  expect(messages.filter((m) => m.type === "error")).toEqual([]);
  const response = messages.find((m) => m.type === "result");
  if (response?.type !== "result") throw new Error("no worker result");
  const store = createTestAutoscheduleStore(restarted);
  store.getState().schedule.install("2026-11-18", response.result);
  const model = store.getState().model;
  const output = XLSX.read(
    XLSX.write(buildScheduleWorkbook(model, "2026-11-18"), {
      bookType: "xlsx",
      type: "array",
    }),
    { type: "array" }
  );
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(
    output.Sheets["排班结果"]!
  );
  expect(rows).toHaveLength(5);
  expect(rows.every((row) => Boolean(row["人员编号"]))).toBe(true);
  expect(rows.find((row) => row["岗位"] === "G12")?.["人员编号"]).toBe(
    "bridge"
  );
  const fill = model.assignments.find((a) => a.position === "H05")!;
  const supervisor = model.assignments.find((a) => a.position === "督导")!;
  expect(fill.supervisorSourceAssignmentId).toBe(supervisor.id);
  expect(fill.supervisorFillRuleId).toBe("configured-fill");
  expect(fill.workHours).toBe(0);
  expect(model.assignments.some((a) => a.status === "unfilled")).toBe(false);
  saveState(model, {
    setItem: (_k, v) => {
      saved = v;
    },
  });
  expect(loadState({ getItem: () => saved }).assignments).toEqual(
    model.assignments
  );
});
