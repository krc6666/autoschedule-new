import { expect, it, vi } from "vitest";
import { supervisorIndependenceScenario } from "../helpers/supervisor-independence-scenario";
import { generateSchedule } from "../helpers/generate-schedule";

const injected = vi.hoisted(() => ({ sourceStaffId: "", count: 0 }));
vi.mock("../../src/domain/kernel/schedule-pipeline", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../../src/domain/kernel/schedule-pipeline")
    >();
  return {
    ...original,
    runPostSchedulePipeline: async (
      context: Parameters<typeof original.runPostSchedulePipeline>[0]
    ) => {
      const warnings = await original.runPostSchedulePipeline(context);
      const rows = context.ledger.snapshot().map((a) => structuredClone(a));
      const source = rows.find((a) => a.position === "督导")!;
      const target = rows.find((a) => a.position === "H05")!;
      expect(target.staffId).not.toBe(source.staffId);
      injected.sourceStaffId = source.staffId!;
      injected.count++;
      Object.assign(target, {
        staffId: source.staffId,
        staffName: source.staffName,
        workHours: 0,
        fatiguePoints: 0,
        supervisorSourceAssignmentId: source.id,
        supervisorFillRuleId: "configured-fill",
      });
      context.ledger.commit({ type: "replace", assignments: rows });
      return warnings;
    },
  };
});

it("repairs unnecessary sharing introduced after the real post-review pipeline without undoing its supervisor", async () => {
  const result = await generateSchedule(
    supervisorIndependenceScenario(),
    "2026-11-18"
  );
  expect(injected.count).toBe(1);
  expect(result.assignments.find((a) => a.position === "督导")?.staffId).toBe(
    injected.sourceStaffId
  );
  const target = result.assignments.find((a) => a.position === "H05")!;
  expect(target.staffId).toBe("replacement");
  expect(target.workHours).toBe(2);
  expect(target.fatiguePoints).toBe(2);
  expect(target.supervisorSourceAssignmentId).toBeUndefined();
  expect(target.supervisorFillRuleId).toBeUndefined();
  expect(result.assignments.every((a) => a.status === "assigned")).toBe(true);
  expect(result.safetyCredential).toBeDefined();
});
