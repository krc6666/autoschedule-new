import type { SchedulePolicyInput } from "../../app/policy-actions";
import type { WorkbookImportMode } from "../../app/workbook-import-controller";
import type { DutyRosterSlot } from "../../domain/duty-roster/roster";
import type {
  AppSection,
  IsoWeekday,
  ScheduleGroupId,
  StaffStatus,
} from "../../model";
import type { HalfRestMode } from "../../domain/shared/schedule-run-preferences";

export type EditableValue = string | number | boolean;

export type UiCommand =
  | { type: "navigate"; section: AppSection }
  | { type: "change-date"; date: string }
  | { type: "switch-group"; groupId: ScheduleGroupId }
  | { type: "open-import"; mode: WorkbookImportMode; date?: string }
  | {
      type: "import-file";
      file: File;
      mode?: WorkbookImportMode;
      date?: string;
    }
  | { type: "close-dialog" }
  | { type: "apply-workbook-import" }
  | { type: "apply-legacy-schedule-import" }
  | { type: "update-legacy-schedule-import-date"; date: string }
  | { type: "dismiss-toast" }
  | { type: "export-config" }
  | { type: "export-late-priority-counts"; date: string }
  | { type: "apply-late-priority-counts-import" }
  | { type: "add-ordinary-priority-position" }
  | {
      type: "delete-ordinary-priority-position";
      airlineCode: string;
      position: string;
    }
  | {
      type: "update-ordinary-priority-position";
      index: number;
      field: "airlineCode" | "position";
      value: string;
    }
  | {
      type: "set-team-leader-gap-fill-positions-movable";
      positionRuleIds: string[];
      movable: boolean;
    }
  | {
      type: "adjust-ordinary-priority-frequency";
      month: string;
      staffId: string;
      airlineCode: string;
      position: string;
      delta: number;
    }
  | { type: "export-schedule" }
  | { type: "export-share-html" }
  | { type: "export-share-png" }
  | { type: "generate-schedule" }
  | {
      type: "update-schedule-preflight-selection";
      selectedIds: string[];
    }
  | {
      type: "update-schedule-preflight-passengers";
      candidateId: string;
      bookedPassengers: number;
    }
  | {
      type: "update-schedule-preflight-staff-status";
      staffId: string;
      status: StaffStatus;
    }
  | { type: "confirm-schedule-preflight"; selectedIds: string[] }
  | { type: "open-reschedule-flight-picker" }
  | {
      type: "update-reschedule-flight-picker-selection";
      selectedIds: string[];
    }
  | { type: "open-team-leader-gap-fill" }
  | { type: "update-team-leader-gap-fill-leader"; staffId: string }
  | {
      type: "update-team-leader-gap-fill-vacancies";
      assignmentIds: string[];
    }
  | { type: "preview-team-leader-gap-fill" }
  | { type: "confirm-team-leader-gap-fill" }
  | {
      type: "update-reschedule-flight-picker-passengers";
      candidateId: string;
      bookedPassengers: number;
    }
  | { type: "confirm-reschedule-flight-picker"; selectedIds: string[] }
  | {
      type: "set-half-rest-staff";
      staffIds: string[];
      modes?: Record<string, HalfRestMode>;
    }
  | { type: "stop-schedule-without-result" }
  | { type: "stop-schedule-with-current-result" }
  | { type: "open-swap-analysis"; assignmentId: string }
  | { type: "select-swap-target"; assignmentId: string }
  | { type: "apply-swap-analysis" }
  | {
      type: "update-configuration";
      entity: string;
      id: string;
      field: string;
      value: EditableValue;
    }
  | { type: "add-flight" }
  | { type: "delete-flight"; id: string }
  | { type: "open-flight-templates" }
  | { type: "add-template-flight"; id: string }
  | { type: "add-template" }
  | { type: "delete-template"; id: string }
  | {
      type: "set-weekly-flight-template";
      weekday: IsoWeekday;
      flightNo: string;
      selected: boolean;
    }
  | { type: "add-staff"; administrative: boolean }
  | { type: "delete-staff"; id: string }
  | { type: "add-positions"; flightNo: string; count: number }
  | {
      type: "copy-position-rules";
      sourceFlightNo: string;
      targetFlightNo: string;
    }
  | { type: "delete-position"; id: string }
  | { type: "move-position"; id: string; direction: -1 | 1 }
  | { type: "sort-counters"; flightNo: string }
  | { type: "open-qualification"; id: string }
  | {
      type: "save-qualification";
      id: string;
      manual: boolean;
      staffIds: string[];
    }
  | { type: "open-flight-query" }
  | { type: "run-flight-query"; date: string }
  | { type: "apply-flight-query"; templateIds: string[]; flightIds: string[] }
  | { type: "apply-policy"; input: SchedulePolicyInput }
  | {
      type: "update-policy";
      entity: string;
      id: string;
      field: string;
      value: EditableValue;
    }
  | {
      type: "add-policy-item";
      collection:
        | "same-flight-staff-exclusion"
        | "duty"
        | "recovery-target"
        | "cross-workday-reservation"
        | "cross-flight-priority"
        | "late-position"
        | "supervisor"
        | "supervisor-fill"
        | "transition";
    }
  | {
      type: "delete-policy-item";
      collection:
        | "same-flight-staff-exclusion"
        | "duty"
        | "recovery-target"
        | "cross-workday-reservation"
        | "cross-flight-priority"
        | "late-position"
        | "supervisor"
        | "supervisor-fill"
        | "transition";
      id: string;
    }
  | { type: "move-duty-priority"; id: string; direction: -1 | 1 }
  | { type: "move-cross-workday-reservation"; id: string; direction: -1 | 1 }
  | { type: "move-cross-flight-priority"; id: string; direction: -1 | 1 }
  | { type: "toggle-administrative-mode"; enabled: boolean }
  | {
      type: "assign-staff";
      assignmentId: string;
      staffId: string;
      sourceAssignmentId?: string;
    }
  | {
      type: "update-assignment";
      id: string;
      field: string;
      value: EditableValue;
    }
  | {
      type: "create-temporary-assignment";
      flightId: string;
      position: string;
      staffName: string;
      layoutGroup: "primary" | "bottom";
      layoutIndex: number;
    }
  | { type: "delete-temporary-assignment"; id: string }
  | { type: "clear-schedule" }
  | { type: "archive-schedule" }
  | { type: "archive-next-duty-day" }
  | {
      type: "update-next-workday-flight-picker-selection";
      selectedIds: string[];
    }
  | {
      type: "update-next-workday-flight-picker-passengers";
      candidateId: string;
      bookedPassengers: number;
    }
  | {
      type: "update-next-workday-flight-picker-staff-status";
      staffId: string;
      status: StaffStatus;
    }
  | { type: "confirm-next-workday-flight-picker"; selectedIds: string[] }
  | { type: "set-schedule-zoom"; value: number }
  | {
      type: "set-load-sort";
      field: "workHours" | "todayFatigue" | "historyFatigue" | "totalFatigue";
      direction: "asc" | "desc";
    }
  | { type: "clear-history" }
  | { type: "delete-history"; id: string }
  | { type: "edit-history-date"; date: string }
  | { type: "save-history-edit" }
  | { type: "cancel-history-edit" }
  | {
      type: "update-duty-roster";
      date: string;
      slot: DutyRosterSlot;
      staffId: string;
    }
  | { type: "reset-duty-roster"; date: string }
  | { type: "rebalance-duty-roster-month"; date: string }
  | {
      type: "adjust-late-priority-frequency";
      month: string;
      staffId: string;
      flightNo: string;
      kind: import("../../domain/reviews/late-priority-policy").LatePriorityFrequencyKind;
      delta: number;
    }
  | {
      type: "reset-monthly-late-priority-frequency-counts";
      month: string;
      date: string;
    }
  | { type: "download-duty-roster-template"; date: string }
  | { type: "apply-duty-roster-import" }
  | { type: "reset-all" };

export const UI_COMMAND_EVENT = "autoschedule-command";

export class UiCommandEvent extends CustomEvent<UiCommand> {
  constructor(command: UiCommand) {
    super(UI_COMMAND_EVENT, {
      detail: command,
      bubbles: true,
      composed: true,
    });
  }
}

export function dispatchUiCommand(
  target: EventTarget,
  command: UiCommand
): void {
  target.dispatchEvent(new UiCommandEvent(command));
}

export function inputValue(
  input: HTMLInputElement | HTMLSelectElement
): EditableValue {
  if (input instanceof HTMLInputElement && input.type === "checkbox")
    return input.checked;
  if (input instanceof HTMLInputElement && input.type === "number")
    return Number(input.value);
  return input.value;
}
