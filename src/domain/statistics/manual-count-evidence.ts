import type {
  Assignment,
  HistoryRecord,
  ManualCountEvidence,
} from "../../model";
import type { SchedulingFacts } from "../shared/scheduling-facts";
import { isCountedWorkloadAssignment } from "../shared/workload-accounting";

export function captureCountBaseline(
  assignment: Assignment,
  previous: Pick<Assignment, "status" | "staffId" | "staffName"> = assignment
): void {
  assignment.countBaseline ??= {
    staffId: previous.status === "assigned" ? previous.staffId : null,
    staffName: previous.status === "assigned" ? previous.staffName : "",
  };
}

export function baselineStaffId(
  record: ManualCountEvidence & { staffId: string | null }
): string | null {
  return record.countBaseline ? record.countBaseline.staffId : record.staffId;
}

export function hasQualificationOverride(record: ManualCountEvidence): boolean {
  return (
    record.manualOverrideWarnings?.some(
      (w) => w.code === "position-qualification"
    ) ?? false
  );
}

export function isClearedCountRecord(
  record: Pick<HistoryRecord, "staffId" | "staffName" | "countBaseline">
): boolean {
  return (
    !record.staffId &&
    !record.staffName &&
    Boolean(record.countBaseline?.staffId)
  );
}

/** Current draft replaces its archived date; it must never count twice. */
export function monthlyCountRecords(
  state: SchedulingFacts,
  date: string
): HistoryRecord[] {
  const activeDate =
    state.activeScheduleDate === date && state.assignments.length ? date : null;
  return [
    ...state.history.filter(
      (r) => r.date.startsWith(date.slice(0, 7)) && r.date !== activeDate
    ),
    ...(activeDate
      ? state.assignments
          .filter(
            (a) =>
              isCountedWorkloadAssignment(state, a) &&
              ((a.status === "assigned" && a.staffId) ||
                a.countBaseline?.staffId)
          )
          .map((a) => ({
            ...a,
            date: activeDate,
            staffId: a.status === "assigned" ? (a.staffId ?? "") : "",
            staffName: a.status === "assigned" ? a.staffName : "",
          }))
      : []),
  ];
}
