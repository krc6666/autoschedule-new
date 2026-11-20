import type { HalfRestSelection, Staff } from "../../model";
import type { SchedulingFacts } from "../shared/scheduling-facts";
import { operationalInterval, durationHours } from "../shared/time";
import { assignmentRule } from "../flights/schedule-position-rules";
import {
  shouldAutoAssign,
  isMobileSupervisor,
} from "../flights/schedule-tasks";
import { evaluateAutomaticHardConstraints } from "../rules/built-in-rule-registry";
import { createScheduleRunFacts } from "../shared/schedule-run-facts";
import { halfRestSelectionForDate } from "../records/half-rest-selections";
import { reassignmentCandidateSafetyReasons } from "../reviews/reassignment-safety-policy";

type StaffingFacts = SchedulingFacts & {
  halfRestSelections: HalfRestSelection[];
};
export interface OverlapStaffingTarget {
  assignmentId: string;
  label: string;
  kind: "vacancy" | "supervisor-fill";
  directStaffNames: string[];
  blockedStaff: Array<{ name: string; reasons: string[] }>;
}
export interface OverlapStaffingWindow {
  startTime: string;
  endTime: string;
  flightNumbers: string[];
  idleStaff: Array<Pick<Staff, "id" | "name" | "teamLeader">>;
  targets: OverlapStaffingTarget[];
}
export interface OverlapStaffingCheck {
  status: "checked" | "unavailable";
  message: string;
  windows: OverlapStaffingWindow[];
}

function clockTime(minutes: number): string {
  const clock = minutes % (24 * 60);
  return `${minutes >= 24 * 60 ? "次日" : ""}${String(Math.floor(clock / 60)).padStart(2, "0")}:${String(clock % 60).padStart(2, "0")}`;
}

/** Final facts only. Reports direct insertion evidence; never changes a schedule
 * or claims that multiple positions can all use the same free person. */
export function buildOverlapStaffingCheck(
  state: StaffingFacts,
  date: string,
  historyEdit = false
): OverlapStaffingCheck {
  const unavailable = (message: string): OverlapStaffingCheck => ({
    status: "unavailable",
    message,
    windows: [],
  });
  if (
    historyEdit ||
    state.activeScheduleDate !== date ||
    !state.assignments.length
  ) {
    return unavailable(
      historyEdit || state.history.some((row) => row.date === date)
        ? "无法完整检查：历史未保存空岗和督导补位关联，仅支持当前完整班表检查。"
        : "无法检查：该日没有当前完整班表。"
    );
  }
  const interval = (row: { startTime: string; endTime: string }) =>
    row.startTime === row.endTime
      ? null
      : operationalInterval(
          row.startTime,
          row.endTime,
          state.settings.nightEnd
        );
  const flightIds = new Set(state.assignments.map((row) => row.flightId));
  const flights = state.flights
    .filter((flight) => flightIds.has(flight.id))
    .map((flight) => ({ flight, time: interval(flight) }));
  const work = state.assignments
    .filter(
      (row) =>
        row.staffId && row.status !== "unfilled" && row.flightNo !== "轮值"
    )
    .map((row) => ({ row, time: interval(row) }));
  const problems = state.assignments.flatMap((row) => {
    const flight = state.flights.find((item) => item.id === row.flightId);
    const rule = assignmentRule(state, row);
    if (
      !flight ||
      !rule ||
      rule.category === "引导" ||
      rule.category === "行政支援"
    )
      return [];
    const source = row.supervisorSourceAssignmentId
      ? state.assignments.find(
          (item) => item.id === row.supervisorSourceAssignmentId
        )
      : undefined;
    const sourceRule = source ? assignmentRule(state, source) : undefined;
    const filledBySupervisor = Boolean(
      row.staffId &&
      row.status === "assigned" &&
      source &&
      sourceRule &&
      isMobileSupervisor(flight, sourceRule) &&
      source.staffId === row.staffId &&
      source.status === "assigned"
    );
    const vacancy =
      !row.staffId &&
      shouldAutoAssign(flight, rule, state.settings.adminSupportEnabled, state);
    return vacancy || filledBySupervisor
      ? [
          {
            row,
            flight,
            rule,
            time: interval(row),
            kind: filledBySupervisor
              ? ("supervisor-fill" as const)
              : ("vacancy" as const),
          },
        ]
      : [];
  });
  if (
    flights.some((entry) => !entry.time) ||
    work.some((entry) => !entry.time) ||
    problems.some((entry) => !entry.time)
  ) {
    return unavailable(
      "无法完整检查：存在缺失或无效的保障/岗位起止时间，请先核对班表。"
    );
  }
  const boundaries = [
    ...new Set([
      ...flights.flatMap(({ time }) => time!),
      ...work.flatMap(({ time }) => time!),
      ...problems.flatMap(({ time }) => time!),
    ]),
  ].sort((left, right) => left - right);
  const overlap = (time: [number, number] | null, start: number, end: number) =>
    Boolean(time && time[0] < end && time[1] > start);
  const workers = state.staff.filter(
    (person) => person.status === "正常" && person.staffType === "常规"
  );
  let facts: ReturnType<typeof createScheduleRunFacts> | undefined;
  const evaluations = new Map<string, { direct: boolean; reasons: string[] }>();
  const windows: OverlapStaffingWindow[] = [];
  for (let index = 0; index + 1 < boundaries.length; index += 1) {
    const start = boundaries[index]!;
    const end = boundaries[index + 1]!;
    const activeFlights = flights.filter(({ time }) =>
      overlap(time, start, end)
    );
    if (activeFlights.length < 2) continue;
    const activeIds = new Set(activeFlights.map(({ flight }) => flight.id));
    const targets = problems.filter(
      (problem) =>
        activeIds.has(problem.row.flightId) && overlap(problem.time, start, end)
    );
    if (!targets.length) continue;
    const idleStaff = workers.filter(
      (person) =>
        !work.some(
          ({ row, time }) =>
            row.staffId === person.id && overlap(time, start, end)
        )
    );
    facts ??= createScheduleRunFacts(
      state,
      date,
      halfRestSelectionForDate(state, date)
    );
    const targetResults = targets.map((target): OverlapStaffingTarget => {
      const directStaffNames: string[] = [];
      const blockedStaff: OverlapStaffingTarget["blockedStaff"] = [];
      for (const person of idleStaff) {
        const key = `${target.row.id}\u0000${person.id}`;
        let evaluation = evaluations.get(key);
        if (!evaluation) {
          const assignments = state.assignments.filter(
            (row) => row.id !== target.row.id
          );
          // A zero-hour supervisor reuse becomes a full, independently staffed role.
          const proposed = {
            ...target.row,
            staffId: person.id,
            staffName: person.name,
            status: "assigned" as const,
            workHours: durationHours(target.row.startTime, target.row.endTime),
          };
          delete proposed.supervisorSourceAssignmentId;
          delete proposed.supervisorFillRuleId;
          const diagnostic = evaluateAutomaticHardConstraints({
            state,
            assignments,
            flight: {
              ...target.flight,
              startTime: target.row.startTime,
              endTime: target.row.endTime,
            },
            rule: target.rule,
            person,
            workHours: proposed.workHours,
            transitionMode: "forbid",
          });
          const reasons = [
            ...new Set([
              ...diagnostic.violations.map((violation) => violation.message),
              ...reassignmentCandidateSafetyReasons({
                state: { ...state, assignments },
                assignment: proposed,
                originalAssignment: target.row,
                primaryAssignment: target.row,
                date,
                review: "coverage",
                facts,
              }),
              ...(person.teamLeader
                ? ["分队长需走人工补差入口，不作为自动直接接替人员"]
                : []),
            ]),
          ];
          evaluation = { direct: reasons.length === 0, reasons };
          evaluations.set(key, evaluation);
        }
        if (evaluation.direct) directStaffNames.push(person.name);
        else
          blockedStaff.push({ name: person.name, reasons: evaluation.reasons });
      }
      return {
        assignmentId: target.row.id,
        label: `${target.row.flightNo}/${target.row.position}`,
        kind: target.kind,
        directStaffNames,
        blockedStaff,
      };
    });
    const window = {
      startTime: clockTime(start),
      endTime: clockTime(end),
      flightNumbers: [
        ...new Set(activeFlights.map(({ flight }) => flight.flightNo)),
      ],
      idleStaff: idleStaff.map(({ id, name, teamLeader }) => ({
        id,
        name,
        teamLeader,
      })),
      targets: targetResults,
    };
    // Merge only genuinely identical adjacent facts, never a transitive flight group.
    const previous = windows.at(-1);
    if (
      previous?.endTime === window.startTime &&
      JSON.stringify({ ...previous, startTime: "", endTime: "" }) ===
        JSON.stringify({ ...window, startTime: "", endTime: "" })
    )
      previous.endTime = window.endTime;
    else windows.push(window);
  }
  return {
    status: "checked",
    message: windows.length
      ? `发现${windows.length}个重叠时段存在缺岗或机动督导补位；${windows.some((window) => window.idleStaff.length > 0) ? "有空闲人员，请展开核对" : "这些时段未发现空闲人员"}。`
      : "未发现重叠航班时段的缺岗或机动督导补位。",
    windows,
  };
}
