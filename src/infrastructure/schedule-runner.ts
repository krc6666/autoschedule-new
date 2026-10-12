import type { AppState, ScheduleResult } from "../model";
import { ScheduleGuardError } from "../domain/kernel/schedule-guard";
import { createScheduleGenerationFacts } from "../domain/shared/scheduling-facts";
import {
  generateSchedule,
  type ScheduleProgressStage,
} from "../domain/kernel/scheduling-kernel";
import type {
  ScheduleWorkerRequest,
  ScheduleWorkerResponse,
} from "./schedule-worker-protocol";
import {
  normalizeScheduleRunPreferences,
  type ScheduleRunPreferences,
} from "../domain/shared/schedule-run-preferences";

export type ScheduleProgressListener = (
  stage: ScheduleProgressStage,
  percent: number
) => void;

export type ScheduleRunOutcome =
  | { kind: "completed"; result: ScheduleResult }
  | { kind: "stopped-without-result" }
  | { kind: "stopped-with-result"; result: ScheduleResult };

export interface ActiveScheduleRun {
  result: Promise<ScheduleRunOutcome>;
  stopWithoutResult(): boolean;
  stopWithLatestResult(): boolean;
  hasLatestSafeResult(): boolean;
}

function workerFailureError(
  context: string,
  reason: unknown,
  fallbackMessage: string
): Error {
  const detail =
    reason instanceof Error
      ? `${reason.name || "Error"}: ${reason.message || fallbackMessage}`
      : String(reason ?? "").trim() || fallbackMessage;
  return new Error(`${context}：${detail}`, {
    ...(reason instanceof Error ? { cause: reason } : {}),
  });
}

export function runScheduleInBackground(
  state: AppState,
  date: string,
  onProgress: ScheduleProgressListener,
  onSafeResultAvailable: () => void = () => undefined,
  preferences?: ScheduleRunPreferences
): ActiveScheduleRun {
  const schedulingFacts = createScheduleGenerationFacts(state);
  const runPreferences = normalizeScheduleRunPreferences(preferences);
  let stopped = false;
  let settled = false;
  let latestSafeResult: ScheduleResult | undefined;
  let worker: Worker | undefined;
  let resolveResult!: (outcome: ScheduleRunOutcome) => void;
  let rejectResult!: (error: unknown) => void;
  const result = new Promise<ScheduleRunOutcome>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const terminateWorker = (): void => {
    if (!worker) return;
    worker.terminate();
    worker = undefined;
  };

  const runOnMainThread = async (): Promise<void> => {
    try {
      const { defaultHighsSolver, HighsSolver } =
        await import("./solver/highs-solver");
      const completed = await generateSchedule(schedulingFacts, date, {
        solver: defaultHighsSolver,
        checkpointSolver: new HighsSolver(),
        preferences: runPreferences,
        onProgress,
        onSafeResult: (safeResult) => {
          latestSafeResult = safeResult;
          onSafeResultAvailable();
        },
      });
      if (settled) return;
      settled = true;
      resolveResult(
        stopped
          ? latestSafeResult
            ? { kind: "stopped-with-result", result: latestSafeResult }
            : { kind: "stopped-without-result" }
          : { kind: "completed", result: completed }
      );
    } catch (error) {
      if (settled) return;
      settled = true;
      rejectResult(error);
    }
  };

  const rejectWorkerFailure = (
    context: string,
    reason: unknown,
    fallbackMessage = "排班后台线程运行失败"
  ): void => {
    if (settled) return;
    settled = true;
    latestSafeResult = undefined;
    terminateWorker();
    rejectResult(workerFailureError(context, reason, fallbackMessage));
  };

  const activeRun: ActiveScheduleRun = {
    result,
    stopWithoutResult: () => {
      if (settled) return false;
      stopped = true;
      latestSafeResult = undefined;
      settled = true;
      terminateWorker();
      resolveResult({ kind: "stopped-without-result" });
      return true;
    },
    stopWithLatestResult: () => {
      if (settled || !latestSafeResult) return false;
      stopped = true;
      settled = true;
      terminateWorker();
      resolveResult({ kind: "stopped-with-result", result: latestSafeResult });
      return true;
    },
    hasLatestSafeResult: () => Boolean(latestSafeResult),
  };

  if (typeof Worker === "undefined") {
    void runOnMainThread();
    return activeRun;
  }

  try {
    worker = new Worker(new URL("../schedule.worker.ts", import.meta.url), {
      type: "module",
    });
  } catch (error) {
    rejectWorkerFailure("Worker 创建失败", error);
    return activeRun;
  }

  worker.onmessage = (event: MessageEvent<ScheduleWorkerResponse>): void => {
    if (!worker || settled) return;
    const message = event.data;
    if (message.type === "progress") {
      onProgress(message.stage, message.percent);
      return;
    }
    if (message.type === "safe-result") {
      latestSafeResult = message.result;
      onSafeResultAvailable();
      return;
    }
    if (message.type === "result") {
      terminateWorker();
      settled = true;
      resolveResult({ kind: "completed", result: message.result });
      return;
    }
    if (message.violations?.length) {
      terminateWorker();
      settled = true;
      rejectResult(new ScheduleGuardError(message.violations));
      return;
    }
    rejectWorkerFailure("Worker 运行失败", message.message);
  };
  worker.onerror = (event): void => {
    rejectWorkerFailure(
      "Worker 运行失败",
      event.error ?? event.message,
      "排班后台线程运行失败"
    );
  };

  try {
    worker.postMessage({
      state: schedulingFacts,
      date,
      preferences: runPreferences,
    } satisfies ScheduleWorkerRequest);
  } catch (error) {
    rejectWorkerFailure("Worker 数据发送失败", error);
  }
  return activeRun;
}
