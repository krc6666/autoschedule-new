import type {
  Assignment,
  HistoryRecord,
  ScheduleSettings,
  Staff,
} from "../../model";
import { isClearedCountRecord } from "./manual-count-evidence";

function isoDateToTime(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const time = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3])
  );
  return Number.isFinite(time) ? time : null;
}

export function recentHistory(
  records: HistoryRecord[],
  date: string,
  windowDays: number
): HistoryRecord[] {
  const target = isoDateToTime(date);
  if (target === null) return [];
  const minimum = target - windowDays * 86_400_000;
  return records.filter((record) => {
    const timestamp = isoDateToTime(record.date);
    return timestamp !== null && timestamp < target && timestamp >= minimum;
  });
}

export function recentArchivedWorkdays(
  records: HistoryRecord[],
  date: string,
  workdayCount: number
): HistoryRecord[] {
  const target = isoDateToTime(date);
  if (target === null) return [];
  const actualRecords = records.filter(
    (record) => !isClearedCountRecord(record)
  );
  const dates = [
    ...new Set(
      actualRecords
        .map((record) => ({
          date: record.date,
          timestamp: isoDateToTime(record.date),
        }))
        .filter(
          (item): item is { date: string; timestamp: number } =>
            item.timestamp !== null && item.timestamp < target
        )
        .sort((left, right) => right.timestamp - left.timestamp)
        .map((item) => item.date)
    ),
  ].slice(0, Math.max(0, Math.round(workdayCount)));
  const selected = new Set(dates);
  return actualRecords.filter((record) => selected.has(record.date));
}

export function consecutiveWorkDays(
  records: HistoryRecord[],
  staffId: string,
  date: string
): number {
  const dates = new Set(
    records
      .filter((record) => record.staffId === staffId)
      .map((record) => record.date)
  );
  const cursor = isoDateToTime(date);
  if (cursor === null) return 0;
  let count = 0;
  for (
    let day = cursor - 86_400_000;
    dates.has(new Date(day).toISOString().slice(0, 10));
    day -= 86_400_000
  ) {
    count += 1;
  }
  return count;
}

export function historyFatigue(
  records: HistoryRecord[],
  staffId: string,
  date: string,
  settings: ScheduleSettings
): number {
  const recent = recentHistory(records, date, settings.historyWindowDays);
  const points = recent
    .filter((record) => record.staffId === staffId)
    .reduce(
      (sum, record) => sum + (record.fatiguePoints || record.workHours),
      0
    );
  const consecutive = consecutiveWorkDays(
    recent.filter((record) => record.historyCoverage !== "late-priority-only"),
    staffId,
    date
  );
  return points + Math.max(0, consecutive - 1) * settings.consecutiveDayPenalty;
}

export interface StaffLoad {
  staff: Staff;
  workHours: number;
  todayFatigue: number;
  historyFatigue: number;
  totalFatigue: number;
}

export function buildStaffLoads(
  staff: Staff[],
  assignments: Assignment[],
  history: HistoryRecord[],
  date: string,
  settings: ScheduleSettings,
  extraTodayFatigue: ReadonlyMap<string, number> = new Map()
): StaffLoad[] {
  return staff.map((person) => {
    const ownAssignments = assignments.filter(
      (assignment) => assignment.staffId === person.id
    );
    const workHours = ownAssignments.reduce(
      (sum, assignment) => sum + assignment.workHours,
      0
    );
    const todayFatigue =
      ownAssignments.reduce(
        (sum, assignment) => sum + assignment.fatiguePoints,
        0
      ) + (extraTodayFatigue.get(person.id) ?? 0);
    const previousFatigue = historyFatigue(history, person.id, date, settings);
    return {
      staff: person,
      workHours,
      todayFatigue,
      historyFatigue: previousFatigue,
      totalFatigue: todayFatigue + previousFatigue,
    };
  });
}
