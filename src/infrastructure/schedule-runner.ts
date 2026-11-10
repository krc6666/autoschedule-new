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
  | { kind: "stopped-without-result"; stopReason?: "time-limit" }
  | {
      kind: "stopped-with-result";
      result: ScheduleResult;
      stopReason?: "time-limit";
    };

export const SCHEDULE_RUN_TIMEOUT_MS = 10 * 60_000;

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
  const deadline = Date.now() + SCHEDULE_RUN_TIMEOUT_MS;
  const schedulingFacts = createScheduleGenerationFacts(state);
  const runPreferences = normalizeScheduleRunPreferences(preferences);
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
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

  const cleanUp = (): void => {
    clearTimeout(timeout);
    terminateWorker();
  };
  const resolveRun = (outcome: ScheduleRunOutcome): void => {
    if (settled) return;
    settled = true;
    cleanUp();
    resolveResult(outcome);
  };
  const rejectRun = (error: unknown): void => {
    if (settled) return;
    settled = true;
    latestSafeResult = undefined;
    cleanUp();
    rejectResult(error);
  };
  const stopAtTimeLimit = (): void => {
    resolveRun(
      latestSafeResult
        ? {
            kind: "stopped-with-result",
            stopReason: "time-limit",
            result: latestSafeResult,
          }
        : { kind: "stopped-without-result", stopReason: "time-limit" }
    );
  };
  // Also check messages: a background tab can delay the timer callback.
  const canReceive = (): boolean => {
    if (settled) return false;
    if (Date.now() < deadline) return true;
    stopAtTimeLimit();
    return false;
  };

  const runOnMainThread = async (): Promise<void> => {
    try {
      const { defaultHighsSolver, HighsSolver } =
        await import("./solver/highs-solver");
      const completed = await generateSchedule(schedulingFacts, date, {
        solver: defaultHighsSolver,
        checkpointSolver: new HighsSolver(),
        preferences: runPreferences,
        onProgress: (stage, percent) => {
          if (canReceive()) onProgress(stage, percent);
        },
        onSafeResult: (safeResult) => {
          if (!canReceive()) return;
          latestSafeResult = safeResult;
          onSafeResultAvailable();
        },
      });
      if (canReceive()) resolveRun({ kind: "completed", result: completed });
    } catch (error) {
      if (canReceive()) rejectRun(error);
    }
  };

  const rejectWorkerFailure = (
    context: string,
    reason: unknown,
    fallbackMessage = "排班后台线程运行失败"
  ): void => {
    rejectRun(workerFailureError(context, reason, fallbackMessage));
  };

  const activeRun: ActiveScheduleRun = {
    result,
    stopWithoutResult: () => {
      if (settled) return false;
      latestSafeResult = undefined;
      resolveRun({ kind: "stopped-without-result" });
      return true;
    },
    stopWithLatestResult: () => {
      if (settled || !latestSafeResult) return false;
      resolveRun({ kind: "stopped-with-result", result: latestSafeResult });
      return true;
    },
    hasLatestSafeResult: () => Boolean(latestSafeResult),
  };

  timeout = setTimeout(stopAtTimeLimit, Math.max(0, deadline - Date.now()));

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
    if (!worker || !canReceive()) return;
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
      resolveRun({ kind: "completed", result: message.result });
      return;
    }
    if (message.violations?.length) {
      rejectRun(new ScheduleGuardError(message.violations));
      return;
    }
    rejectWorkerFailure("Worker 运行失败", message.message);
  };
  worker.onerror = (event): void => {
    if (!canReceive()) return;
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
