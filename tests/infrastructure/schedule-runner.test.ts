import { afterEach, describe, expect, it, vi } from "vitest";

import { createDefaultState } from "../../src/defaults";
import { createTestAutoscheduleStore } from "../helpers/application";
import { runScheduleInBackground } from "../../src/infrastructure/schedule-runner";
import type { ScheduleWorkerResponse } from "../../src/infrastructure/schedule-worker-protocol";

afterEach(() => vi.unstubAllGlobals());

class ControlledWorker {
  static instances: ControlledWorker[] = [];
  onmessage: ((event: MessageEvent<ScheduleWorkerResponse>) => void) | null =
    null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly terminate = vi.fn();
  readonly postMessage = vi.fn();

  constructor() {
    ControlledWorker.instances.push(this);
  }

  emit(message: ScheduleWorkerResponse): void {
    this.onmessage?.({ data: message } as MessageEvent<ScheduleWorkerResponse>);
  }
}

function createRun(halfRestStaffIds: string[] = []) {
  vi.stubGlobal("Worker", ControlledWorker);
  const run = runScheduleInBackground(
    createDefaultState(),
    "2026-08-01",
    () => undefined,
    () => undefined,
    { halfRestStaffIds }
  );
  return { run, worker: ControlledWorker.instances.at(-1)! };
}

describe("background schedule runner", () => {
  it.each([true, false])(
    "preserves guard evidence with details=%s across a serialized worker message",
    async (withDetails) => {
      const { run, worker } = createRun();
      const violations = [
        {
          ruleId: "ke166-supervisor",
          assignmentId: "counter",
          message: "原检查错误",
          ...(withDetails
            ? {
                details: {
                  code: "ke166-distinct-staff-capacity" as const,
                  reason: "人员甲可承担KE166/H05",
                  facts: ["人员甲没有重叠岗位"],
                  steps: ["导出诊断记录"],
                },
              }
            : {}),
        },
      ];
      worker.emit(
        JSON.parse(
          JSON.stringify({ type: "error", message: "原检查错误", violations })
        )
      );
      await expect(run.result).rejects.toMatchObject({
        name: "ScheduleGuardError",
        violations,
      });
      expect(worker.terminate).toHaveBeenCalledOnce();
    }
  );
  it("sends only the active group's staff and history to the worker", () => {
    const initial = createDefaultState();
    initial.groups.B.staff = [
      { ...initial.staff[0]!, id: "b-only", name: "B组人员" },
    ];
    initial.groups.B.history = [
      {
        id: "b-history",
        date: "2026-08-01",
        flightNo: "B-FLIGHT",
        position: "G01",
        staffId: "b-only",
        staffName: "B组人员",
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 1,
        remark: "",
      },
    ];
    const store = createTestAutoscheduleStore(initial);
    store.getState().switchGroup("B");
    vi.stubGlobal("Worker", ControlledWorker);

    const run = runScheduleInBackground(
      store.getState().model,
      "2026-08-01",
      () => undefined,
      () => undefined
    );
    const request =
      ControlledWorker.instances.at(-1)!.postMessage.mock.calls[0]![0];

    expect(
      request.state.staff.map((person: { id: string }) => person.id)
    ).toEqual(["b-only"]);
    expect(request.state.history).toEqual(initial.groups.B.history);
    run.stopWithoutResult();
  });

  it("projects application state to schedule-generation facts before posting", () => {
    const state = createDefaultState();
    const selectedId = state.staff.find(
      (person) => person.status === "正常" && person.staffType === "常规"
    )!.id;
    vi.stubGlobal("Worker", ControlledWorker);
    const run = runScheduleInBackground(
      state,
      "2026-08-01",
      () => undefined,
      () => undefined,
      {
        halfRestStaffIds: [selectedId],
        halfRestModes: { [selectedId]: "late-start" },
      }
    );
    const worker = ControlledWorker.instances.at(-1)!;

    expect(worker.postMessage).toHaveBeenCalledOnce();
    const request = worker.postMessage.mock.calls[0]![0];
    expect(request.state).toMatchObject({
      staff: expect.any(Array),
      flights: expect.any(Array),
      positionRules: expect.any(Array),
      settings: expect.any(Object),
    });
    expect(request.state).not.toHaveProperty("version");
    expect(request.state).not.toHaveProperty("weeklyFlightPlans");
    expect(request.state).not.toHaveProperty("activeScheduleDate");
    expect(request.state).not.toHaveProperty("schedulePolicyStale");
    expect(request.state).not.toHaveProperty("updatedAt");
    expect(request.preferences).toEqual({
      halfRestStaffIds: [selectedId],
      halfRestModes: { [selectedId]: "late-start" },
    });
    run.stopWithoutResult();
  });

  it("stops immediately without exposing a calculated result", async () => {
    const { run, worker } = createRun();

    expect(run.stopWithoutResult()).toBe(true);

    await expect(run.result).resolves.toEqual({
      kind: "stopped-without-result",
    });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("refuses to adopt a result until a complete safe snapshot exists", () => {
    const { run, worker } = createRun();

    expect(run.hasLatestSafeResult()).toBe(false);
    expect(run.stopWithLatestResult()).toBe(false);
    expect(worker.terminate).not.toHaveBeenCalled();
    run.stopWithoutResult();
  });

  it("adopts the latest complete safe snapshot and terminates further work", async () => {
    const { run, worker } = createRun();
    const safeResult = { assignments: [], warnings: [], unfilledCount: 0 };
    worker.emit({ type: "safe-result", result: safeResult });

    expect(run.hasLatestSafeResult()).toBe(true);
    expect(run.stopWithLatestResult()).toBe(true);

    await expect(run.result).resolves.toEqual({
      kind: "stopped-with-result",
      result: safeResult,
    });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("terminates every worker across repeated completed calculations", async () => {
    const workers: ControlledWorker[] = [];
    for (let index = 0; index < 20; index += 1) {
      const { run, worker } = createRun();
      workers.push(worker);
      worker.emit({
        type: "result",
        result: { assignments: [], warnings: [], unfilledCount: 0 },
      });
      await expect(run.result).resolves.toMatchObject({ kind: "completed" });
    }
    expect(
      workers.every((worker) => worker.terminate.mock.calls.length === 1)
    ).toBe(true);
  });

  it("rejects with the original reason when posting schedule data fails", async () => {
    const terminate = vi.fn();
    class PostingFailureWorker extends ControlledWorker {
      override terminate = terminate;
      override postMessage = vi.fn(() => {
        throw new DOMException("无法复制排班数据", "DataCloneError");
      });
    }
    vi.stubGlobal("Worker", PostingFailureWorker);

    const run = runScheduleInBackground(
      createDefaultState(),
      "2026-08-01",
      () => undefined,
      () => undefined
    );

    await expect(run.result).rejects.toThrow(
      "Worker 数据发送失败：DataCloneError: 无法复制排班数据"
    );
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("rejects with a fallback reason when the browser omits worker error details", async () => {
    const { run, worker } = createRun();
    queueMicrotask(() => worker.onerror?.({ message: "" } as ErrorEvent));

    await expect(run.result).rejects.toThrow(
      "Worker 运行失败：排班后台线程运行失败"
    );
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("rejects a worker-reported error, clears its safe result, and allows a later run", async () => {
    const { run, worker } = createRun();
    const safeResult = { assignments: [], warnings: [], unfilledCount: 0 };
    worker.emit({ type: "safe-result", result: safeResult });
    expect(run.hasLatestSafeResult()).toBe(true);

    worker.emit({ type: "error", message: "worker failed" });

    await expect(run.result).rejects.toThrow("Worker 运行失败：worker failed");
    expect(run.hasLatestSafeResult()).toBe(false);
    expect(run.stopWithLatestResult()).toBe(false);
    expect(worker.terminate).toHaveBeenCalledOnce();

    const { run: nextRun, worker: nextWorker } = createRun();
    nextWorker.emit({
      type: "result",
      result: { assignments: [], warnings: [], unfilledCount: 0 },
    });
    await expect(nextRun.result).resolves.toMatchObject({ kind: "completed" });
  });

  it("rejects with the original onerror reason", async () => {
    const { run, worker } = createRun();

    worker.onerror?.({
      error: new Error("worker crashed from wasm"),
      message: "Script error.",
    } as ErrorEvent);

    await expect(run.result).rejects.toThrow(
      "Worker 运行失败：Error: worker crashed from wasm"
    );
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("rejects with the original reason when worker construction fails", async () => {
    class ConstructionFailureWorker {
      constructor() {
        throw new DOMException("Worker 脚本被安全策略拦截", "SecurityError");
      }
    }
    vi.stubGlobal("Worker", ConstructionFailureWorker);
    const run = runScheduleInBackground(
      createDefaultState(),
      "2026-08-01",
      () => undefined,
      () => undefined
    );

    await expect(run.result).rejects.toThrow(
      "Worker 创建失败：SecurityError: Worker 脚本被安全策略拦截"
    );
  });

  it("keeps the main-thread fallback when Worker is unavailable", async () => {
    vi.stubGlobal("Worker", undefined);
    const run = runScheduleInBackground(
      createDefaultState(),
      "2026-08-01",
      () => undefined,
      () => undefined
    );

    const outcome = await run.result;
    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") throw new Error("expected completed run");
    expect(outcome.result.assignments.length).toBeGreaterThan(0);
  }, 60_000);
});
