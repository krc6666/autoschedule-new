import type {
  ScheduleProgressStage,
  ScheduleProgressStep,
} from "../domain/kernel/schedule-progress";
import type { ScheduleProgressOutcome } from "../ui/projections/schedule-progress-tasks";
import type { FlightPlanReconciliation } from "../domain/flights/flight-plan-reconciliation";
import type { DutyRosterImportPreview } from "../infrastructure/duty-roster-excel";
import type { LegacyScheduleImportPreview } from "../infrastructure/legacy-schedule-excel";
import type { OnlineFlight } from "../infrastructure/flight-query";
import type {
  AppSection,
  AppState,
  IsoWeekday,
  ScheduleGroupId,
  StaffStatus,
} from "../model";
import type { ManualSwapAnalysis } from "../domain/reviews/manual-swap-analysis";
import type { FlightSelectionCandidate } from "../domain/flights/next-workday-flight-plan";
import type { LatePriorityCountsImportPreview } from "../infrastructure/late-priority-counts-excel";
import type { HalfRestMode } from "../domain/shared/schedule-run-preferences";
import type { TeamLeaderGapFillPreview } from "../domain/coverage/team-leader-gap-fill";
import type { HistoryImportSummary } from "./workbook-actions";

export type ApplicationDialog =
  | { kind: "templates" }
  | {
      kind: "schedule-preflight";
      date: string;
      groupId: ScheduleGroupId;
      candidates: FlightSelectionCandidate[];
      selectedIds: string[];
      staffStatuses: Record<string, StaffStatus>;
    }
  | {
      kind: "reschedule-flight-picker";
      date: string;
      candidates: FlightSelectionCandidate[];
      selectedIds: string[];
    }
  | {
      kind: "next-workday-flight-picker";
      date: string;
      sourceDate: string;
      groupId: ScheduleGroupId;
      weekday: IsoWeekday;
      candidates: FlightSelectionCandidate[];
      selectedIds: string[];
      staffStatuses: Record<string, StaffStatus>;
    }
  | { kind: "qualification"; positionRuleId: string }
  | {
      kind: "flight-query";
      date: string;
      loading: boolean;
      reconciliation: FlightPlanReconciliation<OnlineFlight> | null;
      fetchedAt: string;
      error: string;
    }
  | { kind: "duty-roster-import"; preview: DutyRosterImportPreview }
  | {
      kind: "late-priority-counts-import";
      preview: LatePriorityCountsImportPreview;
    }
  | {
      kind: "legacy-schedule-import";
      date: string;
      preview: LegacyScheduleImportPreview;
    }
  | {
      kind: "workbook-import";
      mode: "all" | "config" | "history";
      importedState: AppState;
      recognized: string;
      warnings: string[];
      changedConfig: boolean;
      historySummary?: HistoryImportSummary;
    }
  | {
      kind: "swap-analysis";
      sourceAssignmentId: string;
      targetAssignmentId: string | null;
      analysis: ManualSwapAnalysis | null;
    }
  | {
      kind: "team-leader-gap-fill";
      selectedTeamLeaderId: string;
      selectedVacancyAssignmentIds: string[];
      planning: boolean;
      preview: TeamLeaderGapFillPreview | null;
      reasons: string[];
    };

export interface ApplicationToast {
  id: number;
  message: string;
  tone: "success" | "danger" | "warning";
}

export interface ScheduleProgressView {
  outcome: ScheduleProgressOutcome;
  visible: boolean;
  stage: ScheduleProgressStage;
  percent: number;
  steps: readonly ScheduleProgressStep[];
  canAdoptCurrentResult: boolean;
}

export interface ApplicationViewState {
  section: AppSection;
  date: string;
  zoom: number;
  loadSortField:
    "workHours" | "todayFatigue" | "historyFatigue" | "totalFatigue";
  loadSortDirection: "asc" | "desc";
  halfRestStaffIds: string[];
  halfRestModes: Record<string, HalfRestMode>;
  historyEditDate?: string | null;
  dialog: ApplicationDialog | null;
  toast: ApplicationToast | null;
  /** True only during the session immediately after restoring a saved schedule. */
  restoredScheduleNotice?: boolean;
  progress: ScheduleProgressView;
}
