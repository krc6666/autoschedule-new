import type { LeaveType } from "../../model";
import type { SchedulingFacts } from "../shared/scheduling-facts";
import { staffStatusLabel } from "../staff-status";
import { groupStaffFlightsByNormalizedNumber } from "./staff-flight-count";

export interface DailyStaffFlightRow {
  staffId: string;
  staffName: string;
  leaveLabel?: string;
  flightNumbers: string[];
  flightCount: number;
}

export interface DailyStaffFlightStatistics {
  date: string;
  source: "current" | "history" | "partial-history" | "none";
  rows: DailyStaffFlightRow[];
  allRows: DailyStaffFlightRow[];
  assignedStaffCount: number;
  unassignedStaffCount: number;
  unassignedStaffNames: string[];
  totalFlightCount: number;
  staffCount: number;
}

interface StaffFlightEntry {
  staffId: string;
  flightNo: string;
  startTime: string;
}

type DailyStaffFlightFacts = Pick<
  SchedulingFacts,
  "staff" | "assignments" | "activeScheduleDate" | "history"
> & { leaveTypes: readonly LeaveType[] };

function rowsFromEntries(
  state: Pick<DailyStaffFlightFacts, "staff" | "leaveTypes">,
  entries: readonly StaffFlightEntry[],
  includeEmpty = false
): DailyStaffFlightRow[] {
  const regularStaff = state.staff.filter(
    (person) => person.staffType === "常规"
  );
  const regularStaffIds = new Set(regularStaff.map((person) => person.id));
  const flightsByStaffId =
    groupStaffFlightsByNormalizedNumber<StaffFlightEntry>(
      entries.filter((entry) => regularStaffIds.has(entry.staffId))
    );

  return regularStaff.flatMap((person): DailyStaffFlightRow[] => {
    const flights = flightsByStaffId.get(person.id);
    if (!flights?.size && !includeEmpty) return [];
    const flightNumbers = [
      ...(flights ?? new Map<string, StaffFlightEntry[]>()).entries(),
    ]
      .sort(
        ([leftFlight, leftEntries], [rightFlight, rightEntries]) =>
          leftEntries
            .map((entry) => entry.startTime)
            .sort()[0]!
            .localeCompare(
              rightEntries.map((entry) => entry.startTime).sort()[0]!
            ) || leftFlight.localeCompare(rightFlight)
      )
      .map(([flightNo]) => flightNo);
    return [
      {
        staffId: person.id,
        staffName: person.name,
        ...(person.status !== "正常"
          ? { leaveLabel: staffStatusLabel(person, state.leaveTypes) }
          : {}),
        flightNumbers,
        flightCount: flightNumbers.length,
      },
    ];
  });
}

export function buildDailyStaffFlightStatistics(
  state: DailyStaffFlightFacts,
  date: string
): DailyStaffFlightStatistics {
  const regularStaffCount = state.staff.filter(
    (person) => person.staffType === "常规"
  ).length;
  let source: DailyStaffFlightStatistics["source"] = "none";
  let rows: DailyStaffFlightRow[] = [];
  let allRows: DailyStaffFlightRow[] = [];

  if (state.activeScheduleDate === date && state.assignments.length) {
    source = "current";
    const entries = state.assignments
      .filter(
        (assignment) =>
          assignment.status !== "unfilled" && Boolean(assignment.staffId)
      )
      .map((assignment) => ({
        staffId: assignment.staffId!,
        flightNo: assignment.flightNo,
        startTime: assignment.startTime,
      }));
    allRows = rowsFromEntries(state, entries, true);
    rows = allRows.filter((row) => row.flightCount > 0);
  } else {
    const records = state.history.filter((record) => record.date === date);
    if (
      records.some((record) => record.historyCoverage === "late-priority-only")
    ) {
      source = "partial-history";
    } else if (records.length) {
      source = "history";
      const entries = records.map((record) => ({
        staffId: record.staffId,
        flightNo: record.flightNo,
        startTime: record.startTime,
      }));
      allRows = rowsFromEntries(state, entries, true);
      rows = allRows.filter((row) => row.flightCount > 0);
    }
  }

  return {
    date,
    source,
    rows,
    allRows,
    assignedStaffCount: rows.length,
    unassignedStaffCount:
      source === "current" || source === "history"
        ? regularStaffCount - rows.length
        : 0,
    unassignedStaffNames:
      source === "current" || source === "history"
        ? state.staff
            .filter(
              (person) =>
                person.staffType === "常规" && person.status === "正常"
            )
            .filter((person) => !rows.some((row) => row.staffId === person.id))
            .map((person) => person.name)
        : [],
    totalFlightCount: rows.reduce((sum, row) => sum + row.flightCount, 0),
    staffCount: regularStaffCount,
  };
}
