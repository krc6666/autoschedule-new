// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import {
  createTestApplicationCoordinator,
  createTestAutoscheduleStore,
} from "../helpers/application";
const download = vi.hoisted(() => vi.fn());
vi.mock("../../src/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils")>()),
  downloadBlob: download,
}));

it("exports the failed target date and recorded evidence without exporting configuration", async () => {
  const coordinator = createTestApplicationCoordinator(
    createTestAutoscheduleStore(),
    {
      preferences: {
        loadScheduleDate: () => "2026-10-12",
        saveScheduleDate: () => undefined,
        loadScheduleZoom: () => null,
        saveScheduleZoom: () => undefined,
      },
    }
  );
  const details = {
    code: "ke166-distinct-staff-capacity" as const,
    date: "2026-10-14",
    reason: "人员甲也能承担KE166/H05",
    facts: ["人员甲没有重叠岗位"],
    steps: ["请开发人员检查程序"],
    diagnosticMessages: ["Worker 运行失败：RuntimeError: unreachable"],
  };
  coordinator.updateView({
    toast: { id: 1, message: "失败", tone: "danger", details },
  });
  const original = structuredClone(coordinator.model());
  await coordinator.handle({ type: "export-schedule-failure-details" });
  expect(download).toHaveBeenCalledOnce();
  const [blob, name] = download.mock.calls[0]!;
  expect(name).toBe("排班失败诊断_2026-10-14.txt");
  const text = await blob.text();
  expect(text).toContain(details.reason);
  expect(text).toContain(details.facts[0]);
  expect(text).toContain(details.steps[0]);
  expect(text).toContain(details.diagnosticMessages[0]);
  expect(text).toContain("无需自行理解");
  expect(text).not.toContain("qualifiedStaffIds");
  expect(coordinator.model()).toEqual(original);
});
