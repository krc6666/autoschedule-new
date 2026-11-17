import type { Assignment, HistoryRecord } from "../../model";

interface ScheduleDateFacts {
  activeScheduleDate: string | null;
  assignments: readonly Assignment[];
  history: readonly HistoryRecord[];
  schedulePolicyStale: boolean;
}
export type ScheduleDisplaySource = "current" | "history" | "empty";

export function completeScheduleDates(
  state: Pick<ScheduleDateFacts, "history">
): string[] {
  const days = new Map<string, { hasFlight: boolean; partial: boolean }>();
  for (const record of state.history) {
    const day = days.get(record.date) ?? { hasFlight: false, partial: false };
    day.hasFlight ||= record.flightNo !== "轮值";
    day.partial ||= record.historyCoverage === "late-priority-only";
    days.set(record.date, day);
  }
  return [...days]
    .filter(([, day]) => day.hasFlight && !day.partial)
    .map(([date]) => date);
}

export function latestScheduleDate(state: ScheduleDateFacts): string | null {
  const dates = completeScheduleDates(state);
  if (state.activeScheduleDate && state.assignments.length)
    dates.push(state.activeScheduleDate);
  return dates.sort().at(-1) ?? null;
}

export function scheduleDisplaySource(
  state: ScheduleDateFacts,
  date: string
): ScheduleDisplaySource {
  const current =
    state.activeScheduleDate === date && state.assignments.length > 0;
  if (current && !state.schedulePolicyStale) return "current";
  if (completeScheduleDates(state).includes(date)) return "history";
  return current ? "current" : "empty";
}
