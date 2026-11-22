import type { Assignment, HistoryRecord } from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import { latePriorityFlightInScope } from "../statistics/late-priority-flight-scope";
import { isClearedCountRecord } from "../statistics/manual-count-evidence";
import { isLateEndingWork } from "./cross-day-recovery";
import { airlineCode } from "../rules/airline-rotation";
import { normalizeStaffFlightNumber } from "../statistics/staff-flight-count";

export interface StaffLateAirlineRotation {
  staffId: string;
  previousDate: string | null;
  previousAirlines: string[];
  currentAirlines: string[];
  repeatedAirlines: string[];
  flightNumbers: string[];
}

type LateAirlineWork = Pick<Assignment, "flightNo" | "startTime" | "endTime"> &
  Partial<
    Pick<Assignment, "flightId"> &
      Pick<HistoryRecord, "date" | "flightCutoffTime" | "flightStartTime">
  >;

/** Carrier rotation follows the flight window; an early-released job is still
 * work on that late flight. Old history never borrows today's template times. */
export function isRotationLateAssignment(
  state: ScheduleGenerationFacts,
  assignment: LateAirlineWork,
  date: string
): boolean {
  const flight =
    assignment.date === undefined
      ? state.flights.find(
          (f) =>
            f.id === assignment.flightId ||
            normalizeStaffFlightNumber(f.flightNo) ===
              normalizeStaffFlightNumber(assignment.flightNo)
        )
      : undefined;
  const flightWindow = {
    startTime:
      assignment.flightStartTime ?? flight?.startTime ?? assignment.startTime,
    endTime:
      assignment.flightCutoffTime ?? flight?.endTime ?? assignment.endTime,
  };
  return (
    latePriorityFlightInScope(
      state.settings.latePriorityFlightNumbers,
      assignment.flightNo,
      state,
      date
    ) && isLateEndingWork(flightWindow, state)
  );
}

export function staffLateAirlineRotation(
  state: ScheduleGenerationFacts,
  assignments: readonly Assignment[],
  date: string
): StaffLateAirlineRotation[] {
  if (!state.settings.lateAirlineRotationEnabled) return [];
  const dates = [
    ...new Set(
      state.history
        .filter(
          (r) =>
            r.date < date &&
            r.flightNo !== "轮值" &&
            r.staffId &&
            r.staffName &&
            !isClearedCountRecord(r)
        )
        .map((r) => r.date)
    ),
  ].sort();
  const previousDate = dates.at(-1) ?? null;
  // A partial day cannot certify anyone's complete last duty. Do not skip it and
  // accidentally call an older archive the immediately preceding workday.
  const previous: HistoryRecord[] =
    previousDate &&
    !state.history.some(
      (r) =>
        r.date === previousDate && r.historyCoverage === "late-priority-only"
    )
      ? state.history.filter(
          (r) =>
            r.date === previousDate &&
            r.staffId &&
            r.staffName &&
            r.flightNo !== "轮值"
        )
      : [];
  return state.staff
    .filter((p) => p.staffType === "常规" && p.status === "正常")
    .map((p) => {
      const past = previous.filter(
        (r) => r.staffId === p.id && isRotationLateAssignment(state, r, r.date)
      );
      const now = assignments.filter(
        (a) =>
          a.status === "assigned" &&
          a.staffId === p.id &&
          isRotationLateAssignment(state, a, date)
      );
      const previousAirlines = [
        ...new Set(past.map((r) => airlineCode(r.flightNo))),
      ];
      const currentAirlines = [
        ...new Set(now.map((a) => airlineCode(a.flightNo))),
      ];
      return {
        staffId: p.id,
        previousDate,
        previousAirlines,
        currentAirlines,
        repeatedAirlines: currentAirlines.filter((a) =>
          previousAirlines.includes(a)
        ),
        flightNumbers: [
          ...new Set(now.map((a) => normalizeStaffFlightNumber(a.flightNo))),
        ],
      };
    });
}

/** No repeat may be moved to another worker or added on a different carrier. */
export function preservesLateAirlineRotation(
  before: readonly StaffLateAirlineRotation[],
  after: readonly StaffLateAirlineRotation[]
): boolean {
  return after.every((row) =>
    row.repeatedAirlines.every((code) =>
      before
        .find((old) => old.staffId === row.staffId)
        ?.repeatedAirlines.includes(code)
    )
  );
}
