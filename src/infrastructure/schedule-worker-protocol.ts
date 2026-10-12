import type { ScheduleResult } from "../model";
import type { ScheduleProgressStage } from "../domain/kernel/scheduling-kernel";
import type { ScheduleGenerationFacts } from "../domain/shared/scheduling-facts";
import type { ScheduleRunPreferences } from "../domain/shared/schedule-run-preferences";
import type { ScheduleGuardViolation } from "../domain/kernel/schedule-guard";

export interface ScheduleWorkerRequest {
  state: ScheduleGenerationFacts;
  date: string;
  preferences: ScheduleRunPreferences;
}

export type ScheduleWorkerResponse =
  | { type: "progress"; stage: ScheduleProgressStage; percent: number }
  | { type: "safe-result"; result: ScheduleResult }
  | { type: "result"; result: ScheduleResult }
  | {
      type: "error";
      message: string;
      violations?: readonly ScheduleGuardViolation[];
    };
