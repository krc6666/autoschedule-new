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
  const kinds = (["earlyDeparture", "afternoonRest"] as const).filter(
    (kind) => state.settings[`${kind}BalanceEnabled`]
  );
  if (!kinds.length) return current;
  const history = state.history.filter(
    (row) => row.date < date && row.date.slice(0, 7) === date.slice(0, 7)
  );
  const report = (assignments: Assignment[]) =>
    buildMonthlyRelaxedShiftStatistics(
      { ...state, history, assignments, activeScheduleDate: date },
      date
    );
  const baseline = report(current);
  const historyRows = report([]).rows;
  const count = (
    row: (typeof historyRows)[number],
    kind: (typeof kinds)[number]
  ) =>
    kind === "earlyDeparture"
      ? row.earlyDepartures.length
      : row.afternoonRestDates.length;
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
  const score = (value: ReturnType<typeof report>): [number, number] => {
    let excess = 0,
      squares = 0;
    for (const kind of kinds) {
      const values = value.rows
        .filter(
          (row) =>
            participantIds.has(row.staff.id) &&
            eligibleIds.has(row.staff.id) &&
            (kind !== "earlyDeparture" || row.staff.id !== duty)
        )
        .map((row) => count(row, kind));
      for (let i = 0; i < values.length; i++) {
        squares += values[i]! * values[i]!;
        for (const second of values.slice(i + 1))
          excess += Math.max(
            0,
            Math.abs(values[i]! - second) -
              state.settings[`${kind}MaxDifference`]
          );
      }
    }
    return [excess, squares];
  };
  if (
    !kinds.some(
      (kind) =>
        new Set(
          historyRows
            .filter(
              (row) =>
                eligibleIds.has(row.staff.id) &&
                participantIds.has(row.staff.id) &&
                (kind !== "earlyDeparture" || row.staff.id !== duty)
            )
            .map((row) => count(row, kind))
        ).size > 1
    )
  )
    return current;
  const counts = (value: ReturnType<typeof report>) => [
    value.currentEarlyDepartures.length,
    value.currentAfternoonRest.length,
  ];
  const budget = counts(baseline);
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
  const improves = (next: [number, number]) =>
    next[0] < bestScore[0] ||
    (next[0] === bestScore[0] && next[1] < bestScore[1]);
  const accept = (proposal: Assignment[]) => {
    const result = report(proposal),
      next = score(result);
    if (
      !improves(next) ||
      counts(result).some((n, i) => n !== budget[i]) ||
      spread(proposal) > spreadBefore
    )
      return false;
    try {
      assertSafe(proposal);
    } catch (error) {
      if (error instanceof ScheduleGuardError) return false;
      throw error;
    }
    current = proposal;
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
