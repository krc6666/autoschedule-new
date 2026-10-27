import {
  clearHistory,
  deleteHistory,
  replaceHistoryForDate,
} from "../history-actions";
import {
  applyDutyRosterImport,
  applyWorkbookImport,
  type WorkbookImportOptions,
} from "../workbook-actions";
import {
  clearDutyRosterOverride,
  clearMonthlyDutyRosterOverrides,
  updateDutyRosterSlot,
  type DutyRosterSlot,
} from "../../domain/duty-roster/roster";
import type { DutyRosterImportPreview } from "../../infrastructure/duty-roster-excel";
import type { WorkbookImport } from "../../infrastructure/excel";
import type { HistoryRecord } from "../../model";
import type { WorkbookImportMode } from "../workbook-import-controller";
import type { StateCommand } from "./store-command";
import {
  applyLatePriorityCountsImport,
  resetMonthlyLatePriorityFrequencyCounts,
  updateLatePriorityFrequencyAdjustment,
  updateOrdinaryPriorityFrequencyAdjustment,
} from "../statistics-actions";
import type { LatePriorityCountsImportPreview } from "../../infrastructure/late-priority-counts-excel";

export function createRecordsCommands(command: StateCommand) {
  return {
    clearHistory: () => command(clearHistory),
    deleteHistory: (id: string) => command((state) => deleteHistory(state, id)),
    replaceHistory: (date: string, records: HistoryRecord[]) =>
      command((state) => replaceHistoryForDate(state, date, records)),
    clearDutyRosterDay: (date: string) =>
      command((state) => clearDutyRosterOverride(state, date)),
    clearDutyRosterMonth: (date: string) =>
      command((state) => clearMonthlyDutyRosterOverrides(state, date)),
    updateDutyRoster: (date: string, slot: DutyRosterSlot, staffId: string) =>
      command((state) => updateDutyRosterSlot(state, date, slot, staffId)),
    adjustLatePriorityFrequency: (
      month: string,
      staffId: string,
      flightNo: string,
      kind: import("../../domain/reviews/late-priority-policy").LatePriorityFrequencyKind,
      delta: number
    ) =>
      command((state) =>
        updateLatePriorityFrequencyAdjustment(
          state,
          month,
          staffId,
          flightNo,
          kind,
          delta
        )
      ),
    resetMonthlyLatePriorityFrequencyCounts: (date: string) =>
      command((state) => resetMonthlyLatePriorityFrequencyCounts(state, date)),
    adjustOrdinaryPriorityFrequency: (
      month: string,
      staffId: string,
      airlineCode: string,
      position: string,
      delta: number
    ) =>
      command((state) =>
        updateOrdinaryPriorityFrequencyAdjustment(
          state,
          month,
          staffId,
          airlineCode,
          position,
          delta
        )
      ),
    applyLatePriorityCountsImport: (preview: LatePriorityCountsImportPreview) =>
      command((state) => applyLatePriorityCountsImport(state, preview)),
    applyDutyRosterImport: (preview: DutyRosterImportPreview) =>
      command((state) => applyDutyRosterImport(state, preview)),
    applyWorkbookImport: (
      imported: WorkbookImport,
      mode: Exclude<WorkbookImportMode, "duty-roster" | "late-priority-counts">,
      options?: WorkbookImportOptions
    ) =>
      command((state) => applyWorkbookImport(state, imported, mode, options)),
  };
}

export type RecordsCommands = ReturnType<typeof createRecordsCommands>;
