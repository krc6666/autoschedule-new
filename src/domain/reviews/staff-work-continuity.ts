import type { Assignment } from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import type { FinalScheduleReviewContext } from "../rules/rule-registry";
import { operationalInterval } from "../shared/time";
import { groupStaffFlightsByNormalizedNumber } from "../statistics/staff-flight-count";
import { isRotationLocked } from "./rotation-review-safety";
import { optimizeReassignment } from "../solver/reassignment-optimizer";
import { applyConfiguredEarlyReleases } from "../assignments/assignment-timing";
import { rebuildAutomaticAssignmentEvidence } from "../assignments/assignment-evidence";
import { schedulingDecision } from "../rules/schedule-rule-contract";
import { preservesRelaxedShiftBalance } from "./relaxed-shift-balance";
import { ScheduleGuardError } from "../kernel/schedule-guard";

export interface StaffWorkContinuity {
  staffId: string;
  spanMinutes: number;
  maximumGapMinutes: number;
  flightCount: number;
  split: boolean;
  morningAssignmentIds: string[];
  lastAssignmentIds: string[];
}

/** Final attendance facts; zero-hour reused work still occupies the worker. */
export function staffWorkContinuity(
  state: ScheduleGenerationFacts,
  assignments: readonly Assignment[],
  dutyStaffId: string | null
): StaffWorkContinuity[] {
  const interval = (a: { startTime: string; endTime: string }) =>
    operationalInterval(a.startTime, a.endTime, state.settings.nightEnd);
  const morning = operationalInterval(
    state.settings.morningStatsStartTime,
    state.settings.morningStatsEndTime,
    state.settings.nightEnd
  );
  if (!morning) return [];
  const scheduledFlightIds = new Set(assignments.map((a) => a.flightId));
  const flights = state.flights.filter((f) => scheduledFlightIds.has(f.id));
  const lastEnd = Math.max(
    ...flights.map((f) => interval(f)?.[1] ?? -Infinity)
  );
  const lastIds = new Set(
    flights.filter((f) => interval(f)?.[1] === lastEnd).map((f) => f.id)
  );
  return state.staff
    .filter(
      (p) =>
        p.staffType === "常规" && p.status === "正常" && p.id !== dutyStaffId
    )
    .map((p) => {
      const own = assignments.filter(
        (a) =>
          a.status === "assigned" && a.staffId === p.id && a.flightNo !== "轮值"
      );
      const timed = own.flatMap((a) => {
        const range = interval(a);
        return range ? [{ a, range }] : [];
      });
      const blocks: [number, number][] = [];
      for (const { range } of timed.sort(
        (a, b) => a.range[0] - b.range[0] || a.range[1] - b.range[1]
      )) {
        const last = blocks.at(-1);
        if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
        else blocks.push([...range]);
      }
      const morningRows = timed.filter(
        ({ range }) => range[0] >= morning[0] && range[1] <= morning[1]
      );
      const lateRows = timed.filter(
        ({ a, range }) => lastIds.has(a.flightId) && range[0] >= morning[1]
      );
      const split =
        blocks.length > 1 &&
        morningRows.length > 0 &&
        lateRows.length > 0 &&
        timed.every(
          (item) => morningRows.includes(item) || lateRows.includes(item)
        );
      const grouped = groupStaffFlightsByNormalizedNumber(
        own.map((a) => ({ staffId: p.id, flightNo: a.flightNo }))
      );
      return {
        staffId: p.id,
        spanMinutes: blocks.length ? blocks.at(-1)![1] - blocks[0]![0] : 0,
        maximumGapMinutes: Math.max(
          0,
          ...blocks.slice(1).map((b, i) => b[0] - blocks[i]![1])
        ),
        flightCount: grouped.get(p.id)?.size ?? 0,
        split,
        morningAssignmentIds: morningRows.map(({ a }) => a.id),
        lastAssignmentIds: lateRows.map(({ a }) => a.id),
      };
    });
}

function compareLargestFirst(a: number[], b: number[]): number {
  a.sort((x, y) => y - x);
  b.sort((x, y) => y - x);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

/** Redistribution may rotate existing long/short days, but must not add split
 * days or worsen the team's ordered spans/gaps and their totals. */
export function preservesStaffWorkContinuity(
  before: readonly StaffWorkContinuity[],
  after: readonly StaffWorkContinuity[],
  allowRedistribution = false
): boolean {
  if (
    after.some((p) => {
      const old = before.find((b) => b.staffId === p.staffId);
      return (
        !old ||
        p.flightCount !== old.flightCount ||
        (!allowRedistribution &&
          ((p.split && !old.split) ||
            p.spanMinutes > old.spanMinutes ||
            p.maximumGapMinutes > old.maximumGapMinutes))
      );
    })
  )
    return false;
  return (
    !allowRedistribution ||
    (after.filter((p) => p.split).length <=
      before.filter((p) => p.split).length &&
      (["spanMinutes", "maximumGapMinutes"] as const).every((key) => {
        const old = before.map((p) => p[key]),
          now = after.map((p) => p[key]);
        return (
          compareLargestFirst(now, old) <= 0 &&
          now.reduce((n, x) => n + x, 0) <= old.reduce((n, x) => n + x, 0)
        );
      }))
  );
}

/** No extra flights, no new split recipient, and genuinely shorter days. */
export function improvesStaffWorkContinuity(
  before: readonly StaffWorkContinuity[],
  after: readonly StaffWorkContinuity[],
  targetStaffId: string
): boolean {
  const byId = new Map(before.map((p) => [p.staffId, p]));
  if (
    after.some(
      (p) =>
        !byId.has(p.staffId) ||
        p.flightCount !== byId.get(p.staffId)!.flightCount ||
        (p.split && !byId.get(p.staffId)!.split)
    )
  )
    return false;
  const targetBefore = byId.get(targetStaffId),
    targetAfter = after.find((p) => p.staffId === targetStaffId);
  return Boolean(
    targetBefore?.split &&
    targetAfter &&
    !targetAfter.split &&
    targetAfter.spanMinutes < targetBefore.spanMinutes &&
    targetAfter.maximumGapMinutes <= targetBefore.maximumGapMinutes &&
    compareLargestFirst(
      after.map((p) => p.spanMinutes),
      before.map((p) => p.spanMinutes)
    ) <= 0 &&
    compareLargestFirst(
      after.map((p) => p.maximumGapMinutes),
      before.map((p) => p.maximumGapMinutes)
    ) <= 0
  );
}

const CONTINUITY_REVIEW_BUDGET_MS = 4000;

export async function improveStaffWorkContinuity(
  context: FinalScheduleReviewContext
): Promise<Assignment[]> {
  const { state, date, lockedAssignmentIds, facts, solver, assertSafe } =
    context;
  let current = structuredClone([...context.assignments]);
  const duty = facts.currentDutyStaffId;
  const deadline = Date.now() + CONTINUITY_REVIEW_BUDGET_MS;
  const targets = staffWorkContinuity(state, current, duty)
    .filter((p) => p.split)
    .sort(
      (a, b) =>
        b.maximumGapMinutes - a.maximumGapMinutes ||
        a.staffId.localeCompare(b.staffId)
    );
  for (const target of targets) {
    if (Date.now() >= deadline) break;
    const before = staffWorkContinuity(state, current, duty);
    if (!before.find((p) => p.staffId === target.staffId)?.split) continue;
    const groups = groupStaffFlightsByNormalizedNumber(
      current.flatMap((a) =>
        a.status === "assigned" && a.staffId
          ? [{ staffId: a.staffId, flightNo: a.flightNo, assignment: a }]
          : []
      )
    );
    const movable = [...groups.values()].flatMap((flights) =>
      [...flights.values()].flatMap((entries) => {
        const rows = entries.map((e) => e.assignment);
        return rows.some(
          (a) =>
            a.staffId === duty ||
            a.manualRemark ||
            a.teamLeaderGapFill ||
            isRotationLocked(state, a, lockedAssignmentIds)
        )
          ? []
          : rows;
      })
    );
    for (const selectedIds of [
      target.lastAssignmentIds,
      target.morningAssignmentIds,
    ]) {
      if (Date.now() >= deadline) break;
      const primary = movable.find((a) => selectedIds.includes(a.id));
      if (!primary) continue;
      const forbiddenFlights = new Set(
        current.filter((a) => selectedIds.includes(a.id)).map((a) => a.flightId)
      );
      let accepted: Assignment[] | undefined;
      const result = await optimizeReassignment({
        solver,
        state,
        assignments: current,
        primary,
        movableAssignments: movable,
        date,
        facts,
        intent: { kind: "staff-work-continuity-review" },
        primaryCandidateAllowed: (p) =>
          p.id !== target.staffId && p.id !== duty,
        candidateAllowed: (a, p) =>
          p.id !== duty &&
          !(p.id === target.staffId && forbiddenFlights.has(a.flightId)),
        coupledAssignmentGroups: [...groups.values()]
          .flatMap((flights) =>
            [...flights.values()].map((entries) =>
              entries.map((e) => e.assignment.id)
            )
          )
          .filter((ids) => ids.every((id) => movable.some((a) => a.id === id))),
        preserveStaffAssignmentCounts: true,
        maxParticipants: 5,
        timeoutMs: Math.max(1, deadline - Date.now()),
        validateChanges: (changes) => {
          const changesById = new Map(
            changes.map((c) => [c.assignmentId, c.staffId])
          );
          const proposal = structuredClone(current);
          const changedStaff = new Set<string>();
          for (const a of proposal) {
            const incoming = changesById.get(a.id);
            if (!incoming || incoming === a.staffId) continue;
            if (a.staffId) changedStaff.add(a.staffId);
            changedStaff.add(incoming);
            a.staffId = incoming;
            a.staffName = state.staff.find((p) => p.id === incoming)!.name;
            rebuildAutomaticAssignmentEvidence(a, [
              schedulingDecision(
                "staff-work-continuity",
                "selected",
                "已通过整体安全换人集中早晚任务，未增加个人航班数。"
              ),
            ]);
          }
          applyConfiguredEarlyReleases(proposal, state, changedStaff);
          if (
            !improvesStaffWorkContinuity(
              before,
              staffWorkContinuity(state, proposal, duty),
              target.staffId
            )
          )
            return [
              "未缩短目标人员跨度，或新增他人早晚割裂、航班数/整体空挡退步",
            ];
          if (
            !preservesRelaxedShiftBalance(
              state,
              date,
              current,
              proposal,
              new Set([target.staffId])
            )
          )
            return ["月度休息人数或均衡结果退步"];
          try {
            assertSafe(proposal);
          } catch (error) {
            if (error instanceof ScheduleGuardError)
              return ["最终安全复核未通过，保留原安排"];
            throw error;
          }
          accepted = proposal;
          return [];
        },
      });
      if (result.changes && accepted) {
        current = accepted;
        break;
      }
    }
  }
  return current;
}
