import type {
  AppState,
  DutyRosterOverride,
  ScheduleGroupId,
  StaffStatusSelection,
} from "../model";
import type { ApplicationDialog } from "./application-view-state";
import { getDutyRosterForDate } from "../domain/duty-roster/roster";
import { setStaffStatus, staffStatusValue } from "../domain/staff-status";

export type PreflightDialog = Extract<
  ApplicationDialog,
  { selectedIds: string[] }
>;

/** Uncommitted choices only; live catalogues and schedule results stay in the model. */
export interface PreflightDraft {
  groupId: ScheduleGroupId;
  date: string;
  adminSupportEnabled: boolean;
  flights: { flightNo: string; selected: boolean; bookedPassengers: number }[];
  staffStatuses: Record<string, StaffStatusSelection>;
  dutyRoster?: DutyRosterOverride;
}

export function isPreflightDialog(
  dialog: ApplicationDialog | null | undefined
): dialog is PreflightDialog {
  return (
    dialog?.kind === "schedule-preflight" ||
    dialog?.kind === "reschedule-flight-picker" ||
    dialog?.kind === "next-workday-flight-picker"
  );
}

export function capturePreflightDraft(dialog: PreflightDialog): PreflightDraft {
  const selected = new Set(dialog.selectedIds);
  return {
    groupId: dialog.groupId,
    date: dialog.date,
    adminSupportEnabled: dialog.adminSupportEnabled,
    flights: dialog.candidates.map((candidate) => ({
      flightNo: candidate.flightNo,
      selected: selected.has(candidate.id),
      bookedPassengers: candidate.bookedPassengers,
    })),
    staffStatuses: { ...dialog.staffStatuses },
    ...(dialog.dutyRoster
      ? {
          dutyRoster: {
            date: dialog.date,
            cxPreflightStaffId: dialog.dutyRoster.cxPreflightStaffId,
            dutyStaffId: dialog.dutyRoster.dutyStaffId,
            standbyStaffIds: [...dialog.dutyRoster.standbyStaffIds],
          },
        }
      : {}),
  };
}

export function preflightDutyRoster(
  model: AppState,
  date: string,
  statuses: Record<string, StaffStatusSelection>,
  remembered?: DutyRosterOverride
) {
  const temporary = structuredClone(model);
  for (const person of temporary.staff) {
    const status = statuses[person.id];
    if (status) setStaffStatus(person, status, temporary.leaveTypes);
  }
  if (remembered)
    temporary.dutyRosterOverrides = [
      ...temporary.dutyRosterOverrides.filter((row) => row.date !== date),
      { ...remembered, date, standbyStaffIds: [...remembered.standbyStaffIds] },
    ];
  return getDutyRosterForDate(temporary, date);
}

export function restorePreflightDraft(
  dialog: PreflightDialog,
  draft: PreflightDraft,
  model: AppState
): PreflightDialog {
  const flights = new Map(
    draft.flights.map((flight) => [flight.flightNo, flight])
  );
  const selected = new Set(dialog.selectedIds);
  const candidates = dialog.candidates.map((candidate) => {
    const remembered = flights.get(candidate.flightNo);
    if (!remembered) return candidate;
    if (remembered.selected) selected.add(candidate.id);
    else selected.delete(candidate.id);
    return { ...candidate, bookedPassengers: remembered.bookedPassengers };
  });
  const staffStatuses = Object.fromEntries(
    model.staff.map((original) => {
      const person = { ...original };
      const status = draft.staffStatuses[person.id];
      if (status) setStaffStatus(person, status, model.leaveTypes);
      return [person.id, staffStatusValue(person)];
    })
  );
  return {
    ...dialog,
    candidates,
    selectedIds: candidates
      .filter((candidate) => selected.has(candidate.id))
      .map((candidate) => candidate.id),
    adminSupportEnabled: draft.adminSupportEnabled,
    staffStatuses,
    dutyRoster: preflightDutyRoster(
      model,
      dialog.date,
      staffStatuses,
      draft.dutyRoster
    ),
  };
}
