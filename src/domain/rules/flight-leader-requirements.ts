import type { ScheduleSettings } from "../../model";
import { normalizeWeeklyFlightNo } from "../flights/weekly-flight-plan";

export function normalizeFlightLeaderRequirements(
  value: unknown
): ScheduleSettings["flightLeaderRequirements"] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((row) => {
    if (
      !row ||
      typeof row !== "object" ||
      typeof row.flightNo !== "string" ||
      !Number.isInteger(row.minimum) ||
      row.minimum < 1 ||
      row.minimum > 100
    )
      return [];
    const flightNo = normalizeWeeklyFlightNo(row.flightNo);
    if (!flightNo || seen.has(flightNo)) return [];
    seen.add(flightNo);
    return [{ flightNo, minimum: row.minimum }];
  });
}
