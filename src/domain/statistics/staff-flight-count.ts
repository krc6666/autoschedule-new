import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";

export interface DailyFlightCountParticipants {
  dutyStaffId: string | null;
  halfRestStaffIds?: ReadonlySet<string>;
  candidateStaffIds?: ReadonlySet<string>;
}

export function dailyFlightCountParticipantIds(
  state: Pick<ScheduleGenerationFacts, "staff" | "settings" | "positionRules">,
  options: DailyFlightCountParticipants
): Set<string> {
  const qualified =
    options.candidateStaffIds ??
    new Set(state.positionRules.flatMap((rule) => rule.qualifiedStaffIds));
  return new Set(
    state.staff
      .filter(
        (person) =>
          person.status === "正常" &&
          person.staffType === "常规" &&
          person.id !== options.dutyStaffId &&
          qualified.has(person.id) &&
          !(
            state.settings.dailyFlightCountBalanceExemptHalfRest &&
            options.halfRestStaffIds?.has(person.id)
          ) &&
          !(
            state.settings.dailyFlightCountBalanceExemptTeamLeaders &&
            person.teamLeader
          )
      )
      .map((person) => person.id)
  );
}

export interface StaffFlightEntry {
  staffId: string;
  flightNo: string;
}

export function normalizeStaffFlightNumber(value: string): string {
  return value.trim().replaceAll(/\s+/g, "").toUpperCase();
}

export function groupStaffFlightsByNormalizedNumber<T extends StaffFlightEntry>(
  entries: readonly T[]
): Map<string, Map<string, T[]>> {
  const grouped = new Map<string, Map<string, T[]>>();
  for (const entry of entries) {
    const flightNo = normalizeStaffFlightNumber(entry.flightNo);
    if (!flightNo || flightNo === "轮值") continue;
    const flights = grouped.get(entry.staffId) ?? new Map<string, T[]>();
    const sameFlight = flights.get(flightNo) ?? [];
    sameFlight.push(entry);
    flights.set(flightNo, sameFlight);
    grouped.set(entry.staffId, flights);
  }
  return grouped;
}
