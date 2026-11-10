import type { Assignment, HistoryRecord } from "../../model";

type AttendanceIntervals = NonNullable<HistoryRecord["attendanceIntervals"]>;
const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function normalizeAttendanceIntervals(
  value: unknown
): AttendanceIntervals | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;
  const intervals: AttendanceIntervals = [];
  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.startTime !== "string" ||
      typeof item.endTime !== "string" ||
      !clock.test(item.startTime) ||
      !clock.test(item.endTime) ||
      item.startTime === item.endTime
    )
      return undefined;
    if (
      !intervals.some(
        (other) =>
          other.startTime === item.startTime && other.endTime === item.endTime
      )
    )
      intervals.push({ startTime: item.startTime, endTime: item.endTime });
  }
  return intervals;
}

/** Compile once from final assignments; reuse does not become another load record. */
export function additionalAttendanceByAssignment(
  assignments: readonly Assignment[]
): ReadonlyMap<string, AttendanceIntervals> {
  const groups = new Map<string, AttendanceIntervals>();
  const key = (a: Assignment) => `${a.flightId}\u0000${a.staffId}`;
  for (const item of assignments) {
    if (item.status !== "assigned" || !item.staffId) continue;
    const group = groups.get(key(item)) ?? [];
    group.push({ startTime: item.startTime, endTime: item.endTime });
    groups.set(key(item), group);
  }
  const result = new Map<string, AttendanceIntervals>();
  for (const item of assignments) {
    if (item.status !== "assigned" || !item.staffId) continue;
    const additional = normalizeAttendanceIntervals(
      (groups.get(key(item)) ?? []).filter(
        (interval) =>
          interval.startTime !== item.startTime ||
          interval.endTime !== item.endTime
      )
    );
    if (additional) result.set(item.id, additional);
  }
  return result;
}
