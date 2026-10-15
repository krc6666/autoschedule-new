import { getDutyRosterForDate } from "../domain/duty-roster/roster";
import { assignmentUsesUnavailableStaff } from "../domain/kernel/schedule-state";
import { isCountedWorkloadAssignment } from "../domain/shared/workload-accounting";
import type { AppState, HistoryRecord } from "../model";
import { assignmentWarningRemark, createId } from "../utils";
import {
  activeFlightRules,
  makeUnfilled,
} from "../domain/flights/schedule-position-rules";
import type { Assignment } from "../model";
import { isClearedCountRecord } from "../domain/statistics/manual-count-evidence";

export interface HistoricalScheduleDraft {
  flights: AppState["flights"];
  assignments: Assignment[];
  warnings: string[];
}

export function buildHistoricalScheduleDraft(
  state: AppState,
  date: string
): HistoricalScheduleDraft {
  const records = state.history.filter((item) => item.date === date);
  if (!records.length)
    return {
      flights: [],
      assignments: [],
      warnings: ["该日期没有可编辑的完整历史排班"],
    };
  if (records.some((item) => item.historyCoverage === "late-priority-only"))
    return {
      flights: [],
      assignments: [],
      warnings: ["该日期只有末班重点历史记录，不能还原完整排班"],
    };
  const assignableRecords = records.filter(
    (record) => record.flightNo !== "轮值"
  );
  if (!assignableRecords.length)
    return {
      flights: [],
      assignments: [],
      warnings: ["该日期没有可编辑的航班岗位记录"],
    };

  const flightNos = [
    ...new Set(assignableRecords.map((record) => record.flightNo)),
  ];
  const unmatchedFlightNos = new Set<string>();
  const flights = flightNos.flatMap((flightNo) => {
    const source =
      state.templates.find((item) => item.flightNo === flightNo) ??
      state.flights.find((item) => item.flightNo === flightNo);
    if (!source) {
      unmatchedFlightNos.add(flightNo);
      return [];
    }
    return [
      {
        ...source,
        id: `historical-${date}-${source.id}`,
        bookedPassengers:
          state.flights.find((item) => item.flightNo === flightNo)
            ?.bookedPassengers ?? 0,
        positions: [...source.positions],
      },
    ];
  });
  const assignments = flights.flatMap((flight) =>
    activeFlightRules(state, flight).map((rule) =>
      makeUnfilled(flight, rule.name, rule)
    )
  );
  const unmatched = new Set(assignableRecords.map((record) => record.id));
  for (const assignment of assignments) {
    const record =
      records.find(
        (item) =>
          unmatched.has(item.id) &&
          item.flightNo === assignment.flightNo &&
          item.position === assignment.position &&
          (!item.startTime || item.startTime === assignment.startTime) &&
          (!item.endTime || item.endTime === assignment.endTime)
      ) ??
      records.find(
        (item) =>
          unmatched.has(item.id) &&
          item.flightNo === assignment.flightNo &&
          item.position === assignment.position
      );
    if (!record) continue;
    unmatched.delete(record.id);
    assignment.staffId = record.staffId || null;
    assignment.staffName = record.staffName;
    if (!isClearedCountRecord(record)) {
      assignment.workHours = record.workHours;
      assignment.fatiguePoints = record.fatiguePoints;
    }
    assignment.remark = record.assignmentRemarks?.remark ?? record.remark;
    if (record.countBaseline)
      assignment.countBaseline = structuredClone(record.countBaseline);
    if (record.manualOverrideWarnings)
      assignment.manualOverrideWarnings = structuredClone(
        record.manualOverrideWarnings
      );
    if (record.teamLeaderGapFill) assignment.teamLeaderGapFill = true;
    assignment.manualRemark = record.assignmentRemarks?.manualRemark ?? "";
    assignment.status = assignment.staffId ? "assigned" : assignment.status;
  }
  const warnings = [
    ...[...unmatchedFlightNos].map(
      (flightNo) => `${flightNo} 无法匹配当前航班模板或当天航班，未载入人员`
    ),
    ...[...unmatched].map((id) => {
      const record = assignableRecords.find((item) => item.id === id)!;
      return `${record.flightNo}/${record.position} 无法匹配当前航班或岗位配置，未载入人员`;
    }),
  ];
  return { flights, assignments, warnings };
}

export function currentScheduleHistory(
  state: AppState,
  date: string,
  options: { includeUnavailableStaff?: boolean } = {}
): HistoryRecord[] {
  const records: HistoryRecord[] = state.assignments
    .filter(
      (item) =>
        (item.status === "assigned" && item.staffName) ||
        isClearedCountRecord({ ...item, staffId: item.staffId ?? "" })
    )
    .filter(
      (item) =>
        options.includeUnavailableStaff ||
        !assignmentUsesUnavailableStaff(state, item)
    )
    .filter((item) => isCountedWorkloadAssignment(state, item))
    .map((item) => ({
      id: createId("history"),
      date,
      flightNo: item.flightNo,
      position: item.position,
      staffId: item.staffId ?? "",
      staffName: item.staffName,
      startTime: item.startTime,
      endTime: item.endTime,
      flightCutoffTime:
        state.flights.find((flight) => flight.id === item.flightId)?.endTime ??
        item.endTime,
      workHours: item.staffId ? item.workHours : 0,
      fatiguePoints: item.staffId ? item.fatiguePoints : 0,
      remark: assignmentWarningRemark(
        item.remark,
        item.manualRemark,
        item.manualOverrideWarnings
      ),
      ...(item.teamLeaderGapFill ? { teamLeaderGapFill: true as const } : {}),
      ...(item.countBaseline
        ? { countBaseline: structuredClone(item.countBaseline) }
        : {}),
      ...(item.manualOverrideWarnings
        ? {
            manualOverrideWarnings: structuredClone(
              item.manualOverrideWarnings
            ),
          }
        : {}),
      assignmentRemarks: {
        remark: item.remark,
        manualRemark: item.manualRemark,
      },
    }));
  const roster = getDutyRosterForDate(state, date);
  const dutyPerson = roster.dutyStaffId
    ? state.staff.find((person) => person.id === roster.dutyStaffId)
    : undefined;
  if (dutyPerson && state.settings.dutyFatiguePoints > 0) {
    records.push({
      id: createId("history"),
      date,
      flightNo: "轮值",
      position: "值班人员",
      staffId: dutyPerson.id,
      staffName: dutyPerson.name,
      startTime: "",
      endTime: "",
      workHours: 0,
      fatiguePoints: state.settings.dutyFatiguePoints,
      remark: "月度轮值",
    });
  }
  return records;
}

export function replaceHistoryForDate(
  state: AppState,
  date: string,
  records: HistoryRecord[]
): void {
  state.history = [
    ...state.history.filter((item) => item.date !== date),
    ...records,
  ];
}

export function clearHistory(state: AppState): void {
  state.history = [];
}

export function deleteHistory(state: AppState, id: string): void {
  state.history = state.history.filter((item) => item.id !== id);
}
