import type { Assignment, Flight, PositionRule, Staff } from "../../model";
import type { WorkloadFacts } from "../shared/scheduling-facts";
import { eligibleStaffForRule } from "../candidates/assignment-eligibility";
import { recentHistory } from "../statistics/fatigue";
import { getDutyRosterForDate } from "../duty-roster/roster";
import { activeFlightRules } from "../flights/schedule-position-rules";
import { shouldAutoAssign } from "../flights/schedule-tasks";
import { durationHours, timeToMinutes } from "../shared/time";
import { countedWorkloadAssignments } from "../shared/workload-accounting";

export type WorkloadPressure = "宽松" | "紧张" | "密集";

export const WORKLOAD_BALANCE_MIN_FLIGHTS = 4;
export const DENSE_PEAK_STAFFING_RATIO = 0.9;
export const DENSE_CAPACITY_UTILIZATION = 0.75;
export const TIGHT_PEAK_STAFFING_RATIO = 0.6;
export const TIGHT_CAPACITY_UTILIZATION = 0.45;

export interface WorkloadTask {
  flight: Flight;
  rule: PositionRule;
  eligibleStaffIds: string[];
}

export interface WorkloadBalanceMetrics {
  enabled: boolean;
  pressure: WorkloadPressure;
  peakConcurrentPositions: number;
  peakEligibleStaff: number;
  peakStaffingRatio: number;
  scheduledHours: number;
  capacityHours: number;
  utilization: number;
  workHoursDifference: number;
  rollingWorkHoursDifference: number;
  todayFatigueDifference: number;
  recentFatigueDifference: number;
  withinConfiguredTargets: boolean;
  shortageTasks: number;
  summary: string;
}

export type WorkloadPressureFacts = Pick<
  WorkloadBalanceMetrics,
  | "pressure"
  | "peakConcurrentPositions"
  | "peakEligibleStaff"
  | "peakStaffingRatio"
  | "scheduledHours"
  | "capacityHours"
  | "utilization"
  | "shortageTasks"
>;

export interface WorkloadBalancePriority {
  violatesConfiguredTarget: boolean;
  todayHoursExcess: number;
  rollingHoursExcess: number;
  todayFatigueExcess: number;
  todayHoursSpread: number;
  rollingHoursSpread: number;
  recentFatigueSpread: number;
  todayFatigueSpread: number;
}

const EMPTY_WORKLOAD_PRIORITY: WorkloadBalancePriority = {
  violatesConfiguredTarget: false,
  todayHoursExcess: 0,
  rollingHoursExcess: 0,
  todayFatigueExcess: 0,
  todayHoursSpread: 0,
  rollingHoursSpread: 0,
  recentFatigueSpread: 0,
  todayFatigueSpread: 0,
};

function operationalRange(
  flight: Pick<Flight, "startTime" | "endTime">
): [number, number] | null {
  const start = timeToMinutes(flight.startTime);
  let end = timeToMinutes(flight.endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (end <= start) end += 24 * 60;
  return [start, end];
}

export function buildWorkloadTasks(state: WorkloadFacts): WorkloadTask[] {
  return state.flights.flatMap((flight) =>
    activeFlightRules(state, flight)
      .filter(
        (rule) => rule.category !== "行政支援" && shouldAutoAssign(flight, rule)
      )
      .map((rule) => ({
        flight,
        rule,
        eligibleStaffIds: eligibleStaffForRule(state, flight, rule).map(
          (person) => person.id
        ),
      }))
  );
}

function peakPressure(tasks: WorkloadTask[]): {
  demand: number;
  eligible: number;
  ratio: number;
} {
  const ranges = tasks
    .map((task) => ({ task, range: operationalRange(task.flight) }))
    .filter((item): item is { task: WorkloadTask; range: [number, number] } =>
      Boolean(item.range)
    );
  const points = [...new Set(ranges.flatMap(({ range }) => range))].sort(
    (left, right) => left - right
  );
  let peakDemand = 0;
  let peakEligible = 0;
  let peakRatio = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const midpoint = (points[index]! + points[index + 1]!) / 2;
    const active = ranges
      .filter(({ range }) => midpoint >= range[0] && midpoint < range[1])
      .map(({ task }) => task);
    if (!active.length) continue;
    const eligible = new Set(active.flatMap((task) => task.eligibleStaffIds));
    const ratio = eligible.size
      ? active.length / eligible.size
      : Number.POSITIVE_INFINITY;
    peakDemand = Math.max(peakDemand, active.length);
    peakEligible = Math.max(peakEligible, eligible.size);
    peakRatio = Math.max(peakRatio, ratio);
  }
  return { demand: peakDemand, eligible: peakEligible, ratio: peakRatio };
}

export function analyzeWorkloadPressure(
  state: WorkloadFacts,
  tasks = buildWorkloadTasks(state)
): WorkloadPressureFacts {
  const regular = state.staff.filter(
    (person) => person.status === "正常" && person.staffType === "常规"
  );
  const scheduledHours = tasks.reduce(
    (sum, task) =>
      sum + durationHours(task.flight.startTime, task.flight.endTime),
    0
  );
  const capacityHours = regular.length * state.settings.maxDailyHours;
  const utilization =
    capacityHours > 0
      ? scheduledHours / capacityHours
      : scheduledHours
        ? Number.POSITIVE_INFINITY
        : 0;
  const peak = peakPressure(tasks);
  const shortageTasks = tasks.filter(
    (task) => task.eligibleStaffIds.length === 0
  ).length;
  const pressure: WorkloadPressure =
    shortageTasks > 0 ||
    peak.ratio >= DENSE_PEAK_STAFFING_RATIO ||
    utilization >= DENSE_CAPACITY_UTILIZATION
      ? "密集"
      : peak.ratio >= TIGHT_PEAK_STAFFING_RATIO ||
          utilization >= TIGHT_CAPACITY_UTILIZATION
        ? "紧张"
        : "宽松";
  return {
    pressure,
    peakConcurrentPositions: peak.demand,
    peakEligibleStaff: peak.eligible,
    peakStaffingRatio: peak.ratio,
    scheduledHours,
    capacityHours,
    utilization,
    shortageTasks,
  };
}

export interface WorkloadBalanceLoadSnapshot {
  id: string;
  todayHours: number;
  rollingHours: number;
  todayFatigue: number;
  recentFatigue: number;
}

/** Actual saved points, separate from historyFatigue and its penalties. */
export function recentFatigueBalanceApplicable(
  loads: readonly WorkloadBalanceLoadSnapshot[]
): boolean {
  return new Set(loads.map((load) => load.recentFatigue)).size > 1;
}

export function workloadBalanceLoadSnapshots(
  state: WorkloadFacts,
  assignments: Assignment[],
  date: string,
  dutyStaffId: string | null
): WorkloadBalanceLoadSnapshot[] {
  const history = recentHistory(
    state.history,
    date,
    state.settings.historyWindowDays
  );
  const countedAssignments = countedWorkloadAssignments(state, assignments);
  return state.staff
    .filter((person) => person.status === "正常" && person.staffType === "常规")
    .map((person) => ({
      id: person.id,
      todayHours: countedAssignments
        .filter(
          (assignment) =>
            assignment.staffId === person.id && assignment.status === "assigned"
        )
        .reduce((sum, assignment) => sum + assignment.workHours, 0),
      rollingHours: history
        .filter(
          (record) =>
            record.staffId === person.id &&
            record.historyCoverage !== "late-priority-only"
        )
        .reduce((sum, record) => sum + record.workHours, 0),
      recentFatigue: history
        .filter((record) => record.staffId === person.id)
        .reduce((sum, record) => sum + (record.fatiguePoints ?? 0), 0),
      todayFatigue:
        countedAssignments
          .filter(
            (assignment) =>
              assignment.staffId === person.id &&
              assignment.status === "assigned"
          )
          .reduce((sum, assignment) => sum + assignment.fatiguePoints, 0) +
        (person.id === dutyStaffId ? state.settings.dutyFatiguePoints : 0),
    }));
}

export function evaluateWorkloadBalance(
  state: WorkloadFacts,
  date: string,
  assignments = state.assignments,
  knownDutyStaffId?: string | null
): WorkloadBalanceMetrics {
  const pressure = analyzeWorkloadPressure(state);
  const dutyStaffId =
    knownDutyStaffId === undefined
      ? getDutyRosterForDate(state, date).dutyStaffId
      : knownDutyStaffId;
  const loads = workloadBalanceLoadSnapshots(
    state,
    assignments,
    date,
    dutyStaffId
  );
  const workHours = loads.map((load) => load.todayHours);
  const rollingHours = loads.map((load) => load.todayHours + load.rollingHours);
  const todayFatigue = loads.map((load) => load.todayFatigue);
  const recentFatigue = loads.map(
    (load) => load.recentFatigue + load.todayFatigue
  );
  const difference = (values: number[]): number =>
    values.length ? Math.max(...values) - Math.min(...values) : 0;
  const workHoursDifference = difference(workHours);
  const rollingWorkHoursDifference = difference(rollingHours);
  const todayFatigueDifference = difference(todayFatigue);
  const recentFatigueDifference = difference(recentFatigue);
  const withinConfiguredTargets =
    workHoursDifference <= state.settings.maxWorkHoursDifference &&
    rollingWorkHoursDifference <=
      state.settings.maxWorkHoursDifference +
        state.settings.historyWindowDays &&
    todayFatigueDifference <= state.settings.maxTodayFatigueDifference;
  const enabled = state.settings.workloadBalanceEnabled;
  const summary = !enabled
    ? "工时均衡已停用"
    : `${pressure.pressure}：当日工时差 ${workHoursDifference.toFixed(1)} 小时，滚动工时差 ${rollingWorkHoursDifference.toFixed(1)} 小时，疲劳差 ${todayFatigueDifference.toFixed(1)} 点，最近${state.settings.historyWindowDays}天加本班近期累计疲劳差 ${recentFatigueDifference.toFixed(1)} 点（尽量拉近）`;
  return {
    enabled,
    ...pressure,
    workHoursDifference,
    rollingWorkHoursDifference,
    todayFatigueDifference,
    recentFatigueDifference,
    withinConfiguredTargets,
    summary,
  };
}

/** Shared by later reviews; recent improvement may use the daily target budget. */
export function preservesWorkloadBalance(
  state: WorkloadFacts,
  date: string,
  before: readonly Assignment[],
  after: readonly Assignment[],
  dutyStaffId?: string | null
): boolean {
  if (!state.settings.workloadBalanceEnabled) return true;
  const first = evaluateWorkloadBalance(state, date, [...before], dutyStaffId);
  const second = evaluateWorkloadBalance(state, date, [...after], dutyStaffId);
  const dailyMayYield =
    second.todayFatigueDifference <= state.settings.maxTodayFatigueDifference &&
    second.recentFatigueDifference < first.recentFatigueDifference;
  return (
    second.workHoursDifference <= first.workHoursDifference &&
    second.rollingWorkHoursDifference <= first.rollingWorkHoursDifference &&
    second.recentFatigueDifference <= first.recentFatigueDifference &&
    (second.todayFatigueDifference <= first.todayFatigueDifference ||
      dailyMayYield)
  );
}

export function workloadBalancePriority(
  person: Staff,
  assignments: Assignment[],
  state: WorkloadFacts,
  targetHours: number,
  targetFatigue: number,
  dutyStaffId: string | null,
  date: string,
  pressure: WorkloadPressureFacts,
  knownLoads?: readonly WorkloadBalanceLoadSnapshot[]
): WorkloadBalancePriority {
  if (!state.settings.workloadBalanceEnabled) return EMPTY_WORKLOAD_PRIORITY;
  const loads =
    knownLoads ??
    workloadBalanceLoadSnapshots(state, assignments, date, dutyStaffId);
  const current = loads.find((load) => load.id === person.id);
  if (!current || !loads.length) return EMPTY_WORKLOAD_PRIORITY;
  const configuredHoursTarget = Math.max(
    0.5,
    state.settings.maxWorkHoursDifference
  );
  const rollingTarget =
    configuredHoursTarget + Math.max(0, state.settings.historyWindowDays / 2);
  const configuredFatigueTarget = Math.max(
    0.5,
    state.settings.maxTodayFatigueDifference
  );
  const projected = loads.map((load) => ({
    today: load.todayHours + (load.id === person.id ? targetHours : 0),
    rolling:
      load.rollingHours +
      load.todayHours +
      (load.id === person.id ? targetHours : 0),
    fatigue: load.todayFatigue + (load.id === person.id ? targetFatigue : 0),
    recentFatigue:
      load.recentFatigue +
      load.todayFatigue +
      (load.id === person.id ? targetFatigue : 0),
  }));
  const spread = (values: number[]): number =>
    Math.max(...values) - Math.min(...values);
  const todaySpread = spread(projected.map((load) => load.today));
  const rollingSpread = spread(projected.map((load) => load.rolling));
  const fatigueSpread = spread(projected.map((load) => load.fatigue));
  const todayHoursExcess = Math.max(0, todaySpread - configuredHoursTarget);
  const rollingHoursExcess = Math.max(0, rollingSpread - rollingTarget);
  const compareWithinTargets =
    state.flights.length >= WORKLOAD_BALANCE_MIN_FLIGHTS &&
    pressure.pressure !== "宽松";
  const balanceRecent = recentFatigueBalanceApplicable(loads);
  const todayFatigueExcess =
    compareWithinTargets || balanceRecent
      ? Math.max(0, fatigueSpread - configuredFatigueTarget)
      : 0;
  return {
    violatesConfiguredTarget:
      todayHoursExcess > 0 || rollingHoursExcess > 0 || todayFatigueExcess > 0,
    todayHoursExcess,
    rollingHoursExcess,
    todayFatigueExcess,
    todayHoursSpread: compareWithinTargets ? todaySpread : 0,
    rollingHoursSpread: compareWithinTargets ? rollingSpread : 0,
    recentFatigueSpread: balanceRecent
      ? spread(projected.map((load) => load.recentFatigue))
      : 0,
    todayFatigueSpread: compareWithinTargets ? fatigueSpread : 0,
  };
}
