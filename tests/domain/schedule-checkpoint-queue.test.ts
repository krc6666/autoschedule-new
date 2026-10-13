import { describe, expect, it, vi } from "vitest";
import { createScheduleCheckpointQueue } from "../../src/domain/kernel/schedule-checkpoint-queue";
import type { DailySchedulePlan } from "../../src/domain/kernel/daily-schedule-result";
import type { ScheduleResult } from "../../src/model";
import { createLatePriorityPressureState } from "../performance/fixtures/late-priority";

function plan(): DailySchedulePlan {
  return {
    assignments: createLatePriorityPressureState().assignments,
    lockedAssignmentIds: new Set(["A0"]),
    warnings: [],
    dailyFlightCountBalanceFallback: false,
    optimizationQuality: "fairness-time-limited",
  };
}

describe("safe checkpoint coalescing", () => {
  it("finalizes identical plans once even if fresh assignment IDs are used", async () => {
    let finish!: (result: ScheduleResult) => void;
    const finalize = vi.fn(
      (_plan: DailySchedulePlan) =>
        new Promise<ScheduleResult>((resolve) => {
          finish = resolve;
        })
    );
    const publish = vi.fn();
    const queue = createScheduleCheckpointQueue(finalize, publish);
    const first = plan();
    queue.enqueue(first);
    const second = structuredClone(first);
    second.assignments.forEach((row) => (row.id = `new-${row.id}`));
    second.lockedAssignmentIds = new Set(["new-A0"]);
    queue.enqueue(second);
    expect(finalize).toHaveBeenCalledTimes(1);
    first.assignments[0]!.staffId = "changed-after-enqueue";
    expect(finalize.mock.calls[0]![0].assignments[0]!.staffId).toBe("P0");
    finish({ assignments: [], warnings: [], unfilledCount: 0 });
    await Promise.resolve();
    expect(publish).toHaveBeenCalledTimes(1);
    queue.enqueue(second);
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it("rechecks changed people, locks, notes and quality; failed checks never publish", async () => {
    const finalize = vi.fn(async (input: DailySchedulePlan) => {
      if (input.assignments[0]!.staffId === "unsafe")
        throw new Error("guard rejected");
      return { assignments: input.assignments, warnings: [], unfilledCount: 0 };
    });
    const publish = vi.fn();
    const queue = createScheduleCheckpointQueue(finalize, publish);
    const current = plan();
    queue.enqueue(current);
    await Promise.resolve();
    current.assignments[0]!.staffId = "unsafe";
    queue.enqueue(current);
    await Promise.resolve();
    expect(publish).toHaveBeenCalledTimes(1);
    current.assignments[0]!.staffId = "P0";
    current.lockedAssignmentIds.clear();
    queue.enqueue(current);
    await Promise.resolve();
    current.assignments[0]!.systemNotes = ["new evidence"];
    queue.enqueue(current);
    await Promise.resolve();
    current.optimizationQuality = "all-objectives-optimal";
    queue.enqueue(current);
    await Promise.resolve();
    expect(finalize).toHaveBeenCalledTimes(5);
    expect(publish).toHaveBeenCalledTimes(4);
  });

  it("drops pending work before the final pass and never publishes after close", async () => {
    let finish!: (result: ScheduleResult) => void;
    const finalize = vi.fn(
      () =>
        new Promise<ScheduleResult>((resolve) => {
          finish = resolve;
        })
    );
    const publish = vi.fn();
    const queue = createScheduleCheckpointQueue(finalize, publish);
    const current = plan();
    queue.enqueue(current);
    current.assignments[0]!.staffId = "P1";
    queue.enqueue(current);
    queue.discardPending();
    queue.close();
    finish({ assignments: [], warnings: [], unfilledCount: 0 });
    await Promise.resolve();
    queue.enqueue(current);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
  });
});
