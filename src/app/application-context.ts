import type { AppState } from "../model";
import type { AutoscheduleStore } from "./store/autoschedule-store";
import type { ScheduleRunner } from "./schedule-run-controller";
import type { ApplicationViewState } from "./application-view-state";
import type { ApplicationPreferences } from "./application-preferences";
import type { PreflightDialog } from "./preflight-drafts";

export interface ApplicationContext {
  readonly store: AutoscheduleStore;
  readonly scheduleRunner: ScheduleRunner;
  readonly preferences: ApplicationPreferences;
  view(): ApplicationViewState;
  model(): AppState;
  updateView(patch: Partial<ApplicationViewState>): void;
  openPreflightDialog(dialog: PreflightDialog): void;
  commit(message?: string): void;
  toast(message: string, tone?: "success" | "danger" | "warning"): void;
  confirm(message: string): boolean;
}

export interface UiCommandController {
  handle(
    command: import("../ui/events/ui-command").UiCommand
  ): boolean | Promise<boolean>;
}
