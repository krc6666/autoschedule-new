import type { ScheduleProgressStage } from "../domain/kernel/schedule-progress";
import {
  runScheduleInBackground,
  SCHEDULE_RUN_TIMEOUT_MS,
  type ActiveScheduleRun,
  type ScheduleProgressListener,
  type ScheduleRunOutcome,
} from "../infrastructure/schedule-runner";
import type { AppState } from "../model";
import type { ScheduleRunPreferences } from "../domain/shared/schedule-run-preferences";

export function scheduleRunStopMessage(
  outcome: ScheduleRunOutcome,
  manualMessage: string
): string {
  if (outcome.kind === "completed" || outcome.stopReason !== "time-limit")
    return manualMessage;
  const minutes = SCHEDULE_RUN_TIMEOUT_MS / 60_000;
  return `本次计算已达到${minutes}分钟。${manualMessage}`;
}

export type ScheduleRunFinishOutcome =
  "completed" | "failed" | "stopped-without-result" | "stopped-with-result";

export interface ScheduleRunControllerDependencies {
  run: (
    state: AppState,
    date: string,
    onProgress: ScheduleProgressListener,
    onSafeResultAvailable: () => void,
    preferences: ScheduleRunPreferences
  ) => ActiveScheduleRun;
  yieldToBrowser: () => Promise<void>;
  start: () => void;
  progress: (stage: ScheduleProgressStage, percent: number) => void;
  safeResultAvailable?: () => void;
  finish: (outcome: ScheduleRunFinishOutcome) => void;
}

export interface ScheduleRunner {
  isRunning(): boolean;
  canAdoptCurrentResult(): boolean;
  stopWithoutResult(): boolean;
  stopWithCurrentResult(): boolean;
  calculate(
    state: AppState,
    date: string,
    preferences?: ScheduleRunPreferences
  ): Promise<ScheduleRunOutcome>;
}

export class ScheduleRunController implements ScheduleRunner {
  private running = false;
  private activeRun: ActiveScheduleRun | null = null;

  constructor(
    private readonly dependencies: ScheduleRunControllerDependencies
  ) {}

  isRunning(): boolean {
    return this.running;
  }

  canAdoptCurrentResult(): boolean {
    return this.activeRun?.hasLatestSafeResult() ?? false;
  }

  stopWithoutResult(): boolean {
    return this.activeRun?.stopWithoutResult() ?? false;
  }

  stopWithCurrentResult(): boolean {
    return this.activeRun?.stopWithLatestResult() ?? false;
  }

  async calculate(
    state: AppState,
    date: string,
    preferences: ScheduleRunPreferences = { halfRestStaffIds: [] }
  ): Promise<ScheduleRunOutcome> {
    if (this.running) throw new Error("排班正在运行，请等待当前任务完成");
    this.running = true;
    this.dependencies.start();
    await this.dependencies.yieldToBrowser();
    try {
      this.activeRun = this.dependencies.run(
        state,
        date,
        this.dependencies.progress,
        () => this.dependencies.safeResultAvailable?.(),
        preferences
      );
      const outcome = await this.activeRun.result;
      this.dependencies.finish(outcome.kind);
      return outcome;
    } catch (error) {
      this.dependencies.finish("failed");
      throw error;
    } finally {
      this.activeRun = null;
      this.running = false;
    }
  }
}

export interface ScheduleRunnerCallbacks {
  start(): void;
  progress(stage: ScheduleProgressStage, percent: number): void;
  safeResultAvailable(): void;
  finish(outcome: ScheduleRunFinishOutcome): void;
}

export function createBrowserScheduleRunController(
  callbacks: ScheduleRunnerCallbacks
): ScheduleRunController {
  return new ScheduleRunController({
    run: runScheduleInBackground,
    yieldToBrowser: () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    ...callbacks,
  });
}
