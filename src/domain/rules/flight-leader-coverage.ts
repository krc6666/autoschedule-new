import type {
  Assignment,
  FlightLeaderCoverageHistory,
  FlightLeaderCoverageStatus,
} from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import {
  flightRuleMatches,
  type FlightIdentityFacts,
} from "../flights/flight-identities";

type CoverageFacts = Pick<
  ScheduleGenerationFacts,
  "staff" | "flights" | "assignments" | "settings"
> &
  FlightIdentityFacts;

export function flightLeaderMinimum(
  state: Pick<CoverageFacts, "settings"> & FlightIdentityFacts,
  flightNo: string
): number {
  return (
    state.settings.flightLeaderRequirements?.find((row) =>
      flightRuleMatches(state, row.flightNo, flightNo)
    )?.minimum ?? state.settings.minimumFlightLeaders
  );
}

/** One actual flight, one person, one count, regardless of duplicated/reused jobs. */
export function flightLeaderCoverage(
  state: CoverageFacts,
  assignments: readonly Assignment[] = state.assignments
): FlightLeaderCoverageStatus[] {
  if (!state.settings.flightLeaderCoverageEnabled) return [];
  const leaders = new Set(
    state.staff.filter((p) => p.flightLeaderQualified === true).map((p) => p.id)
  );
  return state.flights.map((flight) => ({
    flightId: flight.id,
    flightNo: flight.flightNo,
    required: flightLeaderMinimum(state, flight.flightNo),
    actual: new Set(
      assignments
        .filter(
          (a) =>
            a.flightId === flight.id &&
            a.status === "assigned" &&
            a.staffId &&
            leaders.has(a.staffId)
        )
        .map((a) => a.staffId)
    ).size,
  }));
}

export function flightLeaderWarnings(
  rows: readonly FlightLeaderCoverageStatus[]
): string[] {
  return rows
    .filter((row) => row.actual < row.required)
    .map(
      (row) =>
        `${row.flightNo}${row.actual === 0 ? "无负责人" : "负责人不足"}：需要${row.required}名，实际${row.actual}名，还差${row.required - row.actual}名。仅提示，不影响保存和归档。`
    );
}

/** Validate persisted evidence without substituting present-day flight or staff facts. */
export function normalizeFlightLeaderCoverageHistory(
  value: unknown
): FlightLeaderCoverageHistory[] {
  if (!Array.isArray(value)) return [];
  const dates = new Set<string>();
  return value.flatMap((row) => {
    if (
      !row ||
      typeof row !== "object" ||
      typeof row.date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
      !Number.isFinite(Date.parse(`${row.date}T00:00:00Z`)) ||
      new Date(`${row.date}T00:00:00Z`).toISOString().slice(0, 10) !==
        row.date ||
      dates.has(row.date) ||
      !Array.isArray(row.flights)
    )
      return [];
    const ids = new Set<string>();
    for (const f of row.flights) {
      if (
        !f ||
        typeof f !== "object" ||
        typeof f.flightId !== "string" ||
        !f.flightId ||
        ids.has(f.flightId) ||
        typeof f.flightNo !== "string" ||
        !f.flightNo ||
        !Number.isSafeInteger(f.required) ||
        f.required < 1 ||
        !Number.isSafeInteger(f.actual) ||
        f.actual < 0
      )
        return [];
      ids.add(f.flightId);
    }
    dates.add(row.date);
    return [
      {
        date: row.date,
        flights: row.flights.map((f: FlightLeaderCoverageStatus) => ({
          flightId: f.flightId,
          flightNo: f.flightNo,
          required: f.required,
          actual: f.actual,
        })),
      },
    ];
  });
}
