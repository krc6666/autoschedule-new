import type { Assignment, Flight, ScheduleSettings } from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import { timeToMinutes } from "../shared/time";

/** Dispatch preference only; attendance statistics keep their overlap contract. */
export function isDutyAfternoonFlight(
  flight: Pick<Flight, "startTime">,
  settings: Pick<
    ScheduleSettings,
    "afternoonRestStartTime" | "afternoonRestEndTime"
  >
): boolean {
  const start = timeToMinutes(flight.startTime);
  const from = timeToMinutes(settings.afternoonRestStartTime);
  const until = timeToMinutes(settings.afternoonRestEndTime);
  if (![start, from, until].every(Number.isFinite) || from === until)
    return false;
  return from < until
    ? start >= from && start < until
    : start >= from || start < until;
}

export function dutyAfternoonFlightIds(
  state: Pick<ScheduleGenerationFacts, "settings" | "flights">,
  assignments: readonly Assignment[],
  dutyStaffId: string
): Set<string> {
  const afternoonIds = new Set(
    state.flights
      .filter((f) => isDutyAfternoonFlight(f, state.settings))
      .map((f) => f.id)
  );
  return new Set(
    assignments
      .filter(
        (a) =>
          a.status === "assigned" &&
          a.staffId === dutyStaffId &&
          afternoonIds.has(a.flightId)
      )
      .map((a) => a.flightId)
  );
}
