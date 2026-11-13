import type { PreflightDraft } from "../app/preflight-drafts";

export const PREFLIGHT_DRAFTS_KEY = "autoschedule.preflightDrafts.v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isStaffId(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0);
}

function isDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}

function isDraft(value: unknown): value is PreflightDraft {
  if (
    !isRecord(value) ||
    (value.groupId !== "A" && value.groupId !== "B") ||
    !isDate(value.date) ||
    typeof value.adminSupportEnabled !== "boolean" ||
    !Array.isArray(value.flights) ||
    !isRecord(value.staffStatuses)
  )
    return false;
  const flights = value.flights;
  if (
    !flights.every(
      (flight) =>
        isRecord(flight) &&
        typeof flight.flightNo === "string" &&
        flight.flightNo.length > 0 &&
        typeof flight.selected === "boolean" &&
        typeof flight.bookedPassengers === "number" &&
        Number.isInteger(flight.bookedPassengers) &&
        flight.bookedPassengers >= 0
    ) ||
    new Set(flights.map((flight) => flight.flightNo)).size !== flights.length
  )
    return false;
  if (
    !Object.values(value.staffStatuses).every(
      (status) =>
        status === "正常" ||
        status === "病假" ||
        status === "休假" ||
        (typeof status === "string" &&
          status.startsWith("leave:") &&
          status.length > 6)
    )
  )
    return false;
  if (value.dutyRoster !== undefined) {
    const roster = value.dutyRoster;
    if (
      !isRecord(roster) ||
      roster.date !== value.date ||
      !isStaffId(roster.cxPreflightStaffId) ||
      !isStaffId(roster.dutyStaffId) ||
      !Array.isArray(roster.standbyStaffIds) ||
      roster.standbyStaffIds.length !== 2 ||
      !roster.standbyStaffIds.every(isStaffId)
    )
      return false;
  }
  return true;
}

export function loadPreflightDrafts(
  storage: Pick<Storage, "getItem">
): PreflightDraft[] {
  try {
    const raw = storage.getItem(PREFLIGHT_DRAFTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const drafts = new Map<string, PreflightDraft>();
    for (const item of parsed) {
      if (isDraft(item)) drafts.set(`${item.groupId}:${item.date}`, item);
    }
    return [...drafts.values()];
  } catch {
    return [];
  }
}
