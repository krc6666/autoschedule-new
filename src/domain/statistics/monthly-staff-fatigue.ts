import { dutyFatigueByStaff } from "../duty-roster/roster";
import { countedWorkloadAssignments } from "../shared/workload-accounting";
import type { SchedulingFacts } from "../shared/scheduling-facts";

type StaffFatigueFacts = Pick<
  SchedulingFacts,
  | "staff"
  | "history"
  | "assignments"
  | "activeScheduleDate"
  | "positionRules"
  | "settings"
  | "dutyRosterOverrides"
>;

/** Display-only totals; scheduling continues to use the existing history window. */
export function buildMonthlyStaffFatigue(
  state: StaffFatigueFacts,
  month: string,
  date: string
) {
  const currentDate = state.assignments.length
    ? state.activeScheduleDate
    : null;
  const pointsByDate = new Map<string, Map<string, number>>();
  const add = (day: string, staffId: string, points: number): void => {
    if (!Number.isFinite(points)) return;
    let byStaff = pointsByDate.get(day);
    if (!byStaff) {
      byStaff = new Map();
      pointsByDate.set(day, byStaff);
    }
    byStaff.set(staffId, (byStaff.get(staffId) ?? 0) + points);
  };
  for (const record of state.history) {
    if (record.date !== currentDate && record.staffId)
      add(record.date, record.staffId, record.fatiguePoints);
  }
  if (currentDate) {
    pointsByDate.set(currentDate, new Map());
    for (const assignment of countedWorkloadAssignments(state)) {
      if (assignment.status === "assigned" && assignment.staffId)
        add(currentDate, assignment.staffId, assignment.fatiguePoints);
    }
    for (const [staffId, points] of dutyFatigueByStaff(state, currentDate))
      add(currentDate, staffId, points);
  }
  const monthlyPoints = new Map<string, number>();
  let latestDate: string | null = null;
  for (const [day, byStaff] of pointsByDate) {
    if (!day.startsWith(`${month}-`)) continue;
    if (!latestDate || day > latestDate) latestDate = day;
    for (const [staffId, points] of byStaff)
      monthlyPoints.set(staffId, (monthlyPoints.get(staffId) ?? 0) + points);
  }
  return {
    month,
    latestDate,
    rows: state.staff
      .filter((person) => person.staffType !== "行政支援")
      .map((staff) => ({
        staff,
        todayFatigue: pointsByDate.get(date)?.get(staff.id) ?? 0,
        monthFatigue: monthlyPoints.get(staff.id) ?? 0,
      })),
  };
}
