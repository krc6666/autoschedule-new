import * as XLSX from "xlsx-js-style";
import { expect, it } from "vitest";
import { warningScenario } from "../helpers/actionable-warning-scenario";
import { generateSchedule } from "../helpers/generate-schedule";
import { buildScheduleWorkbook } from "../../src/infrastructure/excel";
import { loadState, saveState } from "../../src/infrastructure/storage";
import { buildScheduleFeedback } from "../../src/domain/feedback/schedule-feedback";

it("keeps the final mixed blocker evidence through storage, feedback and the exported workbook", async () => {
  const state = warningScenario();
  const result = await generateSchedule(state, "2026-10-17");
  state.assignments = result.assignments;
  state.activeScheduleDate = "2026-10-17";
  let persisted = "";
  saveState(state, {
    setItem: (_key, value) => {
      persisted = value;
    },
  });
  const restored = loadState({ getItem: () => persisted });
  const original = state.assignments.find((a) => a.position === "G18")!;
  const loaded = restored.assignments.find((a) => a.position === "G18")!;
  expect(loaded.systemNotes).toEqual(original.systemNotes);
  expect(
    buildScheduleFeedback(restored, "2026-10-17").find(
      (f) => f.key === "morning-priority"
    )?.evidence
  ).toContain("严格跨工作日恢复 3 人");
  const book = buildScheduleWorkbook(restored, "2026-10-17");
  const read = XLSX.read(
    XLSX.write(book, { type: "array", bookType: "xlsx" }),
    { type: "array" }
  );
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(
    read.Sheets["排班结果"]!
  );
  expect(rows.find((r) => Object.values(r).includes("G18"))?.["系统说明"]).toBe(
    original.systemNotes!.join("；")
  );
  expect(persisted).not.toContain("crossFlightPriorityReservations");
});
