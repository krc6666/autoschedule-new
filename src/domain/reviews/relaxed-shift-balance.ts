import type { Assignment } from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import { buildMonthlyRelaxedShiftStatistics } from "../statistics/relaxed-shift-statistics";
import {
  groupStaffFlightsByNormalizedNumber,
  dailyFlightCountParticipantIds,
} from "../statistics/staff-flight-count";
import { getDutyRosterForDate } from "../duty-roster/roster";
import { assignmentRule } from "../flights/schedule-position-rules";
import { clearAutomaticAssignmentEvidence } from "../assignments/assignment-evidence";
import { ScheduleGuardError } from "../kernel/schedule-guard";
import { dutyAfternoonFlightIds } from "../assignments/duty-afternoon-relief";
import type { MonthlyRelaxedShiftStatistics } from "../statistics/relaxed-shift-statistics";
import { preservesWorkloadBalance } from "./workload-balance";
import { timeToMinutes } from "../shared/time";

type RelaxedShiftScore = {
  countExcess: number;
  countSquares: number;
  earlyStartStaffIds: string[];
  earlyStartSpread: number;
  afternoonFreeExcess: number;
  afternoonFreeSquares: number;
};

function relaxedRows(
  value: MonthlyRelaxedShiftStatistics,
  eligibleIds: ReadonlySet<string>,
  excludedDuty?: string | null
) {
  return value.rows.filter(
    ({ staff }) =>
      staff.status === "正常" &&
      staff.staffType === "常规" &&
      !staff.teamLeader &&
      eligibleIds.has(staff.id) &&
      staff.id !== excludedDuty
  );
}

function monthlyCountScore(values: number[], difference: number) {
  let excess = 0;
  let squares = 0;
  for (const [index, value] of values.entries()) {
    squares += value * value;
    for (let other = index + 1; other < values.length; other++)
      excess += Math.max(0, Math.abs(value - values[other]!) - difference);
  }
  return { excess, squares };
}

function earlyStartMinutes(
  row: MonthlyRelaxedShiftStatistics["rows"][number],
  cutoff: number
): number | undefined {
  if (row.earlyDepartureStartMinutes.length !== row.earlyDepartures.length)
    return undefined;
  return row.earlyDepartureStartMinutes.reduce(
    (total, start) => total + Math.max(0, cutoff - start),
    0
  );
}

function relaxedShiftScore(
  state: ScheduleGenerationFacts,
  value: MonthlyRelaxedShiftStatistics,
  eligibleIds: ReadonlySet<string>,
  duty: string | null
): RelaxedShiftScore {
  const { settings } = state;
  const early = settings.earlyDepartureBalanceEnabled
    ? relaxedRows(value, eligibleIds, duty)
    : [];
  const afternoon = settings.afternoonRestBalanceEnabled
    ? relaxedRows(value, eligibleIds)
    : [];
  const earlyCount = monthlyCountScore(
    early.map((row) => row.earlyDepartures.length),
    settings.earlyDepartureMaxDifference
  );
  const restCount = monthlyCountScore(
    afternoon.map((row) => row.afternoonRestDates.length),
    settings.afternoonRestMaxDifference
  );
  const freeCount = monthlyCountScore(
    afternoon.map((row) => row.afternoonFreeDates.length),
    settings.afternoonRestMaxDifference
  );
  const cutoff = timeToMinutes(settings.earlyDepartureCutoffTime);
  const earlyStartStaffIds: string[] = [];
  let sum = 0;
  let squares = 0;
  for (const row of early) {
    const minutes = earlyStartMinutes(row, cutoff);
    if (minutes === undefined) continue;
    earlyStartStaffIds.push(row.staff.id);
    sum += minutes;
    squares += minutes * minutes;
  }
  return {
    countExcess: earlyCount.excess + restCount.excess,
    countSquares: earlyCount.squares + restCount.squares,
    earlyStartStaffIds,
    earlyStartSpread: earlyStartStaffIds.length * squares - sum * sum,
    afternoonFreeExcess: freeCount.excess,
    afternoonFreeSquares: freeCount.squares,
  };
}

function compareRelaxedScores(
  first: RelaxedShiftScore,
  second: RelaxedShiftScore
): number {
  const sameEarlyStartStaff =
    first.earlyStartStaffIds.length === second.earlyStartStaffIds.length &&
    first.earlyStartStaffIds.every(
      (staffId, index) => staffId === second.earlyStartStaffIds[index]
    );
  return (
    first.countExcess - second.countExcess ||
    first.countSquares - second.countSquares ||
    (sameEarlyStartStaff
      ? first.earlyStartSpread - second.earlyStartSpread
      : 0) ||
    first.afternoonFreeExcess - second.afternoonFreeExcess ||
    first.afternoonFreeSquares - second.afternoonFreeSquares
  );
}

function opportunityCounts(
  state: ScheduleGenerationFacts,
  value: MonthlyRelaxedShiftStatistics,
  date: string
) {
  return [
    value.currentEarlyDepartures.length,
    value.currentAfternoonRest.length,
    state.settings.afternoonRestBalanceEnabled
      ? value.rows.filter((row) => row.afternoonFreeDates.includes(date)).length
      : 0,
  ];
}

function compareRelaxedOutcomes(
  state: ScheduleGenerationFacts,
  before: MonthlyRelaxedShiftStatistics,
  after: MonthlyRelaxedShiftStatistics,
  beforeScore: RelaxedShiftScore,
  afterScore: RelaxedShiftScore
): number {
  if (
    state.settings.earlyDepartureBalanceEnabled &&
    beforeScore.countExcess === afterScore.countExcess &&
    beforeScore.countSquares === afterScore.countSquares
  ) {
    const earlier = before.currentEarlyDepartureStartMinutes;
    const later = after.currentEarlyDepartureStartMinutes;
    if (
      earlier.length === before.currentEarlyDepartures.length &&
      (later.length !== earlier.length ||
        later.reduce((sum, minute) => sum + minute, 0) >
          earlier.reduce((sum, minute) => sum + minute, 0))
    )
      return 1;
  }
  return compareRelaxedScores(afterScore, beforeScore);
}

/** Same fairness and rest budgets used by monthly balancing, for later reviews. */
export function preservesRelaxedShiftBalance(
  state: ScheduleGenerationFacts,
  date: string,
  before: readonly Assignment[],
  after: readonly Assignment[],
  afternoonRestYieldStaffIds: ReadonlySet<string> = new Set()
): boolean {
  if (
    !state.settings.earlyDepartureBalanceEnabled &&
    !state.settings.afternoonRestBalanceEnabled
  )
    return true;
  const eligibleIds = new Set(
    before.flatMap((a) =>
      a.status === "assigned" && a.staffId ? [a.staffId] : []
    )
  );
  const report = (assignments: readonly Assignment[]) =>
    buildMonthlyRelaxedShiftStatistics(
      {
        ...state,
        history: state.history.filter(
          (r) => r.date < date && r.date.slice(0, 7) === date.slice(0, 7)
        ),
        assignments: [...assignments],
        activeScheduleDate: date,
      },
      date
    );
  const first = report(before),
    second = report(after);
  // A verified shorter working day may replace the target's idle afternoon.
  // Keep the real statistics unchanged; only this comparison baseline yields.
  const actualYieldIds = new Set(
    first.currentAfternoonRest
      .filter(
        (p) =>
          afternoonRestYieldStaffIds.has(p.staffId) &&
          !second.currentAfternoonRest.some(
            (next) => next.staffId === p.staffId
          )
      )
      .map((p) => p.staffId)
  );
  first.currentAfternoonRest = first.currentAfternoonRest.filter(
    (p) => !actualYieldIds.has(p.staffId)
  );
  const stillFreeIds = new Set(
    second.rows
      .filter((row) => row.afternoonFreeDates.includes(date))
      .map((row) => row.staff.id)
  );
  first.rows = first.rows.map((row) => ({
    ...row,
    afternoonRestDates: actualYieldIds.has(row.staff.id)
      ? row.afternoonRestDates.filter((day) => day !== date)
      : row.afternoonRestDates,
    afternoonFreeDates:
      afternoonRestYieldStaffIds.has(row.staff.id) &&
      !stillFreeIds.has(row.staff.id)
        ? row.afternoonFreeDates.filter((day) => day !== date)
        : row.afternoonFreeDates,
  }));
  const afterCounts = opportunityCounts(state, second, date);
  if (
    opportunityCounts(state, first, date).some(
      (count, index) => count !== afterCounts[index]
    )
  )
    return false;
  const duty = getDutyRosterForDate(state, date).dutyStaffId;
  const a = relaxedShiftScore(state, first, eligibleIds, duty);
  const b = relaxedShiftScore(state, second, eligibleIds, duty);
  return compareRelaxedOutcomes(state, first, second, a, b) <= 0;
}

export function balanceRelaxedShifts(options: {
  state: ScheduleGenerationFacts;
  date: string;
  assignments: readonly Assignment[];
  lockedAssignmentIds: ReadonlySet<string>;
  assertSafe: (assignments: readonly Assignment[]) => void;
  halfRestStaffIds?: ReadonlySet<string>;
}): Assignment[] {
  const { state, date, lockedAssignmentIds, assertSafe } = options;
  let current = structuredClone([...options.assignments]);
  const { settings } = state;
  if (
    !settings.earlyDepartureBalanceEnabled &&
    !settings.afternoonRestBalanceEnabled
  )
    return current;
  const history = state.history.filter(
    (row) => row.date < date && row.date.slice(0, 7) === date.slice(0, 7)
  );
  const report = (assignments: Assignment[]) =>
    buildMonthlyRelaxedShiftStatistics(
      { ...state, history, assignments, activeScheduleDate: date },
      date
    );
  const baseline = report(current);
  const historical = report([]);
  const participants = state.staff.filter(
    (person) =>
      person.status === "正常" &&
      person.staffType === "常规" &&
      !person.teamLeader
  );
  const participantIds = new Set(participants.map((p) => p.id));
  const eligibleIds = new Set(
    current
      .filter((a) => a.status === "assigned" && a.staffId)
      .map((a) => a.staffId!)
  );
  const duty = getDutyRosterForDate(state, date).dutyStaffId;
  const score = (value: MonthlyRelaxedShiftStatistics) =>
    relaxedShiftScore(state, value, eligibleIds, duty);
  const earlyHistory = relaxedRows(historical, eligibleIds, duty);
  const afternoonHistory = relaxedRows(historical, eligibleIds);
  const cutoff = timeToMinutes(settings.earlyDepartureCutoffTime);
  const hasEarlyDifference =
    settings.earlyDepartureBalanceEnabled &&
    (new Set(earlyHistory.map((row) => row.earlyDepartures.length)).size > 1 ||
      new Set(
        earlyHistory.flatMap((row) => earlyStartMinutes(row, cutoff) ?? [])
      ).size > 1);
  const hasAfternoonDifference =
    settings.afternoonRestBalanceEnabled &&
    (new Set(afternoonHistory.map((row) => row.afternoonRestDates.length))
      .size > 1 ||
      new Set(afternoonHistory.map((row) => row.afternoonFreeDates.length))
        .size > 1);
  if (!hasEarlyDifference && !hasAfternoonDifference) return current;
  const counts = (value: MonthlyRelaxedShiftStatistics) =>
    opportunityCounts(state, value, date);
  const budget = counts(baseline);
  let bestReport = baseline;
  const flightIds = dailyFlightCountParticipantIds(state, {
    dutyStaffId: duty,
    halfRestStaffIds: options.halfRestStaffIds,
  });
  const spread = (assignments: Assignment[]) => {
    const grouped = groupStaffFlightsByNormalizedNumber(
      assignments.flatMap((a) =>
        a.status === "assigned" && a.staffId && flightIds.has(a.staffId)
          ? [{ staffId: a.staffId, flightNo: a.flightNo }]
          : []
      )
    );
    const values = [...flightIds].map((id) => grouped.get(id)?.size ?? 0);
    return values.length ? Math.max(...values) - Math.min(...values) : 0;
  };
  const spreadBefore = spread(current);
  const movable = (a: Assignment) =>
    a.status === "assigned" &&
    !!a.staffId &&
    participantIds.has(a.staffId) &&
    !lockedAssignmentIds.has(a.id) &&
    !assignmentRule(state, a)?.manual &&
    !a.manualRemark &&
    !a.supervisorSourceAssignmentId &&
    !a.teamLeaderGapFill &&
    !["机动督导", "引导", "行政支援"].includes(
      assignmentRule(state, a)?.category ?? ""
    );
  let bestScore = score(baseline),
    probes = 0;
  const accept = (proposal: Assignment[]) => {
    const result = report(proposal),
      next = score(result);
    if (
      compareRelaxedOutcomes(state, bestReport, result, bestScore, next) >= 0 ||
      counts(result).some((n, i) => n !== budget[i]) ||
      spread(proposal) > spreadBefore ||
      !preservesWorkloadBalance(state, date, current, proposal, duty) ||
      (duty !== null &&
        dutyAfternoonFlightIds(state, proposal, duty).size >
          dutyAfternoonFlightIds(state, current, duty).size)
    )
      return false;
    try {
      assertSafe(proposal);
    } catch (error) {
      if (error instanceof ScheduleGuardError) return false;
      throw error;
    }
    current = proposal;
    bestReport = result;
    bestScore = next;
    return true;
  };
  // Identity permutations preserve all covered slots and per-person intervals.
  // Then try one complete flight group; every proposal crosses the final guard.
  for (let pass = 0; pass < participants.length && probes < 300; pass++) {
    let changed = false;
    for (let i = 0; i < participants.length && !changed && probes < 300; i++) {
      for (const other of participants.slice(i + 1)) {
        if (++probes > 300) break;
        const first = participants[i]!;
        const affected = current.filter(
          (a) => a.staffId === first.id || a.staffId === other.id
        );
        if (!affected.length || affected.some((a) => !movable(a))) continue;
        if (
          affected.some((a) => {
            const rule = assignmentRule(state, a);
            return (
              rule &&
              !rule.qualifiedStaffIds.includes(
                a.staffId === first.id ? other.id : first.id
              )
            );
          })
        )
          continue;
        const proposal = structuredClone(current);
        for (const a of proposal)
          if (a.staffId === first.id || a.staffId === other.id) {
            const person = a.staffId === first.id ? other : first;
            clearAutomaticAssignmentEvidence(a);
            a.staffId = person.id;
            a.staffName = person.name;
          }
        if (
          proposal.some(
            (a) =>
              a.staffId &&
              assignmentRule(state, a) &&
              !assignmentRule(state, a)!.qualifiedStaffIds.includes(a.staffId)
          )
        )
          continue;
        if (accept(proposal)) {
          changed = true;
          break;
        }
      }
    }
    if (changed) continue;
    const groups = groupStaffFlightsByNormalizedNumber(
      current.flatMap((a) =>
        movable(a)
          ? [{ staffId: a.staffId!, flightNo: a.flightNo, assignment: a }]
          : []
      )
    );
    for (const [source, flights] of groups) {
      for (const entries of flights.values()) {
        const groupIds = new Set(entries.map((e) => e.assignment.id));
        for (const person of participants) {
          if (++probes > 300 || changed) break;
          if (
            person.id === source ||
            entries.some(
              (e) =>
                assignmentRule(state, e.assignment) &&
                !assignmentRule(
                  state,
                  e.assignment
                )!.qualifiedStaffIds.includes(person.id)
            )
          )
            continue;
          const proposal = structuredClone(current);
          for (const a of proposal)
            if (groupIds.has(a.id)) {
              clearAutomaticAssignmentEvidence(a);
              a.staffId = person.id;
              a.staffName = person.name;
            }
          if (accept(proposal)) {
            changed = true;
            break;
          }
        }
        if (changed || probes >= 300) break;
      }
      if (changed || probes >= 300) break;
    }
    if (!changed) break;
  }
  return current;
}
