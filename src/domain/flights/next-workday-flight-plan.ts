import type { Flight, FlightTemplate } from "../../model";
import { normalizeWeeklyFlightNo } from "./weekly-flight-plan";

export interface FlightSelectionCandidate {
  id: string;
  flightNo: string;
  startTime: string;
  endTime: string;
  bookedPassengers: number;
  positions: string[];
  remark: string;
  selectedByDefault: boolean;
  sourceFlightId: string | null;
}

function normalizeBookedPassengers(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/** Unlinked flights may be intentional; only an explicit user choice can rename them. */
export function currentFlightsWithoutTemplates(
  templates: readonly FlightTemplate[],
  currentFlights: readonly Flight[]
): Flight[] {
  const configured = new Set(
    templates.map((template) => normalizeWeeklyFlightNo(template.flightNo))
  );
  return currentFlights.filter(
    (flight) => !configured.has(normalizeWeeklyFlightNo(flight.flightNo))
  );
}

export function buildNextWorkdayFlightCandidates(
  templates: readonly FlightTemplate[],
  defaultFlightNos: readonly string[]
): FlightSelectionCandidate[] {
  const selectedFlightNos = new Set(
    defaultFlightNos.map(normalizeWeeklyFlightNo)
  );
  const candidates = new Map<string, FlightSelectionCandidate>();

  for (const template of templates) {
    const flightNo = normalizeWeeklyFlightNo(template.flightNo);
    if (!flightNo || candidates.has(flightNo)) continue;
    candidates.set(flightNo, {
      id: `template:${template.id}`,
      flightNo,
      startTime: template.startTime,
      endTime: template.endTime,
      bookedPassengers: 0,
      positions: [...template.positions],
      remark: template.remark,
      selectedByDefault: selectedFlightNos.has(flightNo),
      sourceFlightId: null,
    });
  }

  return [...candidates.values()].sort((left, right) =>
    left.flightNo.localeCompare(right.flightNo, "en", { numeric: true })
  );
}

export function buildCurrentScheduleFlightCandidates(
  templates: readonly FlightTemplate[],
  currentFlights: readonly Flight[]
): FlightSelectionCandidate[] {
  const candidates = new Map<string, FlightSelectionCandidate>();
  for (const template of templates) {
    const flightNo = normalizeWeeklyFlightNo(template.flightNo);
    if (!flightNo || candidates.has(flightNo)) continue;
    candidates.set(flightNo, {
      id: `template:${template.id}`,
      flightNo,
      startTime: template.startTime,
      endTime: template.endTime,
      bookedPassengers: 0,
      positions: [...template.positions],
      remark: template.remark,
      selectedByDefault: false,
      sourceFlightId: null,
    });
  }
  for (const flight of currentFlights) {
    const flightNo = normalizeWeeklyFlightNo(flight.flightNo);
    if (!flightNo) continue;
    const templateCandidate = candidates.get(flightNo);
    candidates.set(flightNo, {
      id: templateCandidate?.id ?? `current:${flight.id}`,
      flightNo,
      startTime: flight.startTime,
      endTime: flight.endTime,
      bookedPassengers: normalizeBookedPassengers(flight.bookedPassengers),
      positions: [...flight.positions],
      remark: flight.remark,
      selectedByDefault: true,
      sourceFlightId: flight.id,
    });
  }
  return [...candidates.values()].sort((left, right) =>
    left.flightNo.localeCompare(right.flightNo, "en", { numeric: true })
  );
}

export function updateFlightSelectionBookedPassengers(
  candidates: readonly FlightSelectionCandidate[],
  candidateId: string,
  bookedPassengers: number
): FlightSelectionCandidate[] {
  return candidates.map((candidate) =>
    candidate.id === candidateId
      ? {
          ...candidate,
          bookedPassengers: normalizeBookedPassengers(bookedPassengers),
        }
      : candidate
  );
}

export function materializeNextWorkdayFlights(
  candidates: readonly FlightSelectionCandidate[],
  selectedIds: readonly string[]
): Flight[] {
  const selected = new Set(selectedIds);
  return candidates
    .filter((candidate) => selected.has(candidate.id))
    .map((candidate) => ({
      id: `next-${candidate.flightNo.toLowerCase()}`,
      flightNo: candidate.flightNo,
      startTime: candidate.startTime,
      endTime: candidate.endTime,
      bookedPassengers: normalizeBookedPassengers(candidate.bookedPassengers),
      positions: [...candidate.positions],
      remark: candidate.remark,
    }));
}

export function materializeCurrentScheduleFlights(
  candidates: readonly FlightSelectionCandidate[],
  selectedIds: readonly string[]
): Flight[] {
  const selected = new Set(selectedIds);
  return candidates
    .filter((candidate) => selected.has(candidate.id))
    .map((candidate) => ({
      id:
        candidate.sourceFlightId ??
        `selected-${normalizeWeeklyFlightNo(candidate.flightNo).toLowerCase()}`,
      flightNo: candidate.flightNo,
      startTime: candidate.startTime,
      endTime: candidate.endTime,
      bookedPassengers: normalizeBookedPassengers(candidate.bookedPassengers),
      positions: [...candidate.positions],
      remark: candidate.remark,
    }));
}
