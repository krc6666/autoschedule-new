import { afterEach, expect, it, vi } from "vitest";
import { createDefaultState } from "../../src/defaults";
import type {
  ScheduleWorkerRequest,
  ScheduleWorkerResponse,
} from "../../src/infrastructure/schedule-worker-protocol";
const calculate = vi.hoisted(() => vi.fn());
vi.mock("../../src/domain/kernel/scheduling-kernel", () => ({
  generateSchedule: calculate,
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it.each([true, false])(
  "serializes guard evidence with details=%s from the actual worker error boundary",
  async (withDetails) => {
    const { ScheduleGuardError } =
      await import("../../src/domain/kernel/schedule-guard");
    const violations = [
      {
        ruleId: "ke166-supervisor",
        message: "原检查错误",
        ...(withDetails
          ? {
              details: {
                code: "ke166-distinct-staff-capacity" as const,
                reason: "人员甲可承担KE166/H05",
                facts: ["目前空闲"],
                steps: ["导出记录"],
              },
            }
          : {}),
      },
    ];
    calculate.mockRejectedValueOnce(new ScheduleGuardError(violations));
    const worker: {
      onmessage:
        ((event: MessageEvent<ScheduleWorkerRequest>) => Promise<void>) | null;
      postMessage: ReturnType<typeof vi.fn>;
    } = { onmessage: null, postMessage: vi.fn() };
    vi.stubGlobal("self", worker);
    await import("../../src/schedule.worker");
    await worker.onmessage!(
      new MessageEvent<ScheduleWorkerRequest>("message", {
        data: {
          state: createDefaultState(),
          date: "2026-10-14",
          preferences: { halfRestStaffIds: [] },
        },
      })
    );
    const message: ScheduleWorkerResponse = JSON.parse(
      JSON.stringify(worker.postMessage.mock.calls[0]![0])
    );
    expect(message).toMatchObject({ type: "error", violations });
  }
);
